// Write side of invoices: create, update, status changes and delete, plus the
// general-ledger sync and the totals they share. Every function takes db (a pg
// client) and runs inside the caller's transaction; none of them BEGINs or
// COMMITs. Expected failures are thrown as ServiceError (status + message).

const glPosting = require("../gl/postingService");
const currencyService = require("../currency/currencyService");
const { hasColumn } = require("../../utils/codeGenerator");
const { fail } = require("../shared/serviceError");
const {
  GL_POSTABLE_INVOICE_STATUSES,
  ALLOWED_INVOICE_STATUSES,
  normalizeMoney,
  normalizeBoolean,
  toNullable,
  sanitizeDateInput,
  normalizeInvoiceStatus,
  normalizeInvoiceTemplate,
  calculateDueDateFromTerms,
  calculateInvoiceStatusFromAmounts,
  resolveInvoiceTerms,
} = require("./invoiceValues");
const {
  normalizeInvoiceType,
  validateInvoiceLineItems,
  computeInvoiceAmounts,
  insertInvoiceItems,
} = require("./lineItemService");
const { hasInvoiceColumns } = require("./invoiceQueries");
const numbering = require("./numberingService");
const withholding = require("../payments/withholdingService");
const payments = require("../payments/paymentService");

// Keep the general ledger in sync with an invoice's lifecycle so the GL never
// diverges from the AR subledger. POSTED entries are immutable, so corrections
// are reversing entries: we reverse any existing AR_INVOICE entry, then re-post
// from the current invoice if it should be posted. Must run inside the caller's
// transaction (pass the pg client as `db`).
//   - mode "cancel": reverse only (invoice no longer a receivable).
//   - mode "repost": reverse + re-post the current amounts (edit).
//   - mode "ensure": post only if not already posted and status is postable
//                    (promotion from DRAFT), no churn when already in sync.
const syncInvoiceGl = async (db, invoice, userId, mode) => {
  if (!(await glPosting.glAvailable(db))) return;

  const isIntercompany = String(invoice.invoice_type) === "INTER_COMPANY";
  const source = isIntercompany ? "IC_INVOICE" : "AR_INVOICE";
  const post = isIntercompany
    ? glPosting.postIcInvoiceIssued
    : glPosting.postInvoiceIssued;

  // An inter-company invoice posts TWO legs sharing source_ref (issuer +
  // counterparty), so BOTH must be reversed — alreadyPosted only ever returns
  // the first, which would strand the counterparty's entry POSTED and leave the
  // 1600/2600 pair permanently out of balance.
  const posted = await glPosting.postedEntryIds(source, invoice.id, db);
  const postable = GL_POSTABLE_INVOICE_STATUSES.includes(String(invoice.invoice_status));

  const reverseAll = async (reason) => {
    for (const entry of posted) {
      await glPosting.reverseEntry(db, entry.id, reason, userId);
    }
  };

  if (mode === "cancel") {
    await reverseAll("Invoice cancelled");
    return;
  }
  if (mode === "repost") {
    await reverseAll("Invoice edited");
    if (postable) await post(db, invoice);
    return;
  }
  // "ensure"
  if (!posted.length && postable) await post(db, invoice);
};

const recalculateInvoiceAmountsAndStatus = async (db, invoiceId) => {
  const invoiceResult = await db.query(
    `
    SELECT id, total_amount, due_date, invoice_status
    FROM invoices
    WHERE id = $1
    LIMIT 1
    `,
    [invoiceId],
  );

  if (!invoiceResult.rows.length) {
    throw new Error("Invoice not found while recalculating");
  }

  const invoice = invoiceResult.rows[0];

  const hasTdsAmountColumn = await hasColumn(db, "payments", "tds_amount");
  const paymentResult = await db.query(
    `
    SELECT COALESCE(SUM(amount_received + ${hasTdsAmountColumn ? "COALESCE(tds_amount, 0)" : "0"}), 0) AS total_received
    FROM payments
    WHERE invoice_id = $1
    `,
    [invoiceId],
  );

  const totalReceived = normalizeMoney(
    paymentResult.rows[0]?.total_received || 0,
  );
  const totalAmount = normalizeMoney(invoice.total_amount || 0);
  const balanceOutstanding = totalAmount - totalReceived;

  const invoiceStatus = calculateInvoiceStatusFromAmounts({
    totalAmount,
    totalReceived,
    dueDate: invoice.due_date,
    currentStatus: invoice.invoice_status,
  });

  const updateResult = await db.query(
    `
    UPDATE invoices
    SET
      payment_received_amount = $1,
      balance_outstanding = $2,
      invoice_status = $3,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $4
    RETURNING *
    `,
    [totalReceived, balanceOutstanding, invoiceStatus, invoiceId],
  );

  return updateResult.rows[0];
};

const buildDynamicInvoiceInsert = ({
  invoiceColumns,
  invoiceNumberToUse,
  invoiceType,
  finalBillToRegionId,
  finalPlacementId,
  finalClientId,
  finalRegionId,
  invoice_date,
  finalDueDate,
  billing_period_start,
  billing_period_end,
  totalUnits,
  firstRate,
  subtotal,
  taxAmount,
  totalAmount,
  finalCurrency,
  invoice_status,
  termsToUse,
  customer_message,
  internal_notes,
  notes,
  computedTaxLines,
  invoice_template,
  invoice_template_id,
  invoice_template_name,
  invoice_template_snapshot_json,
  template_custom_fields_json,
  createdBy,
  exchangeRate,
  amountBase,
}) => {
  const columns = [
    "invoice_number",
    "placement_id",
    "client_id",
    "region_id",
    "invoice_date",
    "due_date",
    "billing_period_start",
    "billing_period_end",
    "hours_or_units",
    "bill_rate",
    "subtotal",
    "tax_amount",
    "total_amount",
    "currency",
    "invoice_status",
    "payment_received_amount",
    "balance_outstanding",
    "notes",
    "created_by",
  ];

  const values = [
    invoiceNumberToUse,
    finalPlacementId,
    finalClientId,
    finalRegionId,
    invoice_date,
    finalDueDate,
    toNullable(billing_period_start),
    toNullable(billing_period_end),
    totalUnits,
    firstRate,
    subtotal,
    taxAmount,
    totalAmount,
    finalCurrency,
    normalizeInvoiceStatus(invoice_status),
    0,
    totalAmount,
    toNullable(notes || internal_notes),
    createdBy,
  ];

  // Migration 016. Feature-detected rather than assumed: on a database that has
  // not run 016 these columns are absent, and a CLIENT invoice must still insert
  // (the DB default would be 'CLIENT' anyway). An INTER_COMPANY invoice is
  // rejected up-front in that case — see createInvoice — rather than silently
  // written as a CLIENT row.
  if (invoiceColumns.invoice_type) {
    columns.push("invoice_type");
    values.push(invoiceType || "CLIENT");
  }

  if (invoiceColumns.bill_to_region_id) {
    columns.push("bill_to_region_id");
    values.push(toNullable(finalBillToRegionId));
  }

  if (invoiceColumns.invoice_terms_label) {
    columns.push("invoice_terms_label");
    values.push(termsToUse);
  }

  if (invoiceColumns.customer_message) {
    columns.push("customer_message");
    values.push(toNullable(customer_message));
  }

  if (invoiceColumns.internal_notes) {
    columns.push("internal_notes");
    values.push(toNullable(internal_notes));
  }

  if (invoiceColumns.tax_lines_json) {
    columns.push("tax_lines_json");
    values.push(JSON.stringify(computedTaxLines));
  }

  if (invoiceColumns.invoice_template) {
    columns.push("invoice_template");
    values.push(normalizeInvoiceTemplate(invoice_template));
  }

  if (invoiceColumns.invoice_template_id) {
    columns.push("invoice_template_id");
    values.push(toNullable(invoice_template_id));
  }

  if (invoiceColumns.invoice_template_name) {
    columns.push("invoice_template_name");
    values.push(toNullable(invoice_template_name));
  }

  if (invoiceColumns.invoice_template_snapshot_json) {
    columns.push("invoice_template_snapshot_json");
    values.push(
      JSON.stringify(invoice_template_snapshot_json || {}),
    );
  }

  if (invoiceColumns.template_custom_fields_json) {
    columns.push("template_custom_fields_json");
    values.push(JSON.stringify(template_custom_fields_json || []));
  }

  // Freeze the document -> functional-currency valuation at issue date. Without
  // these, a cross-currency invoice (UK bills USD, books GBP) keeps
  // exchange_rate at its DEFAULT 1 and a null base, and every GBP figure
  // downstream silently renders the unconverted USD number.
  if (invoiceColumns.exchange_rate && exchangeRate != null) {
    columns.push("exchange_rate");
    values.push(exchangeRate);
  }

  if (invoiceColumns.amount_base && amountBase != null) {
    columns.push("amount_base");
    values.push(amountBase);
  }

  const placeholders = values.map((_, index) => {
    const columnName = columns[index];
    if (
      columnName === "tax_lines_json" ||
      columnName === "invoice_template_snapshot_json" ||
      columnName === "template_custom_fields_json"
    ) {
      return `$${index + 1}::jsonb`;
    }
    return `$${index + 1}`;
  });

  return { columns, values, placeholders };
};

const buildDynamicInvoiceUpdate = ({
  invoiceColumns,
  invoiceNumberToUse,
  finalBillToRegionId,
  finalPlacementId,
  finalClientId,
  finalRegionId,
  invoice_date,
  finalDueDate,
  billing_period_start,
  billing_period_end,
  totalUnits,
  firstRate,
  subtotal,
  taxAmount,
  totalAmount,
  finalCurrency,
  invoice_status,
  existingInvoice,
  termsToUse,
  customer_message,
  internal_notes,
  notes,
  computedTaxLines,
  invoice_template,
  invoice_template_id,
  invoice_template_name,
  invoice_template_snapshot_json,
  template_custom_fields_json,
  id,
}) => {
  const sets = [
    "invoice_number = $1",
    "placement_id = $2",
    "client_id = $3",
    "region_id = $4",
    "invoice_date = $5",
    "due_date = $6",
    "billing_period_start = $7",
    "billing_period_end = $8",
    "hours_or_units = $9",
    "bill_rate = $10",
    "subtotal = $11",
    "tax_amount = $12",
    "total_amount = $13",
    "currency = $14",
    "invoice_status = $15",
    "balance_outstanding = $16",
    "notes = $17",
  ];

  const values = [
    invoiceNumberToUse,
    finalPlacementId,
    finalClientId,
    finalRegionId,
    invoice_date,
    finalDueDate,
    toNullable(billing_period_start),
    toNullable(billing_period_end),
    totalUnits,
    firstRate,
    subtotal,
    taxAmount,
    totalAmount,
    finalCurrency,
    normalizeInvoiceStatus(invoice_status, existingInvoice.invoice_status),
    totalAmount - normalizeMoney(existingInvoice.payment_received_amount),
    toNullable(notes || internal_notes),
  ];

  // invoice_type is deliberately NOT in this SET list — the type is immutable
  // after creation (updateInvoice rejects a change), so it must never be
  // rewritten here. bill_to_region_id can move: an inter-company invoice may be
  // re-pointed at a different counterparty while still being inter-company.
  if (invoiceColumns.bill_to_region_id) {
    sets.push(`bill_to_region_id = $${values.length + 1}`);
    values.push(toNullable(finalBillToRegionId));
  }

  if (invoiceColumns.invoice_terms_label) {
    sets.push(`invoice_terms_label = $${values.length + 1}`);
    values.push(termsToUse);
  }

  if (invoiceColumns.customer_message) {
    sets.push(`customer_message = $${values.length + 1}`);
    values.push(toNullable(customer_message));
  }

  if (invoiceColumns.internal_notes) {
    sets.push(`internal_notes = $${values.length + 1}`);
    values.push(toNullable(internal_notes));
  }

  if (invoiceColumns.tax_lines_json) {
    sets.push(`tax_lines_json = $${values.length + 1}::jsonb`);
    values.push(JSON.stringify(computedTaxLines));
  }

  if (invoiceColumns.invoice_template) {
    sets.push(`invoice_template = $${values.length + 1}`);
    values.push(normalizeInvoiceTemplate(invoice_template));
  }

  if (invoiceColumns.invoice_template_id) {
    sets.push(`invoice_template_id = $${values.length + 1}`);
    values.push(toNullable(invoice_template_id));
  }

  if (invoiceColumns.invoice_template_name) {
    sets.push(`invoice_template_name = $${values.length + 1}`);
    values.push(toNullable(invoice_template_name));
  }

  if (invoiceColumns.invoice_template_snapshot_json) {
    sets.push(`invoice_template_snapshot_json = $${values.length + 1}::jsonb`);
    values.push(JSON.stringify(invoice_template_snapshot_json || {}));
  }

  if (invoiceColumns.template_custom_fields_json) {
    sets.push(`template_custom_fields_json = $${values.length + 1}::jsonb`);
    values.push(JSON.stringify(template_custom_fields_json || []));
  }

  sets.push(`updated_at = CURRENT_TIMESTAMP`);
  values.push(id);

  return { sets, values };
};

// Validate line items, turning any validation error into a 400.
const validateLines = async (db, lineItems, context) => {
  try {
    return await validateInvoiceLineItems(db, lineItems, context);
  } catch (validationError) {
    return fail(400, validationError.message);
  }
};

// The parties, currency and terms an invoice resolves to, shared by create and
// update. Fails with the same messages and in the same order as before.
const resolveHeader = async (db, { body, validated, isIntercompany, scope }) => {
  const { client_id, region_id, placement_id, currency } = body;

  // An inter-company invoice has no client and no placement (migration 016's
  // shape CHECK forbids them); its header is authoritative rather than derived.
  const finalClientId = isIntercompany ? null : Number(client_id || validated.clientId);
  const finalRegionId = Number(region_id || validated.regionId);
  const finalPlacementId = isIntercompany ? null : Number(placement_id || validated.primaryPlacement.id);
  const finalBillToRegionId = isIntercompany ? Number(validated.billToRegionId) : null;
  const finalCurrency = String(currency || validated.currency || "").toUpperCase();

  if (isIntercompany) {
    if (finalRegionId !== Number(validated.regionId)) {
      fail(400, "Invoice header does not match the issuing entity");
    }
  } else if (
    finalClientId !== Number(validated.clientId) ||
    finalRegionId !== Number(validated.regionId)
  ) {
    fail(400, "Invoice header does not match selected placement particulars");
  }

  // Row-level RBAC: never trust a body-supplied region_id outside the caller's scope.
  if (!scope.canAct(finalRegionId)) fail(403, "Not authorized for this entity (region)");

  // An inter-company invoice writes into BOTH entities' ledgers, so the caller
  // must be scoped to both — checked up front so the failure is a clear 403
  // rather than an assertCanPost error from deep inside the GL post.
  if (isIntercompany && !scope.canAct(finalBillToRegionId)) {
    fail(403, "Not authorized for the bill-to entity (region)");
  }

  return { finalClientId, finalRegionId, finalPlacementId, finalBillToRegionId, finalCurrency };
};

const loadParties = async (db, clientId, regionId) => {
  const selectedClientResult = clientId
    ? await db.query(`SELECT * FROM clients WHERE id = $1 LIMIT 1`, [clientId])
    : { rows: [] };
  const selectedRegionResult = await db.query(`SELECT * FROM regions WHERE id = $1 LIMIT 1`, [regionId]);
  return {
    selectedClient: selectedClientResult.rows[0] || null,
    selectedRegion: selectedRegionResult.rows[0] || null,
  };
};

// Subtotal, tax, total and the units/rate summary columns.
const totalsFor = (validated, taxLines, isIntercompany) => {
  const amounts = computeInvoiceAmounts({
    lineItems: validated.normalizedLineItems,
    // Inter-company is zero-rated: validation rejects tax lines outright, so
    // this stays empty and tax_amount computes to 0.
    taxLines: isIntercompany ? [] : Array.isArray(taxLines) ? taxLines : [],
  });
  const totalUnits = validated.normalizedLineItems.reduce(
    (sum, item) => sum + normalizeMoney(item.quantity),
    0,
  );
  const firstRate = normalizeMoney(validated.normalizedLineItems[0]?.rate || 0);
  return { ...amounts, totalUnits, firstRate };
};

/**
 * Create an invoice, its line items and (unless DRAFT) its ledger entry.
 * body:  the create route's request body.
 * Returns { invoice, lineItems, taxLines }.
 */
const createInvoice = async (db, body, scope) => {
  const {
    invoice_number,
    invoice_type,
    bill_to_region_id,
    region_id,
    invoice_date,
    due_date,
    currency,
    invoice_status,
    invoice_template,
    invoice_template_id,
    invoice_template_name,
    invoice_template_snapshot_json,
    template_custom_fields_json,
    invoice_terms_label,
    customer_message,
    internal_notes,
    notes,
    billing_period_start,
    billing_period_end,
    line_items = [],
    tax_lines = [],
  } = body;

  const normalizedInvoiceDate = sanitizeDateInput(invoice_date);
  const normalizedDueDateInput = sanitizeDateInput(due_date);
  const normalizedBillingPeriodStart = sanitizeDateInput(billing_period_start);
  const normalizedBillingPeriodEnd = sanitizeDateInput(billing_period_end);

  if (!normalizedInvoiceDate) fail(400, "Valid invoice date is required");

  const validated = await validateLines(db, line_items, {
    invoice_type,
    region_id,
    bill_to_region_id,
    currency,
    tax_lines,
  });
  const isIntercompany = validated.invoiceType === "INTER_COMPANY";
  const header = await resolveHeader(db, { body, validated, isIntercompany, scope });
  const { finalClientId, finalRegionId, finalPlacementId, finalBillToRegionId, finalCurrency } = header;

  if (!finalCurrency) fail(400, "Currency is required");
  if (!isIntercompany && finalCurrency !== validated.currency) {
    fail(400, `Invoice currency must match the selected client/placement currency (${validated.currency})`);
  }

  const invoiceNumberToUse = invoice_number?.trim()
    ? invoice_number.trim().toUpperCase()
    : await numbering.nextInvoiceNumber(db, { intercompany: isIntercompany });

  const existingInvoice = await db.query(
    `SELECT id FROM invoices WHERE LOWER(invoice_number) = LOWER($1) LIMIT 1`,
    [invoiceNumberToUse],
  );
  if (existingInvoice.rows.length > 0) fail(409, "Invoice number already exists");

  const { selectedClient, selectedRegion } = await loadParties(db, finalClientId, finalRegionId);

  // For INTER_COMPANY both placement and client are null, so this falls
  // through to the issuing region's terms, then the Net 30 default.
  const termsToUse = resolveInvoiceTerms({
    placement: validated.primaryPlacement,
    client: selectedClient,
    region: selectedRegion,
    providedTerms: invoice_terms_label,
  });

  const finalDueDate =
    normalizedDueDateInput || calculateDueDateFromTerms(normalizedInvoiceDate, termsToUse);
  if (!finalDueDate) fail(400, "Due date is required");

  const { subtotal, taxAmount, totalAmount, computedTaxLines, totalUnits, firstRate } =
    totalsFor(validated, tax_lines, isIntercompany);
  const invoiceColumns = await hasInvoiceColumns(db);

  // Refuse rather than silently degrade: without 016 the discriminator columns
  // don't exist, so an inter-company payload would insert as a CLIENT row with
  // no bill-to party and no way to tell it apart afterwards.
  if (isIntercompany && !(invoiceColumns.invoice_type && invoiceColumns.bill_to_region_id)) {
    fail(501, "Inter-company invoicing requires migration 016_intercompany_invoices.sql");
  }

  // Value the invoice into its entity's functional currency at issue date.
  // A missing rate must not block invoicing, so fall back to the column
  // defaults (rate 1 / null base) and warn — the same state rows had before.
  let exchangeRate = null;
  let amountBase = null;
  if (invoiceColumns.exchange_rate || invoiceColumns.amount_base) {
    try {
      const valuation = await currencyService.toFunctional(
        totalAmount,
        finalCurrency,
        finalRegionId,
        normalizedInvoiceDate,
        db,
      );
      exchangeRate = valuation.exchangeRate;
      amountBase = valuation.amountBase;
    } catch (fxError) {
      console.warn(
        `Invoice valuation skipped (region ${finalRegionId}, ${finalCurrency} on ${normalizedInvoiceDate}): ${fxError.message}`,
      );
    }
  }

  const insertParts = buildDynamicInvoiceInsert({
    invoiceColumns,
    exchangeRate,
    amountBase,
    invoiceNumberToUse,
    invoiceType: validated.invoiceType,
    finalBillToRegionId,
    finalPlacementId,
    finalClientId,
    finalRegionId,
    invoice_date: normalizedInvoiceDate,
    finalDueDate,
    billing_period_start: normalizedBillingPeriodStart,
    billing_period_end: normalizedBillingPeriodEnd,
    totalUnits,
    firstRate,
    subtotal,
    taxAmount,
    totalAmount,
    finalCurrency,
    invoice_status,
    termsToUse,
    customer_message,
    internal_notes,
    notes,
    computedTaxLines,
    invoice_template: invoice_template || selectedRegion?.invoice_template || "CLASSIC",
    invoice_template_id,
    invoice_template_name,
    invoice_template_snapshot_json,
    template_custom_fields_json,
    createdBy: scope.userId,
  });

  const insertInvoiceResult = await db.query(
    `INSERT INTO invoices (${insertParts.columns.join(", ")})
     VALUES (${insertParts.placeholders.join(", ")})
     RETURNING *`,
    insertParts.values,
  );
  const createdInvoice = insertInvoiceResult.rows[0];

  await insertInvoiceItems(db, createdInvoice.id, validated.normalizedLineItems);

  // Post to the general ledger with the invoice. Skips a DRAFT; idempotent.
  // Inter-company posts TWO entries (issuer + counterparty).
  if (
    GL_POSTABLE_INVOICE_STATUSES.includes(String(createdInvoice.invoice_status)) &&
    (await glPosting.glAvailable(db))
  ) {
    if (isIntercompany) {
      await glPosting.postIcInvoiceIssued(db, createdInvoice);
    } else {
      await glPosting.postInvoiceIssued(db, createdInvoice);
    }
  }

  return {
    invoice: createdInvoice,
    lineItems: validated.normalizedLineItems,
    taxLines: computedTaxLines,
  };
};

/**
 * Replace an invoice's header and line items, then recalculate its balance and
 * re-post it (an edit reverses the old ledger entry and posts the new amounts).
 * The invoice type cannot change. Returns { invoice, previous, lineItems, taxLines }.
 */
const updateInvoice = async (db, id, body, scope) => {
  const {
    invoice_number,
    invoice_type,
    bill_to_region_id,
    region_id,
    invoice_date,
    due_date,
    currency,
    invoice_status,
    invoice_template,
    invoice_template_id,
    invoice_template_name,
    invoice_template_snapshot_json,
    template_custom_fields_json,
    invoice_terms_label,
    customer_message,
    internal_notes,
    notes,
    billing_period_start,
    billing_period_end,
    line_items = [],
    tax_lines = [],
  } = body;

  const normalizedInvoiceDate = sanitizeDateInput(invoice_date);
  const normalizedDueDateInput = sanitizeDateInput(due_date);
  const normalizedBillingPeriodStart = sanitizeDateInput(billing_period_start);
  const normalizedBillingPeriodEnd = sanitizeDateInput(billing_period_end);

  const existingInvoiceResult = await db.query(`SELECT * FROM invoices WHERE id = $1 LIMIT 1`, [id]);
  const existingInvoice = existingInvoiceResult.rows[0];
  if (!existingInvoice || !scope.canAct(existingInvoice.region_id)) fail(404, "Invoice not found");

  if (region_id != null && !scope.canAct(region_id)) {
    fail(403, "Not authorized to assign invoices to this region");
  }
  if (!normalizedInvoiceDate) fail(400, "Valid invoice date is required");

  // The type is fixed at creation. Switching it would mean nulling one set of
  // columns and populating another, reversing one GL shape and posting a
  // different one, and re-numbering across two series (INV- vs IC-). Reject it
  // cleanly instead: cancel and re-raise is the honest way to change type.
  let existingType;
  try {
    existingType = normalizeInvoiceType(existingInvoice.invoice_type);
    if (
      invoice_type != null &&
      String(invoice_type).trim() !== "" &&
      normalizeInvoiceType(invoice_type) !== existingType
    ) {
      fail(400, "Invoice type cannot be changed after creation. Cancel this invoice and raise a new one.");
    }
  } catch (typeError) {
    fail(typeError.status || 400, typeError.message);
  }

  const isIntercompany = existingType === "INTER_COMPANY";
  const validated = await validateLines(db, line_items, {
    invoice_type: existingType,
    // Fall back to the stored values so a partial payload (line items only)
    // still validates against the invoice's own parties.
    region_id: region_id != null ? region_id : existingInvoice.region_id,
    bill_to_region_id: bill_to_region_id != null ? bill_to_region_id : existingInvoice.bill_to_region_id,
    currency,
    tax_lines,
  });
  const header = await resolveHeader(db, { body, validated, isIntercompany, scope });
  const { finalClientId, finalRegionId, finalPlacementId, finalBillToRegionId, finalCurrency } = header;

  if (!isIntercompany && finalCurrency !== validated.currency) {
    fail(400, `Invoice currency must match the selected client/placement currency (${validated.currency})`);
  }

  const invoiceNumberToUse = invoice_number?.trim()
    ? invoice_number.trim().toUpperCase()
    : existingInvoice.invoice_number;

  const duplicateCheck = await db.query(
    `SELECT id FROM invoices WHERE LOWER(invoice_number)=LOWER($1) AND id<>$2 LIMIT 1`,
    [invoiceNumberToUse, id],
  );
  if (duplicateCheck.rows.length > 0) fail(409, "Invoice number already exists");

  const { selectedClient, selectedRegion } = await loadParties(db, finalClientId, finalRegionId);
  const termsToUse = resolveInvoiceTerms({
    placement: validated.primaryPlacement,
    client: selectedClient,
    region: selectedRegion,
    providedTerms: invoice_terms_label,
  });

  const finalDueDate =
    normalizedDueDateInput || calculateDueDateFromTerms(normalizedInvoiceDate, termsToUse);
  if (!finalDueDate) fail(400, "Due date is required");

  const { subtotal, taxAmount, totalAmount, computedTaxLines, totalUnits, firstRate } =
    totalsFor(validated, tax_lines, isIntercompany);
  const invoiceColumns = await hasInvoiceColumns(db);
  const keep = (value, existing) => (value !== undefined ? value : existing);

  const updateParts = buildDynamicInvoiceUpdate({
    invoiceColumns,
    invoiceNumberToUse,
    finalBillToRegionId,
    finalPlacementId,
    finalClientId,
    finalRegionId,
    invoice_date: normalizedInvoiceDate,
    finalDueDate,
    billing_period_start: normalizedBillingPeriodStart,
    billing_period_end: normalizedBillingPeriodEnd,
    totalUnits,
    firstRate,
    subtotal,
    taxAmount,
    totalAmount,
    finalCurrency,
    invoice_status,
    existingInvoice,
    termsToUse,
    customer_message,
    internal_notes,
    notes,
    computedTaxLines,
    invoice_template:
      invoice_template ||
      selectedRegion?.invoice_template ||
      existingInvoice?.invoice_template ||
      "CLASSIC",
    invoice_template_id: keep(invoice_template_id, existingInvoice.invoice_template_id),
    invoice_template_name: keep(invoice_template_name, existingInvoice.invoice_template_name),
    invoice_template_snapshot_json: keep(
      invoice_template_snapshot_json,
      existingInvoice.invoice_template_snapshot_json,
    ),
    template_custom_fields_json: keep(
      template_custom_fields_json,
      existingInvoice.template_custom_fields_json,
    ),
    id,
  });

  await db.query(
    `UPDATE invoices
     SET ${updateParts.sets.join(",\n         ")}
     WHERE id = $${updateParts.values.length}`,
    updateParts.values,
  );

  await db.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [id]);
  await insertInvoiceItems(db, id, validated.normalizedLineItems);

  const recalculatedInvoice = await recalculateInvoiceAmountsAndStatus(db, Number(id));

  // GL lifecycle: an edit to a posted invoice reverses the stale entry and
  // re-posts the new amounts so the ledger matches the revised invoice.
  await syncInvoiceGl(db, recalculatedInvoice, scope.userId, "repost");

  return {
    invoice: recalculatedInvoice,
    previous: existingInvoice,
    lineItems: validated.normalizedLineItems,
    taxLines: computedTaxLines,
  };
};

// A payment date from the request: YYYY-MM-DD, a real date, not in the future.
// Round-trips the parse because JS rolls impossible dates forward rather than
// rejecting them (2026-02-31 -> 2026-03-03).
const checkPaymentDate = (requestedPaymentDate) => {
  if (!requestedPaymentDate) return;
  const parsed = new Date(`${requestedPaymentDate}T00:00:00Z`);
  const isValidDate =
    /^\d{4}-\d{2}-\d{2}$/.test(requestedPaymentDate) &&
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === requestedPaymentDate;
  if (!isValidDate) fail(400, "Invalid payment date");

  const todayKey = new Date().toISOString().slice(0, 10);
  if (requestedPaymentDate > todayKey) fail(400, "Payment date cannot be in the future");
};

/**
 * Change an invoice's status. PAID and PARTIALLY_PAID record an automatic
 * payment (with any TDS); moving back to OVERDUE/GENERATED/SENT removes the
 * automatic payments; CANCELLED reverses the ledger entry; promotion from DRAFT
 * posts it. body: { status | invoice_status, tds_applicable, tds_percent,
 * payment_date, amount_received | amount }. Returns { invoice, previous }.
 */
const updateInvoiceStatus = async (db, id, body, scope) => {
  const requestedStatus = String(body.status || body.invoice_status || "").toUpperCase();
  if (!ALLOWED_INVOICE_STATUSES.includes(requestedStatus)) fail(400, "Invalid invoice status");

  const invoiceResult = await db.query(`SELECT * FROM invoices WHERE id = $1 LIMIT 1`, [id]);
  const invoice = invoiceResult.rows[0];
  if (!invoice || !scope.canAct(invoice.region_id)) fail(404, "Invoice not found");

  const isPayment = ["PAID", "PARTIALLY_PAID"].includes(requestedStatus);

  // TDS only exists for regions configured for it (India). Elsewhere the
  // client never renders the question, so requiring an answer would reject
  // every US/UK payment.
  const regionTdsApplicable = await withholding.getRegionTdsApplicable(db, invoice.region_id);
  if (
    regionTdsApplicable &&
    isPayment &&
    (body.tds_applicable === undefined || body.tds_applicable === null || body.tds_applicable === "")
  ) {
    fail(400, "TDS paid selection is required");
  }

  const tds = withholding.resolveTds({
    regionApplies: regionTdsApplicable,
    selected: normalizeBoolean(body.tds_applicable),
    percent: body.tds_percent,
  });
  const statusTdsAmount = withholding.calculateTdsAmount(invoice, tds.applicable, tds.percent);

  if (isPayment && tds.applicable && tds.percent <= 0) {
    fail(400, "TDS percentage is required when TDS is paid");
  }

  // Optional: when omitted, the automatic payment is dated CURRENT_DATE.
  const requestedPaymentDate = String(body.payment_date || "").trim();
  checkPaymentDate(requestedPaymentDate);

  if (requestedStatus === "CANCELLED") {
    const paymentsResult = await db.query(
      `SELECT COUNT(*)::int AS payment_count FROM payments WHERE invoice_id = $1`,
      [id],
    );
    if (Number(paymentsResult.rows[0]?.payment_count || 0) > 0) {
      fail(400, "Cannot cancel invoice with existing payments");
    }
  }

  const totalAmount = normalizeMoney(invoice.total_amount);
  const alreadyReceived = normalizeMoney(invoice.payment_received_amount);
  const partialAmount = Number(body.amount_received || body.amount || 0);

  if (requestedStatus === "PAID" && statusTdsAmount > Math.max(totalAmount - alreadyReceived, 0)) {
    fail(400, "TDS amount exceeds outstanding balance");
  }
  if (requestedStatus === "PARTIALLY_PAID") {
    if (partialAmount <= 0) fail(400, "Amount is required for PARTIALLY_PAID status");
    if (alreadyReceived + partialAmount + statusTdsAmount > totalAmount) {
      fail(400, "Partial payment exceeds outstanding balance");
    }
  }

  const autoPayment = (amountReceived, extra = {}) =>
    payments.recordStatusPayment(db, {
      invoiceId: id,
      amountReceived,
      status: requestedStatus,
      userId: scope.userId,
      tdsApplicable: tds.applicable,
      tdsPercent: tds.applicable ? tds.percent : null,
      tdsAmount: statusTdsAmount,
      ...extra,
    });
  const setStatus = async () =>
    (await db.query(
      `UPDATE invoices
       SET invoice_status = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING *`,
      [requestedStatus, id],
    )).rows[0];

  let updatedInvoice;
  if (requestedStatus === "PAID") {
    if (alreadyReceived < totalAmount) {
      await autoPayment(Math.max(totalAmount - alreadyReceived - statusTdsAmount, 0), {
        paymentDate: requestedPaymentDate || null,
      });
    }
    updatedInvoice = await recalculateInvoiceAmountsAndStatus(db, Number(id));
  } else if (requestedStatus === "PARTIALLY_PAID") {
    // The requested payment_date is not used here: the payment is dated today.
    await autoPayment(partialAmount);
    updatedInvoice = await recalculateInvoiceAmountsAndStatus(db, Number(id));
  } else if (["OVERDUE", "GENERATED", "SENT"].includes(requestedStatus)) {
    const autoPaymentsResult = await db.query(
      `DELETE FROM payments
       WHERE invoice_id = $1
         AND payment_mode = 'AUTO'
       RETURNING *`,
      [id],
    );
    updatedInvoice = autoPaymentsResult.rows.length > 0
      ? await recalculateInvoiceAmountsAndStatus(db, Number(id))
      : await setStatus();
  } else {
    updatedInvoice = await setStatus();
  }

  // GL lifecycle: promotion from DRAFT into a postable status posts the entry;
  // CANCELLED reverses it. Other transitions (already posted) are no-ops.
  await syncInvoiceGl(db, updatedInvoice, scope.userId, requestedStatus === "CANCELLED" ? "cancel" : "ensure");

  return { invoice: updatedInvoice, previous: invoice };
};

/**
 * Delete an invoice that has no payments, reversing its ledger entry first so
 * the ledger never references a deleted document. Returns { previous }.
 */
const deleteInvoice = async (db, id, scope) => {
  const invoiceResult = await db.query(`SELECT * FROM invoices WHERE id = $1 LIMIT 1`, [id]);
  const existingInvoice = invoiceResult.rows[0];
  if (!existingInvoice || !scope.canAct(existingInvoice.region_id)) fail(404, "Invoice not found");

  const paymentCheck = await db.query(
    `SELECT COUNT(*)::int AS payment_count FROM payments WHERE invoice_id = $1`,
    [id],
  );
  if (Number(paymentCheck.rows[0]?.payment_count || 0) > 0) {
    fail(400, "Cannot delete invoice with linked payments");
  }

  if (await glPosting.glAvailable(db)) {
    const postedId = await glPosting.alreadyPosted("AR_INVOICE", id, db);
    if (postedId) await glPosting.reverseEntry(db, postedId, "Invoice deleted", scope.userId);
  }

  await db.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [id]);
  await db.query(`DELETE FROM invoices WHERE id = $1`, [id]);
  return { previous: existingInvoice };
};

module.exports = {
  syncInvoiceGl,
  recalculateInvoiceAmountsAndStatus,
  createInvoice,
  updateInvoice,
  updateInvoiceStatus,
  deleteInvoice,
};

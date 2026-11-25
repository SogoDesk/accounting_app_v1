// Write side of customer payments: record (allocating one receipt across one
// or more invoices), edit and delete, keeping invoice balances and the general
// ledger in step. Every function takes db (a pg client) and runs inside the
// caller's transaction; none of them BEGINs or COMMITs. Expected failures are
// thrown as ServiceError (status + message).

const glPosting = require("../gl/postingService");
const {
  generatePaymentCode,
  generatePaymentReference,
  hasColumn,
} = require("../../utils/codeGenerator");
const { fail } = require("../shared/serviceError");
const withholding = require("./withholdingService");
const { getInvoiceWithContext } = require("./paymentQueries");

const ALLOWED_PAYMENT_MODES = [
  "BANK_TRANSFER", "WIRE_TRANSFER", "ACH", "CHECK", "CASH", "CARD",
  "UPI", "NEFT", "RTGS", "IMPS", "OTHER",
];
const SUPPORTED_PAYMENT_CURRENCIES = new Set(["USD", "GBP", "INR"]);

const normalizeMoney = (value) => {
  const num = Number(value || 0);
  return Number.isNaN(num) ? 0 : num;
};
const normalizeNullable = (value) => value === undefined || value === null || value === "" ? null : value;
const normalizeUpperNullable = (value) => value === undefined || value === null || value === "" ? null : String(value).trim().toUpperCase();
const normalizeCurrencyCode = (value, fallback = "") => {
  const code = String(value || fallback || "").trim().toUpperCase();
  return code || fallback || "";
};
const normalizeBoolean = (value) => {
  if (value === true || value === 1) return true;
  if (typeof value === "string") return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
  return false;
};
// Note: the YYYY-MM-DD shortcut below never matches (the backslashes are
// doubled), so every date goes through new Date() and the server's local
// date. Kept as it was; see the step 0.5 notes.
const sanitizeDateInput = (value) => {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\\d{4}-\\d{2}-\\d{2}$/.test(raw)) return raw;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
};

const getInvoiceStatusFromAmounts = ({ totalAmount, totalReceived, dueDate }) => {
  const total = normalizeMoney(totalAmount);
  const received = normalizeMoney(totalReceived);
  if (total > 0 && received >= total) return "PAID";
  if (received > 0 && received < total) return "PARTIALLY_PAID";
  if (dueDate) {
    const due = new Date(dueDate);
    const today = new Date();
    due.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    if (due < today && total > 0) return "OVERDUE";
  }
  return "GENERATED";
};

// Re-derive an invoice's received amount, balance and status from its payments
// (cash + TDS). A cancelled invoice is left alone. Returns the invoice row.
const recalculateInvoiceTotals = async (db, invoiceId) => {
  const invoiceResult = await db.query(`
    SELECT id, total_amount, due_date, invoice_status FROM invoices WHERE id = $1 LIMIT 1
  `, [invoiceId]);
  if (!invoiceResult.rows.length) throw new Error("Invoice not found");
  const invoice = invoiceResult.rows[0];
  if (String(invoice.invoice_status || "").toUpperCase() === "CANCELLED") return invoice;
  const hasTdsAmountColumn = await hasColumn(db, "payments", "tds_amount");
  const creditedResult = await db.query(`
    SELECT COALESCE(SUM(amount_received + ${hasTdsAmountColumn ? "COALESCE(tds_amount, 0)" : "0"}), 0) AS total_credited
    FROM payments WHERE invoice_id = $1
  `, [invoiceId]);
  const totalReceived = normalizeMoney(creditedResult.rows[0]?.total_credited || 0);
  const totalAmount = normalizeMoney(invoice.total_amount || 0);
  const balanceOutstanding = Math.max(totalAmount - totalReceived, 0);
  const invoiceStatus = getInvoiceStatusFromAmounts({ totalAmount, totalReceived, dueDate: invoice.due_date });
  const updateResult = await db.query(`
    UPDATE invoices SET payment_received_amount = $1, balance_outstanding = $2,
      invoice_status = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *
  `, [totalReceived, balanceOutstanding, invoiceStatus, invoiceId]);
  return updateResult.rows[0];
};

// Post a payment to the ledger: an inter-company settlement, or an ordinary
// customer receipt (bank + TDS against receivable).
const postPayment = async (db, invoice, payment, userId) => {
  if (!(await glPosting.glAvailable(db))) return;
  if (String(invoice.invoice_type) === "INTER_COMPANY") {
    await glPosting.postIcInvoiceSettled(db, invoice, {
      id: payment.id, amount: payment.amount_received, payment_date: payment.payment_date, created_by: userId,
    });
  } else {
    await glPosting.postCustomerReceipt(db, {
      id: payment.id, invoice_id: invoice.id, payment_date: payment.payment_date,
      amount_received: payment.amount_received, tds_amount: payment.tds_amount,
      currency: payment.currency || invoice.currency, payment_code: payment.payment_code, created_by: userId,
    }, invoice);
  }
};

const reversePosted = async (db, paymentId, reason, userId) => {
  if (!(await glPosting.glAvailable(db))) return;
  const posted = await glPosting.postedEntryIds("AR_PAYMENT", paymentId, db);
  for (const e of posted) await glPosting.reverseEntry(db, e.id, reason, userId);
};

const checkPaymentMode = (mode) => {
  if (mode && !ALLOWED_PAYMENT_MODES.includes(mode)) fail(400, "Invalid payment mode");
};
const checkCurrency = (currency) => {
  if (currency && SUPPORTED_PAYMENT_CURRENCIES.size && !SUPPORTED_PAYMENT_CURRENCIES.has(currency)) {
    fail(400, `Unsupported payment currency ${currency}`);
  }
};

/**
 * Record a receipt against one invoice (invoice_id) or several (invoice_ids).
 * The cash is applied to the invoices in order, each up to its balance net of
 * TDS; a blank amount pays them all in full. Each invoice gets its own payment
 * row and ledger entry. Returns { payment, payments, invoices }.
 */
const createPayment = async (db, body, scope) => {
  const hasPaymentCodeColumn = await hasColumn(db, "payments", "payment_code");
  const { payment_code, invoice_id, invoice_ids, payment_date, amount_received, payment_mode, reference_number, tds_applicable, tds_percent, notes } = body;
  const targetInvoiceIds = Array.from(new Set((Array.isArray(invoice_ids) && invoice_ids.length ? invoice_ids : [invoice_id])
    .filter(Boolean).map(Number).filter((id) => Number.isFinite(id) && id > 0)));
  const finalPaymentDate = sanitizeDateInput(payment_date);
  if (!targetInvoiceIds.length || !finalPaymentDate) fail(400, "At least one invoice and payment date are required");

  await db.query("SELECT id FROM invoices WHERE id = ANY($1) FOR UPDATE", [targetInvoiceIds]);
  const invoices = [];
  for (const targetInvoiceId of targetInvoiceIds) {
    const invoice = await getInvoiceWithContext(db, targetInvoiceId);
    if (!invoice) fail(404, `Invoice ${targetInvoiceId} not found`);
    if (String(invoice.invoice_status || "").toUpperCase() === "CANCELLED") fail(400, "Cannot add payment to a cancelled invoice");
    if (!scope.canAct(invoice.region_id)) fail(403, "Not authorized for this entity (region)");
    invoices.push(invoice);
  }

  const tds = withholding.resolveTds({
    regionApplies: invoices.some((invoice) => invoice.region_tds_applicable === true),
    selected: normalizeBoolean(tds_applicable),
    percent: tds_percent,
  });
  if (tds.applicable && tds.percent <= 0) fail(400, "TDS percentage is required when TDS is applicable");

  const invoiceCurrencies = Array.from(new Set(invoices.map((invoice) => normalizeCurrencyCode(invoice.currency, "USD")).filter(Boolean)));
  if (invoiceCurrencies.length > 1) fail(400, "Selected invoices must use the same currency for a single payment");
  const paymentCurrency = invoiceCurrencies[0] || "USD";
  checkCurrency(paymentCurrency);

  const invoiceCredits = invoices.map((invoice) => {
    const tdsAmount = withholding.calculateTdsAmount(invoice, tds.applicable, tds.percent);
    const balance = normalizeMoney(invoice.balance_outstanding);
    return { invoice, tdsAmount, maxCashAmount: Math.max(balance - tdsAmount, 0), balance };
  });
  const suggestedCashTotal = invoiceCredits.reduce((sum, item) => sum + item.maxCashAmount, 0);
  let remainingCashAmount = amount_received !== undefined && amount_received !== "" ? normalizeMoney(amount_received) : suggestedCashTotal;
  const totalTds = invoiceCredits.reduce((sum, item) => sum + item.tdsAmount, 0);
  if (remainingCashAmount <= 0 && totalTds <= 0) fail(400, "Amount received or TDS amount must be greater than zero");
  if (remainingCashAmount > suggestedCashTotal) fail(400, `Amount cannot exceed current net receivable of ${suggestedCashTotal.toFixed(2)}`);

  let finalPaymentCode = null;
  if (hasPaymentCodeColumn) {
    if (payment_code && String(payment_code).trim()) {
      finalPaymentCode = String(payment_code).trim().toUpperCase();
      const existingCode = await db.query("SELECT id FROM payments WHERE payment_code = $1 LIMIT 1", [finalPaymentCode]);
      if (existingCode.rows.length) fail(400, "Payment code already exists");
    } else finalPaymentCode = await generatePaymentCode(db);
  }
  const finalReferenceNumber = reference_number && String(reference_number).trim() ? String(reference_number).trim().toUpperCase() : await generatePaymentReference(db);
  const normalizedPaymentMode = normalizeUpperNullable(payment_mode);
  checkPaymentMode(normalizedPaymentMode);

  const insertColumns = ["invoice_id", "payment_date", "currency", "amount_received", "payment_mode", "reference_number", "tds_applicable", "tds_percent", "tds_amount", "notes", "created_by"];
  if (hasPaymentCodeColumn) insertColumns.splice(1, 0, "payment_code");
  const placeholders = insertColumns.map((_, index) => `$${index + 1}`).join(", ");
  const createdPayments = [], updatedInvoices = [];
  for (let index = 0; index < invoiceCredits.length; index++) {
    const item = invoiceCredits[index];
    const cashAmount = Math.min(item.maxCashAmount, remainingCashAmount);
    remainingCashAmount = Number((remainingCashAmount - cashAmount).toFixed(2));
    const creditedAmount = cashAmount + item.tdsAmount;
    if (creditedAmount <= 0) continue;
    if (creditedAmount > item.balance) fail(400, `Credited amount cannot exceed balance for invoice ${item.invoice.invoice_number}`);
    let paymentCodeForRow = finalPaymentCode;
    if (hasPaymentCodeColumn && (!paymentCodeForRow || index > 0)) paymentCodeForRow = await generatePaymentCode(db);
    const insertValues = [Number(item.invoice.id), finalPaymentDate, paymentCurrency, cashAmount, normalizedPaymentMode, finalReferenceNumber, tds.applicable, tds.percent || null, item.tdsAmount, normalizeNullable(notes), scope.userId];
    if (hasPaymentCodeColumn) insertValues.splice(1, 0, paymentCodeForRow);
    const paymentResult = await db.query(`INSERT INTO payments (${insertColumns.join(", ")}) VALUES (${placeholders}) RETURNING *`, insertValues);
    const payment = paymentResult.rows[0];
    createdPayments.push(payment);
    await postPayment(db, item.invoice, payment, scope.userId);
    updatedInvoices.push(await recalculateInvoiceTotals(db, item.invoice.id));
  }
  if (!createdPayments.length) fail(400, "No payable invoice balance found for the selected invoices");

  return { payment: createdPayments[0], payments: createdPayments, invoices: updatedInvoices };
};

/**
 * Edit a payment (amount, date, mode, TDS, or move it to another invoice).
 * Fields left out keep their current values. Both invoices' balances are
 * recalculated and the ledger entry is reversed and re-posted.
 * Returns { payment, previous, invoice }.
 */
const updatePayment = async (db, paymentId, body, scope) => {
  const hasPaymentCodeColumn = await hasColumn(db, "payments", "payment_code");
  const existingResult = await db.query("SELECT * FROM payments WHERE id = $1 LIMIT 1", [paymentId]);
  if (!existingResult.rows.length) fail(404, "Payment not found");
  const existingPayment = existingResult.rows[0];
  const { payment_code, invoice_id, payment_date, amount_received, payment_mode, reference_number, tds_applicable, tds_percent, notes } = body;
  const targetInvoiceId = Number(invoice_id || existingPayment.invoice_id);
  const finalPaymentDate = payment_date !== undefined ? sanitizeDateInput(payment_date) : sanitizeDateInput(existingPayment.payment_date);
  const finalAmount = amount_received !== undefined ? normalizeMoney(amount_received) : normalizeMoney(existingPayment.amount_received);
  if (!targetInvoiceId || !finalPaymentDate) fail(400, "Invoice and payment date are required");
  if (finalAmount <= 0) fail(400, "Amount received must be greater than zero");

  const targetInvoice = await getInvoiceWithContext(db, targetInvoiceId);
  if (!targetInvoice) fail(404, "Invoice not found");
  if (!scope.canAct(targetInvoice.region_id)) fail(403, "Not authorized for this invoice's entity");
  if (String(targetInvoice.invoice_status || "").toUpperCase() === "CANCELLED") fail(400, "Cannot attach payment to a cancelled invoice");
  const targetCurrency = normalizeCurrencyCode(targetInvoice.currency, "USD");
  checkCurrency(targetCurrency);

  const tds = withholding.resolveTds({
    regionApplies: targetInvoice.region_tds_applicable === true,
    selected: tds_applicable !== undefined ? normalizeBoolean(tds_applicable) : normalizeBoolean(existingPayment.tds_applicable),
    percent: tds_percent !== undefined ? tds_percent : existingPayment.tds_percent,
  });
  if (tds.applicable && tds.percent <= 0) fail(400, "TDS percentage is required when TDS is applicable");
  const finalTdsAmount = withholding.calculateTdsAmount(targetInvoice, tds.applicable, tds.percent);

  const allPaymentsResult = await db.query(`
    SELECT COALESCE(SUM(amount_received + COALESCE(tds_amount, 0)), 0) AS total_received
    FROM payments WHERE invoice_id = $1 AND id <> $2
  `, [targetInvoiceId, paymentId]);
  const otherPaymentsTotal = normalizeMoney(allPaymentsResult.rows[0]?.total_received || 0);
  const invoiceTotal = normalizeMoney(targetInvoice.total_amount);
  const allowedMax = Math.max(invoiceTotal - otherPaymentsTotal - finalTdsAmount, 0);
  if (finalAmount > allowedMax) fail(400, `Amount cannot exceed remaining allowable balance of ${allowedMax.toFixed(2)}`);

  let finalPaymentCode = hasPaymentCodeColumn ? existingPayment.payment_code : null;
  if (hasPaymentCodeColumn) {
    if (payment_code && String(payment_code).trim()) {
      finalPaymentCode = String(payment_code).trim().toUpperCase();
      const duplicate = await db.query("SELECT id FROM payments WHERE payment_code = $1 AND id <> $2 LIMIT 1", [finalPaymentCode, paymentId]);
      if (duplicate.rows.length) fail(400, "Payment code already exists");
    } else if (!existingPayment.payment_code) finalPaymentCode = await generatePaymentCode(db);
  }
  const normalizedPaymentMode = payment_mode !== undefined ? normalizeUpperNullable(payment_mode) : normalizeUpperNullable(existingPayment.payment_mode);
  checkPaymentMode(normalizedPaymentMode);
  const updatedReferenceNumber = reference_number !== undefined ? normalizeNullable(String(reference_number).trim().toUpperCase()) : existingPayment.reference_number;

  const updateFields = [
    { column: "invoice_id", value: targetInvoiceId }, { column: "payment_date", value: finalPaymentDate },
    { column: "currency", value: targetCurrency }, { column: "amount_received", value: finalAmount },
    { column: "payment_mode", value: normalizedPaymentMode }, { column: "reference_number", value: updatedReferenceNumber },
    { column: "tds_applicable", value: tds.applicable }, { column: "tds_percent", value: tds.percent || null },
    { column: "tds_amount", value: finalTdsAmount }, { column: "notes", value: notes !== undefined ? normalizeNullable(notes) : existingPayment.notes },
  ];
  if (hasPaymentCodeColumn) updateFields.splice(1, 0, { column: "payment_code", value: finalPaymentCode });
  const setClause = updateFields.map((field, index) => `${field.column} = $${index + 1}`).join(", ");
  const values = updateFields.map((field) => field.value);
  values.push(paymentId);
  const updateResult = await db.query(`UPDATE payments SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = $${values.length} RETURNING *`, values);
  if (Number(existingPayment.invoice_id) !== targetInvoiceId) await recalculateInvoiceTotals(db, existingPayment.invoice_id);
  const updatedInvoice = await recalculateInvoiceTotals(db, targetInvoiceId);

  await reversePosted(db, paymentId, "Payment edited", scope.userId);
  const inv = await getInvoiceWithContext(db, targetInvoiceId);
  if (inv) await postPayment(db, inv, updateResult.rows[0], scope.userId);

  return { payment: updateResult.rows[0], previous: existingPayment, invoice: updatedInvoice };
};

/** Delete a payment, reverse its ledger entry and recalculate its invoice. Returns { previous, invoice }. */
const deletePayment = async (db, paymentId, scope) => {
  const existingResult = await db.query(`
    SELECT p.*, i.region_id FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.id = $1 LIMIT 1
  `, [paymentId]);
  const existingPayment = existingResult.rows[0];
  if (!existingPayment || !scope.canAct(existingPayment.region_id)) fail(404, "Payment not found");
  await reversePosted(db, paymentId, "Payment deleted", scope.userId);
  await db.query("DELETE FROM payments WHERE id = $1", [paymentId]);
  const updatedInvoice = await recalculateInvoiceTotals(db, existingPayment.invoice_id);
  return { previous: existingPayment, invoice: updatedInvoice };
};

/**
 * The payment an invoice status change creates (mode AUTO). It is not posted
 * to the ledger — see the step 0.5 notes. Dated paymentDate, or today.
 */
const recordStatusPayment = async (
  db,
  { invoiceId, amountReceived, status, userId, tdsApplicable, tdsPercent, tdsAmount, paymentDate },
) => {
  const paymentCodeColumnExists = await hasColumn(db, "payments", "payment_code");
  const tdsApplicableColumnExists = await hasColumn(db, "payments", "tds_applicable");
  const tdsPercentColumnExists = await hasColumn(db, "payments", "tds_percent");
  const tdsAmountColumnExists = await hasColumn(db, "payments", "tds_amount");
  const generatedCode = paymentCodeColumnExists ? await generatePaymentCode(db) : null;
  const generatedReference = await generatePaymentReference(db);

  const columns = [];
  const placeholders = [];
  const values = [];
  const addValue = (column, value) => {
    columns.push(column);
    values.push(value);
    placeholders.push(`$${values.length}`);
  };

  if (paymentCodeColumnExists) addValue("payment_code", generatedCode);
  addValue("invoice_id", Number(invoiceId));
  if (paymentDate) {
    addValue("payment_date", paymentDate);
  } else {
    columns.push("payment_date");
    placeholders.push("CURRENT_DATE");
  }
  addValue("amount_received", amountReceived);
  addValue("payment_mode", "AUTO");
  addValue("reference_number", generatedReference);
  addValue("notes", `Auto-created from invoice status change to ${status}`);
  if (tdsApplicableColumnExists) addValue("tds_applicable", tdsApplicable === true || tdsApplicable === 1);
  if (tdsPercentColumnExists) addValue("tds_percent", tdsPercent || null);
  if (tdsAmountColumnExists) addValue("tds_amount", tdsAmount || 0);
  addValue("created_by", userId || null);

  await db.query(
    `INSERT INTO payments (${columns.join(", ")})
     VALUES (${placeholders.join(", ")})`,
    values,
  );
};

module.exports = {
  ALLOWED_PAYMENT_MODES,
  recalculateInvoiceTotals,
  createPayment,
  updatePayment,
  deletePayment,
  recordStatusPayment,
};

const pool = require("../config/db");
const { auditLog } = require("../middleware/auditMiddleware");
const { generateInvoicePdf } = require("../utils/invoicePdfGenerator");
const {
  generateInvoiceNumber,
  generateIntercompanyInvoiceNumber,
  generatePaymentCode,
  generatePaymentReference,
  hasColumn,
} = require("../utils/codeGenerator");
const glPosting = require("../services/gl/postingService");
const { canActOnEntity } = require("../middleware/scopeMiddleware");
const { sendReport } = require("../services/reports/reportExport");
const { convertToUsd } = require("../utils/fx");
const { groupCurrency, attachReportingFields, makeMultiConverter } = require("../utils/reportingCurrency");
const currencyService = require("../services/currency/currencyService");

// Mirrors the InvoicesPage "Status" column (OVERDUE/DUE derived from due date).
const invoiceDisplayStatus = (row) => {
  const status = String(row?.invoice_status || "").toUpperCase();
  const isClosed = ["PAID", "CANCELLED"].includes(status);
  const outstanding = Number(row?.balance_outstanding || 0) > 0;
  if (!isClosed && outstanding && row?.due_date) {
    const due = new Date(row.due_date); due.setHours(0, 0, 0, 0);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (due < today) return "OVERDUE";
    if (due.getTime() === today.getTime()) return "DUE";
  }
  return status || "DRAFT";
};

// Invoice statuses that represent a real receivable worth posting to the GL.
const GL_POSTABLE_INVOICE_STATUSES = [
  "GENERATED",
  "SENT",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
];

const ALLOWED_INVOICE_STATUSES = [
  "DRAFT",
  "GENERATED",
  "SENT",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
  "CANCELLED",
];

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

const INVOICE_TEMPLATE_OPTIONS = new Set(["CLASSIC", "EXECUTIVE", "MINIMAL"]);
const COUNTRY_TO_CURRENCY = {
  US: "USD",
  GB: "GBP",
  IN: "INR",
};

const normalizeMoney = (value) => {
  const num = Number(value || 0);
  return Number.isNaN(num) ? 0 : num;
};

const normalizeBoolean = (value) => {
  if (value === true || value === 1) return true;
  const normalized = String(value || "").trim().toLowerCase();
  return ["true", "1", "yes", "y"].includes(normalized);
};

const calculateTdsAmount = (invoice, tdsApplicable, tdsPercent) => {
  if (!tdsApplicable) return 0;
  const percent = normalizeMoney(tdsPercent);
  if (percent <= 0) return 0;
  return Number(((normalizeMoney(invoice.subtotal) * percent) / 100).toFixed(2));
};

const toNullable = (value) => {
  if (value === undefined || value === null || value === "") return null;
  return value;
};

const sanitizeDateInput = (value) => {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  const lowered = raw.toLowerCase();
  const placeholders = new Set([
    "—",
    "-",
    "n/a",
    "na",
    "dd/mm/yyyy",
    "mm/dd/yyyy",
    "yyyy-mm-dd",
  ]);
  if (placeholders.has(lowered)) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const localDateMatch = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (localDateMatch) {
    const [, day, month, year] = localDateMatch;
    const normalized = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    const parsedLocal = new Date(`${normalized}T00:00:00Z`);
    if (
      !Number.isNaN(parsedLocal.getTime()) &&
      parsedLocal.toISOString().slice(0, 10) === normalized
    ) {
      return normalized;
    }
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
};

const normalizeInvoiceStatus = (status, fallback = "GENERATED") => {
  const value = String(status || "").toUpperCase();
  return ALLOWED_INVOICE_STATUSES.includes(value) ? value : fallback;
};

const normalizeCurrencyCode = (value, fallback = "USD") => {
  const code = String(value || "").trim().toUpperCase();
  return code || fallback;
};

const resolvePlacementCurrency = (placement, fallback = "USD") =>
  normalizeCurrencyCode(
    placement?.client_currency ||
      placement?.currency ||
      placement?.region_currency ||
      COUNTRY_TO_CURRENCY[String(placement?.region_country_code || "").toUpperCase()] ||
      fallback,
    fallback,
  );

const extractNetDays = (terms) => {
  if (!terms) return 30;
  const value = String(terms).trim().toUpperCase();
  if (value === "DUE_ON_RECEIPT") return 0;
  const match = value.match(/(\d{1,3})/);
  return match ? Number(match[1]) : 30;
};

const calculateDueDateFromTerms = (invoiceDate, terms) => {
  const base = invoiceDate ? new Date(invoiceDate) : new Date();
  if (Number.isNaN(base.getTime())) return null;

  const days = extractNetDays(terms);
  const result = new Date(base);
  result.setDate(result.getDate() + days);
  return result.toISOString().slice(0, 10);
};

const serializeDateOnly = (value) => {
  if (!value) return value;
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  return value;
};

const serializeInvoiceDates = (invoice = {}) => ({
  ...invoice,
  invoice_date: serializeDateOnly(invoice.invoice_date),
  due_date: serializeDateOnly(invoice.due_date),
  billing_period_start: serializeDateOnly(invoice.billing_period_start),
  billing_period_end: serializeDateOnly(invoice.billing_period_end),
});

const calculateInvoiceStatusFromAmounts = ({
  totalAmount,
  totalReceived,
  dueDate,
  currentStatus,
}) => {
  const total = normalizeMoney(totalAmount);
  const received = normalizeMoney(totalReceived);
  const today = new Date();
  const due = dueDate ? new Date(dueDate) : null;

  if (String(currentStatus || "").toUpperCase() === "CANCELLED") {
    return "CANCELLED";
  }

  if (received >= total && total > 0) return "PAID";
  if (received > 0 && received < total) return "PARTIALLY_PAID";
  if (due && due < today && total > 0) return "OVERDUE";

  return "GENERATED";
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

const resolveInvoiceTerms = ({ placement, client, region, providedTerms }) => {
  if (providedTerms && String(providedTerms).trim()) {
    return String(providedTerms).trim();
  }

  if (
    placement?.payment_terms === "CUSTOM" &&
    placement?.custom_payment_terms_days
  ) {
    return `Net ${placement.custom_payment_terms_days}`;
  }

  if (placement?.payment_terms) {
    return String(placement.payment_terms).replace("NET_", "Net ");
  }

  if (client?.default_payment_terms) return client.default_payment_terms;
  if (region?.invoice_terms_label) return region.invoice_terms_label;

  return "Net 30";
};

const buildLineDescription = (item) => {
  if (item.description && String(item.description).trim()) {
    return String(item.description).trim();
  }

  const parts = [];

  if (item.activity_label) parts.push(String(item.activity_label).trim());
  if (item.candidate_name) {
    parts.push(`for ${String(item.candidate_name).trim()}`);
  }
  if (item.job_title) parts.push(`(${String(item.job_title).trim()})`);
  if (item.line_date) parts.push(`dated ${String(item.line_date).trim()}`);

  const combined = parts.join(" ").trim();
  return combined || "Invoice line item";
};

const sanitizeTaxLines = (taxLines = []) => {
  if (!Array.isArray(taxLines)) return [];

  return taxLines
    .filter(
      (line) =>
        String(line?.tax_name || "").trim() ||
        normalizeMoney(line?.tax_percent) > 0 ||
        normalizeMoney(line?.tax_amount) > 0,
    )
    .map((line, index) => ({
      id: index + 1,
      tax_name: String(line.tax_name || "Tax").trim(),
      tax_percent: normalizeMoney(line.tax_percent),
      tax_amount: normalizeMoney(line.tax_amount),
      sort_order: index + 1,
    }));
};

const normalizeInvoiceTemplate = (value, fallback = "CLASSIC") => {
  const normalized = String(value || fallback).trim().toUpperCase();
  if (INVOICE_TEMPLATE_OPTIONS.has(normalized)) return normalized;
  const safeFallback = String(fallback || "CLASSIC").trim().toUpperCase();
  return INVOICE_TEMPLATE_OPTIONS.has(safeFallback) ? safeFallback : "CLASSIC";
};

const computeInvoiceAmounts = ({ lineItems = [], taxLines = [] }) => {
  const subtotal = lineItems.reduce((sum, item) => {
    const qty = normalizeMoney(item.quantity);
    const rate = normalizeMoney(item.rate || item.unit_price);
    return sum + qty * rate;
  }, 0);

  const computedTaxLines = sanitizeTaxLines(
    (Array.isArray(taxLines) ? taxLines : []).map((tax) => ({
      ...tax,
      tax_amount: (subtotal * normalizeMoney(tax.tax_percent)) / 100,
    })),
  );

  const taxAmount = computedTaxLines.reduce(
    (sum, line) => sum + normalizeMoney(line.tax_amount),
    0,
  );

  return {
    subtotal,
    taxAmount,
    totalAmount: subtotal + taxAmount,
    computedTaxLines,
  };
};

// Memoized per process: the column set is fixed once migrations are applied
// (000_base + deltas), so we no longer run ALTER/detection on every request.
let _invoiceColumnsCache = null;
const hasInvoiceColumns = async (db) => {
  if (_invoiceColumnsCache) return _invoiceColumnsCache;
  try {
    await db.query(`
      ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS invoice_template varchar(30) DEFAULT 'CLASSIC'
    `);
    await db.query(`
      ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS invoice_template_id bigint
    `);
    await db.query(`
      ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS invoice_template_name varchar(140)
    `);
    await db.query(`
      ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS invoice_template_snapshot_json jsonb DEFAULT '{}'::jsonb
    `);
    await db.query(`
      ALTER TABLE invoices
      ADD COLUMN IF NOT EXISTS template_custom_fields_json jsonb DEFAULT '[]'::jsonb
    `);
  } catch (err) {
    console.error("ensure invoice_template column warning:", err.message);
  }

  const result = await db.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'invoices'
      AND column_name IN (
        'invoice_terms_label',
        'customer_message',
        'internal_notes',
        'tax_lines_json',
        'invoice_template',
        'invoice_template_id',
        'invoice_template_name',
        'invoice_template_snapshot_json',
        'template_custom_fields_json',
        'exchange_rate',
        'amount_base',
        'invoice_type',
        'bill_to_region_id'
      )
  `);

  const columns = new Set(result.rows.map((row) => row.column_name));

  _invoiceColumnsCache = {
    invoice_terms_label: columns.has("invoice_terms_label"),
    customer_message: columns.has("customer_message"),
    internal_notes: columns.has("internal_notes"),
    tax_lines_json: columns.has("tax_lines_json"),
    invoice_template: columns.has("invoice_template"),
    invoice_template_id: columns.has("invoice_template_id"),
    invoice_template_name: columns.has("invoice_template_name"),
    invoice_template_snapshot_json: columns.has(
      "invoice_template_snapshot_json",
    ),
    template_custom_fields_json: columns.has("template_custom_fields_json"),
    exchange_rate: columns.has("exchange_rate"),
    amount_base: columns.has("amount_base"),
    invoice_type: columns.has("invoice_type"),
    bill_to_region_id: columns.has("bill_to_region_id"),
  };
  return _invoiceColumnsCache;
};

let _regionBrandingColumnsCache = null;
const hasRegionInvoiceBrandingColumns = async (db) => {
  if (_regionBrandingColumnsCache) return _regionBrandingColumnsCache;
  const result = await db.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'regions'
      AND column_name IN (
        'invoice_template',
        'invoice_brand_primary_color',
        'invoice_brand_accent_color',
        'invoice_brand_footer_note',
        'tds_applicable'
      )
  `);

  const columns = new Set(result.rows.map((row) => row.column_name));

  _regionBrandingColumnsCache = {
    invoice_template: columns.has("invoice_template"),
    invoice_brand_primary_color: columns.has("invoice_brand_primary_color"),
    invoice_brand_accent_color: columns.has("invoice_brand_accent_color"),
    invoice_brand_footer_note: columns.has("invoice_brand_footer_note"),
    tds_applicable: columns.has("tds_applicable"),
  };
  return _regionBrandingColumnsCache;
};

const getRegionBrandingSelects = (regionColumns, alias = "r") => [
  regionColumns.invoice_template
    ? `${alias}.invoice_template AS region_invoice_template`
    : "NULL::text AS region_invoice_template",
  regionColumns.invoice_brand_primary_color
    ? `${alias}.invoice_brand_primary_color`
    : "NULL::text AS invoice_brand_primary_color",
  regionColumns.invoice_brand_accent_color
    ? `${alias}.invoice_brand_accent_color`
    : "NULL::text AS invoice_brand_accent_color",
  regionColumns.invoice_brand_footer_note
    ? `${alias}.invoice_brand_footer_note`
    : "NULL::text AS invoice_brand_footer_note",
  // Falls back to TRUE pre-migration: asking about TDS when it doesn't apply is
  // a harmless extra question, whereas defaulting to FALSE would silently stop
  // capturing TDS for the Indian entities that need it.
  regionColumns.tds_applicable
    ? `${alias}.tds_applicable AS region_tds_applicable`
    : "TRUE::boolean AS region_tds_applicable",
];

// Whether a region withholds TDS. Pre-migration the column is absent, so fall
// back to TRUE — the same reasoning as getRegionBrandingSelects.
const getRegionTdsApplicable = async (db, regionId) => {
  const regionColumns = await hasRegionInvoiceBrandingColumns(db);
  if (!regionColumns.tds_applicable) return true;
  if (!regionId) return false;

  const result = await db.query(
    `SELECT tds_applicable FROM regions WHERE id = $1 LIMIT 1`,
    [regionId],
  );
  return result.rows[0]?.tds_applicable === true;
};

let _invoiceItemColumnsCache = null;
const hasInvoiceItemColumns = async (db) => {
  if (_invoiceItemColumnsCache) return _invoiceItemColumnsCache;
  const result = await db.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'invoice_items'
      AND column_name IN (
        'placement_id',
        'candidate_id',
        'candidate_name',
        'job_title',
        'activity_label',
        'line_date'
      )
  `);

  const columns = new Set(result.rows.map((row) => row.column_name));

  _invoiceItemColumnsCache = {
    placement_id: columns.has("placement_id"),
    candidate_id: columns.has("candidate_id"),
    candidate_name: columns.has("candidate_name"),
    job_title: columns.has("job_title"),
    activity_label: columns.has("activity_label"),
    line_date: columns.has("line_date"),
  };
  return _invoiceItemColumnsCache;
};

const getOptionalInvoiceSelects = (invoiceColumns) => [
  invoiceColumns.invoice_terms_label
    ? "i.invoice_terms_label"
    : "NULL::text AS invoice_terms_label",
  invoiceColumns.customer_message
    ? "i.customer_message"
    : "NULL::text AS customer_message",
  invoiceColumns.internal_notes
    ? "i.internal_notes"
    : "i.notes AS internal_notes",
  invoiceColumns.tax_lines_json
    ? "COALESCE(i.tax_lines_json, '[]'::jsonb) AS tax_lines_json"
    : "'[]'::jsonb AS tax_lines_json",
  invoiceColumns.invoice_template
    ? "i.invoice_template"
    : "NULL::text AS invoice_template",
  invoiceColumns.invoice_template_id
    ? "i.invoice_template_id"
    : "NULL::bigint AS invoice_template_id",
  invoiceColumns.invoice_template_name
    ? "i.invoice_template_name"
    : "NULL::text AS invoice_template_name",
  invoiceColumns.invoice_template_snapshot_json
    ? "COALESCE(i.invoice_template_snapshot_json, '{}'::jsonb) AS invoice_template_snapshot_json"
    : "'{}'::jsonb AS invoice_template_snapshot_json",
  invoiceColumns.template_custom_fields_json
    ? "COALESCE(i.template_custom_fields_json, '[]'::jsonb) AS template_custom_fields_json"
    : "'[]'::jsonb AS template_custom_fields_json",
];

const getOptionalInvoiceItemSelects = (itemColumns) => [
  itemColumns.placement_id ? "ii.placement_id" : "NULL::bigint AS placement_id",
  itemColumns.candidate_id ? "ii.candidate_id" : "NULL::bigint AS candidate_id",
  itemColumns.candidate_name
    ? "ii.candidate_name"
    : "NULL::varchar(150) AS candidate_name",
  itemColumns.job_title ? "ii.job_title" : "NULL::varchar(150) AS job_title",
  itemColumns.activity_label
    ? "ii.activity_label"
    : "NULL::varchar(150) AS activity_label",
  itemColumns.line_date ? "ii.line_date" : "NULL::date AS line_date",
];

const insertInvoiceItems = async (db, invoiceId, lineItems = []) => {
  const itemColumns = await hasInvoiceItemColumns(db);

  for (const item of lineItems) {
    const quantity = normalizeMoney(item.quantity);
    const unitPrice = normalizeMoney(item.rate || item.unit_price);
    const lineTotal = quantity * unitPrice;
    const description = buildLineDescription(item);

    const columns = [
      "invoice_id",
      "description",
      "quantity",
      "unit_price",
      "line_total",
    ];
    const values = [invoiceId, description, quantity, unitPrice, lineTotal];

    if (itemColumns.placement_id) {
      columns.push("placement_id");
      values.push(toNullable(item.placement_id));
    }
    if (itemColumns.candidate_id) {
      columns.push("candidate_id");
      values.push(toNullable(item.candidate_id));
    }
    if (itemColumns.candidate_name) {
      columns.push("candidate_name");
      values.push(toNullable(item.candidate_name));
    }
    if (itemColumns.job_title) {
      columns.push("job_title");
      values.push(toNullable(item.job_title));
    }
    if (itemColumns.activity_label) {
      columns.push("activity_label");
      values.push(toNullable(item.activity_label));
    }
    if (itemColumns.line_date) {
      columns.push("line_date");
      values.push(toNullable(item.line_date));
    }

    const placeholders = columns.map((_, index) => `$${index + 1}`);

    await db.query(
      `
      INSERT INTO invoice_items (${columns.join(", ")})
      VALUES (${placeholders.join(", ")})
      `,
      values,
    );
  }
};

const getInvoiceItems = async (db, invoiceId) => {
  const itemColumns = await hasInvoiceItemColumns(db);
  const joins = itemColumns.placement_id
    ? `
      LEFT JOIN placements p ON p.id = ii.placement_id
      LEFT JOIN candidates c ON c.id = p.candidate_id
    `
    : "";

  const result = await db.query(
    `
    SELECT
      ii.id,
      ii.invoice_id,
      ii.description,
      ii.quantity,
      ii.unit_price AS rate,
      ii.line_total AS amount,
      ${getOptionalInvoiceItemSelects(itemColumns).join(",\n      ")},
      ${itemColumns.placement_id ? "p.placement_code" : "NULL::text AS placement_code"},
      ${itemColumns.placement_id ? "c.full_name AS fallback_candidate_name" : "NULL::text AS fallback_candidate_name"},
      ${itemColumns.placement_id ? "p.job_title AS fallback_job_title" : "NULL::text AS fallback_job_title"},
      ii.created_at
    FROM invoice_items ii
    ${joins}
    WHERE ii.invoice_id = $1
    ORDER BY ii.id ASC
    `,
    [invoiceId],
  );

  return result.rows.map((row) => ({
    ...row,
    candidate_name: row.candidate_name || row.fallback_candidate_name || null,
    job_title: row.job_title || row.fallback_job_title || null,
  }));
};

const getInvoiceTaxLines = async (invoiceRow) => {
  return sanitizeTaxLines(invoiceRow?.tax_lines_json || []);
};

const sanitizeInvoiceRecord = (invoice = {}) =>
  serializeInvoiceDates(
    Object.fromEntries(
      Object.entries(invoice).filter(([key]) => !key.startsWith("quick")),
    ),
  );

const mapInvoiceResponse = async (db, invoiceRow) => {
  const lineItems = await getInvoiceItems(db, invoiceRow.id);
  const taxLines = await getInvoiceTaxLines(invoiceRow);

  return {
    ...sanitizeInvoiceRecord(invoiceRow),
    line_items: lineItems,
    tax_lines: taxLines,
  };
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

const getAllInvoices = async (req, res) => {
  try {
    const invoiceColumns = await hasInvoiceColumns(pool);
    const regionColumns = await hasRegionInvoiceBrandingColumns(pool);

    // Row-level RBAC: restrict to the caller's allowed entities (regions).
    const scopeParams = [];
    const conditions = [];
    if (req.scopeEnforced && Array.isArray(req.allowedEntityIds)) {
      scopeParams.push(req.allowedEntityIds);
      conditions.push(`i.region_id = ANY($${scopeParams.length})`);
    }

    // Date range, applied in SQL so the window spans every invoice rather than
    // just the rows this page happened to return. Ignored unless well-formed.
    const isDateKey = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
    const fromDate = String(req.query.from || req.query.start_date || "").trim();
    const toDate = String(req.query.to || req.query.end_date || "").trim();

    if (isDateKey(fromDate)) {
      scopeParams.push(fromDate);
      conditions.push(`i.due_date >= $${scopeParams.length}`);
    }
    if (isDateKey(toDate)) {
      scopeParams.push(toDate);
      conditions.push(`i.due_date <= $${scopeParams.length}`);
    }

    const scopeWhere = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    // Derived display status — mirrors the frontend's getInvoiceDisplayStatus so
    // status filtering means the SAME thing in the list, its count, and the tab
    // counts: an open, dated invoice reads OVERDUE (past due) or DUE (due within
    // 15 days); otherwise it keeps its stored status (DRAFT when blank).
    const DISPLAY_STATUS_SQL = `
      CASE
        WHEN i.balance_outstanding > 0
         AND UPPER(COALESCE(i.invoice_status, '')) NOT IN ('PAID', 'CANCELLED')
         AND i.due_date IS NOT NULL THEN
           CASE
             WHEN (i.due_date::date - CURRENT_DATE) < 0 THEN 'OVERDUE'
             WHEN (i.due_date::date - CURRENT_DATE) <= 15 THEN 'DUE'
             ELSE COALESCE(NULLIF(UPPER(i.invoice_status), ''), 'DRAFT')
           END
        ELSE COALESCE(NULLIF(UPPER(i.invoice_status), ''), 'DRAFT')
      END`;
    const OUTSTANDING_SQL =
      "(i.balance_outstanding > 0 AND UPPER(COALESCE(i.invoice_status, '')) NOT IN ('PAID', 'CANCELLED'))";
    const OVERDUE_SQL = `${OUTSTANDING_SQL.slice(0, -1)} AND i.due_date IS NOT NULL AND i.due_date::date < CURRENT_DATE)`;
    // Joins the list/count/tab-count queries need for the search predicate
    // (client / candidate / region names) and the derived status.
    const LIST_JOINS = `
      LEFT JOIN placements p ON i.placement_id = p.id
      LEFT JOIN candidates c ON p.candidate_id = c.id
      LEFT JOIN clients cl ON i.client_id = cl.id
      LEFT JOIN regions r ON i.region_id = r.id`;

    // Filters layer over the whole-book scope (RBAC + date), which the KPI
    // `totals` keep using untouched:
    //  · tab-count scope  = + region + client + search  (mirrors the toolbar
    //    EXCEPT the status/scope the tabs themselves toggle);
    //  · list/count scope = tab scope + status + scope.
    // Region stays OUT of `totals` so `by_region` always covers every region.
    const tabParams = [...scopeParams];
    const tabConditions = [...conditions];

    const regionId = parseInt(req.query.region_id, 10);
    if (Number.isInteger(regionId) && regionId > 0) {
      tabParams.push(regionId);
      tabConditions.push(`i.region_id = $${tabParams.length}`);
    }
    const currency = String(req.query.currency || "").trim().toUpperCase();
    if (currency) {
      tabParams.push(currency);
      tabConditions.push(`UPPER(i.currency) = $${tabParams.length}`);
    }
    const clientId = parseInt(req.query.client_id, 10);
    if (Number.isInteger(clientId) && clientId > 0) {
      tabParams.push(clientId);
      tabConditions.push(`i.client_id = $${tabParams.length}`);
    }
    const searchTerm = String(req.query.search || "").trim();
    if (searchTerm) {
      tabParams.push(`%${searchTerm}%`);
      const p = `$${tabParams.length}`;
      tabConditions.push(
        `(i.invoice_number ILIKE ${p} OR cl.client_name ILIKE ${p} OR c.full_name ILIKE ${p} OR r.region_name ILIKE ${p})`,
      );
    }
    const tabWhere = tabConditions.length
      ? `WHERE ${tabConditions.join(" AND ")}`
      : "";

    const listParams = [...tabParams];
    const listConditions = [...tabConditions];
    const STATUS_FILTER_VALUES = ["DUE", "DRAFT", "GENERATED", "SENT", "PARTIALLY_PAID", "PAID", "OVERDUE", "CANCELLED"];
    const statusFilter = String(req.query.status || "").toUpperCase();
    if (STATUS_FILTER_VALUES.includes(statusFilter)) {
      listParams.push(statusFilter);
      listConditions.push(`(${DISPLAY_STATUS_SQL}) = $${listParams.length}`);
    }
    const scopeFilter = String(req.query.scope || "").toLowerCase();
    if (scopeFilter === "outstanding") {
      listConditions.push(OUTSTANDING_SQL);
    } else if (scopeFilter === "overdue") {
      listConditions.push(OVERDUE_SQL);
    } else if (scopeFilter === "collected") {
      listConditions.push("i.payment_received_amount > 0");
    } else if (scopeFilter === "sent") {
      // "Sent" tab: issued to the client but not yet paid/overdue — matches the
      // tab_counts.sent badge (display IN SENT, GENERATED).
      listConditions.push(`(${DISPLAY_STATUS_SQL}) IN ('SENT', 'GENERATED')`);
    }
    const listWhere = listConditions.length
      ? `WHERE ${listConditions.join(" AND ")}`
      : "";

    // Pagination.
    const pageNum = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limitNum = Math.min(
      2000,
      Math.max(1, parseInt(req.query.limit, 10) || 100),
    );
    const offset = (pageNum - 1) * limitNum;

    const countResult = await pool.query(
      `SELECT COUNT(DISTINCT i.id)::int AS total FROM invoices i ${LIST_JOINS} ${listWhere}`,
      listParams,
    );
    const total = countResult.rows[0]?.total ?? 0;

    // Segmented-tab counts (All / Sent / Overdue / Paid) over the tab scope
    // (search + client + region + date, but NOT the status/scope the tabs
    // toggle), so every tab shows its true count regardless of which is active.
    const tabCountResult = await pool.query(
      `SELECT
         COUNT(*)::int AS all,
         COUNT(*) FILTER (WHERE display IN ('SENT', 'GENERATED'))::int AS sent,
         COUNT(*) FILTER (WHERE display = 'OVERDUE')::int AS overdue,
         COUNT(*) FILTER (WHERE display = 'PAID')::int AS paid
       FROM (
         SELECT (${DISPLAY_STATUS_SQL}) AS display
         FROM invoices i ${LIST_JOINS} ${tabWhere}
       ) s`,
      tabParams,
    );
    const tabCounts = tabCountResult.rows[0] || { all: 0, sent: 0, overdue: 0, paid: 0 };

    const limitParamIndex = listParams.length + 1;
    const offsetParamIndex = listParams.length + 2;
    const queryParams = [...listParams, limitNum, offset];

    const result = await pool.query(
      `
      SELECT
        i.id,
        i.invoice_number,
        i.placement_id,
        p.placement_code,
        c.full_name AS candidate_name,
        i.client_id,
        cl.client_name,
        i.region_id,
        r.region_name,
        r.functional_currency,
        r.company_name,
        r.company_address,
        r.company_id_label,
        r.company_id_value,
        r.logo_url,
        r.bank_name,
        r.bank_account_name,
        r.bank_account_number,
        r.bank_routing_number,
        r.bank_swift_ifsc,
        r.bank_branch_details,
        ${getRegionBrandingSelects(regionColumns).join(",\n        ")},
        i.invoice_date,
        i.due_date,
        i.billing_period_start,
        i.billing_period_end,
        i.hours_or_units,
        i.bill_rate,
        i.subtotal,
        i.tax_amount,
        i.total_amount,
        i.currency,
        i.exchange_rate,
        i.amount_base,
        i.invoice_status,
        i.payment_received_amount,
        i.balance_outstanding,
        i.notes,
        ${getOptionalInvoiceSelects(invoiceColumns).join(",\n        ")},
        COALESCE(ii_counts.item_count, 0) AS particulars_count,
        i.created_at,
        i.updated_at
      FROM invoices i
      LEFT JOIN placements p ON i.placement_id = p.id
      LEFT JOIN candidates c ON p.candidate_id = c.id
      LEFT JOIN clients cl ON i.client_id = cl.id
      LEFT JOIN regions r ON i.region_id = r.id
      LEFT JOIN (
        SELECT invoice_id, COUNT(*)::int AS item_count
        FROM invoice_items
        GROUP BY invoice_id
      ) ii_counts ON ii_counts.invoice_id = i.id
      ${listWhere}
      ORDER BY i.id DESC
      LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}
      `,
      queryParams,
    );

    // Consolidate mixed-currency figures into the company group currency so the
    // InvoicesPage/Dashboard KPIs can sum across regions without adding raw £+₹+$.
    const data = result.rows.map(sanitizeInvoiceRecord);
    const reportingCcy = await groupCurrency(pool);
    await attachReportingFields(
      data,
      {
        total_amount: "total_amount_reporting",
        payment_received_amount: "payment_received_amount_reporting",
        balance_outstanding: "balance_outstanding_reporting",
      },
      { db: pool, reportingCcy },
    );

    // Whole-dataset KPI totals — computed over the FULL filtered set (same RBAC +
    // date window, no LIMIT/OFFSET) so the InvoicesPage cards reflect every
    // invoice, not just this page. `all` is consolidated into the group currency
    // for the all-regions view; `by_region` carries each region's native
    // (billing-currency) figures plus its book-currency (`functional`) equivalents
    // for the single-region dual display. Book figures use the booked
    // amount_base/total ratio, matching the ledger's per-date valuation.
    const totalsResult = await pool.query(
      `SELECT
         i.region_id,
         i.currency AS native_currency,
         r.functional_currency,
         SUM(i.total_amount) AS invoiced,
         SUM(i.payment_received_amount) AS received,
         SUM(CASE WHEN i.invoice_status NOT IN ('PAID','CANCELLED') AND i.balance_outstanding > 0
                  THEN i.balance_outstanding ELSE 0 END) AS due,
         SUM(CASE WHEN i.invoice_status NOT IN ('PAID','CANCELLED') AND i.balance_outstanding > 0 AND i.due_date < CURRENT_DATE
                  THEN i.balance_outstanding ELSE 0 END) AS overdue,
         SUM(COALESCE(i.amount_base, i.total_amount)) AS invoiced_fn,
         SUM(i.payment_received_amount * CASE WHEN i.total_amount > 0
                  THEN COALESCE(i.amount_base, i.total_amount) / i.total_amount ELSE 1 END) AS received_fn,
         SUM(CASE WHEN i.invoice_status NOT IN ('PAID','CANCELLED') AND i.balance_outstanding > 0
                  THEN i.balance_outstanding * (CASE WHEN i.total_amount > 0
                       THEN COALESCE(i.amount_base, i.total_amount) / i.total_amount ELSE 1 END) ELSE 0 END) AS due_fn,
         SUM(CASE WHEN i.invoice_status NOT IN ('PAID','CANCELLED') AND i.balance_outstanding > 0 AND i.due_date < CURRENT_DATE
                  THEN i.balance_outstanding * (CASE WHEN i.total_amount > 0
                       THEN COALESCE(i.amount_base, i.total_amount) / i.total_amount ELSE 1 END) ELSE 0 END) AS overdue_fn,
         COUNT(*)::int AS count
       FROM invoices i
       LEFT JOIN regions r ON i.region_id = r.id
       ${scopeWhere}
       GROUP BY i.region_id, i.currency, r.functional_currency`,
      scopeParams,
    );

    const convert = await makeMultiConverter(pool);
    const MONEY = ["invoiced", "received", "due", "overdue"];
    const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
    const totals = {
      reporting_currency: reportingCcy,
      all: { invoiced: 0, received: 0, due: 0, overdue: 0, count: 0 },
      by_region: {},
    };
    for (const b of totalsResult.rows) {
      const rid = String(b.region_id);
      const native = String(b.native_currency || reportingCcy).toUpperCase();
      const fnCcy = String(b.functional_currency || native).toUpperCase();
      const cnt = Number(b.count) || 0;
      totals.all.count += cnt;
      if (!totals.by_region[rid]) {
        totals.by_region[rid] = {
          currency: native,
          functional_currency: fnCcy,
          invoiced: 0, received: 0, due: 0, overdue: 0, count: 0,
          functional: { invoiced: 0, received: 0, due: 0, overdue: 0 },
        };
      }
      const br = totals.by_region[rid];
      br.count += cnt;
      for (const m of MONEY) {
        const nativeVal = Number(b[m]) || 0;
        totals.all[m] += await convert(nativeVal, native, reportingCcy);
        br[m] += await convert(nativeVal, native, br.currency);
        br.functional[m] += await convert(Number(b[`${m}_fn`]) || 0, fnCcy, br.functional_currency);
      }
    }
    for (const m of MONEY) totals.all[m] = round2(totals.all[m]);
    for (const rid of Object.keys(totals.by_region)) {
      const br = totals.by_region[rid];
      for (const m of MONEY) {
        br[m] = round2(br[m]);
        br.functional[m] = round2(br.functional[m]);
      }
    }

    return res.status(200).json({
      success: true,
      message: "Invoices fetched successfully",
      data,
      total,
      page: pageNum,
      limit: limitNum,
      reporting_currency: reportingCcy,
      totals,
      tab_counts: tabCounts,
    });
  } catch (error) {
    console.error("getAllInvoices error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while fetching invoices",
      error: error.message,
    });
  }
};

const getInvoiceById = async (req, res) => {
  try {
    const { id } = req.params;
    const invoiceColumns = await hasInvoiceColumns(pool);
    const regionColumns = await hasRegionInvoiceBrandingColumns(pool);

    const invoiceResult = await pool.query(
      `
      SELECT
        i.*,
        p.placement_code,
        p.job_title,
        p.billing_type,
        p.invoice_cycle,
        p.payment_terms,
        p.custom_payment_terms_days,
        c.full_name AS candidate_name,
        cl.client_name,
        cl.primary_contact_name,
        cl.primary_contact_email,
        cl.billing_address,
        cl.tax_identifier,
        cl.default_payment_terms,
        r.region_name,
        r.company_name,
        r.company_address,
        r.company_id_label,
        r.company_id_value,
        r.logo_url,
        r.bank_name,
        r.bank_account_name,
        r.bank_account_number,
        r.bank_routing_number,
        r.bank_swift_ifsc,
        r.bank_branch_details,
        ${getRegionBrandingSelects(regionColumns).join(",\n        ")},
        ${getOptionalInvoiceSelects(invoiceColumns).join(",\n        ")}
      FROM invoices i
      LEFT JOIN placements p ON i.placement_id = p.id
      LEFT JOIN candidates c ON p.candidate_id = c.id
      LEFT JOIN clients cl ON i.client_id = cl.id
      LEFT JOIN regions r ON i.region_id = r.id
      WHERE i.id = $1
      LIMIT 1
      `,
      [id],
    );

    if (
      !invoiceResult.rows.length ||
      !canActOnEntity(req, invoiceResult.rows[0].region_id)
    ) {
      return res
        .status(404)
        .json({ success: false, message: "Invoice not found" });
    }

    const invoice = await mapInvoiceResponse(pool, invoiceResult.rows[0]);

    return res.status(200).json({
      success: true,
      message: "Invoice fetched successfully",
      data: invoice,
    });
  } catch (error) {
    console.error("getInvoiceById error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while fetching invoice",
      error: error.message,
    });
  }
};

const getInvoicePrintData = async (req, res) => {
  try {
    const { id } = req.params;
    const invoiceColumns = await hasInvoiceColumns(pool);
    const regionColumns = await hasRegionInvoiceBrandingColumns(pool);

    const invoiceResult = await pool.query(
      `
      SELECT
        i.*,
        p.placement_code,
        p.job_title,
        p.billing_type,
        p.invoice_cycle,
        p.payment_terms,
        p.custom_payment_terms_days,
        c.full_name AS candidate_name,
        cl.client_name,
        cl.primary_contact_name,
        cl.primary_contact_email,
        cl.billing_address,
        cl.tax_identifier,
        cl.default_payment_terms,
        r.region_name,
        r.company_name,
        r.company_address,
        r.company_id_label,
        r.company_id_value,
        r.logo_url,
        r.bank_name,
        r.bank_account_name,
        r.bank_account_number,
        r.bank_routing_number,
        r.bank_swift_ifsc,
        r.bank_branch_details,
        ${getRegionBrandingSelects(regionColumns).join(",\n        ")},
        ${getOptionalInvoiceSelects(invoiceColumns).join(",\n        ")}
      FROM invoices i
      LEFT JOIN placements p ON i.placement_id = p.id
      LEFT JOIN candidates c ON p.candidate_id = c.id
      LEFT JOIN clients cl ON i.client_id = cl.id
      LEFT JOIN regions r ON i.region_id = r.id
      WHERE i.id = $1
      LIMIT 1
      `,
      [id],
    );

    if (
      !invoiceResult.rows.length ||
      !canActOnEntity(req, invoiceResult.rows[0].region_id)
    ) {
      return res
        .status(404)
        .json({ success: false, message: "Invoice not found" });
    }

    const invoice = await mapInvoiceResponse(pool, invoiceResult.rows[0]);

    const paymentsResult = await pool.query(
      `
      SELECT
        id,
        invoice_id,
        payment_date,
        amount_received,
        payment_mode,
        reference_number,
        notes,
        created_at,
        updated_at
      FROM payments
      WHERE invoice_id = $1
      ORDER BY payment_date ASC, id ASC
      `,
      [id],
    );

    return res.status(200).json({
      success: true,
      message: "Invoice print data fetched successfully",
      data: {
        ...invoice,
        payments: paymentsResult.rows,
      },
    });
  } catch (error) {
    console.error("getInvoicePrintData error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while fetching invoice print data",
      error: error.message,
    });
  }
};

const downloadInvoicePdf = async (req, res) => {
  try {
    const { id } = req.params;
    const invoiceColumns = await hasInvoiceColumns(pool);
    const regionColumns = await hasRegionInvoiceBrandingColumns(pool);

    const invoiceResult = await pool.query(
      `
      SELECT
        i.*,
        p.placement_code,
        p.job_title,
        p.billing_type,
        p.invoice_cycle,
        p.payment_terms,
        p.custom_payment_terms_days,
        c.full_name AS candidate_name,
        cl.client_name,
        cl.primary_contact_name,
        cl.primary_contact_email,
        cl.billing_address,
        cl.tax_identifier,
        cl.default_payment_terms,
        r.region_name,
        r.company_name,
        r.company_address,
        r.company_id_label,
        r.company_id_value,
        r.logo_url,
        r.bank_name,
        r.bank_account_name,
        r.bank_account_number,
        r.bank_routing_number,
        r.bank_swift_ifsc,
        r.bank_branch_details,
        ${getRegionBrandingSelects(regionColumns).join(",\n        ")},
        ${getOptionalInvoiceSelects(invoiceColumns).join(",\n        ")}
      FROM invoices i
      LEFT JOIN placements p ON i.placement_id = p.id
      LEFT JOIN candidates c ON p.candidate_id = c.id
      LEFT JOIN clients cl ON i.client_id = cl.id
      LEFT JOIN regions r ON i.region_id = r.id
      WHERE i.id = $1
      LIMIT 1
      `,
      [id],
    );

    if (
      !invoiceResult.rows.length ||
      !canActOnEntity(req, invoiceResult.rows[0].region_id)
    ) {
      return res
        .status(404)
        .json({ success: false, message: "Invoice not found" });
    }

    const invoice = await mapInvoiceResponse(pool, invoiceResult.rows[0]);
    return await generateInvoicePdf(invoice, res);
  } catch (error) {
    console.error("downloadInvoicePdf error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while generating invoice PDF",
      error: error.message,
    });
  }
};

const getInvoicePlacementOptions = async (req, res) => {
  try {
    const regionColumns = await hasRegionInvoiceBrandingColumns(pool);
    const result = await pool.query(
      `
      SELECT
        p.id,
        p.placement_code,
        p.client_id,
        cl.client_name,
        cl.currency AS client_currency,
        cl.default_payment_terms,
        p.region_id,
        r.region_name,
        r.country_code AS region_country_code,
        r.default_currency AS region_currency,
        r.company_name,
        r.company_address,
        r.company_id_label,
        r.company_id_value,
        r.logo_url,
        r.invoice_terms_label,
        r.bank_name,
        r.bank_account_name,
        r.bank_account_number,
        r.bank_routing_number,
        r.bank_swift_ifsc,
        r.bank_branch_details,
        ${getRegionBrandingSelects(regionColumns).join(",\n        ")},
        p.currency,
        p.bill_rate,
        p.tax_percent,
        p.billing_type,
        p.expected_hours_per_month,
        p.monthly_billing_amount,
        p.one_time_fee_amount,
        p.invoice_cycle,
        p.payment_terms,
        p.custom_payment_terms_days,
        p.start_date,
        p.end_date,
        c.id AS candidate_id,
        c.full_name AS candidate_name,
        c.job_title
      FROM placements p
      JOIN clients cl ON p.client_id = cl.id
      JOIN regions r ON p.region_id = r.id
      JOIN candidates c ON p.candidate_id = c.id
      WHERE p.placement_status = 'ACTIVE'
      ORDER BY p.id DESC
      `,
    );

    return res.status(200).json({
      success: true,
      message: "Invoice placement options fetched successfully",
      data: result.rows,
    });
  } catch (error) {
    console.error("getInvoicePlacementOptions error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while fetching placement options",
      error: error.message,
    });
  }
};

const getNextInvoiceNumberPreview = async (req, res) => {
  try {
    // The two series never interleave (INV- vs IC-), so the preview must draw
    // from the same sequence the create path will use. `?type=INTER_COMPANY`
    // burns an IC number; anything else keeps the default client series.
    const isIntercompany =
      String(req.query.type || "").trim().toUpperCase() === "INTER_COMPANY";
    const invoiceNumber = isIntercompany
      ? await generateIntercompanyInvoiceNumber(pool)
      : await generateInvoiceNumber(pool);
    return res.status(200).json({
      success: true,
      message: "Invoice number preview fetched successfully",
      data: { invoice_number: invoiceNumber },
    });
  } catch (error) {
    console.error("getNextInvoiceNumberPreview error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while generating invoice number preview",
      error: error.message,
    });
  }
};

const INVOICE_TYPES = ["CLIENT", "INTER_COMPANY"];

// The CLIENT / INTER_COMPANY discriminator from migration 016. Absent or blank
// means CLIENT, so every existing payload and the timesheet path keep working
// unchanged. An unrecognised value is REJECTED rather than coerced: silently
// downgrading an INTER_COMPANY payload to CLIENT would write the wrong shape and
// then fail confusingly against invoices_type_shape_check.
const normalizeInvoiceType = (value) => {
  if (value == null || String(value).trim() === "") return "CLIENT";
  const normalized = String(value).trim().toUpperCase();
  if (!INVOICE_TYPES.includes(normalized)) {
    throw new Error(
      `Unknown invoice type: ${value}. Expected one of ${INVOICE_TYPES.join(", ")}`,
    );
  }
  return normalized;
};

/**
 * Inter-company line items: free-form, no placement, no candidate, no client.
 *
 * Everything the CLIENT path derives from the primary placement is instead taken
 * from the header — the issuing entity (region_id) and the counterparty
 * (bill_to_region_id), both rows in `regions`.
 */
const validateIntercompanyLineItems = async (db, lineItems = [], context = {}) => {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new Error("At least one invoice line item is required");
  }

  const regionId = Number(context.region_id || 0);
  const billToRegionId = Number(context.bill_to_region_id || 0);

  if (!regionId) throw new Error("Issuing entity (region) is required");
  if (!billToRegionId) {
    throw new Error("Bill-to entity is required for an inter-company invoice");
  }
  if (regionId === billToRegionId) {
    throw new Error("An entity cannot invoice itself");
  }

  const regionResult = await db.query(
    `SELECT id, region_name, default_currency, functional_currency, invoice_terms_label
       FROM regions WHERE id = ANY($1::int[])`,
    [[regionId, billToRegionId]],
  );
  const regionMap = new Map(
    regionResult.rows.map((row) => [Number(row.id), row]),
  );
  const issuerRegion = regionMap.get(regionId);
  const billToRegion = regionMap.get(billToRegionId);
  if (!issuerRegion) throw new Error("Issuing entity (region) not found");
  if (!billToRegion) throw new Error("Bill-to entity not found");

  // Sensible default, still editable: the counterparty's functional currency is
  // what it actually settles in (USD for UK -> USA). A header value wins.
  const currency = String(
    context.currency ||
      billToRegion.functional_currency ||
      billToRegion.default_currency ||
      "",
  )
    .trim()
    .toUpperCase();
  if (!currency) throw new Error("Currency is required");

  // Zero-rated by decision; invoices_ic_zero_rated_check enforces it at the DB
  // too, but reject here so the caller gets a readable message rather than a
  // constraint violation.
  const taxLines = Array.isArray(context.tax_lines) ? context.tax_lines : [];
  if (taxLines.length) {
    throw new Error(
      "Inter-company invoices are zero-rated and cannot carry tax lines",
    );
  }

  const normalizedLineItems = lineItems.map((item, index) => {
    const description = String(item.description || item.activity_label || "").trim();
    if (!description) {
      throw new Error(`Line ${index + 1}: description is required`);
    }

    const quantity = normalizeMoney(item.quantity);
    const rate = normalizeMoney(item.rate || item.unit_price);

    if (quantity <= 0) {
      throw new Error(`Line ${index + 1}: quantity must be greater than 0`);
    }
    if (rate < 0) {
      throw new Error(`Line ${index + 1}: rate cannot be negative`);
    }

    return {
      placement_id: null,
      candidate_id: null,
      candidate_name: null,
      job_title: null,
      activity_label: item.activity_label
        ? String(item.activity_label).trim()
        : null,
      line_date: sanitizeDateInput(item.line_date),
      description,
      quantity,
      rate,
      unit_price: rate,
      amount: quantity * rate,
    };
  });

  return {
    invoiceType: "INTER_COMPANY",
    placementMap: new Map(),
    primaryPlacement: null,
    clientId: null,
    regionId,
    billToRegionId,
    issuerRegion,
    billToRegion,
    currency,
    normalizedLineItems,
  };
};

// Dispatcher. CLIENT keeps the placement-driven path below, byte for byte.
const validateInvoiceLineItems = async (db, lineItems = [], context = {}) => {
  if (normalizeInvoiceType(context.invoice_type) === "INTER_COMPANY") {
    return validateIntercompanyLineItems(db, lineItems, context);
  }
  return validateClientLineItems(db, lineItems);
};

const validateClientLineItems = async (db, lineItems = []) => {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new Error("At least one invoice line item is required");
  }

  const placementIds = lineItems
    .map((item) => Number(item.placement_id || 0))
    .filter((id) => id > 0);

  if (!placementIds.length) {
    throw new Error("At least one valid placement is required");
  }

  const uniquePlacementIds = [...new Set(placementIds)];
  const placementResult = await db.query(
    `
    SELECT
      p.*,
      c.full_name AS candidate_name,
      c.job_title AS candidate_job_title,
      cl.client_name,
      cl.currency AS client_currency,
      cl.default_payment_terms,
      r.region_name,
      r.country_code AS region_country_code,
      r.default_currency AS region_currency,
      r.invoice_terms_label
    FROM placements p
    JOIN candidates c ON p.candidate_id = c.id
    JOIN clients cl ON p.client_id = cl.id
    JOIN regions r ON p.region_id = r.id
    WHERE p.id = ANY($1::int[])
    `,
    [uniquePlacementIds],
  );

  if (placementResult.rows.length !== uniquePlacementIds.length) {
    throw new Error("One or more selected placements were not found");
  }

  const placementMap = new Map(
    placementResult.rows.map((row) => [Number(row.id), row]),
  );

  const primaryPlacement = placementMap.get(Number(placementIds[0]));
  if (!primaryPlacement) throw new Error("Primary placement not found");

  const expectedClientId = Number(primaryPlacement.client_id);
  const expectedRegionId = Number(primaryPlacement.region_id);
  const expectedCurrency = resolvePlacementCurrency(primaryPlacement);

  const normalizedLineItems = lineItems.map((item, index) => {
    const placement = placementMap.get(Number(item.placement_id));
    if (!placement) {
      throw new Error(`Line ${index + 1}: placement not found`);
    }

    if (Number(placement.client_id) !== expectedClientId) {
      throw new Error("All invoice particulars must belong to the same client");
    }

    if (resolvePlacementCurrency(placement) !== expectedCurrency) {
      throw new Error("All invoice particulars must use the same currency");
    }

    const quantity = normalizeMoney(item.quantity);
    const rate = normalizeMoney(item.rate || item.unit_price);

    if (quantity <= 0) {
      throw new Error(`Line ${index + 1}: quantity must be greater than 0`);
    }

    if (rate < 0) {
      throw new Error(`Line ${index + 1}: rate cannot be negative`);
    }

    return {
      placement_id: Number(placement.id),
      candidate_id: placement.candidate_id,
      candidate_name: item.candidate_name || placement.candidate_name,
      job_title:
        item.job_title ||
        item.activity_label ||
        placement.job_title ||
        placement.candidate_job_title,
      activity_label:
        item.activity_label ||
        placement.job_title ||
        placement.candidate_job_title,
      line_date: sanitizeDateInput(item.line_date),
      description: buildLineDescription({
        ...item,
        candidate_name: item.candidate_name || placement.candidate_name,
        job_title:
          item.job_title ||
          placement.job_title ||
          placement.candidate_job_title,
      }),
      quantity,
      rate,
      unit_price: rate,
      amount: quantity * rate,
    };
  });

  return {
    invoiceType: "CLIENT",
    placementMap,
    primaryPlacement,
    clientId: expectedClientId,
    regionId: expectedRegionId,
    billToRegionId: null,
    currency: expectedCurrency,
    normalizedLineItems,
  };
};

const createInvoice = async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      invoice_number,
      invoice_type,
      bill_to_region_id,
      client_id,
      region_id,
      placement_id,
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
    } = req.body;

    const normalizedInvoiceDate = sanitizeDateInput(invoice_date);
    const normalizedDueDateInput = sanitizeDateInput(due_date);
    const normalizedBillingPeriodStart = sanitizeDateInput(billing_period_start);
    const normalizedBillingPeriodEnd = sanitizeDateInput(billing_period_end);

    if (!normalizedInvoiceDate) {
      return res.status(400).json({
        success: false,
        message: "Valid invoice date is required",
      });
    }

    let validated;
    try {
      validated = await validateInvoiceLineItems(client, line_items, {
        invoice_type,
        region_id,
        bill_to_region_id,
        currency,
        tax_lines,
      });
    } catch (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError.message,
      });
    }

    const isIntercompany = validated.invoiceType === "INTER_COMPANY";

    // An inter-company invoice has no client and no placement (migration 016's
    // shape CHECK forbids them); its header is authoritative rather than derived.
    const finalClientId = isIntercompany
      ? null
      : Number(client_id || validated.clientId);
    const finalRegionId = Number(region_id || validated.regionId);
    const finalPlacementId = isIntercompany
      ? null
      : Number(placement_id || validated.primaryPlacement.id);
    const finalBillToRegionId = isIntercompany
      ? Number(validated.billToRegionId)
      : null;
    const finalCurrency = String(
      currency || validated.currency || "",
    ).toUpperCase();

    if (isIntercompany) {
      if (finalRegionId !== Number(validated.regionId)) {
        return res.status(400).json({
          success: false,
          message: "Invoice header does not match the issuing entity",
        });
      }
    } else if (
      finalClientId !== Number(validated.clientId) ||
      finalRegionId !== Number(validated.regionId)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invoice header does not match selected placement particulars",
      });
    }

    // Row-level RBAC: never trust a body-supplied region_id outside the caller's scope.
    if (!canActOnEntity(req, finalRegionId)) {
      return res.status(403).json({
        success: false,
        message: "Not authorized for this entity (region)",
      });
    }

    // An inter-company invoice writes into BOTH entities' ledgers, so the caller
    // must be scoped to both. Checked here so the failure is a clear 403 up
    // front rather than an assertCanPost throw from deep inside the GL post —
    // and so a DRAFT (which posts nothing) can't be raised now and fail later.
    if (isIntercompany && !canActOnEntity(req, finalBillToRegionId)) {
      return res.status(403).json({
        success: false,
        message: "Not authorized for the bill-to entity (region)",
      });
    }

    if (!finalCurrency) {
      return res.status(400).json({
        success: false,
        message: "Currency is required",
      });
    }

    if (!isIntercompany && finalCurrency !== validated.currency) {
      return res.status(400).json({
        success: false,
        message: `Invoice currency must match the selected client/placement currency (${validated.currency})`,
      });
    }

    const invoiceNumberToUse = invoice_number?.trim()
      ? invoice_number.trim().toUpperCase()
      : isIntercompany
        ? await generateIntercompanyInvoiceNumber(pool)
        : await generateInvoiceNumber(pool);

    const existingInvoice = await client.query(
      `SELECT id FROM invoices WHERE LOWER(invoice_number) = LOWER($1) LIMIT 1`,
      [invoiceNumberToUse],
    );

    if (existingInvoice.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Invoice number already exists",
      });
    }

    const selectedClientResult = finalClientId
      ? await client.query(`SELECT * FROM clients WHERE id = $1 LIMIT 1`, [
          finalClientId,
        ])
      : { rows: [] };
    const selectedRegionResult = await client.query(
      `SELECT * FROM regions WHERE id = $1 LIMIT 1`,
      [finalRegionId],
    );

    const selectedClient = selectedClientResult.rows[0] || null;
    const selectedRegion = selectedRegionResult.rows[0] || null;

    // For INTER_COMPANY both placement and client are null, so this falls
    // through to the issuing region's terms, then the Net 30 default.
    const termsToUse = resolveInvoiceTerms({
      placement: validated.primaryPlacement,
      client: selectedClient,
      region: selectedRegion,
      providedTerms: invoice_terms_label,
    });

    const finalDueDate =
      normalizedDueDateInput ||
      calculateDueDateFromTerms(normalizedInvoiceDate, termsToUse);

    if (!finalDueDate) {
      return res.status(400).json({
        success: false,
        message: "Due date is required",
      });
    }

    const { subtotal, taxAmount, totalAmount, computedTaxLines } =
      computeInvoiceAmounts({
        lineItems: validated.normalizedLineItems,
        // Inter-company is zero-rated: validation rejects tax lines outright, so
        // this stays empty and tax_amount computes to 0.
        taxLines: isIntercompany
          ? []
          : Array.isArray(tax_lines)
            ? tax_lines
            : [],
      });

    const totalUnits = validated.normalizedLineItems.reduce(
      (sum, item) => sum + normalizeMoney(item.quantity),
      0,
    );
    const firstRate = normalizeMoney(
      validated.normalizedLineItems[0]?.rate || 0,
    );
    const invoiceColumns = await hasInvoiceColumns(client);

    // Refuse rather than silently degrade: without 016 the discriminator columns
    // don't exist, so an inter-company payload would insert as a CLIENT row with
    // no bill-to party and no way to tell it apart afterwards.
    if (
      isIntercompany &&
      !(invoiceColumns.invoice_type && invoiceColumns.bill_to_region_id)
    ) {
      return res.status(501).json({
        success: false,
        message:
          "Inter-company invoicing requires migration 016_intercompany_invoices.sql",
      });
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
          client,
        );
        exchangeRate = valuation.exchangeRate;
        amountBase = valuation.amountBase;
      } catch (fxError) {
        console.warn(
          `Invoice valuation skipped (region ${finalRegionId}, ${finalCurrency} on ${normalizedInvoiceDate}): ${fxError.message}`,
        );
      }
    }

    await client.query("BEGIN");

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
      invoice_template:
        invoice_template || selectedRegion?.invoice_template || "CLASSIC",
      invoice_template_id,
      invoice_template_name,
      invoice_template_snapshot_json,
      template_custom_fields_json,
      createdBy: req.user?.id || null,
    });

    const insertInvoiceResult = await client.query(
      `
      INSERT INTO invoices (${insertParts.columns.join(", ")})
      VALUES (${insertParts.placeholders.join(", ")})
      RETURNING *
      `,
      insertParts.values,
    );

    const createdInvoice = insertInvoiceResult.rows[0];

    await insertInvoiceItems(
      client,
      createdInvoice.id,
      validated.normalizedLineItems,
    );

    // Auto-post to the general ledger, atomically with the invoice. Skips if the
    // GL isn't migrated yet (002) or the invoice is still a DRAFT; idempotent.
    // Inter-company posts TWO entries (issuer + counterparty); see
    // postingService.postIcInvoiceIssued.
    if (
      GL_POSTABLE_INVOICE_STATUSES.includes(String(createdInvoice.invoice_status)) &&
      (await glPosting.glAvailable(client))
    ) {
      if (isIntercompany) {
        await glPosting.postIcInvoiceIssued(client, createdInvoice);
      } else {
        await glPosting.postInvoiceIssued(client, createdInvoice);
      }
    }

    await client.query("COMMIT");

    const fullInvoiceResult = await pool.query(
      `SELECT * FROM invoices WHERE id = $1 LIMIT 1`,
      [createdInvoice.id],
    );

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "CREATE",
      entityType: "invoices",
      entityId: createdInvoice.id,
      newValues: fullInvoiceResult.rows[0],
      ipAddress: req.ip,
    });

    return res.status(201).json({
      success: true,
      message: "Invoice created successfully",
      data: {
        ...sanitizeInvoiceRecord(createdInvoice),
        line_items: validated.normalizedLineItems,
        tax_lines: computedTaxLines,
      },
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_err) {}
    if (error.code === "22007") {
      return res.status(400).json({
        success: false,
        message:
          "Invalid date value in invoice date, due date, billing period, or line item date",
      });
    }
    console.error("createInvoice error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while creating invoice",
      error: error.message,
    });
  } finally {
    client.release();
  }
};

const updateInvoice = async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const {
      invoice_number,
      invoice_type,
      bill_to_region_id,
      client_id,
      region_id,
      placement_id,
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
    } = req.body;

    const normalizedInvoiceDate = sanitizeDateInput(invoice_date);
    const normalizedDueDateInput = sanitizeDateInput(due_date);
    const normalizedBillingPeriodStart = sanitizeDateInput(billing_period_start);
    const normalizedBillingPeriodEnd = sanitizeDateInput(billing_period_end);

    const existingInvoiceResult = await client.query(
      `SELECT * FROM invoices WHERE id = $1 LIMIT 1`,
      [id],
    );

    if (!existingInvoiceResult.rows.length || !canActOnEntity(req, existingInvoiceResult.rows[0].region_id)) {
      return res
        .status(404)
        .json({ success: false, message: "Invoice not found" });
    }

    const existingInvoice = existingInvoiceResult.rows[0];

    if (region_id != null && !canActOnEntity(req, region_id)) {
      return res.status(403).json({ success: false, message: "Not authorized to assign invoices to this region" });
    }

    if (!normalizedInvoiceDate) {
      return res.status(400).json({
        success: false,
        message: "Valid invoice date is required",
      });
    }

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
        return res.status(400).json({
          success: false,
          message:
            "Invoice type cannot be changed after creation. Cancel this invoice and raise a new one.",
        });
      }
    } catch (typeError) {
      return res.status(400).json({ success: false, message: typeError.message });
    }

    const isIntercompany = existingType === "INTER_COMPANY";

    let validated;
    try {
      validated = await validateInvoiceLineItems(client, line_items, {
        invoice_type: existingType,
        // Fall back to the stored values so a partial payload (line items only)
        // still validates against the invoice's own parties.
        region_id: region_id != null ? region_id : existingInvoice.region_id,
        bill_to_region_id:
          bill_to_region_id != null
            ? bill_to_region_id
            : existingInvoice.bill_to_region_id,
        currency,
        tax_lines,
      });
    } catch (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError.message,
      });
    }

    const finalClientId = isIntercompany
      ? null
      : Number(client_id || validated.clientId);
    const finalRegionId = Number(region_id || validated.regionId);
    const finalPlacementId = isIntercompany
      ? null
      : Number(placement_id || validated.primaryPlacement.id);
    const finalBillToRegionId = isIntercompany
      ? Number(validated.billToRegionId)
      : null;
    const finalCurrency = String(
      currency || validated.currency || "",
    ).toUpperCase();

    if (isIntercompany) {
      if (finalRegionId !== Number(validated.regionId)) {
        return res.status(400).json({
          success: false,
          message: "Invoice header does not match the issuing entity",
        });
      }
    } else if (
      finalClientId !== Number(validated.clientId) ||
      finalRegionId !== Number(validated.regionId)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invoice header does not match selected placement particulars",
      });
    }

    // Row-level RBAC: never trust a body-supplied region_id outside the caller's scope.
    if (!canActOnEntity(req, finalRegionId)) {
      return res.status(403).json({
        success: false,
        message: "Not authorized for this entity (region)",
      });
    }

    // Reposting an inter-company edit rewrites BOTH entities' ledgers, so the
    // caller must still be scoped to both — the same rule createInvoice applies.
    if (isIntercompany && !canActOnEntity(req, finalBillToRegionId)) {
      return res.status(403).json({
        success: false,
        message: "Not authorized for the bill-to entity (region)",
      });
    }

    if (!isIntercompany && finalCurrency !== validated.currency) {
      return res.status(400).json({
        success: false,
        message: `Invoice currency must match the selected client/placement currency (${validated.currency})`,
      });
    }

    const invoiceNumberToUse = invoice_number?.trim()
      ? invoice_number.trim().toUpperCase()
      : existingInvoice.invoice_number;

    const duplicateCheck = await client.query(
      `SELECT id FROM invoices WHERE LOWER(invoice_number)=LOWER($1) AND id<>$2 LIMIT 1`,
      [invoiceNumberToUse, id],
    );

    if (duplicateCheck.rows.length > 0) {
      return res.status(409).json({
        success: false,
        message: "Invoice number already exists",
      });
    }

    const selectedClientResult = finalClientId
      ? await client.query(`SELECT * FROM clients WHERE id = $1 LIMIT 1`, [
          finalClientId,
        ])
      : { rows: [] };
    const selectedRegionResult = await client.query(
      `SELECT * FROM regions WHERE id = $1 LIMIT 1`,
      [finalRegionId],
    );

    const selectedClient = selectedClientResult.rows[0] || null;
    const selectedRegion = selectedRegionResult.rows[0] || null;

    const termsToUse = resolveInvoiceTerms({
      placement: validated.primaryPlacement,
      client: selectedClient,
      region: selectedRegion,
      providedTerms: invoice_terms_label,
    });

    const finalDueDate =
      normalizedDueDateInput ||
      calculateDueDateFromTerms(normalizedInvoiceDate, termsToUse);

    if (!finalDueDate) {
      return res.status(400).json({
        success: false,
        message: "Due date is required",
      });
    }

    const { subtotal, taxAmount, totalAmount, computedTaxLines } =
      computeInvoiceAmounts({
        lineItems: validated.normalizedLineItems,
        // Zero-rated: validation already rejects tax lines on an inter-company
        // invoice, and invoices_ic_zero_rated_check would reject the row anyway.
        taxLines: isIntercompany
          ? []
          : Array.isArray(tax_lines)
            ? tax_lines
            : [],
      });

    const totalUnits = validated.normalizedLineItems.reduce(
      (sum, item) => sum + normalizeMoney(item.quantity),
      0,
    );
    const firstRate = normalizeMoney(
      validated.normalizedLineItems[0]?.rate || 0,
    );
    const invoiceColumns = await hasInvoiceColumns(client);


    await client.query("BEGIN");

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
      invoice_template_id:
        invoice_template_id !== undefined
          ? invoice_template_id
          : existingInvoice.invoice_template_id,
      invoice_template_name:
        invoice_template_name !== undefined
          ? invoice_template_name
          : existingInvoice.invoice_template_name,
      invoice_template_snapshot_json:
        invoice_template_snapshot_json !== undefined
          ? invoice_template_snapshot_json
          : existingInvoice.invoice_template_snapshot_json,
      template_custom_fields_json:
        template_custom_fields_json !== undefined
          ? template_custom_fields_json
          : existingInvoice.template_custom_fields_json,
      id,
    });

    await client.query(
      `
      UPDATE invoices
      SET
        ${updateParts.sets.join(",\n        ")}
      WHERE id = $${updateParts.values.length}
      `,
      updateParts.values,
    );

    await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [id]);
    await insertInvoiceItems(client, id, validated.normalizedLineItems);

    const recalculatedInvoice = await recalculateInvoiceAmountsAndStatus(
      client,
      Number(id),
    );

    // GL lifecycle: an edit to a posted invoice reverses the stale entry and
    // re-posts the new amounts so the ledger matches the revised invoice.
    await syncInvoiceGl(client, recalculatedInvoice, req.user?.id || null, "repost");

    await client.query("COMMIT");

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "UPDATE",
      entityType: "invoices",
      entityId: Number(id),
      oldValues: existingInvoice,
      newValues: recalculatedInvoice,
      ipAddress: req.ip,
    });

    return res.status(200).json({
      success: true,
      message: "Invoice updated successfully",
      data: {
        ...sanitizeInvoiceRecord(recalculatedInvoice),
        line_items: validated.normalizedLineItems,
        tax_lines: computedTaxLines,
      },
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_err) {}
    if (error.code === "22007") {
      return res.status(400).json({
        success: false,
        message:
          "Invalid date value in invoice date, due date, billing period, or line item date",
      });
    }
    console.error("updateInvoice error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while updating invoice",
      error: error.message,
    });
  } finally {
    client.release();
  }
};

const createInvoiceStatusPayment = async (
  client,
  { invoiceId, amountReceived, status, userId, tdsApplicable, tdsPercent, tdsAmount, paymentDate },
) => {
  const paymentCodeColumnExists = await hasColumn(
    client,
    "payments",
    "payment_code",
  );
  const tdsApplicableColumnExists = await hasColumn(
    client,
    "payments",
    "tds_applicable",
  );
  const tdsPercentColumnExists = await hasColumn(
    client,
    "payments",
    "tds_percent",
  );
  const tdsAmountColumnExists = await hasColumn(
    client,
    "payments",
    "tds_amount",
  );
  const generatedCode = paymentCodeColumnExists
    ? await generatePaymentCode(client)
    : null;
  const generatedReference = await generatePaymentReference(client);

  const columns = [];
  const placeholders = [];
  const values = [];
  const addValue = (column, value) => {
    columns.push(column);
    values.push(value);
    placeholders.push(`$${values.length}`);
  };
  const addExpression = (column, expression) => {
    columns.push(column);
    placeholders.push(expression);
  };

  if (paymentCodeColumnExists) addValue("payment_code", generatedCode);
  addValue("invoice_id", Number(invoiceId));
  if (paymentDate) {
    addValue("payment_date", paymentDate);
  } else {
    addExpression("payment_date", "CURRENT_DATE");
  }
  addValue("amount_received", amountReceived);
  addValue("payment_mode", "AUTO");
  addValue("reference_number", generatedReference);
  addValue(
    "notes",
    `Auto-created from invoice status change to ${status}`,
  );
  if (tdsApplicableColumnExists) {
    addValue("tds_applicable", normalizeBoolean(tdsApplicable));
  }
  if (tdsPercentColumnExists) addValue("tds_percent", tdsPercent || null);
  if (tdsAmountColumnExists) addValue("tds_amount", tdsAmount || 0);
  addValue("created_by", userId || null);

  await client.query(
    `
    INSERT INTO payments (${columns.join(", ")})
    VALUES (${placeholders.join(", ")})
    `,
    values,
  );
};

const updateInvoiceStatus = async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const requestedStatus = String(
      req.body.status || req.body.invoice_status || "",
    ).toUpperCase();

    if (!ALLOWED_INVOICE_STATUSES.includes(requestedStatus)) {
      return res.status(400).json({
        success: false,
        message: "Invalid invoice status",
      });
    }

    const invoiceResult = await client.query(
      `SELECT * FROM invoices WHERE id = $1 LIMIT 1`,
      [id],
    );

    if (!invoiceResult.rows.length || !canActOnEntity(req, invoiceResult.rows[0].region_id)) {
      return res
        .status(404)
        .json({ success: false, message: "Invoice not found" });
    }

    const invoice = invoiceResult.rows[0];

    // TDS only exists for regions configured for it (India). Elsewhere the
    // client never renders the question, so requiring an answer would reject
    // every US/UK payment.
    const regionTdsApplicable = await getRegionTdsApplicable(
      client,
      invoice.region_id,
    );

    if (
      regionTdsApplicable &&
      ["PAID", "PARTIALLY_PAID"].includes(requestedStatus) &&
      (req.body.tds_applicable === undefined ||
        req.body.tds_applicable === null ||
        req.body.tds_applicable === "")
    ) {
      return res.status(400).json({
        success: false,
        message: "TDS paid selection is required",
      });
    }

    // Server-side gate, not just a UI concern: a stale client posting TDS for a
    // non-TDS region must not withhold anything.
    const statusTdsApplicable =
      regionTdsApplicable && normalizeBoolean(req.body.tds_applicable);
    const statusTdsPercent = statusTdsApplicable
      ? normalizeMoney(req.body.tds_percent)
      : 0;
    const statusTdsAmount = calculateTdsAmount(
      invoice,
      statusTdsApplicable,
      statusTdsPercent,
    );

    if (
      ["PAID", "PARTIALLY_PAID"].includes(requestedStatus) &&
      statusTdsApplicable &&
      statusTdsPercent <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "TDS percentage is required when TDS is paid",
      });
    }

    // Optional: when omitted, createInvoiceStatusPayment falls back to CURRENT_DATE.
    const requestedPaymentDate = String(req.body.payment_date || "").trim();
    if (requestedPaymentDate) {
      // Round-trip the parse: JS rolls impossible dates forward rather than
      // rejecting them (2026-02-31 -> 2026-03-03), so a NaN check alone would
      // let them through to Postgres and surface as a 500.
      const parsed = new Date(`${requestedPaymentDate}T00:00:00Z`);
      const isValidDate =
        /^\d{4}-\d{2}-\d{2}$/.test(requestedPaymentDate) &&
        !Number.isNaN(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === requestedPaymentDate;

      if (!isValidDate) {
        return res.status(400).json({
          success: false,
          message: "Invalid payment date",
        });
      }

      const todayKey = new Date().toISOString().slice(0, 10);
      if (requestedPaymentDate > todayKey) {
        return res.status(400).json({
          success: false,
          message: "Payment date cannot be in the future",
        });
      }
    }

    if (requestedStatus === "CANCELLED") {
      const paymentsResult = await client.query(
        `SELECT COUNT(*)::int AS payment_count FROM payments WHERE invoice_id = $1`,
        [id],
      );

      if (Number(paymentsResult.rows[0]?.payment_count || 0) > 0) {
        return res.status(400).json({
          success: false,
          message: "Cannot cancel invoice with existing payments",
        });
      }
    }

    if (requestedStatus === "PAID") {
      const totalAmount = normalizeMoney(invoice.total_amount);
      const alreadyReceived = normalizeMoney(invoice.payment_received_amount);
      const balance = Math.max(totalAmount - alreadyReceived, 0);

      if (statusTdsAmount > balance) {
        return res.status(400).json({
          success: false,
          message: "TDS amount exceeds outstanding balance",
        });
      }
    }

    if (requestedStatus === "PARTIALLY_PAID") {
      const partialAmount = Number(
        req.body.amount_received || req.body.amount || 0,
      );

      if (partialAmount <= 0) {
        return res.status(400).json({
          success: false,
          message: "Amount is required for PARTIALLY_PAID status",
        });
      }

      const totalAmount = normalizeMoney(invoice.total_amount);
      const alreadyReceived = normalizeMoney(invoice.payment_received_amount);

      if (alreadyReceived + partialAmount + statusTdsAmount > totalAmount) {
        return res.status(400).json({
          success: false,
          message: "Partial payment exceeds outstanding balance",
        });
      }
    }

    await client.query("BEGIN");

    let updatedInvoice;

    if (requestedStatus === "PAID") {
      const totalAmount = normalizeMoney(invoice.total_amount);
      const alreadyReceived = normalizeMoney(invoice.payment_received_amount);

      if (alreadyReceived < totalAmount) {
        const amountToCreate = Math.max(
          totalAmount - alreadyReceived - statusTdsAmount,
          0,
        );

        await createInvoiceStatusPayment(client, {
          invoiceId: id,
          amountReceived: amountToCreate,
          status: "PAID",
          userId: req.user?.id || null,
          tdsApplicable: statusTdsApplicable,
          tdsPercent: statusTdsApplicable ? statusTdsPercent : null,
          tdsAmount: statusTdsAmount,
          paymentDate: requestedPaymentDate || null,
        });
      }

      updatedInvoice = await recalculateInvoiceAmountsAndStatus(
        client,
        Number(id),
      );
    } else if (requestedStatus === "PARTIALLY_PAID") {
      const partialAmount = Number(
        req.body.amount_received || req.body.amount || 0,
      );

      await createInvoiceStatusPayment(client, {
        invoiceId: id,
        amountReceived: partialAmount,
        status: "PARTIALLY_PAID",
        userId: req.user?.id || null,
        tdsApplicable: statusTdsApplicable,
        tdsPercent: statusTdsApplicable ? statusTdsPercent : null,
        tdsAmount: statusTdsAmount,
      });

      updatedInvoice = await recalculateInvoiceAmountsAndStatus(
        client,
        Number(id),
      );
    } else if (
      requestedStatus === "OVERDUE" ||
      requestedStatus === "GENERATED" ||
      requestedStatus === "SENT"
    ) {
      const autoPaymentsResult = await client.query(
        `
        DELETE FROM payments
        WHERE invoice_id = $1
          AND payment_mode = 'AUTO'
        RETURNING *
        `,
        [id],
      );

      if (autoPaymentsResult.rows.length > 0) {
        updatedInvoice = await recalculateInvoiceAmountsAndStatus(
          client,
          Number(id),
        );
      } else {
        const updateResult = await client.query(
          `
          UPDATE invoices
          SET invoice_status = $1,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = $2
          RETURNING *
          `,
          [requestedStatus, id],
        );
        updatedInvoice = updateResult.rows[0];
      }
    } else {
      const updateResult = await client.query(
        `
        UPDATE invoices
        SET invoice_status = $1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        RETURNING *
        `,
        [requestedStatus, id],
      );
      updatedInvoice = updateResult.rows[0];
    }

    // GL lifecycle: promotion from DRAFT into a postable status posts the entry;
    // CANCELLED reverses it. Other transitions (already posted) are no-ops.
    await syncInvoiceGl(
      client,
      updatedInvoice,
      req.user?.id || null,
      requestedStatus === "CANCELLED" ? "cancel" : "ensure",
    );

    await client.query("COMMIT");

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "UPDATE_STATUS",
      entityType: "invoices",
      entityId: Number(id),
      oldValues: invoice,
      newValues: updatedInvoice,
      ipAddress: req.ip,
    });

    return res.status(200).json({
      success: true,
      message: "Invoice status updated successfully",
      data: sanitizeInvoiceRecord(updatedInvoice),
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_err) {}
    console.error("updateInvoiceStatus error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while updating invoice status",
      error: error.message,
    });
  } finally {
    client.release();
  }
};

const deleteInvoice = async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    const invoiceResult = await client.query(
      `SELECT * FROM invoices WHERE id = $1 LIMIT 1`,
      [id],
    );

    if (!invoiceResult.rows.length || !canActOnEntity(req, invoiceResult.rows[0].region_id)) {
      return res
        .status(404)
        .json({ success: false, message: "Invoice not found" });
    }

    const existingInvoice = invoiceResult.rows[0];

    const paymentCheck = await client.query(
      `SELECT COUNT(*)::int AS payment_count FROM payments WHERE invoice_id = $1`,
      [id],
    );

    if (Number(paymentCheck.rows[0]?.payment_count || 0) > 0) {
      return res.status(400).json({
        success: false,
        message: "Cannot delete invoice with linked payments",
      });
    }

    await client.query("BEGIN");

    // Reverse any posted GL entry before removing the invoice so the ledger
    // never references a deleted document with an unbalanced posting.
    if (await glPosting.glAvailable(client)) {
      const postedId = await glPosting.alreadyPosted("AR_INVOICE", id, client);
      if (postedId) {
        await glPosting.reverseEntry(client, postedId, "Invoice deleted", req.user?.id || null);
      }
    }

    await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [id]);
    await client.query(`DELETE FROM invoices WHERE id = $1`, [id]);

    await client.query("COMMIT");

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "DELETE",
      entityType: "invoices",
      entityId: Number(id),
      oldValues: existingInvoice,
      ipAddress: req.ip,
    });

    return res.status(200).json({
      success: true,
      message: "Invoice deleted successfully",
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_err) {}
    console.error("deleteInvoice error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error while deleting invoice",
      error: error.message,
    });
  } finally {
    client.release();
  }
};

// GET /api/invoices/export?format=xlsx&from=&to=&status=&scope=&region_id=&search=
// status = derived display status; scope = outstanding|overdue|collected.
const exportInvoices = async (req, res) => {
  try {
    const { status, scope, region_id, client_id, search, from, to, currency } = req.query;
    const conditions = [];
    const values = [];
    let idx = 1;
    if (region_id) { conditions.push(`i.region_id = $${idx++}`); values.push(Number(region_id)); }
    if (client_id) { conditions.push(`i.client_id = $${idx++}`); values.push(Number(client_id)); }
    if (currency) { conditions.push(`UPPER(i.currency) = $${idx++}`); values.push(String(currency).toUpperCase()); }
    if (from) { conditions.push(`i.due_date >= $${idx++}`); values.push(from); }
    if (to) { conditions.push(`i.due_date <= $${idx++}`); values.push(to); }
    if (req.scopeEnforced && Array.isArray(req.allowedEntityIds)) { conditions.push(`i.region_id = ANY($${idx++})`); values.push(req.allowedEntityIds); }
    if (search) {
      conditions.push(`(i.invoice_number ILIKE $${idx} OR cl.client_name ILIKE $${idx} OR COALESCE(c.full_name, '') ILIKE $${idx} OR COALESCE(r.region_name, '') ILIKE $${idx})`);
      values.push(`%${search}%`); idx += 1;
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT i.id, i.invoice_number, i.invoice_date, i.due_date, i.total_amount, i.currency, i.invoice_status,
              i.payment_received_amount, i.balance_outstanding,
              cl.client_name, r.region_name, c.full_name AS candidate_name
         FROM invoices i
         LEFT JOIN clients cl ON i.client_id = cl.id
         LEFT JOIN regions r ON i.region_id = r.id
         LEFT JOIN placements p ON i.placement_id = p.id
         LEFT JOIN candidates c ON p.candidate_id = c.id
         ${where}
        ORDER BY i.invoice_date DESC, i.id DESC`, values);

    const wantStatus = status ? String(status).toUpperCase() : "";
    const wantScope = scope ? String(scope).toLowerCase() : "";
    const cache = new Map();
    let totalUsd = 0;
    const rows = [];
    for (const r of result.rows) {
      const display = invoiceDisplayStatus(r);
      if (wantStatus && display !== wantStatus) continue;
      const outstanding = Number(r.balance_outstanding || 0);
      const received = Number(r.payment_received_amount || 0);
      const closed = ["PAID", "CANCELLED"].includes(String(r.invoice_status || "").toUpperCase());
      const isOutstanding = outstanding > 0 && !closed;
      const overdue = isOutstanding && r.due_date && new Date(r.due_date) < new Date(new Date().setHours(0, 0, 0, 0));
      const isCollected = received > 0;
      if (wantScope === "outstanding" && !isOutstanding) continue;
      if (wantScope === "overdue" && !overdue) continue;
      if (wantScope === "collected" && !isCollected) continue;
      if (wantScope === "sent" && !(display === "SENT" || display === "GENERATED")) continue;

      const tUsd = await convertToUsd(r.total_amount, r.currency, cache);
      totalUsd += tUsd;
      rows.push({
        invoice_date: String(r.invoice_date).slice(0, 10),
        invoice_number: r.invoice_number,
        client_name: r.client_name || "",
        region_name: r.region_name || "",
        candidate_name: r.candidate_name || "",
        due_date: r.due_date ? String(r.due_date).slice(0, 10) : "",
        currency: r.currency,
        total_amount: Number(r.total_amount || 0),
        payment_received_amount: received,
        balance_outstanding: outstanding,
        total_usd: tUsd,
        status: display,
      });
    }
    const rangeLabel = (from || to) ? `${from || "…"} to ${to || "…"}` : "All dates";
    const report = {
      title: "Invoices",
      subtitle: `${rangeLabel} · ${rows.length} invoice(s) · total in USD (consolidated)`,
      columns: [
        { key: "invoice_date", label: "Date", type: "text" },
        { key: "invoice_number", label: "Invoice #", type: "text" },
        { key: "client_name", label: "Client", type: "text" },
        { key: "region_name", label: "Location", type: "text" },
        { key: "candidate_name", label: "Candidate", type: "text" },
        { key: "due_date", label: "Due", type: "text" },
        { key: "currency", label: "Currency", type: "text" },
        { key: "total_amount", label: "Total", type: "money" },
        { key: "payment_received_amount", label: "Received", type: "money" },
        { key: "balance_outstanding", label: "Outstanding", type: "money" },
        { key: "total_usd", label: "Total (USD)", type: "money" },
        { key: "status", label: "Status", type: "text" },
      ],
      rows,
      totals: { total_usd: Math.round(totalUsd * 100) / 100 },
    };
    return await sendReport(res, report, req.query.format || "xlsx");
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to export invoices", error: error.message });
  }
};

module.exports = {
  getAllInvoices,
  exportInvoices,
  getInvoiceById,
  getInvoicePrintData,
  getInvoicePlacementOptions,
  getNextInvoiceNumberPreview,
  createInvoice,
  updateInvoice,
  updateInvoiceStatus,
  deleteInvoice,
  downloadInvoicePdf,
  // Not a route handler. Exported for tests: the GL lifecycle (reverse/repost
  // both legs of an inter-company invoice) can only be exercised inside a
  // transaction that is rolled back, and the route handlers commit their own.
  syncInvoiceGl,
  validateInvoiceLineItems,
  normalizeInvoiceType,
};

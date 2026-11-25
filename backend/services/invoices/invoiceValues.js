// Pure value helpers for invoices: normalising request values, dates, terms
// and statuses. No database access. Moved unchanged from invoiceController.js.

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

const normalizeInvoiceTemplate = (value, fallback = "CLASSIC") => {
  const normalized = String(value || fallback).trim().toUpperCase();
  if (INVOICE_TEMPLATE_OPTIONS.has(normalized)) return normalized;
  const safeFallback = String(fallback || "CLASSIC").trim().toUpperCase();
  return INVOICE_TEMPLATE_OPTIONS.has(safeFallback) ? safeFallback : "CLASSIC";
};

const sanitizeInvoiceRecord = (invoice = {}) =>
  serializeInvoiceDates(
    Object.fromEntries(
      Object.entries(invoice).filter(([key]) => !key.startsWith("quick")),
    ),
  );

module.exports = {
  GL_POSTABLE_INVOICE_STATUSES,
  ALLOWED_INVOICE_STATUSES,
  invoiceDisplayStatus,
  normalizeMoney,
  normalizeBoolean,
  toNullable,
  sanitizeDateInput,
  normalizeInvoiceStatus,
  normalizeCurrencyCode,
  resolvePlacementCurrency,
  calculateDueDateFromTerms,
  serializeDateOnly,
  serializeInvoiceDates,
  calculateInvoiceStatusFromAmounts,
  resolveInvoiceTerms,
  normalizeInvoiceTemplate,
  sanitizeInvoiceRecord,
};

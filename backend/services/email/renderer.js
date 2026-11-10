const currencySymbols = { USD: "$", GBP: "£", EUR: "€", INR: "₹", AUD: "A$", CAD: "C$" };

const SAMPLE_LOGO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="150" height="34">' +
      '<rect width="150" height="34" rx="4" fill="#d8ebe6"/>' +
      '<text x="75" y="22" font-family="Segoe UI,Arial" font-size="13" font-weight="600" ' +
      'fill="#0f7d70" text-anchor="middle">YOUR LOGO</text></svg>',
  );

const TOKENS = [
  { key: "invoice_number", label: "Invoice number", sample: "INV-2026-000123" },
  { key: "invoice_date", label: "Invoice date", sample: "2026-07-01" },
  { key: "due_date", label: "Due date", sample: "2026-07-31" },
  { key: "total_amount", label: "Invoice total", sample: "$ 8,000.00" },
  { key: "balance_due", label: "Amount outstanding", sample: "$ 8,000.00" },
  { key: "currency", label: "Currency", sample: "USD" },
  { key: "payment_terms", label: "Payment terms", sample: "Net 30" },
  { key: "client_name", label: "Client name", sample: "Acme Corp" },
  { key: "contact_name", label: "Contact name", sample: "John Smith" },
  { key: "company_name", label: "Your company", sample: "TetriQ Solutions" },
  { key: "company_address", label: "Your address", sample: "Carrollton, Texas, USA" },
  { key: "logo_url", label: "Logo", sample: SAMPLE_LOGO },
  { key: "header_banner_url", label: "Header banner", sample: "" },
  { key: "footer_note", label: "Footer note", sample: "info@tetriqsolutions.com · +1 (804) 336-2001" },
  { key: "region_name", label: "Region", sample: "United Kingdom" },
  { key: "days_until_due", label: "Days until due", sample: "5", reminderOnly: true },
  { key: "days_overdue", label: "Days overdue", sample: "12", reminderOnly: true },
];

const escapeHtml = (v) =>
  String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const sanitizeHtml = (html) =>
  String(html ?? "")
    .replace(/<\s*(script|iframe|object|embed|link|meta|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|iframe|object|embed|link|meta)\b[^>]*\/?>/gi, "")
    .replace(/\son\w+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'>\s]*\2/gi, '$1="#"');

const stripHeaderBreaks = (v) => String(v ?? "").replace(/[\r\n]+/g, " ").trim();

const publicBase = () =>
  String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");

const safeUrl = (v) => {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("/")) {
    const base = publicBase();
    return base ? `${base}${s}` : "";
  }
  return "";
};

const fmtDate = (v) => {
  if (!v) return "";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return v.trim();
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const fmtMoney = (amount, currency) => {
  const n = Number(amount || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  const code = String(currency || "").toUpperCase();
  return `${currencySymbols[code] || code} ${n}`.trim();
};

const dayIndex = (v) => Math.floor(Date.parse(`${fmtDate(v)}T00:00:00Z`) / 86400000);
const daysBetween = (from, to) => Math.max(0, dayIndex(to) - dayIndex(from));

const buildContext = (invoice = {}, brand = {}) => {
  const ccy = invoice.currency;
  const due = invoice.due_date ? new Date(invoice.due_date) : null;
  const today = new Date();
  return {
    invoice_number: invoice.invoice_number || "",
    invoice_date: fmtDate(invoice.invoice_date),
    due_date: fmtDate(invoice.due_date),
    total_amount: fmtMoney(invoice.total_amount, ccy),
    balance_due: fmtMoney(invoice.balance_outstanding ?? invoice.total_amount, ccy),
    currency: String(ccy || "").toUpperCase(),
    payment_terms: invoice.payment_terms_label || invoice.default_payment_terms || "Net 30",
    client_name: invoice.client_name || "",
    contact_name: invoice.primary_contact_name || invoice.client_name || "there",
    company_name: invoice.company_name || invoice.region_name || "",
    company_address: invoice.company_address || "",
    logo_url: brand.email_logo_url || safeUrl(invoice.logo_url),
    header_banner_url: brand.header_banner_url || "",
    footer_note: invoice.footer_note || "",
    region_name: invoice.region_name || "",
    days_until_due: due ? String(daysBetween(today, due)) : "0",
    days_overdue: due ? String(daysBetween(due, today)) : "0",
  };
};

const sampleContext = () =>
  Object.fromEntries(TOKENS.map((t) => [t.key, t.sample]));

const render = (template, context, { escape = true } = {}) =>
  String(template ?? "").replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, key) => {
    const k = String(key).toLowerCase();
    if (!(k in context)) return match;
    return escape ? escapeHtml(context[k]) : String(context[k] ?? "");
  });

const dropEmptyImages = (html) =>
  String(html ?? "")
    .replace(/<img\b[^>]*\bsrc\s*=\s*(""|'')[^>]*>/gi, "")
    .replace(/<img\b(?![^>]*\bsrc\s*=)[^>]*>/gi, "");

const renderTemplate = (template, context) => ({
  subject: stripHeaderBreaks(render(template.subject, context, { escape: false })),
  html: dropEmptyImages(render(sanitizeHtml(template.body), context)),
});

const toDisplayHtml = (html) => {
  const base = publicBase();
  if (!base) return String(html ?? "");
  return String(html ?? "").split(base).join("");
};

module.exports = {
  TOKENS, buildContext, sampleContext, render, renderTemplate,
  sanitizeHtml, escapeHtml, stripHeaderBreaks, fmtMoney, fmtDate, toDisplayHtml,
  safeUrl, publicBase,
};

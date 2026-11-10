const fs = require("fs");
const http = require("http");
const https = require("https");
const net = require("net");
const dns = require("dns").promises;
const path = require("path");
const PDFDocument = require("pdfkit");

// SSRF guard: a region's logo_url is operator-supplied and fetched server-side
// (following redirects), so block requests that resolve to private/loopback/
// link-local/metadata ranges. DNS is resolved so a public hostname pointing at
// an internal IP is also rejected.
const isPrivateIp = (ip) => {
  if (net.isIPv4(ip)) {
    const o = ip.split(".").map(Number);
    if (o[0] === 10 || o[0] === 127 || o[0] === 0) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 169 && o[1] === 254) return true; // link-local incl. 169.254.169.254
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // CGNAT
    return false;
  }
  const v = String(ip).toLowerCase().replace(/^\[|\]$/g, "");
  if (v === "::1" || v === "::") return true;
  if (/^f[cd]/.test(v)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(v)) return true; // fe80::/10 link-local
  if (v.startsWith("::ffff:")) {
    const mapped = v.split(":").pop();
    if (net.isIPv4(mapped)) return isPrivateIp(mapped);
  }
  return false;
};

const isSafeRemoteUrl = async (urlStr) => {
  let u;
  try { u = new URL(String(urlStr)); } catch (_e) { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return !isPrivateIp(host);
  try {
    const addrs = await dns.lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch (_e) {
    return false;
  }
};

const PAGE = {
  width: 595.28,
  height: 841.89,
  marginLeft: 42,
  marginRight: 42,
  marginTop: 34,
  marginBottom: 34,
};

const INVOICE_TEMPLATES = new Set(["CLASSIC", "EXECUTIVE", "MINIMAL"]);

// Line-items table columns (sum = 500, matching the content width at tableX=48).
const COLS = { sno: 28, desc: 248, qty: 50, rate: 84, amount: 90 };
const TABLE_WIDTH = COLS.sno + COLS.desc + COLS.qty + COLS.rate + COLS.amount;
// x-offsets (relative to tableX) of each internal vertical divider.
const COL_DIVIDERS = [
  COLS.sno,
  COLS.sno + COLS.desc,
  COLS.sno + COLS.desc + COLS.qty,
  COLS.sno + COLS.desc + COLS.qty + COLS.rate,
];
const AMOUNT_X = COLS.sno + COLS.desc + COLS.qty + COLS.rate; // left edge of amount column

const safeText = (value, fallback = "-") => {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
};

const numeric = (value) => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const money = (value) =>
  Number(numeric(value)).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const moneyNoDecimals = (value) =>
  Number(numeric(value)).toLocaleString("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

// Symbols that render correctly in PDFKit's standard (WinAnsi) Helvetica.
// The Rupee sign U+20B9 is NOT in that set, so INR falls back to a code prefix.
const CURRENCY_SYMBOLS = { USD: "$", EUR: "€", GBP: "£" };

const localeForCurrency = (code) => (code === "INR" ? "en-IN" : "en-US");

// Consistent money: symbol/code + grouped value with two decimals.
const moneyWithCurrency = (currency, value) => {
  const code = String(currency || "USD").toUpperCase();
  const amount = Number(numeric(value)).toLocaleString(localeForCurrency(code), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const symbol = CURRENCY_SYMBOLS[code];
  return symbol ? `${symbol}${amount}` : `${code} ${amount}`;
};

// Table/summary amounts use the same professional formatting (2 decimals).
const moneyCompactByCurrency = (currency, value) => moneyWithCurrency(currency, value);

// Quantities: show whole numbers cleanly, fractions up to 2 dp (e.g. 160, 7.5).
const formatQuantity = (value) => {
  const n = numeric(value);
  if (!n) return "";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
};

const splitAddressLines = (value) => {
  if (!value) return [];
  return String(value)
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter(Boolean);
};

const isHttpUrl = (value) => /^https?:\/\//i.test(String(value || ""));

const normalizeLogoPath = (logoUrl) => {
  const raw = String(logoUrl || "").trim();
  if (!raw) return "";
  return raw
    .replace(/\\/g, "/")
    .replace(/^\/api\/uploads\//i, "/uploads/")
    .replace(/^api\/uploads\//i, "uploads/");
};

const fetchLogoBuffer = async (logoUrl) => {
  if (!(await isSafeRemoteUrl(logoUrl))) return null;
  return new Promise((resolve) => {
  const client = logoUrl.startsWith("https://") ? https : http;
  const request = client.get(logoUrl, { timeout: 6000 }, (response) => {
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      response.resume();
      resolve(fetchLogoBuffer(new URL(response.headers.location, logoUrl).toString()));
      return;
    }

    if (response.statusCode !== 200) {
      response.resume();
      resolve(null);
      return;
    }

    const chunks = [];
    let size = 0;
    response.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        request.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => resolve(Buffer.concat(chunks)));
  });

  request.on("timeout", () => {
    request.destroy();
    resolve(null);
  });
  request.on("error", () => resolve(null));
  });
};

const resolveLocalLogoPath = (logoPath) => {
  const normalized = normalizeLogoPath(logoPath);
  if (!normalized || isHttpUrl(normalized)) return null;

  const cleaned = normalized.startsWith("/") ? normalized.slice(1) : normalized;
  const candidates = [
    path.resolve(process.cwd(), cleaned),
    path.resolve(__dirname, "..", cleaned),
    path.resolve(__dirname, "..", "..", cleaned),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
};

const resolveLogoSource = async (logoUrl) => {
  if (!logoUrl) return null;
  const normalized = normalizeLogoPath(logoUrl);

  if (isHttpUrl(normalized)) {
    try {
      const parsed = new URL(normalized);
      const localUploadPath = resolveLocalLogoPath(parsed.pathname);
      if (localUploadPath) return localUploadPath;
    } catch {
      // Fall through to remote fetch for any odd but still fetchable URL string.
    }
    return fetchLogoBuffer(normalized);
  }

  return resolveLocalLogoPath(normalized);
};

// Bundled brand logo, shown on every invoice whose entity hasn't uploaded its own.
const DEFAULT_LOGO_PATH = path.resolve(__dirname, "..", "assets", "tetriq-logo.png");

// Resolve a region's logo, falling back to the bundled TetriQ logo so invoices
// are never logo-less.
const resolveLogoWithFallback = async (logoUrl) => {
  const resolved = await resolveLogoSource(logoUrl);
  if (resolved) return resolved;
  return fs.existsSync(DEFAULT_LOGO_PATH) ? DEFAULT_LOGO_PATH : null;
};

const ordinalDay = (day) => {
  if (day >= 11 && day <= 13) return `${day}th`;
  const rem = day % 10;
  if (rem === 1) return `${day}st`;
  if (rem === 2) return `${day}nd`;
  if (rem === 3) return `${day}rd`;
  return `${day}th`;
};

const formatDateLong = (value) => {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).substring(0, 10);

  return `${ordinalDay(d.getDate())} ${d.toLocaleDateString("en-GB", {
    month: "long",
    year: "numeric",
  })}`;
};

const buildDescription = (item, invoice) => {
  if (item?.description && String(item.description).trim()) {
    return String(item.description).trim();
  }

  const activity = String(item?.activity_label || "Consulting Services").trim();
  const candidate = String(item?.candidate_name || invoice?.candidate_name || "").trim();
  const jobTitle = String(item?.job_title || invoice?.job_title || "").trim();

  if (candidate && jobTitle) return `${activity} for ${candidate} (${jobTitle})`;
  if (candidate) return `${activity} for ${candidate}`;
  return activity;
};

const buildNormalizedLineItems = (invoice) => {
  const lineItems = Array.isArray(invoice.line_items) ? invoice.line_items : [];

  if (lineItems.length > 0) {
    return lineItems.map((item, index) => ({
      index,
      line_date: item.line_date || invoice.invoice_date,
      activity_label: item.activity_label || item.candidate_name || "Consulting Services",
      description: buildDescription(item, invoice),
      quantity: numeric(item.quantity),
      rate: numeric(item.rate || item.unit_price),
      amount: numeric(
        item.amount ||
          item.line_total ||
          numeric(item.quantity) * numeric(item.rate || item.unit_price),
      ),
    }));
  }

  return [
    {
      index: 0,
      line_date: invoice.invoice_date,
      activity_label: invoice.candidate_name || "Consulting Services",
      description: buildDescription({}, invoice),
      quantity: numeric(invoice.hours_or_units || 1),
      rate: numeric(invoice.bill_rate || 0),
      amount: numeric(invoice.subtotal || 0),
    },
  ];
};

const buildNormalizedTaxLines = (invoice) => {
  const taxLines = Array.isArray(invoice.tax_lines) ? invoice.tax_lines : [];

  if (taxLines.length > 0) {
    return taxLines.map((tax) => ({
      tax_name: safeText(tax.tax_name, "Tax"),
      tax_percent: numeric(tax.tax_percent),
      tax_amount: numeric(tax.tax_amount),
    }));
  }

  if (numeric(invoice.tax_amount) > 0) {
    return [{ tax_name: "Tax", tax_percent: 0, tax_amount: numeric(invoice.tax_amount) }];
  }

  return [];
};

const numberToWordsBelowThousand = (num) => {
  const ones = [
    "",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
  ];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  let result = "";
  const hundreds = Math.floor(num / 100);
  const rem = num % 100;

  if (hundreds) {
    result += `${ones[hundreds]} Hundred`;
    if (rem) result += " and ";
  }

  if (rem < 20) result += ones[rem];
  else {
    result += tens[Math.floor(rem / 10)];
    if (rem % 10) result += ` ${ones[rem % 10]}`;
  }

  return result.trim();
};

const integerToIndianWords = (num) => {
  if (!num) return "Zero";

  const pieces = [];
  const crore = Math.floor(num / 10000000);
  num %= 10000000;
  const lakh = Math.floor(num / 100000);
  num %= 100000;
  const thousand = Math.floor(num / 1000);
  num %= 1000;

  if (crore) pieces.push(`${numberToWordsBelowThousand(crore)} Crore`);
  if (lakh) pieces.push(`${numberToWordsBelowThousand(lakh)} Lakh`);
  if (thousand) pieces.push(`${numberToWordsBelowThousand(thousand)} Thousand`);
  if (num) pieces.push(numberToWordsBelowThousand(num));

  return pieces.join(" ").trim();
};

const integerToInternationalWords = (num) => {
  if (!num) return "Zero";

  const pieces = [];
  const billion = Math.floor(num / 1000000000);
  num %= 1000000000;
  const million = Math.floor(num / 1000000);
  num %= 1000000;
  const thousand = Math.floor(num / 1000);
  num %= 1000;

  if (billion) pieces.push(`${numberToWordsBelowThousand(billion)} Billion`);
  if (million) pieces.push(`${numberToWordsBelowThousand(million)} Million`);
  if (thousand) pieces.push(`${numberToWordsBelowThousand(thousand)} Thousand`);
  if (num) pieces.push(numberToWordsBelowThousand(num));

  return pieces.join(" ").trim();
};

const CURRENCY_WORD_UNITS = {
  USD: { whole: "Dollars", sub: "Cents" },
  EUR: { whole: "Euros", sub: "Cents" },
  GBP: { whole: "Pounds", sub: "Pence" },
  INR: { whole: "Rupees", sub: "Paise" },
};

const amountInWords = (value, currency = "USD") => {
  const code = String(currency || "USD").toUpperCase();
  const amount = numeric(value);
  const whole = Math.floor(amount);
  const decimal = Math.round((amount - whole) * 100);

  const units = CURRENCY_WORD_UNITS[code] || { whole: code, sub: "Cents" };
  const toWords = code === "INR" ? integerToIndianWords : integerToInternationalWords;

  let output = `${toWords(whole)} ${units.whole}`;
  if (decimal > 0) output += ` and ${toWords(decimal)} ${units.sub}`;
  return `${output} only.`;
};

const normalizeTemplate = (value) => {
  const normalized = String(value || "CLASSIC").trim().toUpperCase();
  return INVOICE_TEMPLATES.has(normalized) ? normalized : "CLASSIC";
};

const normalizeHexColor = (value, fallback) => {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  const withHash = raw.startsWith("#") ? raw : `#${raw}`;
  return /^#[0-9a-fA-F]{6}$/.test(withHash) ? withHash.toUpperCase() : fallback;
};

const paletteForTemplate = (invoice, template) => {
  const primary = normalizeHexColor(invoice.invoice_brand_primary_color, "#00695C");
  const accent = normalizeHexColor(invoice.invoice_brand_accent_color, "#00897B");

  if (template === "EXECUTIVE") {
    return {
      titleColor: accent,
      borderColor: accent,
      headerFill: "#E0F2F1",
      footerAccent: accent,
      textMuted: "#334155",
      headerFont: "Helvetica-Bold",
    };
  }

  if (template === "MINIMAL") {
    return {
      titleColor: primary,
      borderColor: "#9CA3AF",
      headerFill: "#F5F5F5",
      footerAccent: "#9CA3AF",
      textMuted: "#525252",
      headerFont: "Helvetica",
    };
  }

  return {
    titleColor: primary,
    borderColor: "#111111",
    headerFill: "#EFEFEF",
    footerAccent: accent,
    textMuted: "#4B5563",
    headerFont: "Helvetica-Bold",
  };
};

const pageBottom = () => PAGE.height - PAGE.marginBottom;
const contentWidth = () => PAGE.width - PAGE.marginLeft - PAGE.marginRight;

const drawFooter = (doc, addressText, palette, footerNote) => {
  const footerY = PAGE.height - 24;
  doc
    .moveTo(PAGE.marginLeft, footerY)
    .lineTo(PAGE.width - PAGE.marginRight, footerY)
    .lineWidth(1.8)
    .strokeColor(palette.footerAccent)
    .stroke();

  const footerText = [addressText, safeText(footerNote, "")]
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .join("  •  ");

  doc
    .font("Times-Roman")
    .fontSize(8.8)
    .fillColor("#111111")
    .text(footerText, PAGE.marginLeft, footerY + 5, {
      width: contentWidth(),
      align: "center",
    });
};

const drawPageHeader = (doc, invoice, palette, template, isContinuation = false) => {
  const logo = invoice._resolved_logo_source || null;
  const companyLines = [safeText(invoice.company_name).toUpperCase(), ...splitAddressLines(invoice.company_address)];
  const clientLines = [safeText(invoice.client_name).toUpperCase(), ...splitAddressLines(invoice.billing_address)];

  if (logo && !isContinuation) {
    try {
      doc.image(logo, 405, 18, { fit: [145, 60], align: "right", valign: "top" });
    } catch (error) {
      console.error("Logo render error:", error.message);
    }
  }

  if (isContinuation) {
    doc
      .font(palette.headerFont)
      .fontSize(12.5)
      .fillColor(palette.titleColor)
      .text(`Invoice Continued - ${safeText(invoice.invoice_number)}`, 48, 42, { width: 300 });
    return 72;
  }

  doc
    .font(palette.headerFont)
    .fontSize(21)
    .fillColor(palette.titleColor)
    .text(template === "MINIMAL" ? "INVOICE" : "Invoice", 0, 88, {
      align: "center",
      underline: true,
    });

  let leftY = 138;
  companyLines.forEach((line, index) => {
    doc
      .font(index === 0 ? "Helvetica-Bold" : "Helvetica")
      .fontSize(index === 0 ? 11.8 : 10.1)
      .fillColor("#111111")
      .text(line, 48, leftY, { width: 280 });
    leftY = doc.y + 1;
  });

  if (invoice.company_id_value) {
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .text(`${safeText(invoice.company_id_label, "ID")}: ${invoice.company_id_value}`, 48, leftY, {
        width: 280,
      });
    leftY = doc.y + 1;
  }

  const rightX = 398;
  let rightY = 144;
  doc.font("Helvetica-Bold").fontSize(10.3).fillColor("#111111");
  doc.text(`INVOICE No: ${safeText(invoice.invoice_number)}`, rightX, rightY, { width: 150 });
  rightY += 17;
  doc.text(`DATE: ${formatDateLong(invoice.invoice_date)}`, rightX, rightY, { width: 150 });
  rightY += 17;
  doc.text(`DUE DATE: ${formatDateLong(invoice.due_date)}`, rightX, rightY, { width: 150 });

  let y = Math.max(leftY, rightY) + 14;
  doc.font("Helvetica-Bold").fontSize(10.6).text("TO,", 48, y, { width: 40 });
  y += 20;

  clientLines.forEach((line, index) => {
    doc
      .font(index === 0 ? "Helvetica-Bold" : "Helvetica")
      .fontSize(index === 0 ? 10.8 : 10)
      .text(line, 48, y, { width: 300 });
    y = doc.y + 1;
  });

  if (invoice.tax_identifier) {
    doc
      .font("Helvetica-Bold")
      .fontSize(10)
      .text(`GSTIN: ${invoice.tax_identifier}`, 48, y, { width: 300 });
    y = doc.y + 1;
  }

  return y + 14;
};

const drawColumnDividers = (doc, tableX, y, height, borderColor) => {
  COL_DIVIDERS.forEach((dx) => {
    doc.moveTo(tableX + dx, y).lineTo(tableX + dx, y + height).lineWidth(1).strokeColor(borderColor).stroke();
  });
};

const drawTableHeader = (doc, tableX, y, palette) => {
  const headerH = 24;

  doc.save().rect(tableX, y, TABLE_WIDTH, headerH).fill(palette.headerFill).restore();
  doc.lineWidth(1).strokeColor(palette.borderColor).rect(tableX, y, TABLE_WIDTH, headerH).stroke();
  drawColumnDividers(doc, tableX, y, headerH, palette.borderColor);

  doc.font(palette.headerFont).fontSize(9.4).fillColor("#111111");
  const ty = y + 8;
  doc.text("#", tableX, ty, { width: COLS.sno, align: "center" });
  doc.text("DESCRIPTION", tableX + COLS.sno + 8, ty, { width: COLS.desc - 12, align: "left" });
  doc.text("QTY", tableX + COLS.sno + COLS.desc, ty, { width: COLS.qty, align: "center" });
  doc.text("RATE", tableX + COLS.sno + COLS.desc + COLS.qty, ty, { width: COLS.rate - 8, align: "right" });
  doc.text("AMOUNT", tableX + AMOUNT_X, ty, { width: COLS.amount - 8, align: "right" });

  return y + headerH;
};

const drawMultipleInvoice = (doc, invoice) => {
  const lineItems = buildNormalizedLineItems(invoice);
  const taxLines = buildNormalizedTaxLines(invoice);
  const footerAddress = splitAddressLines(invoice.company_address).join(", ");
  const template = normalizeTemplate(invoice.invoice_template || invoice.region_invoice_template);
  const palette = paletteForTemplate(invoice, template);
  const currency = safeText(invoice.currency, "USD").toUpperCase();

  const tableX = 48;
  const tableWidth = TABLE_WIDTH;
  const firstPageParticularsLimit = 12;
  const nextPageParticularsLimit = 20;

  let y = drawPageHeader(doc, invoice, palette, template, false);
  y = drawTableHeader(doc, tableX, y, palette);

  let itemsOnCurrentPage = 0;
  let isFirstItemsPage = true;

  for (let index = 0; index < lineItems.length; index += 1) {
    const item = lineItems[index];
    const description = safeText(item.description, "-").trim();
    const pageLimit = isFirstItemsPage ? firstPageParticularsLimit : nextPageParticularsLimit;

    doc.font("Helvetica").fontSize(9.4);
    const measuredHeight = doc.heightOfString(description, { width: COLS.desc - 16, lineGap: 1.2 });
    const rowHeight = Math.max(24, measuredHeight + 12);

    if (itemsOnCurrentPage >= pageLimit || y + rowHeight > pageBottom() - 26) {
      drawFooter(doc, footerAddress, palette, invoice.invoice_brand_footer_note);
      doc.addPage();
      y = drawPageHeader(doc, invoice, palette, template, true);
      y = drawTableHeader(doc, tableX, y, palette);
      itemsOnCurrentPage = 0;
      isFirstItemsPage = false;
    }

    // zebra striping for readability on multi-line invoices
    if (index % 2 === 1) {
      doc.save().rect(tableX, y, tableWidth, rowHeight).fill("#FAFAFA").restore();
    }
    doc.lineWidth(1).strokeColor(palette.borderColor).rect(tableX, y, tableWidth, rowHeight).stroke();
    drawColumnDividers(doc, tableX, y, rowHeight, palette.borderColor);

    const qty = formatQuantity(item.quantity);
    const rate = numeric(item.rate) ? moneyWithCurrency(currency, item.rate) : "";

    doc.font("Helvetica").fontSize(9.4).fillColor("#111111");
    doc.text(String(index + 1), tableX, y + 6, { width: COLS.sno, align: "center" });
    doc.text(description, tableX + COLS.sno + 8, y + 6, { width: COLS.desc - 16, lineGap: 1.2 });
    doc.text(qty, tableX + COLS.sno + COLS.desc, y + 6, { width: COLS.qty, align: "center" });
    doc.text(rate, tableX + COLS.sno + COLS.desc + COLS.qty, y + 6, { width: COLS.rate - 8, align: "right" });
    doc.text(moneyCompactByCurrency(currency, item.amount), tableX + AMOUNT_X, y + 6, {
      width: COLS.amount - 8,
      align: "right",
    });

    y += rowHeight;
    itemsOnCurrentPage += 1;
  }

  const labelWidth = TABLE_WIDTH - COLS.amount; // summary label spans all but the amount column
  const summaryRows = [
    ["Subtotal", moneyCompactByCurrency(currency, invoice.subtotal), false],
    ...taxLines.map((tax) => [
      tax.tax_percent ? `${tax.tax_name} @ ${tax.tax_percent}%` : tax.tax_name,
      moneyCompactByCurrency(currency, tax.tax_amount),
      false,
    ]),
    ["Total", moneyCompactByCurrency(currency, invoice.total_amount), true],
  ];

  const estimatedSummaryHeight = summaryRows.length * 22 + 26 + 92;
  if (y + estimatedSummaryHeight > pageBottom() - 20) {
    drawFooter(doc, footerAddress, palette, invoice.invoice_brand_footer_note);
    doc.addPage();
    y = drawPageHeader(doc, invoice, palette, template, true);
    y = drawTableHeader(doc, tableX, y, palette);
  }

  summaryRows.forEach(([label, value, isTotal]) => {
    const h = 22;
    if (isTotal) {
      doc.save().rect(tableX, y, tableWidth, h).fill(palette.headerFill).restore();
    }
    doc.lineWidth(isTotal ? 1.2 : 1).strokeColor(palette.borderColor).rect(tableX, y, tableWidth, h).stroke();
    doc
      .moveTo(tableX + AMOUNT_X, y)
      .lineTo(tableX + AMOUNT_X, y + h)
      .strokeColor(palette.borderColor)
      .stroke();

    doc.font("Helvetica-Bold").fontSize(isTotal ? 10.6 : 9.6).fillColor("#111111");
    doc.text(label, tableX + 8, y + 6, { width: labelWidth - 16, align: "right" });
    doc.text(value, tableX + AMOUNT_X, y + 6, { width: COLS.amount - 8, align: "right" });

    y += h;
  });

  const wordsY = y + 10;
  const wordsLabelW = 110;
  const wordsH = 24;

  doc.lineWidth(1).strokeColor(palette.borderColor).rect(tableX, wordsY, wordsLabelW, wordsH).stroke();
  doc
    .rect(tableX + wordsLabelW, wordsY, tableWidth - wordsLabelW, wordsH)
    .strokeColor(palette.borderColor)
    .stroke();

  doc.font("Helvetica-Bold").fontSize(9.4).fillColor("#111111").text("Amount in Words", tableX + 6, wordsY + 6, {
    width: wordsLabelW - 12,
  });
  doc.font("Helvetica").fontSize(9.4).text(amountInWords(invoice.total_amount, currency), tableX + wordsLabelW + 6, wordsY + 6, {
    width: tableWidth - wordsLabelW - 12,
  });

  const bankY = wordsY + 36;
  const bankRows = [
    ["Account Holder Name", safeText(invoice.bank_account_name || invoice.company_name)],
    ["Account Number", safeText(invoice.bank_account_number)],
    ["Bank Name", safeText(invoice.bank_name)],
    ["Branch Name", safeText(invoice.bank_branch_details || "-")],
    ["IFSC / SWIFT", safeText(invoice.bank_swift_ifsc || invoice.bank_routing_number)],
  ];

  bankRows.forEach(([label, value], idx) => {
    const lineY = bankY + idx * 15;
    doc.font("Helvetica-Bold").fontSize(9.4).text(label, tableX, lineY, { width: 130 });
    doc.font("Helvetica").fontSize(9.4).text(value, tableX + 135, lineY, { width: 210 });
  });

  const signY = bankY + bankRows.length * 15 + 16;
  doc.font("Helvetica").fontSize(10).text(`For ${safeText(invoice.company_name)}.`, tableX, signY);
  doc.font("Helvetica-Bold").text("Authorized Signatory", tableX, signY + 17);

  drawFooter(doc, footerAddress, palette, invoice.invoice_brand_footer_note);
};

const newDocument = () =>
  new PDFDocument({ size: "A4", margin: 0, autoFirstPage: true, bufferPages: false });

const invoicePdfFileName = (invoice) =>
  `Invoice ${safeText(invoice.invoice_number, "invoice")}.pdf`;

const drawInvoice = async (doc, invoice) => {
  const line_items = buildNormalizedLineItems(invoice);
  const tax_lines = buildNormalizedTaxLines(invoice);

  const subtotal = numeric(invoice.subtotal) || line_items.reduce((sum, item) => sum + numeric(item.amount), 0);
  const taxAmount = numeric(invoice.tax_amount) || tax_lines.reduce((sum, tax) => sum + numeric(tax.tax_amount), 0);
  const total_amount = numeric(invoice.total_amount) || subtotal + taxAmount;

  const enrichedInvoice = {
    ...invoice,
    line_items,
    tax_lines,
    subtotal,
    tax_amount: taxAmount,
    total_amount,
    balance_outstanding: numeric(invoice.balance_outstanding) || total_amount,
    invoice_template: normalizeTemplate(invoice.invoice_template || invoice.region_invoice_template || "CLASSIC"),
    _resolved_logo_source: await resolveLogoWithFallback(invoice.logo_url),
  };

  drawMultipleInvoice(doc, enrichedInvoice);
};

const generateInvoicePdf = async (invoice, res) => {
  const doc = newDocument();
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${invoicePdfFileName(invoice)}"`);
  doc.pipe(res);
  await drawInvoice(doc, invoice);
  doc.end();
};

const renderInvoicePdfBuffer = (invoice) =>
  new Promise((resolve, reject) => {
    const doc = newDocument();
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    drawInvoice(doc, invoice)
      .then(() => doc.end())
      .catch(reject);
  });

module.exports = {
  generateInvoicePdf,
  renderInvoicePdfBuffer,
  invoicePdfFileName,
};

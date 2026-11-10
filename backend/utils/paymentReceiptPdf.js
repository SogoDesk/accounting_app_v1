const PDFDocument = require("pdfkit");

// Helvetica (pdfkit's built-in) has no ₹ glyph, so use the symbol only for
// currencies it can render and fall back to the ISO code otherwise.
const SYMBOL = { USD: "$", GBP: "£", EUR: "€" };
const money = (amount, currency) => {
  const code = String(currency || "USD").toUpperCase();
  const n = Number(amount || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return SYMBOL[code] ? `${SYMBOL[code]} ${n}` : `${code} ${n}`;
};
const fmtDate = (d) => {
  if (!d) return "-";
  const s = String(d).slice(0, 10);
  const parts = s.split("-");
  if (parts.length !== 3) return s;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
};
const txt = (v, fallback = "-") => {
  const s = String(v == null ? "" : v).trim();
  return s || fallback;
};

const INK = "#14131f";
const MUTED = "#8b8a9c";
const ACCENT = "#5b4de3";
const BORDER = "#e6e4f2";
const SUNKEN = "#f7f6fb";

// Clean, self-contained payment-receipt PDF (no logos/templates).
const generatePaymentReceiptPdf = (payment, res) => {
  const doc = new PDFDocument({ size: "A4", margin: 48 });
  const code = txt(payment.payment_code || payment.reference_number, "receipt");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="Receipt ${code}.pdf"`);
  doc.pipe(res);

  const ccy = payment.currency;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const colGap = 24;
  const colW = (width - colGap) / 2;

  // ---- Masthead -----------------------------------------------------------
  doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(9)
    .text("PAYMENT RECEIPT", left, 52, { characterSpacing: 1.5 });
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(24)
    .text(code, left, 66);
  doc.fillColor(MUTED).font("Helvetica").fontSize(10)
    .text(`${fmtDate(payment.payment_date)}  ·  ${txt(String(payment.payment_mode || "").replace(/_/g, " "))}`, left, 96);

  // Right: RECEIVED badge + amount
  const badgeW = 74;
  const badgeX = right - badgeW;
  doc.roundedRect(badgeX, 54, badgeW, 20, 6).fill("#e6f7ef");
  doc.fillColor("#1f9d57").font("Helvetica-Bold").fontSize(8.5)
    .text("RECEIVED", badgeX, 60, { width: badgeW, align: "center", characterSpacing: 0.5 });
  doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8.5)
    .text("AMOUNT RECEIVED", left, 84, { width, align: "right", characterSpacing: 0.5 });
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(18)
    .text(money(payment.amount_received, ccy), left, 96, { width, align: "right" });

  let y = 128;
  doc.moveTo(left, y).lineTo(right, y).strokeColor(BORDER).lineWidth(1).stroke();
  y += 20;

  // ---- Received from + meta ----------------------------------------------
  const labelVal = (x, yy, label, value, w) => {
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8).text(label.toUpperCase(), x, yy, { width: w, characterSpacing: 0.4 });
    doc.fillColor(INK).font("Helvetica").fontSize(10.5).text(txt(value), x, yy + 12, { width: w });
  };

  doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8).text("RECEIVED FROM", left, y, { characterSpacing: 0.4 });
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(13).text(txt(payment.client_name), left, y + 13, { width: colW });
  const sub = [payment.candidate_name, payment.placement_code].filter(Boolean).join("  ·  ");
  if (sub) doc.fillColor(MUTED).font("Helvetica").fontSize(9.5).text(sub, left, y + 31, { width: colW });

  const mx = left + colW + colGap;
  const metaRow = (yy, label, value) => {
    doc.fillColor(MUTED).font("Helvetica").fontSize(9.5).text(label, mx, yy, { width: colW * 0.5 });
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(9.5).text(txt(value), mx, yy, { width: colW, align: "right" });
  };
  metaRow(y, "Payment date", fmtDate(payment.payment_date));
  metaRow(y + 18, "Method", String(payment.payment_mode || "-").replace(/_/g, " "));
  metaRow(y + 36, "Reference", payment.reference_number);
  metaRow(y + 54, "Currency", ccy);

  y += 92;

  // ---- Applied to invoice -------------------------------------------------
  doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8).text("APPLIED TO INVOICE", left, y, { characterSpacing: 0.4 });
  y += 14;
  const cardH = 70;
  doc.roundedRect(left, y, width, cardH, 8).fillAndStroke(SUNKEN, BORDER);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(12).text(txt(payment.invoice_number), left + 16, y + 12);
  doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(9)
    .text(txt(String(payment.invoice_status || "").replace(/_/g, " ")).toUpperCase(), left, y + 13, { width: width - 16, align: "right" });
  const cellW = (width - 32) / 3;
  const cell = (i, label, value) => {
    const cx = left + 16 + i * cellW;
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(7.5).text(label.toUpperCase(), cx, y + 38, { width: cellW - 8, characterSpacing: 0.3 });
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(11).text(value, cx, y + 50, { width: cellW - 8 });
  };
  cell(0, "Invoice total", money(payment.invoice_total_amount, ccy));
  cell(1, "Applied", money(payment.amount_received, ccy));
  cell(2, "Balance remaining", money(payment.invoice_balance_outstanding, ccy));

  y += cardH + 24;

  // ---- Amount breakdown (right-aligned) ----------------------------------
  const sumX = left + width - 240;
  const sumW = 240;
  const tds = payment.tds_applicable && Number(payment.tds_amount || 0) > 0;
  const gross = Number(payment.amount_received || 0) + (tds ? Number(payment.tds_amount || 0) : 0);
  const sumRow = (yy, label, value, opts = {}) => {
    doc.fillColor(opts.strong ? INK : MUTED).font(opts.strong ? "Helvetica-Bold" : "Helvetica").fontSize(opts.strong ? 12 : 10)
      .text(label, sumX, yy, { width: sumW * 0.5 });
    doc.fillColor(opts.color || INK).font("Helvetica-Bold").fontSize(opts.strong ? 12 : 10)
      .text(value, sumX, yy, { width: sumW, align: "right" });
  };
  if (tds) {
    sumRow(y, "Gross", money(gross, ccy));
    y += 18;
    sumRow(y, `TDS (${Number(payment.tds_percent || 0)}%)`, `- ${money(payment.tds_amount, ccy)}`, { color: "#1f9d57" });
    y += 20;
  }
  doc.moveTo(sumX, y - 4).lineTo(right, y - 4).strokeColor(BORDER).lineWidth(1).stroke();
  sumRow(y + 4, "Net received", money(payment.amount_received, ccy), { strong: true });
  y += 40;

  // ---- Notes --------------------------------------------------------------
  if (txt(payment.notes, "")) {
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8).text("NOTES", left, y, { characterSpacing: 0.4 });
    doc.fillColor(INK).font("Helvetica").fontSize(10).text(txt(payment.notes), left, y + 13, { width });
  }

  // ---- Footer -------------------------------------------------------------
  doc.fillColor(MUTED).font("Helvetica").fontSize(8)
    .text(`${txt(payment.region_name, "")}`, left, doc.page.height - 60, { width: width / 2 });
  doc.fillColor(MUTED).font("Helvetica").fontSize(8)
    .text("This is a system-generated payment receipt.", left, doc.page.height - 60, { width, align: "right" });

  doc.end();
};

module.exports = { generatePaymentReceiptPdf };

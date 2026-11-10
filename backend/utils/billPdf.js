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
  const p = s.split("-");
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : s;
};
const num = (v) => { const n = Number(v || 0); return Number.isNaN(n) ? 0 : n; };
const txt = (v, fallback = "-") => { const s = String(v == null ? "" : v).trim(); return s || fallback; };

const INK = "#14131f";
const MUTED = "#8b8a9c";
const ACCENT = "#5b4de3";
const BORDER = "#e6e4f2";
const SUNKEN = "#f7f6fb";

// Clean, self-contained vendor-bill PDF (no logos/templates).
const generateBillPdf = (bill, res) => {
  const doc = new PDFDocument({ size: "A4", margin: 48 });
  const number = txt(bill.bill_number, "bill");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="Bill ${number}.pdf"`);
  doc.pipe(res);

  const ccy = bill.currency;
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;

  const balance = num(bill.balance_outstanding);
  const paid = num(bill.payment_paid_amount);
  const paidClosed = balance <= 0 && num(bill.total_amount) > 0;
  const payLabel = paidClosed ? "PAID" : paid > 0 ? "PARTIALLY PAID" : "UNPAID";

  // ---- Masthead -----------------------------------------------------------
  doc.fillColor(ACCENT).font("Helvetica-Bold").fontSize(9)
    .text("VENDOR BILL", left, 52, { characterSpacing: 1.5 });
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(23).text(number, left, 66, { width: width * 0.62 });
  doc.fillColor(MUTED).font("Helvetica").fontSize(10).text(txt(bill.region_name), left, doc.y + 2, { width: width * 0.62 });

  // Right: status chips + amount
  const chip = (label, x, bg, fg) => {
    const w = Math.max(52, label.length * 6.2 + 16);
    doc.roundedRect(x - w, 54, w, 18, 6).fill(bg);
    doc.fillColor(fg).font("Helvetica-Bold").fontSize(7.5).text(label, x - w, 59, { width: w, align: "center", characterSpacing: 0.5 });
    return w;
  };
  const approval = String(bill.approval_status || "").toUpperCase();
  const apprBg = approval === "APPROVED" ? "#e6f7ef" : approval === "REJECTED" ? "#fdecec" : "#fff4e5";
  const apprFg = approval === "APPROVED" ? "#1f9d57" : approval === "REJECTED" ? "#d64545" : "#b7791f";
  let cx = right;
  if (approval) { const w = chip(approval.replace(/_/g, " "), cx, apprBg, apprFg); cx -= w + 6; }
  const payBg = payLabel === "PAID" ? "#e6f7ef" : payLabel === "UNPAID" ? "#f1f0f6" : "#fff4e5";
  const payFg = payLabel === "PAID" ? "#1f9d57" : payLabel === "UNPAID" ? "#6b6a7b" : "#b7791f";
  chip(payLabel, cx, payBg, payFg);

  doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8.5).text("AMOUNT", left, 84, { width, align: "right", characterSpacing: 0.5 });
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(18).text(money(balance > 0 ? balance : bill.total_amount, ccy), left, 96, { width, align: "right" });

  let y = 128;
  doc.moveTo(left, y).lineTo(right, y).strokeColor(BORDER).lineWidth(1).stroke();
  y += 20;

  // ---- Bill from + meta ---------------------------------------------------
  const colW = (width - 24) / 2;
  doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8).text("BILL FROM", left, y, { characterSpacing: 0.4 });
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(13).text(txt(bill.vendor_name), left, y + 13, { width: colW });
  doc.fillColor(MUTED).font("Helvetica").fontSize(9.5).text(`Vendor · ${txt(bill.region_name)}`, left, y + 31, { width: colW });

  const mx = left + colW + 24;
  const metaRow = (yy, label, value) => {
    doc.fillColor(MUTED).font("Helvetica").fontSize(9.5).text(label, mx, yy, { width: colW * 0.5 });
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(9.5).text(txt(value), mx, yy, { width: colW, align: "right" });
  };
  metaRow(y, "Bill date", fmtDate(bill.bill_date));
  metaRow(y + 18, "Due date", fmtDate(bill.due_date));
  metaRow(y + 36, "Currency", ccy);
  if (bill.external_reference) metaRow(y + 54, "Reference", bill.external_reference);

  y += bill.external_reference ? 88 : 74;

  // ---- Line items ---------------------------------------------------------
  const cQty = right - 250;
  const cRate = right - 150;
  const cAmt = right;
  doc.rect(left, y, width, 24).fill(SUNKEN);
  doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8);
  doc.text("DESCRIPTION", left + 12, y + 8, { width: cQty - left - 20, characterSpacing: 0.4 });
  doc.text("QTY", cQty, y + 8, { width: 60, align: "right" });
  doc.text("UNIT PRICE", cRate - 60, y + 8, { width: 90, align: "right" });
  doc.text("LINE TOTAL", cAmt - 100, y + 8, { width: 100, align: "right" });
  y += 24;

  const items = bill.line_items || [];
  if (!items.length) {
    doc.fillColor(MUTED).font("Helvetica").fontSize(10).text("No line items on this bill.", left + 12, y + 10);
    y += 34;
  } else {
    items.forEach((it) => {
      const descH = doc.font("Helvetica").fontSize(10).heightOfString(txt(it.description), { width: cQty - left - 24 });
      const rowH = Math.max(26, descH + 14);
      doc.fillColor(INK).font("Helvetica").fontSize(10).text(txt(it.description), left + 12, y + 7, { width: cQty - left - 24 });
      doc.font("Helvetica").fontSize(10);
      doc.text(num(it.quantity).toFixed(2), cQty, y + 7, { width: 60, align: "right" });
      doc.text(money(it.unit_price, ccy), cRate - 60, y + 7, { width: 90, align: "right" });
      doc.font("Helvetica-Bold").text(money(it.line_total, ccy), cAmt - 100, y + 7, { width: 100, align: "right" });
      y += rowH;
      doc.moveTo(left, y).lineTo(right, y).strokeColor(BORDER).lineWidth(0.5).stroke();
    });
  }

  y += 18;

  // ---- Totals (right-aligned) --------------------------------------------
  const sumX = right - 240;
  const sumW = 240;
  const sumRow = (yy, label, value, opts = {}) => {
    doc.fillColor(opts.strong ? INK : MUTED).font(opts.strong ? "Helvetica-Bold" : "Helvetica").fontSize(opts.strong ? 12 : 10)
      .text(label, sumX, yy, { width: sumW * 0.5 });
    doc.fillColor(opts.color || INK).font("Helvetica-Bold").fontSize(opts.strong ? 12 : 10)
      .text(value, sumX, yy, { width: sumW, align: "right" });
  };
  if (bill.subtotal != null) { sumRow(y, "Subtotal", money(bill.subtotal, ccy)); y += 18; }
  if (bill.tax_amount != null) { sumRow(y, "Tax", money(bill.tax_amount, ccy)); y += 18; }
  doc.moveTo(sumX, y).lineTo(right, y).strokeColor(BORDER).lineWidth(1).stroke();
  y += 6;
  sumRow(y, "Total", money(bill.total_amount, ccy), { strong: true });
  y += 20;
  sumRow(y, "Paid", `- ${money(paid, ccy)}`, { color: "#1f9d57" });
  y += 18;
  doc.roundedRect(sumX, y, sumW, 26, 6).fill(balance > 0 ? "#fdecec" : SUNKEN);
  doc.fillColor(balance > 0 ? "#d64545" : INK).font("Helvetica-Bold").fontSize(11)
    .text("Balance due", sumX + 10, y + 8, { width: sumW * 0.5 });
  doc.fillColor(balance > 0 ? "#d64545" : INK).font("Helvetica-Bold").fontSize(11)
    .text(money(balance, ccy), sumX, y + 8, { width: sumW - 10, align: "right" });
  y += 42;

  // ---- Notes --------------------------------------------------------------
  if (txt(bill.notes, "")) {
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8).text("NOTES", left, y, { characterSpacing: 0.4 });
    doc.fillColor(INK).font("Helvetica").fontSize(10).text(txt(bill.notes), left, y + 13, { width });
  }

  // ---- Footer -------------------------------------------------------------
  doc.fillColor(MUTED).font("Helvetica").fontSize(8)
    .text("This is a system-generated vendor bill.", left, doc.page.height - 60, { width, align: "right" });

  doc.end();
};

module.exports = { generateBillPdf };

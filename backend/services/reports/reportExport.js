// =============================================================================
// reportExport — render a normalized report descriptor to Excel (.xlsx), PDF, or
// CSV. One descriptor, three formats, so every report can be downloaded in a
// readable, consistently-formatted way.
//
// Descriptor shape:
//   {
//     title:    "Trial Balance",
//     subtitle: "As of 2026-06-29 · USD",          // optional
//     columns:  [{ key, label, type? }],            // type: 'money' | 'number' | 'date' | 'text'
//     rows:     [ { <key>: value, ... } ],
//     totals:   { <key>: value },                   // optional totals row (by column key)
//   }
// =============================================================================

const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");

const isMoney = (type) => type === "money";
const isNumeric = (type) => type === "money" || type === "number";

const fmtMoney = (v) =>
  (Number(v) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const cellText = (row, col) => {
  const v = row[col.key];
  if (v === null || v === undefined) return "";
  if (isMoney(col.type)) return fmtMoney(v);
  return String(v);
};

// ---- Excel ------------------------------------------------------------------
async function toXlsxBuffer(report) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Accounting App";
  const ws = wb.addWorksheet((report.title || "Report").slice(0, 31));
  const cols = report.columns || [];
  const lastCol = Math.max(cols.length, 1);

  // Title + subtitle (merged across columns)
  ws.mergeCells(1, 1, 1, lastCol);
  ws.getCell(1, 1).value = report.title || "Report";
  ws.getCell(1, 1).font = { bold: true, size: 14 };
  if (report.subtitle) {
    ws.mergeCells(2, 1, 2, lastCol);
    ws.getCell(2, 1).value = report.subtitle;
    ws.getCell(2, 1).font = { italic: true, color: { argb: "FF6B7280" } };
  }

  const headerRowIdx = report.subtitle ? 4 : 3;
  const header = ws.getRow(headerRowIdx);
  cols.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.label;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D4ED8" } };
    cell.alignment = { horizontal: isNumeric(c.type) ? "right" : "left" };
  });
  header.commit();

  (report.rows || []).forEach((row) => {
    const r = ws.addRow(cols.map((c) => {
      const v = row[c.key];
      if (isNumeric(c.type)) return v == null ? null : Number(v);
      return v == null ? "" : String(v);
    }));
    cols.forEach((c, i) => {
      if (isMoney(c.type)) { r.getCell(i + 1).numFmt = "#,##0.00"; r.getCell(i + 1).alignment = { horizontal: "right" }; }
      else if (c.type === "number") r.getCell(i + 1).alignment = { horizontal: "right" };
    });
  });

  if (report.totals) {
    const totalRow = ws.addRow(cols.map((c, i) => {
      if (i === 0) return "Total";
      const v = report.totals[c.key];
      return isNumeric(c.type) && v != null ? Number(v) : (v == null ? "" : v);
    }));
    totalRow.eachCell((cell, i) => {
      cell.font = { bold: true };
      cell.border = { top: { style: "thin" } };
      if (isMoney(cols[i - 1] && cols[i - 1].type)) cell.numFmt = "#,##0.00";
    });
  }

  // Auto-ish column widths
  cols.forEach((c, i) => {
    const headerLen = String(c.label || "").length;
    let maxLen = headerLen;
    (report.rows || []).forEach((row) => { maxLen = Math.max(maxLen, cellText(row, c).length); });
    ws.getColumn(i + 1).width = Math.min(Math.max(maxLen + 2, 10), 50);
  });

  return wb.xlsx.writeBuffer();
}

// ---- PDF --------------------------------------------------------------------
function streamPdf(report, res, filename) {
  const doc = new PDFDocument({ size: "A4", margin: 40, layout: "landscape" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  doc.pipe(res);

  const cols = report.columns || [];
  const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const startX = doc.page.margins.left;

  doc.fontSize(16).font("Helvetica-Bold").text(report.title || "Report");
  if (report.subtitle) doc.moveDown(0.2).fontSize(10).font("Helvetica").fillColor("#6B7280").text(report.subtitle);
  doc.fillColor("#111827").moveDown(0.6);

  // Column widths: numeric columns narrower, first text column widest.
  const weights = cols.map((c) => (isNumeric(c.type) ? 1 : 1.6));
  const wsum = weights.reduce((a, b) => a + b, 0) || 1;
  const widths = weights.map((w) => (w / wsum) * pageWidth);

  const rowHeight = 18;
  let y = doc.y;
  const drawRow = (values, opts = {}) => {
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom) { doc.addPage(); y = doc.page.margins.top; }
    let x = startX;
    if (opts.fill) { doc.rect(startX, y, pageWidth, rowHeight).fill(opts.fill); doc.fillColor(opts.color || "#111827"); }
    doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor(opts.color || "#111827");
    cols.forEach((c, i) => {
      const align = isNumeric(c.type) ? "right" : "left";
      doc.text(String(values[i] ?? ""), x + 4, y + 5, { width: widths[i] - 8, align, ellipsis: true });
      x += widths[i];
    });
    if (opts.line) doc.moveTo(startX, y + rowHeight).lineTo(startX + pageWidth, y + rowHeight).strokeColor("#E5E7EB").stroke();
    y += rowHeight;
  };

  drawRow(cols.map((c) => c.label), { fill: "#1D4ED8", color: "#FFFFFF", bold: true });
  (report.rows || []).forEach((row) => drawRow(cols.map((c) => cellText(row, c)), { line: true }));
  if (report.totals) {
    drawRow(cols.map((c, i) => (i === 0 ? "Total" : (report.totals[c.key] != null && isMoney(c.type) ? fmtMoney(report.totals[c.key]) : (report.totals[c.key] ?? "")))), { bold: true });
  }
  doc.end();
}

// ---- CSV --------------------------------------------------------------------
function toCsv(report) {
  const cols = report.columns || [];
  const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const lines = [cols.map((c) => esc(c.label)).join(",")];
  (report.rows || []).forEach((row) => {
    lines.push(cols.map((c) => esc(isMoney(c.type) ? fmtMoney(row[c.key]) : row[c.key])).join(","));
  });
  if (report.totals) {
    lines.push(cols.map((c, i) => esc(i === 0 ? "Total" : (isMoney(c.type) ? fmtMoney(report.totals[c.key]) : (report.totals[c.key] ?? "")))).join(","));
  }
  return lines.join("\n");
}

const safeName = (s) => String(s || "report").replace(/[^a-z0-9._-]+/gi, "_").toLowerCase();

/** Dispatch a report descriptor to the requested format on the response. */
async function sendReport(res, report, format) {
  const base = safeName(report.title);
  const fmt = String(format || "csv").toLowerCase();
  if (fmt === "xlsx" || fmt === "excel") {
    const buf = await toXlsxBuffer(report);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${base}.xlsx"`);
    return res.send(Buffer.from(buf));
  }
  if (fmt === "pdf") return streamPdf(report, res, `${base}.pdf`);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${base}.csv"`);
  return res.send(toCsv(report));
}

module.exports = { toXlsxBuffer, streamPdf, toCsv, sendReport };

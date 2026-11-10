// =============================================================================
// Bank statement parsers — CSV and OFX -> normalized transaction lines.
//
// A normalized line is:
//   { txnDate: 'YYYY-MM-DD', valueDate: 'YYYY-MM-DD'|null, description, reference,
//     amount: Number (signed: + inflow / - outflow), externalId|null, runningBalance|null }
//
// Dependency-free on purpose (no csv/ofx npm packages). The CSV parser handles
// quoted fields and auto-detects common column layouts (single signed Amount, or
// separate Debit/Credit columns). OFX parsing extracts <STMTTRN> records.
// =============================================================================

// ---- CSV --------------------------------------------------------------------

// RFC-4180-ish row splitter: handles "quoted, fields", escaped "" quotes, CRLF.
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const s = String(text).replace(/^﻿/, ""); // strip BOM
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((x) => x.trim() !== "")) rows.push(row); }
  return rows;
}

const norm = (h) => String(h || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");

// Find the index of the first header that matches any of the candidate names.
function findCol(headers, candidates) {
  const normed = headers.map(norm);
  for (const cand of candidates) {
    const i = normed.indexOf(norm(cand));
    if (i !== -1) return i;
  }
  return -1;
}

const cleanNumber = (v) => {
  if (v == null) return 0;
  const s = String(v).replace(/[^0-9.\-()]/g, "").replace(/^\((.*)\)$/, "-$1");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

// Parse a date in common bank formats -> YYYY-MM-DD (or null).
function parseDate(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);            // YYYY-MM-DD
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);                // DD/MM/YYYY (assume day-first)
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  m = s.match(/^(\d{8})$/);                                         // YYYYMMDD
  if (m) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return null;
}

/**
 * Parse a CSV bank statement. Auto-detects columns; an explicit `mapping`
 * ({ date, description, amount, debit, credit, reference, balance, valueDate })
 * of header names overrides detection.
 */
function parseCsv(text, mapping = {}) {
  const rows = parseCsvRows(text);
  if (rows.length < 2) return [];
  const headers = rows[0];

  const col = (key, candidates) =>
    mapping[key] ? findCol(headers, [mapping[key]]) : findCol(headers, candidates);

  const iDate = col("date", ["date", "transaction date", "txn date", "posting date", "value date"]);
  const iDesc = col("description", ["description", "narration", "details", "particulars", "memo", "transaction details"]);
  const iAmount = col("amount", ["amount", "transaction amount"]);
  const iDebit = col("debit", ["debit", "withdrawal", "withdrawal amount", "dr", "paid out"]);
  const iCredit = col("credit", ["credit", "deposit", "deposit amount", "cr", "paid in"]);
  const iRef = col("reference", ["reference", "ref", "cheque no", "chq no", "transaction id", "ref no"]);
  const iBal = col("balance", ["balance", "running balance", "closing balance"]);
  const iValue = col("valueDate", ["value date", "value dt"]);

  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const txnDate = parseDate(iDate >= 0 ? row[iDate] : null);
    if (!txnDate) continue; // skip non-data rows (totals/footers)

    let amount;
    if (iAmount >= 0 && String(row[iAmount] || "").trim() !== "") {
      amount = cleanNumber(row[iAmount]);
    } else {
      const debit = iDebit >= 0 ? cleanNumber(row[iDebit]) : 0;
      const credit = iCredit >= 0 ? cleanNumber(row[iCredit]) : 0;
      amount = credit - debit; // signed
    }
    if (!amount) continue;

    out.push({
      txnDate,
      valueDate: iValue >= 0 ? parseDate(row[iValue]) : null,
      description: (iDesc >= 0 ? row[iDesc] : "").trim(),
      reference: (iRef >= 0 ? row[iRef] : "").trim() || null,
      amount,
      externalId: null,
      runningBalance: iBal >= 0 && String(row[iBal] || "").trim() !== "" ? cleanNumber(row[iBal]) : null,
    });
  }
  return out;
}

// ---- OFX --------------------------------------------------------------------

const ofxTag = (block, tag) => {
  const m = block.match(new RegExp(`<${tag}>([^<\r\n]*)`, "i"));
  return m ? m[1].trim() : "";
};

/** Parse an OFX (or QFX) statement body -> normalized lines. */
function parseOfx(text) {
  const out = [];
  const blocks = String(text).match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) || [];
  for (const block of blocks) {
    const amount = cleanNumber(ofxTag(block, "TRNAMT"));
    if (!amount) continue;
    const dt = ofxTag(block, "DTPOSTED").slice(0, 8);
    const txnDate = parseDate(dt);
    if (!txnDate) continue;
    const name = ofxTag(block, "NAME");
    const memo = ofxTag(block, "MEMO");
    out.push({
      txnDate,
      valueDate: parseDate(ofxTag(block, "DTUSER").slice(0, 8)) || null,
      description: [name, memo].filter(Boolean).join(" - ") || "OFX transaction",
      reference: ofxTag(block, "CHECKNUM") || null,
      amount,
      externalId: ofxTag(block, "FITID") || null,
      runningBalance: null,
    });
  }
  return out;
}

module.exports = { parseCsv, parseOfx, parseDate, cleanNumber };

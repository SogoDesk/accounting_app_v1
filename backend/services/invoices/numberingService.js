// Invoice number allocation. Client invoices (INV-) and inter-company invoices
// (IC-) are separate series; the counters live in utils/codeGenerator.js, which
// the other document types share.

const {
  generateInvoiceNumber,
  generateIntercompanyInvoiceNumber,
} = require("../../utils/codeGenerator");

// Take the next number in the series for this invoice type. Numbers are drawn
// from a Postgres sequence, so a number is used up even if the caller's
// transaction later rolls back, and the preview route uses one up too.
const nextInvoiceNumber = (db, { intercompany = false } = {}) =>
  intercompany ? generateIntercompanyInvoiceNumber(db) : generateInvoiceNumber(db);

// The ?type= value of the preview route: INTER_COMPANY or anything else.
const isIntercompanyType = (type) =>
  String(type || "").trim().toUpperCase() === "INTER_COMPANY";

module.exports = { nextInvoiceNumber, isIntercompanyType };

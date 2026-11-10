// =============================================================================
// importService — persist normalized statement lines for a bank account.
//
// Records one bank_statement_imports batch and inserts bank_transactions,
// deduping per account via a content hash (prefers the bank-provided external
// id / OFX FITID when present). Safe to re-import the same statement: duplicates
// are skipped via the UNIQUE (bank_account_id, dedupe_hash) constraint.
// =============================================================================

const crypto = require("crypto");

// Stable per-account hash. When the bank gives a unique id (OFX FITID), key on
// it; otherwise key on the natural content so re-uploads dedupe.
const dedupeHash = (bankAccountId, line) => {
  const key = line.externalId
    ? `${bankAccountId}|ext|${line.externalId}`
    : `${bankAccountId}|${line.txnDate}|${line.amount}|${String(line.description || "").trim().toLowerCase()}|${String(line.reference || "")}`;
  return crypto.createHash("sha256").update(key).digest("hex");
};

/**
 * Import normalized lines for a bank account. Pass a pg client (`db`) inside a
 * transaction. Returns { importId, total, inserted, duplicates }.
 */
async function importStatement(db, { bankAccount, source, filename, lines, userId }) {
  const batch = await db.query(
    `INSERT INTO bank_statement_imports (bank_account_id, source, filename, row_count, imported_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [bankAccount.id, source, filename || null, lines.length, userId || null],
  );
  const importId = batch.rows[0].id;

  let inserted = 0;
  let duplicates = 0;
  for (const line of lines) {
    const hash = dedupeHash(bankAccount.id, line);
    const res = await db.query(
      `INSERT INTO bank_transactions
         (bank_account_id, import_id, txn_date, value_date, description, reference, amount, currency,
          running_balance, external_id, dedupe_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (bank_account_id, dedupe_hash) DO NOTHING
       RETURNING id`,
      [
        bankAccount.id, importId, line.txnDate, line.valueDate || null, line.description || null,
        line.reference || null, line.amount, bankAccount.currency,
        line.runningBalance == null ? null : line.runningBalance, line.externalId || null, hash,
      ],
    );
    if (res.rows.length) inserted += 1;
    else duplicates += 1;
  }

  await db.query(
    `UPDATE bank_statement_imports SET inserted_count = $1, duplicate_count = $2 WHERE id = $3`,
    [inserted, duplicates, importId],
  );

  return { importId, total: lines.length, inserted, duplicates };
}

module.exports = { importStatement, dedupeHash };

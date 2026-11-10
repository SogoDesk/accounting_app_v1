// =============================================================================
// reconciliationService — match imported bank transactions to the GL and
// reconcile a bank account against a statement balance.
//
// A bank account maps to a 1000-series GL account. A statement line's signed
// amount (+ inflow / - outflow) corresponds to the NET debit-minus-credit on the
// bank GL account for a journal entry (debit increases the bank asset). Matching
// therefore compares a bank transaction's amount to each posted entry's bank-line
// net, within a date window.
//
// Unmatched lines that the books don't yet contain (e.g. bank fees, interest)
// can be booked straight from the statement via createEntryFromTxn(), which posts
// through ledgerEngine and links the new entry back to the transaction.
// =============================================================================

const pool = require("../../config/db");
const ledger = require("../gl/ledgerEngine");
const posting = require("../gl/postingService");
const currency = require("../currency/currencyService");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

async function getBankAccount(db, bankAccountId) {
  const { rows } = await db.query("SELECT * FROM bank_accounts WHERE id = $1", [bankAccountId]);
  if (!rows.length) throw new Error("Bank account not found");
  return rows[0];
}

// Candidate posted journal entries whose bank-line net matches `amount` within a
// date window and aren't already matched to another transaction on this account.
// Each candidate carries a deterministic `score` (0–100): amount-exactness (up to
// 60) plus date proximity within the window (up to 40). Higher = closer match.
// Rows are ordered by score descending (then nearest date, then newest entry).
async function candidateEntries(db, account, amount, txnDate, windowDays) {
  const win = Math.max(Number(windowDays) || 0, 1);
  const { rows } = await db.query(
    `SELECT je.id AS entry_id, je.entry_no, je.entry_date, je.description,
            SUM(jl.debit - jl.credit) AS bank_net,
            ABS(SUM(jl.debit - jl.credit) - $4) AS amount_diff,
            ABS(je.entry_date - $5::date)       AS day_diff
       FROM journal_entries je
       JOIN journal_lines jl ON jl.entry_id = je.id
      WHERE je.status = 'POSTED'
        AND jl.account_id = $1
        AND je.entity_id  = $2
        AND je.id NOT IN (
          SELECT matched_entry_id FROM bank_transactions
           WHERE bank_account_id = $3 AND matched_entry_id IS NOT NULL
        )
      GROUP BY je.id, je.entry_no, je.entry_date, je.description
     HAVING ABS(SUM(jl.debit - jl.credit) - $4) < 0.005
        AND ABS(je.entry_date - $5::date) <= $6`,
    [account.gl_account_id, account.region_id, account.id, amount, txnDate, win],
  );
  const tol = 0.005; // amount tolerance already enforced by HAVING
  const scored = rows.map((r) => {
    const amountDiff = Math.abs(Number(r.amount_diff));
    const dayDiff = Math.abs(Number(r.day_diff));
    const amountScore = 60 * (1 - Math.min(amountDiff / tol, 1));
    const dateScore = 40 * (1 - Math.min(dayDiff / win, 1));
    const score = Math.round(amountScore + dateScore);
    return { ...r, score };
  });
  scored.sort((a, b) => b.score - a.score || Number(a.day_diff) - Number(b.day_diff) || b.entry_id - a.entry_id);
  return scored;
}

/** Suggested GL matches for one bank transaction (read-only). */
async function suggestMatches(db, txnId, windowDays = 5) {
  const { rows } = await db.query("SELECT * FROM bank_transactions WHERE id = $1", [txnId]);
  if (!rows.length) throw new Error("Bank transaction not found");
  const txn = rows[0];
  const account = await getBankAccount(db, txn.bank_account_id);
  if (!account.gl_account_id) return { txn, suggestions: [] };
  const dateStr = txn.txn_date instanceof Date ? txn.txn_date.toISOString().slice(0, 10) : String(txn.txn_date).slice(0, 10);
  const suggestions = await candidateEntries(db, account, Number(txn.amount), dateStr, windowDays);
  return { txn, suggestions };
}

/**
 * Auto-match every UNMATCHED transaction on an account that has exactly one
 * candidate GL entry. Returns the number matched. Run inside a transaction.
 */
async function autoMatch(db, bankAccountId, windowDays = 5) {
  const account = await getBankAccount(db, bankAccountId);
  if (!account.gl_account_id) return { matched: 0, skipped: 0 };
  const { rows: txns } = await db.query(
    `SELECT * FROM bank_transactions WHERE bank_account_id = $1 AND status = 'UNMATCHED' ORDER BY txn_date`,
    [bankAccountId],
  );
  let matched = 0;
  for (const txn of txns) {
    const dateStr = txn.txn_date instanceof Date ? txn.txn_date.toISOString().slice(0, 10) : String(txn.txn_date).slice(0, 10);
    const cands = await candidateEntries(db, account, Number(txn.amount), dateStr, windowDays);
    if (cands.length === 1) {
      await db.query(
        `UPDATE bank_transactions SET status='MATCHED', matched_entry_id=$1, matched_type='JOURNAL' WHERE id=$2`,
        [cands[0].entry_id, txn.id],
      );
      matched += 1;
    }
  }
  return { matched, total: txns.length };
}

/** Manually match a transaction to a specific posted journal entry. */
async function matchTransaction(db, txnId, entryId) {
  const { rows } = await db.query(
    `UPDATE bank_transactions SET status='MATCHED', matched_entry_id=$1, matched_type='JOURNAL'
      WHERE id=$2 AND status IN ('UNMATCHED','MATCHED') RETURNING *`,
    [entryId, txnId],
  );
  if (!rows.length) throw new Error("Transaction not found or already reconciled");
  return rows[0];
}

/** Clear a (non-reconciled) match. */
async function unmatch(db, txnId) {
  const { rows } = await db.query(
    `UPDATE bank_transactions
        SET status='UNMATCHED', matched_entry_id=NULL, matched_type=NULL
      WHERE id=$1 AND status <> 'RECONCILED' RETURNING *`,
    [txnId],
  );
  if (!rows.length) throw new Error("Transaction not found or already reconciled");
  return rows[0];
}

/**
 * Book an unmatched bank line straight from the statement (e.g. bank fee /
 * interest). Posts Dr/Cr against the bank GL account and a contra account, then
 * links the new entry to the transaction. Runs inside the caller's transaction.
 */
async function createEntryFromTxn(db, { txnId, contraAccountCode, userId, description }) {
  const { rows } = await db.query("SELECT * FROM bank_transactions WHERE id = $1", [txnId]);
  if (!rows.length) throw new Error("Bank transaction not found");
  const txn = rows[0];
  if (txn.status === "RECONCILED") throw new Error("Transaction already reconciled");
  const account = await getBankAccount(db, txn.bank_account_id);
  if (!account.gl_account_id) throw new Error("Bank account has no GL account mapping");

  const bankAcct = await db.query("SELECT account_code FROM chart_of_accounts WHERE id = $1", [account.gl_account_id]);
  if (!bankAcct.rows.length) throw new Error("Bank GL account not found");
  const bankCode = bankAcct.rows[0].account_code;

  const amount = Number(txn.amount);
  const inflow = amount > 0;
  const mag = round2(Math.abs(amount));
  const contra = contraAccountCode || (inflow ? "4920" : "5200"); // interest income / bank charges
  const dateStr = txn.txn_date instanceof Date ? txn.txn_date.toISOString().slice(0, 10) : String(txn.txn_date).slice(0, 10);

  let exchangeRate = 1;
  let baseMag = mag;
  try {
    const f = await currency.toFunctional(mag, txn.currency, account.region_id, dateStr, db);
    exchangeRate = f.exchangeRate;
    baseMag = round2(f.amountBase);
  } catch (_e) { /* currency engine absent; treat as functional */ }

  const bankLine = { accountCode: bankCode, currency: txn.currency, exchangeRate, memo: description || txn.description || "Bank entry" };
  const contraLine = { accountCode: contra, currency: txn.currency, exchangeRate, memo: description || txn.description || "Bank entry" };
  if (inflow) {
    bankLine.debit = mag; bankLine.debitBase = baseMag;
    contraLine.credit = mag; contraLine.creditBase = baseMag;
  } else {
    bankLine.credit = mag; bankLine.creditBase = baseMag;
    contraLine.debit = mag; contraLine.debitBase = baseMag;
  }

  const locationId = await posting.resolveLocationId(account.region_id, null, db);
  const entry = await ledger.postEntry(
    db,
    {
      entityId: account.region_id, locationId, entryDate: dateStr, source: "MANUAL",
      sourceRef: `BANKTXN-${txn.id}`, description: description || `Bank: ${txn.description || txn.id}`, userId,
    },
    [bankLine, contraLine],
  );

  await db.query(
    `UPDATE bank_transactions SET status='MATCHED', matched_entry_id=$1, matched_type='MANUAL_ENTRY' WHERE id=$2`,
    [entry.id, txn.id],
  );
  return { entry, txnId: txn.id };
}

/** Open a reconciliation session for a statement. */
async function openReconciliation(db, { bankAccountId, statementDate, openingBalance = 0, closingBalance, userId }) {
  const { rows } = await db.query(
    `INSERT INTO bank_reconciliations
       (bank_account_id, statement_date, statement_opening_balance, statement_closing_balance, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [bankAccountId, statementDate, round2(openingBalance), round2(closingBalance), userId || null],
  );
  return rows[0];
}

/**
 * Complete a reconciliation: mark the given matched transactions RECONCILED,
 * compute the reconciled balance (opening + Σ reconciled amounts) and the
 * difference vs the statement closing balance. Runs in the caller's transaction.
 */
async function completeReconciliation(db, { reconciliationId, txnIds, allowDifference = false }) {
  const recRes = await db.query("SELECT * FROM bank_reconciliations WHERE id = $1", [reconciliationId]);
  if (!recRes.rows.length) throw new Error("Reconciliation not found");
  const rec = recRes.rows[0];

  let reconciledSum = 0;
  for (const txnId of txnIds || []) {
    const upd = await db.query(
      `UPDATE bank_transactions
          SET status='RECONCILED', reconciliation_id=$1, reconciled_at=now()
        WHERE id=$2 AND bank_account_id=$3 AND status IN ('MATCHED','UNMATCHED')
        RETURNING amount`,
      [reconciliationId, txnId, rec.bank_account_id],
    );
    if (upd.rows.length) reconciledSum += Number(upd.rows[0].amount);
  }

  const reconciledBalance = round2(Number(rec.statement_opening_balance) + reconciledSum);
  const difference = round2(Number(rec.statement_closing_balance) - reconciledBalance);
  const balanced = Math.abs(difference) < 0.005;

  const { rows } = await db.query(
    `UPDATE bank_reconciliations
        SET reconciled_balance=$1, difference=$2,
            status=$3, completed_at = CASE WHEN $3='COMPLETED' THEN now() ELSE NULL END
      WHERE id=$4 RETURNING *`,
    [reconciledBalance, difference, balanced || allowDifference ? "COMPLETED" : "IN_PROGRESS", reconciliationId],
  );
  return { reconciliation: rows[0], balanced, difference };
}

module.exports = {
  suggestMatches, autoMatch, matchTransaction, unmatch,
  createEntryFromTxn, openReconciliation, completeReconciliation,
};

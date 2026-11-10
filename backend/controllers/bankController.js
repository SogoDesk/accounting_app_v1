// =============================================================================
// bankController — bank accounts, statement import (auto bank feed), and
// reconciliation against the general ledger. Every endpoint is row-level scoped
// to the caller's allowed entities (bank_accounts.region_id).
// =============================================================================

const pool = require("../config/db");
const { auditLog } = require("../middleware/auditMiddleware");
const { canActOnEntity } = require("../middleware/scopeMiddleware");
const { getSource, detectFileSource } = require("../services/banking/feedSources");
const importService = require("../services/banking/importService");
const recon = require("../services/banking/reconciliationService");

const ready = async (db = pool) => {
  const { rows } = await db.query("SELECT to_regclass('public.bank_accounts') AS t");
  return rows[0].t !== null;
};
const notReady = (res) =>
  res.json({ success: true, ready: false, message: "Banking not enabled. Apply migration 010.", data: [] });

// Load a bank account and assert the caller may act on its entity.
async function loadAccountScoped(db, req, id) {
  const { rows } = await db.query("SELECT * FROM bank_accounts WHERE id = $1", [Number(id)]);
  if (!rows.length || !canActOnEntity(req, rows[0].region_id)) return null;
  return rows[0];
}

// ---- bank accounts ---------------------------------------------------------
const listAccounts = async (req, res) => {
  try {
    if (!(await ready())) return notReady(res);
    const params = []; const where = [];
    if (req.query.regionId) { params.push(Number(req.query.regionId)); where.push(`ba.region_id = $${params.length}`); }
    if (req.scopeEnforced && Array.isArray(req.allowedEntityIds)) {
      params.push(req.allowedEntityIds); where.push(`ba.region_id = ANY($${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const { rows } = await pool.query(
      `SELECT ba.*, r.region_name AS entity_name, a.account_code AS gl_account_code,
              (SELECT COUNT(*) FROM bank_transactions t WHERE t.bank_account_id = ba.id AND t.status='UNMATCHED') AS unmatched_count
         FROM bank_accounts ba
         LEFT JOIN regions r ON r.id = ba.region_id
         LEFT JOIN chart_of_accounts a ON a.id = ba.gl_account_id
         ${whereSql} ORDER BY ba.id DESC`, params);
    return res.json({ success: true, ready: true, data: rows });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};

const createAccount = async (req, res) => {
  try {
    if (!(await ready())) return notReady(res);
    const b = req.body;
    if (!b.name || !b.region_id || !b.currency) {
      return res.status(400).json({ success: false, message: "name, region_id and currency are required" });
    }
    if (!canActOnEntity(req, b.region_id)) {
      return res.status(403).json({ success: false, message: "Not authorized for this entity (region)" });
    }
    const { rows } = await pool.query(
      `INSERT INTO bank_accounts
         (region_id, gl_account_id, name, bank_name, account_number_masked, currency,
          opening_balance, opening_date, feed_source, external_ref, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [Number(b.region_id), b.gl_account_id || null, b.name, b.bank_name || null,
       b.account_number_masked || null, String(b.currency).toUpperCase(),
       Number(b.opening_balance || 0), b.opening_date || null,
       String(b.feed_source || "MANUAL").toUpperCase(), b.external_ref || null,
       String(b.status || "ACTIVE").toUpperCase(), req.user?.id || null]);
    await auditLog({ userId: req.user?.id, userEmail: req.user?.email, action: "CREATE", entityType: "bank_accounts", entityId: rows[0].id, newValues: rows[0], ipAddress: req.ip });
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};

const updateAccount = async (req, res) => {
  try {
    if (!(await ready())) return notReady(res);
    const existing = await loadAccountScoped(pool, req, req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: "Bank account not found" });
    if (req.body.region_id != null && !canActOnEntity(req, req.body.region_id)) {
      return res.status(403).json({ success: false, message: "Not authorized to assign to this entity" });
    }
    const p = { ...existing, ...req.body };
    const { rows } = await pool.query(
      `UPDATE bank_accounts SET region_id=$1, gl_account_id=$2, name=$3, bank_name=$4,
              account_number_masked=$5, currency=$6, opening_balance=$7, opening_date=$8,
              feed_source=$9, external_ref=$10, status=$11, updated_at=now()
        WHERE id=$12 RETURNING *`,
      [Number(p.region_id), p.gl_account_id || null, p.name, p.bank_name || null,
       p.account_number_masked || null, String(p.currency).toUpperCase(),
       Number(p.opening_balance || 0), p.opening_date || null,
       String(p.feed_source || "MANUAL").toUpperCase(), p.external_ref || null,
       String(p.status || "ACTIVE").toUpperCase(), existing.id]);
    return res.json({ success: true, data: rows[0] });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};

const deleteAccount = async (req, res) => {
  try {
    if (!(await ready())) return notReady(res);
    const existing = await loadAccountScoped(pool, req, req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: "Bank account not found" });
    await pool.query("DELETE FROM bank_accounts WHERE id = $1", [existing.id]);
    await auditLog({ userId: req.user?.id, userEmail: req.user?.email, action: "DELETE", entityType: "bank_accounts", entityId: existing.id, oldValues: existing, ipAddress: req.ip });
    return res.json({ success: true, message: "Bank account deleted" });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};

// ---- statement import (auto feed) ------------------------------------------
const importStatement = async (req, res) => {
  const db = await pool.connect();
  try {
    if (!(await ready(db))) { return notReady(res); }
    const account = await loadAccountScoped(db, req, req.params.id);
    if (!account) return res.status(404).json({ success: false, message: "Bank account not found" });
    if (!req.file) return res.status(400).json({ success: false, message: "A statement file is required" });

    const content = req.file.buffer.toString("utf8");
    const sourceKey = (req.body.source && String(req.body.source).toUpperCase()) || detectFileSource(req.file.originalname, content);
    const source = getSource(sourceKey);
    if (source.kind !== "FILE") return res.status(400).json({ success: false, message: `${sourceKey} is a live feed, not a file import` });

    const mapping = req.body.mapping ? JSON.parse(req.body.mapping) : {};
    const lines = source.parse(content, { mapping });
    if (!lines.length) return res.status(400).json({ success: false, message: "No transactions found in file" });

    await db.query("BEGIN");
    const result = await importService.importStatement(db, {
      bankAccount: account, source: sourceKey, filename: req.file.originalname, lines, userId: req.user?.id,
    });
    await db.query("COMMIT");
    return res.json({ success: true, message: `Imported ${result.inserted} new, ${result.duplicates} duplicate(s)`, data: result });
  } catch (e) {
    try { await db.query("ROLLBACK"); } catch (_) {}
    return res.status(500).json({ success: false, message: e.message });
  } finally { db.release(); }
};

// ---- transactions ----------------------------------------------------------
const listTransactions = async (req, res) => {
  try {
    if (!(await ready())) return notReady(res);
    const account = await loadAccountScoped(pool, req, req.params.id);
    if (!account) return res.status(404).json({ success: false, message: "Bank account not found" });
    const params = [account.id]; const where = ["t.bank_account_id = $1"];
    if (req.query.status) { params.push(String(req.query.status).toUpperCase()); where.push(`t.status = $${params.length}`); }
    const { rows } = await pool.query(
      `SELECT t.*, je.entry_no AS matched_entry_no
         FROM bank_transactions t
         LEFT JOIN journal_entries je ON je.id = t.matched_entry_id
        WHERE ${where.join(" AND ")}
        ORDER BY t.txn_date DESC, t.id DESC LIMIT 1000`, params);
    return res.json({ success: true, ready: true, data: rows });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};

// Resolve a transaction and scope-check via its account.
async function loadTxnScoped(db, req, txnId) {
  const { rows } = await db.query(
    `SELECT t.*, ba.region_id FROM bank_transactions t JOIN bank_accounts ba ON ba.id = t.bank_account_id WHERE t.id = $1`,
    [Number(txnId)]);
  if (!rows.length || !canActOnEntity(req, rows[0].region_id)) return null;
  return rows[0];
}

const suggestMatches = async (req, res) => {
  try {
    if (!(await ready())) return notReady(res);
    if (!(await loadTxnScoped(pool, req, req.params.txnId))) return res.status(404).json({ success: false, message: "Transaction not found" });
    const out = await recon.suggestMatches(pool, Number(req.params.txnId), Number(req.query.windowDays) || 5);
    return res.json({ success: true, data: out });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};

const autoMatch = async (req, res) => {
  const db = await pool.connect();
  try {
    if (!(await ready(db))) { return notReady(res); }
    const account = await loadAccountScoped(db, req, req.params.id);
    if (!account) return res.status(404).json({ success: false, message: "Bank account not found" });
    await db.query("BEGIN");
    const out = await recon.autoMatch(db, account.id, Number(req.body.windowDays) || 5);
    await db.query("COMMIT");
    return res.json({ success: true, message: `Matched ${out.matched} of ${out.total} unmatched`, data: out });
  } catch (e) { try { await db.query("ROLLBACK"); } catch (_) {} return res.status(500).json({ success: false, message: e.message }); }
  finally { db.release(); }
};

const matchTransaction = async (req, res) => {
  try {
    if (!(await ready())) return notReady(res);
    if (!(await loadTxnScoped(pool, req, req.params.txnId))) return res.status(404).json({ success: false, message: "Transaction not found" });
    if (!req.body.entryId) return res.status(400).json({ success: false, message: "entryId is required" });
    const row = await recon.matchTransaction(pool, Number(req.params.txnId), Number(req.body.entryId));
    return res.json({ success: true, data: row });
  } catch (e) { return res.status(400).json({ success: false, message: e.message }); }
};

const unmatchTransaction = async (req, res) => {
  try {
    if (!(await ready())) return notReady(res);
    if (!(await loadTxnScoped(pool, req, req.params.txnId))) return res.status(404).json({ success: false, message: "Transaction not found" });
    const row = await recon.unmatch(pool, Number(req.params.txnId));
    return res.json({ success: true, data: row });
  } catch (e) { return res.status(400).json({ success: false, message: e.message }); }
};

const bookTransaction = async (req, res) => {
  const db = await pool.connect();
  try {
    if (!(await ready(db))) { return notReady(res); }
    if (!(await loadTxnScoped(db, req, req.params.txnId))) return res.status(404).json({ success: false, message: "Transaction not found" });
    await db.query("BEGIN");
    const out = await recon.createEntryFromTxn(db, {
      txnId: Number(req.params.txnId), contraAccountCode: req.body.contraAccountCode,
      description: req.body.description, userId: req.user?.id,
    });
    await db.query("COMMIT");
    return res.json({ success: true, message: "Entry booked and matched", data: out });
  } catch (e) { try { await db.query("ROLLBACK"); } catch (_) {} return res.status(400).json({ success: false, message: e.message }); }
  finally { db.release(); }
};

// ---- reconciliation --------------------------------------------------------
const listReconciliations = async (req, res) => {
  try {
    if (!(await ready())) return notReady(res);
    const account = await loadAccountScoped(pool, req, req.params.id);
    if (!account) return res.status(404).json({ success: false, message: "Bank account not found" });
    const { rows } = await pool.query(
      "SELECT * FROM bank_reconciliations WHERE bank_account_id = $1 ORDER BY statement_date DESC, id DESC", [account.id]);
    return res.json({ success: true, ready: true, data: rows });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};

const openReconciliation = async (req, res) => {
  try {
    if (!(await ready())) return notReady(res);
    const account = await loadAccountScoped(pool, req, req.params.id);
    if (!account) return res.status(404).json({ success: false, message: "Bank account not found" });
    if (!req.body.statement_date || req.body.statement_closing_balance == null) {
      return res.status(400).json({ success: false, message: "statement_date and statement_closing_balance are required" });
    }
    const rec = await recon.openReconciliation(pool, {
      bankAccountId: account.id, statementDate: req.body.statement_date,
      openingBalance: Number(req.body.statement_opening_balance || account.opening_balance || 0),
      closingBalance: Number(req.body.statement_closing_balance), userId: req.user?.id,
    });
    return res.status(201).json({ success: true, data: rec });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};

const completeReconciliation = async (req, res) => {
  const db = await pool.connect();
  try {
    if (!(await ready(db))) { return notReady(res); }
    const recRes = await db.query(
      `SELECT br.*, ba.region_id FROM bank_reconciliations br JOIN bank_accounts ba ON ba.id = br.bank_account_id WHERE br.id = $1`,
      [Number(req.params.recId)]);
    if (!recRes.rows.length || !canActOnEntity(req, recRes.rows[0].region_id)) {
      return res.status(404).json({ success: false, message: "Reconciliation not found" });
    }
    await db.query("BEGIN");
    const out = await recon.completeReconciliation(db, {
      reconciliationId: Number(req.params.recId), txnIds: req.body.txnIds || [], allowDifference: !!req.body.allowDifference,
    });
    await db.query("COMMIT");
    return res.json({ success: true, message: out.balanced ? "Reconciled and balanced" : `Difference of ${out.difference}`, data: out });
  } catch (e) { try { await db.query("ROLLBACK"); } catch (_) {} return res.status(500).json({ success: false, message: e.message }); }
  finally { db.release(); }
};

// ---- summary (book vs statement) -------------------------------------------
const summary = async (req, res) => {
  try {
    if (!(await ready())) return notReady(res);
    const account = await loadAccountScoped(pool, req, req.params.id);
    if (!account) return res.status(404).json({ success: false, message: "Bank account not found" });
    const stats = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status='UNMATCHED')  AS unmatched,
         COUNT(*) FILTER (WHERE status='MATCHED')    AS matched,
         COUNT(*) FILTER (WHERE status='RECONCILED') AS reconciled,
         COALESCE(SUM(amount),0)                     AS statement_net,
         COALESCE(SUM(amount) FILTER (WHERE status='UNMATCHED' AND amount > 0), 0)  AS outstanding_deposits,
         COALESCE(SUM(-amount) FILTER (WHERE status='UNMATCHED' AND amount < 0), 0) AS uncleared_payments
       FROM bank_transactions WHERE bank_account_id = $1`, [account.id]);
    // GL book balance for the mapped account
    let bookBalance = null;
    if (account.gl_account_id) {
      const bal = await pool.query(
        `SELECT COALESCE(SUM(jl.debit - jl.credit),0) AS bal
           FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
          WHERE je.status='POSTED' AND jl.account_id = $1 AND je.entity_id = $2`,
        [account.gl_account_id, account.region_id]);
      bookBalance = Number(bal.rows[0].bal);
    }
    const s = stats.rows[0];
    return res.json({ success: true, ready: true, data: {
      account, unmatched: Number(s.unmatched), matched: Number(s.matched), reconciled: Number(s.reconciled),
      statement_net: Number(s.statement_net),
      outstanding_deposits: Number(s.outstanding_deposits),
      uncleared_payments: Number(s.uncleared_payments),
      book_balance: bookBalance,
      bank_balance: Number(account.opening_balance) + Number(s.statement_net),
    } });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};

module.exports = {
  listAccounts, createAccount, updateAccount, deleteAccount,
  importStatement, listTransactions, suggestMatches, autoMatch,
  matchTransaction, unmatchTransaction, bookTransaction,
  listReconciliations, openReconciliation, completeReconciliation, summary,
};

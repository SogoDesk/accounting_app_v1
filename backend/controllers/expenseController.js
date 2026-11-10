const pool = require("../config/db");
const { auditLog } = require("../middleware/auditMiddleware");
const glPosting = require("../services/gl/postingService");
const currency = require("../services/currency/currencyService");
const { canActOnEntity } = require("../middleware/scopeMiddleware");
const { sendReport } = require("../services/reports/reportExport");

const REIMBURSEMENTS_ACCOUNT = "2500";

const num = (v) => { const n = Number(v || 0); return Number.isNaN(n) ? 0 : n; };
// NaN-safe: a missing/invalid amount must not silently produce a NaN money row.
const round2 = (n) => { const v = Number(n); return Number.isNaN(v) ? 0 : Math.round((v + Number.EPSILON) * 100) / 100; };

// Last-resort static rates (currency -> USD) so consolidated reports always
// render even before any exchange_rates rows exist. Mirrors the dashboard.
const USD_RATES = { USD: 1, INR: 0.012, EUR: 1.08, GBP: 1.27, AED: 0.272, SGD: 0.74, JPY: 0.0067, HKD: 0.128, CAD: 0.73, AUD: 0.66 };
const rateToUsd = async (ccy, db = pool) => {
  const code = String(ccy || "USD").toUpperCase();
  if (code === "USD") return 1;
  try { const { rate } = await currency.getRate(code, "USD", null, db); if (rate > 0) return rate; } catch (_) { /* no rate row */ }
  return USD_RATES[code] != null ? USD_RATES[code] : 1;
};
// Convert via a USD pivot. Never throws, so a missing rate degrades to an
// approximate consolidated figure instead of failing the whole report.
// `cache` memoises per-currency USD rates within one request.
const convertAmount = async (amount, from, to, cache, db = pool) => {
  const a = num(amount);
  const f = String(from || "USD").toUpperCase(), t = String(to || "USD").toUpperCase();
  if (a === 0 || f === t) return a;
  const get = async (c) => { if (cache.has(c)) return cache.get(c); const v = await rateToUsd(c, db); cache.set(c, v); return v; };
  const fU = await get(f), tU = await get(t);
  return tU ? (a * fU) / tU : a;
};
// Consolidated views report in USD (override via ?reportingCurrency); a single
// selected entity reports natively in its own books (functional) currency.
const reportingCurrencyFor = async (req, db = pool) => {
  if (req.query.entityId) {
    const { rows } = await db.query("SELECT default_currency, functional_currency FROM regions WHERE id = $1", [Number(req.query.entityId)]);
    const r = rows[0];
    if (r) return String(r.functional_currency || r.default_currency || "USD").toUpperCase();
  }
  return String(req.query.reportingCurrency || "USD").toUpperCase();
};

// `to_regclass` is checked once; the table never disappears mid-process, so a
// positive result is cached to drop a round-trip from every expense request.
let _expensesReady = false;
async function ready(db = pool) {
  if (_expensesReady) return true;
  const { rows } = await db.query("SELECT to_regclass('public.expenses') AS t");
  _expensesReady = rows[0].t !== null;
  return _expensesReady;
}
const notReady = (res) =>
  res.json({ success: true, ready: false, message: "Expenses not enabled. Apply migration 003 and restart the backend.", data: [] });

const accountCode = async (db, glAccountId) => {
  if (!glAccountId) return null;
  const { rows } = await db.query("SELECT account_code FROM chart_of_accounts WHERE id = $1", [glAccountId]);
  return rows.length ? rows[0].account_code : null;
};

// Shared: insert an expense row + post it to the GL. Caller owns the transaction.
async function recordExpense(db, data, userId) {
  const amount = round2(data.amount);
  const gst = round2(data.gst_amount);
  const tds = round2(data.tds_amount);
  const total = round2(amount + gst);
  const ccy = String(data.currency || "INR").toUpperCase();
  const date = String(data.expense_date).slice(0, 10);

  let exchangeRate = 1, amountBase = total;
  try { const f = await currency.toFunctional(total, ccy, Number(data.entity_id), date, db); amountBase = f.amountBase; exchangeRate = f.exchangeRate; } catch (_) { /* migration 001 absent */ }

  const ins = await db.query(
    `INSERT INTO expenses
      (entity_id, expense_date, category_id, expense_type, recurring_id, vendor_id, vendor_name, description,
       payment_method_id, currency, amount, gst_amount, tds_amount, total_amount, exchange_rate, amount_base,
       is_reimbursable, paid_by, status, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     RETURNING *`,
    [Number(data.entity_id), date, data.category_id ? Number(data.category_id) : null, data.expense_type || "VARIABLE",
     data.recurring_id || null, data.vendor_id || null, data.vendor_name || null, data.description || null,
     data.payment_method_id || null, ccy, amount, gst, tds, total, exchangeRate, amountBase,
     !!data.is_reimbursable, data.paid_by || null, "RECORDED", data.notes || null, userId || null]);
  const expense = ins.rows[0];
  await postExpenseToGl(db, expense, userId);
  return expense;
}

// Post an expense to the GL — debit its category's account, credit the payment
// method's account (or the reimbursements liability), then stamp gl_entry_id
// back onto the row. Shared by create and edit (which reverses then re-posts).
async function postExpenseToGl(db, expense, userId) {
  if (!(await glPosting.glAvailable(db))) return;
  const cat = await db.query("SELECT gl_account_id FROM expense_categories WHERE id = $1", [expense.category_id]);
  const catCode = await accountCode(db, cat.rows[0]?.gl_account_id);
  let creditCode = REIMBURSEMENTS_ACCOUNT;
  if (!expense.is_reimbursable) {
    const pm = await db.query("SELECT gl_account_id FROM payment_methods WHERE id = $1", [expense.payment_method_id]);
    creditCode = (await accountCode(db, pm.rows[0]?.gl_account_id)) || "1000";
  }
  if (!catCode) return;
  const posted = await glPosting.postExpense(db, {
    ...expense, region_id: expense.entity_id, expense_account_code: catCode, credit_account_code: creditCode, created_by: userId,
  });
  if (posted?.id) await db.query("UPDATE expenses SET gl_entry_id = $1 WHERE id = $2", [posted.id, expense.id]);
}

// ---- masters ---------------------------------------------------------------
const listCategories = async (req, res) => {
  try {
    if (!(await ready())) return notReady(res);
    const where = req.query.all === "true" ? "" : "WHERE ec.is_active = true";
    const { rows } = await pool.query(
      `SELECT ec.*, a.account_code, a.account_name AS gl_account_name
         FROM expense_categories ec LEFT JOIN chart_of_accounts a ON ec.gl_account_id = a.id
        ${where} ORDER BY ec.name`);
    return res.json({ success: true, ready: true, data: rows });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};

const createCategory = async (req, res) => {
  try {
    if (!(await ready())) return notReady(res);
    const { name, gl_account_id } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ success: false, message: "Category name is required" });
    const { rows } = await pool.query(
      `INSERT INTO expense_categories (name, gl_account_id) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET gl_account_id = EXCLUDED.gl_account_id, is_active = true
       RETURNING *`, [String(name).trim(), gl_account_id || null]);
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};

const updateCategory = async (req, res) => {
  try {
    if (!(await ready())) return notReady(res);
    const id = Number(req.params.id);
    const sets = []; const params = [];
    if (req.body.name !== undefined) { params.push(String(req.body.name).trim()); sets.push(`name = $${params.length}`); }
    if (req.body.gl_account_id !== undefined) { params.push(req.body.gl_account_id || null); sets.push(`gl_account_id = $${params.length}`); }
    if (req.body.is_active !== undefined) { params.push(!!req.body.is_active); sets.push(`is_active = $${params.length}`); }
    if (!sets.length) return res.status(400).json({ success: false, message: "Nothing to update" });
    params.push(id);
    const { rows } = await pool.query(`UPDATE expense_categories SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`, params);
    if (!rows.length) return res.status(404).json({ success: false, message: "Category not found" });
    return res.json({ success: true, data: rows[0] });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};

// 360° view for a single category: consolidated totals, spend by location
// (entity), monthly trend and recent expenses. All cross-entity money is folded
// into one reporting currency (USD) so a multi-location category reads cleanly.
const categoryOverview = async (req, res) => {
  try {
    if (!(await ready())) return notReady(res);
    const id = Number(req.params.id);
    const year = Number(req.query.year) || new Date().getFullYear();

    const catRes = await pool.query(
      `SELECT ec.*, a.account_code, a.account_name AS gl_account_name
         FROM expense_categories ec LEFT JOIN chart_of_accounts a ON ec.gl_account_id = a.id
        WHERE ec.id = $1`, [id]);
    if (!catRes.rows.length) return res.status(404).json({ success: false, message: "Category not found" });
    const category = catRes.rows[0];

    // Optional RBAC scope clause, parameterised per-query.
    const scopeIds = (req.scopeEnforced && Array.isArray(req.allowedEntityIds)) ? req.allowedEntityIds : null;
    const reporting = "USD";
    const cache = new Map();

    // Totals by type + currency.
    const tParams = [id]; let tScope = "";
    if (scopeIds) { tParams.push(scopeIds); tScope = `AND e.entity_id = ANY($${tParams.length})`; }
    const tRes = await pool.query(
      `SELECT e.expense_type, e.currency, COUNT(*)::int AS n, SUM(e.total_amount) AS total
         FROM expenses e
        WHERE e.category_id = $1 AND e.status <> 'CANCELLED' ${tScope}
        GROUP BY e.expense_type, e.currency`, tParams);
    let fixed = 0, variable = 0, count = 0;
    for (const r of tRes.rows) {
      const c = await convertAmount(r.total, r.currency, reporting, cache);
      if (r.expense_type === "FIXED") fixed += c; else variable += c;
      count += r.n;
    }

    // Spend by location (entity).
    const enParams = [id]; let enScope = "";
    if (scopeIds) { enParams.push(scopeIds); enScope = `AND e.entity_id = ANY($${enParams.length})`; }
    const enRes = await pool.query(
      `SELECT r.region_name, e.currency, SUM(e.total_amount) AS total
         FROM expenses e LEFT JOIN regions r ON e.entity_id = r.id
        WHERE e.category_id = $1 AND e.status <> 'CANCELLED' ${enScope}
        GROUP BY r.region_name, e.currency`, enParams);
    const byEntityMap = new Map();
    for (const r of enRes.rows) {
      const c = await convertAmount(r.total, r.currency, reporting, cache);
      const name = r.region_name || "Unassigned";
      byEntityMap.set(name, (byEntityMap.get(name) || 0) + c);
    }
    const byEntity = [...byEntityMap.entries()].map(([name, total]) => ({ name, total: round2(total) })).sort((a, b) => b.total - a.total);

    // Monthly trend for the year.
    const mParams = [id, year]; let mScope = "";
    if (scopeIds) { mParams.push(scopeIds); mScope = `AND e.entity_id = ANY($${mParams.length})`; }
    const mRes = await pool.query(
      `SELECT EXTRACT(MONTH FROM e.expense_date)::int AS month, e.currency, SUM(e.total_amount) AS total
         FROM expenses e
        WHERE e.category_id = $1 AND e.status <> 'CANCELLED' AND EXTRACT(YEAR FROM e.expense_date) = $2 ${mScope}
        GROUP BY EXTRACT(MONTH FROM e.expense_date), e.currency`, mParams);
    const months = Array(12).fill(0);
    for (const r of mRes.rows) {
      const idx = Number(r.month) - 1;
      if (idx >= 0 && idx < 12) months[idx] += await convertAmount(r.total, r.currency, reporting, cache);
    }
    const byMonth = months.map((v, i) => ({ month: i + 1, total: round2(v) }));

    // Recent expenses for this category.
    const rParams = [id]; let rScope = "";
    if (scopeIds) { rParams.push(scopeIds); rScope = `AND e.entity_id = ANY($${rParams.length})`; }
    const recentRes = await pool.query(
      `SELECT e.id, e.expense_date, e.description, e.vendor_name, e.paid_by, e.is_reimbursable,
              e.currency, e.amount, e.gst_amount, e.tds_amount, e.total_amount, e.expense_type, e.status,
              r.region_name AS entity_name, pm.name AS payment_method_name
         FROM expenses e
         LEFT JOIN regions r ON e.entity_id = r.id
         LEFT JOIN payment_methods pm ON e.payment_method_id = pm.id
        WHERE e.category_id = $1 ${rScope}
        ORDER BY e.expense_date DESC, e.id DESC LIMIT 25`, rParams);

    return res.json({ success: true, ready: true, data: {
      category, currency: reporting, year,
      summary: { total: round2(fixed + variable), fixed: round2(fixed), variable: round2(variable), count },
      byEntity, byMonth, recent: recentRes.rows,
    } });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};

const listPaymentMethods = async (req, res) => {
  try {
    if (!(await ready())) return notReady(res);
    const { rows } = await pool.query(
      `SELECT pm.*, a.account_code FROM payment_methods pm
         LEFT JOIN chart_of_accounts a ON pm.gl_account_id = a.id
        WHERE pm.is_active = true ORDER BY pm.name`);
    return res.json({ success: true, ready: true, data: rows });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};

const createPaymentMethod = async (req, res) => {
  try {
    if (!(await ready())) return notReady(res);
    const { name, gl_account_id, method_type } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ success: false, message: "Payment method name is required" });
    const { rows } = await pool.query(
      `INSERT INTO payment_methods (name, method_type, gl_account_id) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE SET gl_account_id = EXCLUDED.gl_account_id, method_type = EXCLUDED.method_type, is_active = true
       RETURNING *`,
      [String(name).trim(), String(method_type || "BANK").toUpperCase(), gl_account_id || null]);
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};

// ---- expenses register -----------------------------------------------------
const listExpenses = async (req, res) => {
  try {
    if (!(await ready())) return notReady(res);
    const { entityId, categoryId, status, from, to, type, reimbursable, search } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const params = []; const where = [];
    if (entityId) { params.push(Number(entityId)); where.push(`e.entity_id = $${params.length}`); }
    if (categoryId) { params.push(Number(categoryId)); where.push(`e.category_id = $${params.length}`); }
    if (status) { params.push(status); where.push(`e.status = $${params.length}`); }
    if (type) { params.push(type); where.push(`e.expense_type = $${params.length}`); }
    if (reimbursable === "true") where.push(`e.is_reimbursable = true`);
    if (from) { params.push(from); where.push(`e.expense_date >= $${params.length}`); }
    if (to) { params.push(to); where.push(`e.expense_date <= $${params.length}`); }
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      where.push(`(e.description ILIKE $${params.length} OR e.vendor_name ILIKE $${params.length} OR e.paid_by ILIKE $${params.length})`);
    }
    // Row-level RBAC: restrict to the caller's allowed entities (regions).
    if (req.scopeEnforced && Array.isArray(req.allowedEntityIds)) {
      params.push(req.allowedEntityIds); where.push(`e.entity_id = ANY($${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    // Count + a currency-bucketed grand total over the WHOLE filtered set (not
    // just the current page), so the footer reflects reality across pages.
    const count = await pool.query(`SELECT COUNT(*) FROM expenses e ${whereSql}`, params);
    const totalsRes = await pool.query(`SELECT e.currency, SUM(e.total_amount) AS total FROM expenses e ${whereSql} GROUP BY e.currency`, params);
    const reportingCurrency = await reportingCurrencyFor(req);
    const rateCache = new Map();
    let grandTotal = 0;
    for (const t of totalsRes.rows) grandTotal += await convertAmount(t.total, t.currency, reportingCurrency, rateCache);

    params.push(limit); params.push((page - 1) * limit);
    const { rows } = await pool.query(
      `SELECT e.*, ec.name AS category_name, pm.name AS payment_method_name, r.region_name AS entity_name
         FROM expenses e
         LEFT JOIN expense_categories ec ON e.category_id = ec.id
         LEFT JOIN payment_methods pm ON e.payment_method_id = pm.id
         LEFT JOIN regions r ON e.entity_id = r.id
         ${whereSql}
        ORDER BY e.expense_date DESC, e.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    // Per-row reporting-currency amount so cross-region charts/aggregations never
    // raw-sum mixed native currencies (single region → same currency, 1:1).
    for (const row of rows) {
      row.total_amount_reporting = await convertAmount(row.total_amount, row.currency, reportingCurrency, rateCache);
    }
    return res.json({
      success: true, ready: true, data: rows,
      pagination: { total: Number(count.rows[0].count), page, limit },
      grandTotal: round2(grandTotal), currency: reportingCurrency,
    });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};

// Excel/CSV/PDF export of the expenses register honouring the SAME filters as
// the list (entity, category, status, type, date range, search) but with no
// pagination — the whole filtered set, plus a consolidated USD total column.
const exportExpenses = async (req, res) => {
  try {
    if (!(await ready())) return notReady(res);
    const { entityId, categoryId, status, from, to, type, reimbursable, search } = req.query;
    const params = []; const where = [];
    if (entityId) { params.push(Number(entityId)); where.push(`e.entity_id = $${params.length}`); }
    if (categoryId) { params.push(Number(categoryId)); where.push(`e.category_id = $${params.length}`); }
    if (status) { params.push(status); where.push(`e.status = $${params.length}`); }
    if (type) { params.push(type); where.push(`e.expense_type = $${params.length}`); }
    if (reimbursable === "true") where.push(`e.is_reimbursable = true`);
    if (from) { params.push(from); where.push(`e.expense_date >= $${params.length}`); }
    if (to) { params.push(to); where.push(`e.expense_date <= $${params.length}`); }
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      where.push(`(e.description ILIKE $${params.length} OR e.vendor_name ILIKE $${params.length} OR e.paid_by ILIKE $${params.length})`);
    }
    if (req.scopeEnforced && Array.isArray(req.allowedEntityIds)) {
      params.push(req.allowedEntityIds); where.push(`e.entity_id = ANY($${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const { rows } = await pool.query(
      `SELECT e.*, ec.name AS category_name, pm.name AS payment_method_name, r.region_name AS entity_name
         FROM expenses e
         LEFT JOIN expense_categories ec ON e.category_id = ec.id
         LEFT JOIN payment_methods pm ON e.payment_method_id = pm.id
         LEFT JOIN regions r ON e.entity_id = r.id
         ${whereSql}
        ORDER BY e.expense_date DESC, e.id DESC`, params);

    const cache = new Map();
    let totalUsd = 0;
    const outRows = [];
    for (const r of rows) {
      const usd = await convertAmount(r.total_amount, r.currency, "USD", cache);
      totalUsd += usd;
      outRows.push({
        expense_date: String(r.expense_date).slice(0, 10),
        entity_name: r.entity_name || "",
        category_name: r.category_name || "",
        expense_type: r.expense_type || "",
        description: r.description || "",
        payee: r.is_reimbursable ? `${r.paid_by || "Staff"} (reimb.)` : (r.vendor_name || r.payment_method_name || ""),
        currency: r.currency,
        amount: num(r.amount),
        gst_amount: num(r.gst_amount),
        tds_amount: num(r.tds_amount),
        total_amount: num(r.total_amount),
        total_usd: round2(usd),
        status: r.status,
      });
    }

    const rangeLabel = (from || to) ? `${from || "…"} to ${to || "…"}` : "All dates";
    const report = {
      title: "Expenses",
      subtitle: `${rangeLabel} · ${outRows.length} expense(s) · total in USD (consolidated)`,
      columns: [
        { key: "expense_date", label: "Date", type: "text" },
        { key: "entity_name", label: "Location", type: "text" },
        { key: "category_name", label: "Category", type: "text" },
        { key: "expense_type", label: "Type", type: "text" },
        { key: "description", label: "Description", type: "text" },
        { key: "payee", label: "Payee", type: "text" },
        { key: "currency", label: "Currency", type: "text" },
        { key: "amount", label: "Amount", type: "money" },
        { key: "gst_amount", label: "GST", type: "money" },
        { key: "tds_amount", label: "TDS", type: "money" },
        { key: "total_amount", label: "Total", type: "money" },
        { key: "total_usd", label: "Total (USD)", type: "money" },
        { key: "status", label: "Status", type: "text" },
      ],
      rows: outRows,
      totals: { total_usd: round2(totalUsd) },
    };
    return await sendReport(res, report, req.query.format || "xlsx");
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};

const createExpense = async (req, res) => {
  const db = await pool.connect();
  try {
    if (!(await ready(db))) return notReady(res);
    const b = req.body;
    if (!b.entity_id || !b.expense_date || !b.category_id) {
      return res.status(400).json({ success: false, message: "entity_id, expense_date and category_id are required" });
    }
    if (!(Number(b.amount) > 0)) {
      return res.status(400).json({ success: false, message: "A valid expense amount greater than zero is required" });
    }
    // Row-level RBAC: never trust a body-supplied entity_id outside the caller's scope.
    if (!canActOnEntity(req, b.entity_id)) {
      return res.status(403).json({ success: false, message: "Not authorized for this entity (region)" });
    }
    await db.query("BEGIN");
    const expense = await recordExpense(db, b, req.user?.id);
    await db.query("COMMIT");
    await auditLog({ userId: req.user?.id, userEmail: req.user?.email, action: "CREATE", entityType: "expenses", entityId: expense.id, newValues: expense, ipAddress: req.ip });
    return res.status(201).json({ success: true, data: expense });
  } catch (e) {
    try { await db.query("ROLLBACK"); } catch (_) {}
    return res.status(500).json({ success: false, message: e.message });
  } finally { db.release(); }
};

const reimburseExpense = async (req, res) => {
  const db = await pool.connect();
  try {
    if (!(await ready(db))) return notReady(res);
    const id = Number(req.params.id);
    const { rows } = await db.query("SELECT * FROM expenses WHERE id = $1", [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: "Expense not found" });
    const e = rows[0];
    if (!e.is_reimbursable || e.status === "REIMBURSED") return res.status(400).json({ success: false, message: "Not a pending reimbursable expense" });
    if (!canActOnEntity(req, e.entity_id)) return res.status(403).json({ success: false, message: "Not authorized to reimburse expenses for this entity" });
    const bankCode = String(req.body.payment_account_code || "1000");

    await db.query("BEGIN");
    if (await glPosting.glAvailable(db)) {
      // Route through the hash-chained engine (postExpenseReimbursement) instead
      // of the legacy createJournalEntry so the entry is location-tagged, carries
      // *_minor amounts, joins the hash chain, and is POST-authorized.
      await glPosting.postExpenseReimbursement(
        db,
        { ...e, created_by: req.user?.id || null },
        { reimbursementCode: REIMBURSEMENTS_ACCOUNT, bankCode },
      );
    }
    await db.query("UPDATE expenses SET status = 'REIMBURSED', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [id]);
    await db.query("COMMIT");
    return res.json({ success: true, message: "Reimbursement recorded" });
  } catch (e) {
    try { await db.query("ROLLBACK"); } catch (_) {}
    return res.status(500).json({ success: false, message: e.message });
  } finally { db.release(); }
};

// Edit an expense. Amounts/accounts may change, so the prior GL entry is
// reversed and a fresh one posted — keeping the ledger balanced and audit-clean.
const updateExpense = async (req, res) => {
  const db = await pool.connect();
  try {
    if (!(await ready(db))) return notReady(res);
    const id = Number(req.params.id);
    const cur = await db.query("SELECT * FROM expenses WHERE id = $1", [id]);
    if (!cur.rows.length) return res.status(404).json({ success: false, message: "Expense not found" });
    const existing = cur.rows[0];
    if (!canActOnEntity(req, existing.entity_id)) return res.status(403).json({ success: false, message: "Not authorized for this entity (region)" });
    if (existing.status === "REIMBURSED") return res.status(400).json({ success: false, message: "A reimbursed expense is settled and can't be edited. Reverse the reimbursement first." });

    const b = req.body;
    const entityId = b.entity_id != null ? Number(b.entity_id) : existing.entity_id;
    const categoryId = b.category_id != null ? Number(b.category_id) : existing.category_id;
    if (!entityId || !categoryId) return res.status(400).json({ success: false, message: "entity_id and category_id are required" });
    if (!canActOnEntity(req, entityId)) return res.status(403).json({ success: false, message: "Not authorized for the target entity (region)" });
    if (b.amount != null && !(Number(b.amount) > 0)) return res.status(400).json({ success: false, message: "A valid expense amount greater than zero is required" });

    const amount = round2(b.amount != null ? b.amount : existing.amount);
    const gst = round2(b.gst_amount != null ? b.gst_amount : existing.gst_amount);
    const tds = round2(b.tds_amount != null ? b.tds_amount : existing.tds_amount);
    const total = round2(amount + gst);
    const ccy = String(b.currency || existing.currency || "INR").toUpperCase();
    const date = String(b.expense_date || existing.expense_date).slice(0, 10);
    const reimbursable = b.is_reimbursable != null ? !!b.is_reimbursable : existing.is_reimbursable;
    const paymentMethodId = reimbursable ? null : (b.payment_method_id ? Number(b.payment_method_id) : (b.payment_method_id === "" ? null : existing.payment_method_id));

    let exchangeRate = 1, amountBase = total;
    try { const f = await currency.toFunctional(total, ccy, entityId, date, db); amountBase = f.amountBase; exchangeRate = f.exchangeRate; } catch (_) { /* migration 001 absent */ }

    await db.query("BEGIN");
    if (existing.gl_entry_id && await glPosting.glAvailable(db)) {
      await glPosting.reverseEntry(db, existing.gl_entry_id, "Expense edited", req.user?.id || null);
    }
    const upd = await db.query(
      `UPDATE expenses SET
         entity_id=$1, expense_date=$2, category_id=$3, expense_type=$4, vendor_name=$5, description=$6,
         payment_method_id=$7, currency=$8, amount=$9, gst_amount=$10, tds_amount=$11, total_amount=$12,
         exchange_rate=$13, amount_base=$14, is_reimbursable=$15, paid_by=$16, notes=$17,
         gl_entry_id=NULL, updated_at=CURRENT_TIMESTAMP
       WHERE id=$18 RETURNING *`,
      [entityId, date, categoryId, b.expense_type || existing.expense_type, b.vendor_name ?? existing.vendor_name,
       b.description ?? existing.description, paymentMethodId, ccy, amount, gst, tds, total, exchangeRate, amountBase,
       reimbursable, reimbursable ? (b.paid_by ?? existing.paid_by) : null, b.notes ?? existing.notes, id]);
    await postExpenseToGl(db, upd.rows[0], req.user?.id);
    const fresh = await db.query("SELECT * FROM expenses WHERE id = $1", [id]);
    await db.query("COMMIT");
    await auditLog({ userId: req.user?.id, userEmail: req.user?.email, action: "UPDATE", entityType: "expenses", entityId: id, oldValues: existing, newValues: fresh.rows[0], ipAddress: req.ip });
    return res.json({ success: true, data: fresh.rows[0] });
  } catch (e) {
    try { await db.query("ROLLBACK"); } catch (_) {}
    return res.status(500).json({ success: false, message: e.message });
  } finally { db.release(); }
};

// Delete an expense. Any GL entry it posted is reversed first so the ledger
// stays balanced; the immutable posted+reversal pair remains for audit.
const deleteExpense = async (req, res) => {
  const db = await pool.connect();
  try {
    if (!(await ready(db))) return notReady(res);
    const id = Number(req.params.id);
    const { rows } = await db.query("SELECT * FROM expenses WHERE id = $1", [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: "Expense not found" });
    const e = rows[0];
    if (!canActOnEntity(req, e.entity_id)) return res.status(403).json({ success: false, message: "Not authorized to delete expenses for this entity" });
    if (e.status === "REIMBURSED") return res.status(400).json({ success: false, message: "A reimbursed expense is settled and can't be deleted. Reverse the reimbursement first." });

    await db.query("BEGIN");
    if (e.gl_entry_id && await glPosting.glAvailable(db)) {
      await glPosting.reverseEntry(db, e.gl_entry_id, "Expense deleted", req.user?.id || null);
    }
    await db.query("DELETE FROM expenses WHERE id = $1", [id]);
    await db.query("COMMIT");
    await auditLog({ userId: req.user?.id, userEmail: req.user?.email, action: "DELETE", entityType: "expenses", entityId: id, oldValues: e, ipAddress: req.ip });
    return res.json({ success: true, message: "Expense deleted" });
  } catch (e) {
    try { await db.query("ROLLBACK"); } catch (_) {}
    return res.status(500).json({ success: false, message: e.message });
  } finally { db.release(); }
};

// ---- recurring -------------------------------------------------------------
const listRecurring = async (req, res) => {
  try {
    if (!(await ready())) return notReady(res);
    const { rows } = await pool.query(
      `SELECT re.*, ec.name AS category_name, r.region_name AS entity_name
         FROM recurring_expenses re
         LEFT JOIN expense_categories ec ON re.category_id = ec.id
         LEFT JOIN regions r ON re.entity_id = r.id
        ORDER BY re.is_active DESC, re.name`);
    return res.json({ success: true, ready: true, data: rows });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};

const createRecurring = async (req, res) => {
  try {
    if (!(await ready())) return notReady(res);
    const b = req.body;
    const actual = round2(b.actual_cost);
    const gstPct = num(b.gst_percent); const tdsPct = num(b.tds_percent);
    const amount = round2(actual + actual * gstPct / 100 - actual * tdsPct / 100);
    const period = Math.max(1, Number(b.period_months) || 1);
    const monthly = round2(amount / period);
    const { rows } = await pool.query(
      `INSERT INTO recurring_expenses
        (entity_id, name, category_id, vendor_id, vendor_name, payment_method_id, currency,
         actual_cost, gst_percent, tds_percent, amount, period_months, monthly_equiv, start_month, end_month, is_active, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [Number(b.entity_id), b.name, b.category_id || null, b.vendor_id || null, b.vendor_name || null,
       b.payment_method_id || null, String(b.currency || "INR").toUpperCase(), actual, gstPct, tdsPct, amount, period, monthly,
       b.start_month, b.end_month || null, b.is_active !== false, b.notes || null, req.user?.id || null]);
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};

// Generate the selected month's expenses from active recurring templates (idempotent).
const runRecurring = async (req, res) => {
  const db = await pool.connect();
  try {
    if (!(await ready(db))) return notReady(res);
    const monthStart = req.body.month ? new Date(req.body.month) : new Date();
    monthStart.setDate(1);
    const mDate = monthStart.toISOString().slice(0, 10);

    await db.query("BEGIN");
    const { rows: templates } = await db.query(
      `SELECT * FROM recurring_expenses WHERE is_active = true AND start_month <= $1 AND (end_month IS NULL OR end_month >= $1)`, [mDate]);
    let created = 0;
    for (const t of templates) {
      const exists = await db.query(
        `SELECT 1 FROM expenses WHERE recurring_id = $1 AND date_trunc('month', expense_date) = date_trunc('month', $2::date) LIMIT 1`, [t.id, mDate]);
      if (exists.rowCount) continue;
      const monthlyActual = num(t.actual_cost) / Math.max(1, t.period_months);
      await recordExpense(db, {
        entity_id: t.entity_id, expense_date: mDate, category_id: t.category_id, expense_type: "FIXED",
        recurring_id: t.id, vendor_name: t.vendor_name, payment_method_id: t.payment_method_id, currency: t.currency,
        amount: round2(monthlyActual), gst_amount: round2(monthlyActual * num(t.gst_percent) / 100),
        tds_amount: round2(monthlyActual * num(t.tds_percent) / 100), description: t.name,
      }, req.user?.id);
      created += 1;
    }
    await db.query("COMMIT");
    return res.json({ success: true, message: `Generated ${created} recurring expense(s) for ${mDate}.`, created });
  } catch (e) {
    try { await db.query("ROLLBACK"); } catch (_) {}
    return res.status(500).json({ success: false, message: e.message });
  } finally { db.release(); }
};

// How many of the active templates due in a given month have already been
// generated into the expenses register. Powers the "generated?" indicator.
const recurringStatus = async (req, res) => {
  try {
    if (!(await ready())) return notReady(res);
    const monthStart = req.query.month ? new Date(req.query.month) : new Date();
    monthStart.setDate(1);
    const mDate = monthStart.toISOString().slice(0, 10);
    const { rows } = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE re.is_active AND re.start_month <= $1 AND (re.end_month IS NULL OR re.end_month >= $1))::int AS due,
         COUNT(*) FILTER (WHERE re.is_active AND re.start_month <= $1 AND (re.end_month IS NULL OR re.end_month >= $1)
                           AND EXISTS (SELECT 1 FROM expenses e
                                        WHERE e.recurring_id = re.id
                                          AND date_trunc('month', e.expense_date) = date_trunc('month', $1::date)))::int AS generated
         FROM recurring_expenses re`, [mDate]);
    const due = rows[0].due || 0, generated = rows[0].generated || 0;
    return res.json({ success: true, ready: true, data: { month: mDate, due, generated, pending: Math.max(0, due - generated) } });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};

// ---- reports ---------------------------------------------------------------
const reportByCategory = async (req, res) => {
  try {
    if (!(await ready())) return notReady(res);
    const year = Number(req.query.year) || new Date().getFullYear();
    const params = [year]; let entityFilter = "";
    if (req.query.entityId) { params.push(Number(req.query.entityId)); entityFilter = `AND e.entity_id = $${params.length}`; }
    // Group by currency too, then fold per-currency buckets into the reporting
    // currency so a multi-entity matrix doesn't add ₹ + $ + € into one cell.
    const { rows } = await pool.query(
      `SELECT ec.name AS category, EXTRACT(MONTH FROM e.expense_date)::int AS month, e.currency, SUM(e.total_amount) AS total
         FROM expenses e LEFT JOIN expense_categories ec ON e.category_id = ec.id
        WHERE EXTRACT(YEAR FROM e.expense_date) = $1 AND e.status <> 'CANCELLED' ${entityFilter}
        GROUP BY ec.name, EXTRACT(MONTH FROM e.expense_date), e.currency`, params);
    const reportingCurrency = await reportingCurrencyFor(req);
    const cache = new Map();
    const agg = new Map();
    for (const r of rows) {
      const conv = await convertAmount(r.total, r.currency, reportingCurrency, cache);
      const key = `${r.category ?? "Uncategorised"} ${r.month}`;
      agg.set(key, (agg.get(key) || 0) + conv);
    }
    const data = [...agg.entries()].map(([key, total]) => {
      const [category, month] = key.split(" ");
      return { category, month: Number(month), total: round2(total) };
    }).sort((a, b) => String(a.category).localeCompare(String(b.category)));
    return res.json({ success: true, ready: true, year, currency: reportingCurrency, data });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};

const reportSummary = async (req, res) => {
  try {
    if (!(await ready())) return notReady(res);
    const params = []; const where = ["status <> 'CANCELLED'"];
    if (req.query.entityId) { params.push(Number(req.query.entityId)); where.push(`entity_id = $${params.length}`); }
    if (req.query.from) { params.push(req.query.from); where.push(`expense_date >= $${params.length}`); }
    if (req.query.to) { params.push(req.query.to); where.push(`expense_date <= $${params.length}`); }
    // Bucket by type AND currency, then fold into the reporting currency so the
    // all-entities totals don't sum mixed currencies.
    const { rows } = await pool.query(
      `SELECT expense_type, currency, COUNT(*)::int AS count, SUM(total_amount) AS total
         FROM expenses WHERE ${where.join(" AND ")} GROUP BY expense_type, currency`, params);
    const reportingCurrency = await reportingCurrencyFor(req);
    const cache = new Map();
    let fixed = 0, variable = 0, fixedCount = 0, variableCount = 0;
    for (const r of rows) {
      const conv = await convertAmount(r.total, r.currency, reportingCurrency, cache);
      if (r.expense_type === "FIXED") { fixed += conv; fixedCount += r.count; }
      else { variable += conv; variableCount += r.count; }
    }
    return res.json({ success: true, ready: true, data: {
      fixed: round2(fixed), variable: round2(variable), total: round2(fixed + variable),
      fixedCount, variableCount, currency: reportingCurrency,
    } });
  } catch (e) { return res.status(500).json({ success: false, message: e.message }); }
};

module.exports = {
  listCategories, createCategory, updateCategory, categoryOverview, listPaymentMethods, createPaymentMethod, listExpenses, exportExpenses, createExpense, updateExpense, deleteExpense, reimburseExpense,
  listRecurring, createRecurring, runRecurring, recurringStatus, reportByCategory, reportSummary,
};

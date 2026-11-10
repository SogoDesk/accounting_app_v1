const pool = require("../config/db");
const glReports = require("../services/gl/glReports");
const postingService = require("../services/gl/postingService");
const fxRevaluationService = require("../services/gl/fxRevaluationService");
const recognitionService = require("../services/gl/recognitionService");
const closeScheduler = require("../services/gl/closeScheduler");
const { canActOnEntity } = require("../middleware/scopeMiddleware");
const { sendReport } = require("../services/reports/reportExport");

// GL is "ready" only when migrations 001 + 002 have both been applied.
async function glReadiness(db = pool) {
  const { rows } = await db.query(`
    SELECT to_regclass('public.journal_entries') AS gl,
           to_regclass('public.exchange_rates')  AS fx,
           EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_name = 'regions' AND column_name = 'functional_currency'
           ) AS func
  `);
  const r = rows[0];
  return Boolean(r.gl) && Boolean(r.fx) && Boolean(r.func);
}

const notReady = (res) =>
  res.json({
    success: true,
    glReady: false,
    message: "General ledger not enabled. Apply migrations 001 and 002, then restart the backend.",
    data: null,
  });

// GET /api/gl/chart-of-accounts
const getChartOfAccounts = async (req, res) => {
  try {
    if (!(await glReadiness())) return notReady(res);
    const { rows } = await pool.query(
      `SELECT id, account_code, account_name, account_type, normal_balance, is_control, is_active
         FROM chart_of_accounts
        ORDER BY account_code`,
    );
    return res.json({ success: true, glReady: true, data: rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// Normal balance is determined by account family (no need to ask the user).
const ACCOUNT_TYPES = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"];
const normalBalanceFor = (type) =>
  type === "ASSET" || type === "EXPENSE" ? "DEBIT" : "CREDIT";

async function accountHasLines(accountId, db = pool) {
  const { rows } = await db.query(
    "SELECT 1 FROM journal_lines WHERE account_id = $1 LIMIT 1",
    [accountId],
  );
  return rows.length > 0;
}

// POST /api/gl/chart-of-accounts  { account_code, account_name, account_type }
const createAccount = async (req, res) => {
  try {
    if (!(await glReadiness())) return notReady(res);
    const code = String(req.body.account_code || "").trim();
    const name = String(req.body.account_name || "").trim();
    const type = String(req.body.account_type || "").trim().toUpperCase();

    if (!code) return res.status(400).json({ success: false, message: "Account code is required." });
    if (!name) return res.status(400).json({ success: false, message: "Account name is required." });
    if (!ACCOUNT_TYPES.includes(type)) {
      return res.status(400).json({ success: false, message: "Pick a valid account type." });
    }

    const dup = await pool.query("SELECT 1 FROM chart_of_accounts WHERE account_code = $1", [code]);
    if (dup.rows.length) {
      return res.status(400).json({ success: false, message: `Account code ${code} already exists.` });
    }

    const { rows } = await pool.query(
      `INSERT INTO chart_of_accounts (account_code, account_name, account_type, normal_balance, is_control, is_active)
       VALUES ($1, $2, $3, $4, false, true)
       RETURNING id, account_code, account_name, account_type, normal_balance, is_control, is_active`,
      [code, name, type, normalBalanceFor(type)],
    );
    return res.status(201).json({ success: true, glReady: true, data: rows[0] });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// PUT /api/gl/chart-of-accounts/:id  { account_name?, account_type?, account_code?, is_active? }
// Rename and active-toggle are always allowed; code/type changes are blocked once
// the account has posted lines (would silently rewrite history in the reports).
const updateAccount = async (req, res) => {
  try {
    if (!(await glReadiness())) return notReady(res);
    const id = Number(req.params.id);
    const found = await pool.query("SELECT * FROM chart_of_accounts WHERE id = $1", [id]);
    if (!found.rows.length) {
      return res.status(404).json({ success: false, message: "Account not found." });
    }
    const acc = found.rows[0];
    if (acc.is_control) {
      return res.status(400).json({ success: false, message: "System control accounts can't be edited." });
    }

    const sets = [];
    const params = [];
    const push = (frag, val) => { params.push(val); sets.push(`${frag} = $${params.length}`); };

    if (req.body.account_name != null) {
      const name = String(req.body.account_name).trim();
      if (!name) return res.status(400).json({ success: false, message: "Account name can't be empty." });
      push("account_name", name);
    }

    if (req.body.is_active != null) {
      push("is_active", Boolean(req.body.is_active));
    }

    const wantsCode = req.body.account_code != null && String(req.body.account_code).trim() !== acc.account_code;
    const wantsType = req.body.account_type != null && String(req.body.account_type).trim().toUpperCase() !== acc.account_type;

    if (wantsCode || wantsType) {
      if (await accountHasLines(id)) {
        return res.status(400).json({
          success: false,
          message: "This account already has transactions, so its code and type are locked. You can still rename or deactivate it.",
        });
      }
      if (wantsCode) {
        const code = String(req.body.account_code).trim();
        const dup = await pool.query("SELECT 1 FROM chart_of_accounts WHERE account_code = $1 AND id <> $2", [code, id]);
        if (dup.rows.length) return res.status(400).json({ success: false, message: `Account code ${code} already exists.` });
        push("account_code", code);
      }
      if (wantsType) {
        const type = String(req.body.account_type).trim().toUpperCase();
        if (!ACCOUNT_TYPES.includes(type)) return res.status(400).json({ success: false, message: "Pick a valid account type." });
        push("account_type", type);
        push("normal_balance", normalBalanceFor(type));
      }
    }

    if (!sets.length) {
      return res.status(400).json({ success: false, message: "Nothing to update." });
    }

    params.push(id);
    const { rows } = await pool.query(
      `UPDATE chart_of_accounts SET ${sets.join(", ")} WHERE id = $${params.length}
       RETURNING id, account_code, account_name, account_type, normal_balance, is_control, is_active`,
      params,
    );
    return res.json({ success: true, glReady: true, data: rows[0] });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/gl/journal-entries?entityId=&from=&to=&source=&status=&page=&limit=
const getJournalEntries = async (req, res) => {
  try {
    if (!(await glReadiness())) return notReady(res);
    const { entityId, from, to, source, status } = req.query;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Number(req.query.limit) || 50);

    const params = [];
    const where = [];
    if (entityId) { params.push(Number(entityId)); where.push(`je.entity_id = $${params.length}`); }
    if (from) { params.push(from); where.push(`je.entry_date >= $${params.length}`); }
    if (to) { params.push(to); where.push(`je.entry_date <= $${params.length}`); }
    if (source) { params.push(source); where.push(`je.source = $${params.length}`); }
    if (status) { params.push(status); where.push(`je.status = $${params.length}`); }
    // Row-level RBAC: restrict to the caller's allowed entities (regions).
    if (req.scopeEnforced && Array.isArray(req.allowedEntityIds)) {
      params.push(req.allowedEntityIds); where.push(`je.entity_id = ANY($${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM journal_entries je ${whereSql}`, params,
    );

    params.push(limit); params.push((page - 1) * limit);
    const { rows } = await pool.query(
      `SELECT je.id, je.entry_no, je.entry_date, je.description, je.source,
              je.source_ref, je.status, je.entity_id, r.region_name AS entity_name,
              COALESCE(r.functional_currency, r.default_currency) AS entity_currency,
              (SELECT COALESCE(SUM(jl.debit_base), 0)
                 FROM journal_lines jl WHERE jl.entry_id = je.id) AS amount_base
         FROM journal_entries je
         JOIN regions r ON je.entity_id = r.id
         ${whereSql}
        ORDER BY je.entry_date DESC, je.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return res.json({
      success: true, glReady: true, data: rows,
      pagination: { total: Number(countResult.rows[0].count), page, limit },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/gl/journal-entries/:id
const getJournalEntryById = async (req, res) => {
  try {
    if (!(await glReadiness())) return notReady(res);
    const id = Number(req.params.id);
    const header = await pool.query(
      `SELECT je.*, r.region_name AS entity_name,
              COALESCE(r.functional_currency, r.default_currency) AS entity_currency
         FROM journal_entries je JOIN regions r ON je.entity_id = r.id
        WHERE je.id = $1`, [id],
    );
    if (!header.rows.length || !canActOnEntity(req, header.rows[0].entity_id)) {
      return res.status(404).json({ success: false, message: "Journal entry not found" });
    }
    const lines = await pool.query(
      `SELECT jl.id, jl.account_id, a.account_code, a.account_name, a.account_type,
              jl.currency, jl.debit, jl.credit, jl.exchange_rate,
              jl.debit_base, jl.credit_base, jl.memo
         FROM journal_lines jl
         JOIN chart_of_accounts a ON jl.account_id = a.id
        WHERE jl.entry_id = $1
        ORDER BY jl.id`, [id],
    );
    return res.json({ success: true, glReady: true, data: { ...header.rows[0], lines: lines.rows } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/gl/journal-entries
// Manual journal entry posted by a finance user. Lines are in the entity's
// functional currency. Posts through the immutable ledgerEngine (balanced,
// period-checked, hash-chained) inside a single transaction.
const createManualJournalEntry = async (req, res) => {
  try {
    if (!(await glReadiness())) return notReady(res);

    const entityId = Number(req.body.entityId);
    const entryDate = req.body.entryDate;
    const description = (req.body.description || "").trim();
    const rawLines = Array.isArray(req.body.lines) ? req.body.lines : [];

    if (!entityId) return res.status(400).json({ success: false, message: "Select an entity." });
    if (!entryDate) return res.status(400).json({ success: false, message: "Entry date is required." });
    if (!canActOnEntity(req, entityId)) {
      return res.status(403).json({ success: false, message: "Not authorized for this entity." });
    }

    // Normalize + validate each line: exactly one of debit/credit, positive.
    const lines = [];
    for (const l of rawLines) {
      const accountId = Number(l.accountId);
      const debit = Math.round((Number(l.debit || 0) + Number.EPSILON) * 100) / 100;
      const credit = Math.round((Number(l.credit || 0) + Number.EPSILON) * 100) / 100;
      if (!accountId) continue; // skip blank rows
      if (debit < 0 || credit < 0) {
        return res.status(400).json({ success: false, message: "Amounts cannot be negative." });
      }
      if (debit > 0 && credit > 0) {
        return res.status(400).json({ success: false, message: "Each line is either a debit or a credit, not both." });
      }
      if (debit === 0 && credit === 0) continue; // skip empty rows
      lines.push({ accountId, debit, credit, memo: (l.memo || "").trim() || null });
    }

    if (lines.length < 2) {
      return res.status(400).json({ success: false, message: "A journal entry needs at least two lines with amounts." });
    }

    const totalDebit = Math.round(lines.reduce((s, l) => s + l.debit, 0) * 100) / 100;
    const totalCredit = Math.round(lines.reduce((s, l) => s + l.credit, 0) * 100) / 100;
    if (totalDebit !== totalCredit) {
      return res.status(400).json({
        success: false,
        message: `Out of balance: debits (${totalDebit}) must equal credits (${totalCredit}).`,
      });
    }
    if (totalDebit === 0) {
      return res.status(400).json({ success: false, message: "Entry total cannot be zero." });
    }

    // Block manual posting to system control accounts (AR/AP) — those tie back
    // to invoices/bills and must only be moved by the subledgers.
    const accountIds = [...new Set(lines.map((l) => l.accountId))];
    const acc = await pool.query(
      `SELECT id, account_code, account_name, is_control, is_active
         FROM chart_of_accounts WHERE id = ANY($1)`,
      [accountIds],
    );
    const byId = new Map(acc.rows.map((a) => [a.id, a]));
    for (const id of accountIds) {
      const a = byId.get(id);
      if (!a || !a.is_active) {
        return res.status(400).json({ success: false, message: "One or more accounts are invalid or inactive." });
      }
      if (a.is_control) {
        return res.status(400).json({
          success: false,
          message: `${a.account_code} ${a.account_name} is a system control account and can't be posted to manually.`,
        });
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await postingService.postManualEntry(client, {
        entityId,
        entryDate,
        description: description || "Manual journal entry",
        lines,
        userId: req.user?.id,
      });
      await client.query("COMMIT");
      return res.status(201).json({ success: true, glReady: true, data: result });
    } catch (err) {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: err.message });
    } finally {
      client.release();
    }
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/gl/reports/trial-balance?entityId=&asOf=
const getTrialBalance = async (req, res) => {
  try {
    if (!(await glReadiness())) return notReady(res);
    const entityId = req.query.entityId ? Number(req.query.entityId) : undefined;
    const allowedEntityIds = req.scopeEnforced ? req.allowedEntityIds : null;
    const data = await glReports.trialBalance({ entityId, allowedEntityIds, asOf: req.query.asOf });
    return res.json({ success: true, glReady: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/gl/reports/profit-and-loss?entityId=&from=&to=
const getProfitAndLoss = async (req, res) => {
  try {
    if (!(await glReadiness())) return notReady(res);
    const entityId = req.query.entityId ? Number(req.query.entityId) : undefined;
    const allowedEntityIds = req.scopeEnforced ? req.allowedEntityIds : null;
    const data = await glReports.profitAndLoss({ entityId, allowedEntityIds, from: req.query.from, to: req.query.to });
    return res.json({ success: true, glReady: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/gl/reports/balance-sheet?entityId=&asOf=
const getBalanceSheet = async (req, res) => {
  try {
    if (!(await glReadiness())) return notReady(res);
    const entityId = req.query.entityId ? Number(req.query.entityId) : undefined;
    const allowedEntityIds = req.scopeEnforced ? req.allowedEntityIds : null;
    const data = await glReports.balanceSheet({ entityId, allowedEntityIds, asOf: req.query.asOf });
    return res.json({ success: true, glReady: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/gl/reports/consolidated?rootLocationId=&asOf=
// Consolidated statements over an org subtree with intercompany (1600/2600)
// eliminations; eliminations.intercompanyNet must be ~0.
const getConsolidated = async (req, res) => {
  try {
    if (!(await glReadiness())) return notReady(res);
    const rootLocationId = req.query.rootLocationId ? Number(req.query.rootLocationId) : undefined;
    const allowedEntityIds = req.scopeEnforced ? req.allowedEntityIds : null;
    const data = await glReports.consolidated({ rootLocationId, allowedEntityIds, asOf: req.query.asOf });
    return res.json({ success: true, glReady: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/gl/accounts/:id/register?entityId=&from=&to=
const getAccountRegister = async (req, res) => {
  try {
    if (!(await glReadiness())) return notReady(res);
    const accountId = Number(req.params.id);
    const entityId = req.query.entityId ? Number(req.query.entityId) : undefined;
    if (entityId && !canActOnEntity(req, entityId)) {
      return res.status(403).json({ success: false, message: "Not authorized for this entity." });
    }
    const allowedEntityIds = req.scopeEnforced ? req.allowedEntityIds : null;
    const data = await glReports.accountRegister({
      accountId, entityId, allowedEntityIds, from: req.query.from, to: req.query.to,
    });
    return res.json({ success: true, glReady: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/gl/reports/general-ledger?entityId=&from=&to=
const getGeneralLedger = async (req, res) => {
  try {
    if (!(await glReadiness())) return notReady(res);
    const entityId = req.query.entityId ? Number(req.query.entityId) : undefined;
    const allowedEntityIds = req.scopeEnforced ? req.allowedEntityIds : null;
    const data = await glReports.generalLedger({ entityId, allowedEntityIds, from: req.query.from, to: req.query.to });
    return res.json({ success: true, glReady: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/gl/reports/cash-flow?entityId=&from=&to=
const getCashFlow = async (req, res) => {
  try {
    if (!(await glReadiness())) return notReady(res);
    const entityId = req.query.entityId ? Number(req.query.entityId) : undefined;
    const allowedEntityIds = req.scopeEnforced ? req.allowedEntityIds : null;
    const data = await glReports.cashFlow({ entityId, allowedEntityIds, from: req.query.from, to: req.query.to });
    return res.json({ success: true, glReady: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/gl/reports/:type/export?format=xlsx|pdf|csv&entityId=&asOf=&from=&to=
// Download trial-balance / profit-and-loss / balance-sheet as Excel, PDF, or CSV.
const exportReport = async (req, res) => {
  try {
    if (!(await glReadiness())) return notReady(res);
    const type = String(req.params.type || "");
    const format = req.query.format || "xlsx";
    const entityId = req.query.entityId ? Number(req.query.entityId) : undefined;
    const allowedEntityIds = req.scopeEnforced ? req.allowedEntityIds : null;
    let report;

    if (type === "trial-balance") {
      const d = await glReports.trialBalance({ entityId, allowedEntityIds, asOf: req.query.asOf });
      report = {
        title: "Trial Balance",
        subtitle: `As of ${d.asOf}${d.currency ? " · " + d.currency : ""}`,
        columns: [
          { key: "account_code", label: "Code" }, { key: "account_name", label: "Account" },
          { key: "debit", label: "Debit", type: "money" }, { key: "credit", label: "Credit", type: "money" },
        ],
        rows: d.rows,
        totals: { debit: d.totals.debit, credit: d.totals.credit },
      };
    } else if (type === "profit-and-loss") {
      const d = await glReports.profitAndLoss({ entityId, allowedEntityIds, from: req.query.from, to: req.query.to });
      const rows = [
        ...d.income.map((r) => ({ section: "Income", ...r })),
        ...d.expense.map((r) => ({ section: "Expense", ...r })),
      ];
      report = {
        title: "Profit and Loss",
        subtitle: `${d.from} → ${d.to}${d.currency ? " · " + d.currency : ""} · Net ${d.totals.netProfit}`,
        columns: [
          { key: "section", label: "Section" }, { key: "account_code", label: "Code" },
          { key: "account_name", label: "Account" }, { key: "amount", label: "Amount", type: "money" },
        ],
        rows,
        totals: { amount: d.totals.netProfit, section: "Net profit" },
      };
    } else if (type === "balance-sheet") {
      const d = await glReports.balanceSheet({ entityId, allowedEntityIds, asOf: req.query.asOf });
      const rows = [
        ...d.assets.map((r) => ({ section: "Assets", ...r })),
        ...d.liabilities.map((r) => ({ section: "Liabilities", ...r })),
        ...d.equity.map((r) => ({ section: "Equity", ...r })),
      ];
      report = {
        title: "Balance Sheet",
        subtitle: `As of ${d.asOf}${d.currency ? " · " + d.currency : ""} · ${d.totals.balanced ? "Balanced" : "OUT OF BALANCE"}`,
        columns: [
          { key: "section", label: "Section" }, { key: "account_code", label: "Code" },
          { key: "account_name", label: "Account" }, { key: "amount", label: "Amount", type: "money" },
        ],
        rows,
        totals: { amount: d.totals.assets, section: "Total assets" },
      };
    } else if (type === "general-ledger") {
      const d = await glReports.generalLedger({ entityId, allowedEntityIds, from: req.query.from, to: req.query.to });
      report = {
        title: "General Ledger",
        subtitle: `${d.from || "start"} → ${d.to}${d.currency ? " · " + d.currency : ""}`,
        columns: [
          { key: "account_code", label: "Code" }, { key: "account_name", label: "Account" },
          { key: "opening", label: "Opening", type: "money" }, { key: "debit", label: "Debit", type: "money" },
          { key: "credit", label: "Credit", type: "money" }, { key: "closing", label: "Closing", type: "money" },
        ],
        rows: d.rows,
        totals: {
          debit: d.rows.reduce((s, r) => s + Number(r.debit || 0), 0),
          credit: d.rows.reduce((s, r) => s + Number(r.credit || 0), 0),
        },
      };
    } else if (type === "cash-flow") {
      const d = await glReports.cashFlow({ entityId, allowedEntityIds, from: req.query.from, to: req.query.to });
      const rows = [
        ...d.sections.operating.map((r) => ({ section: "Operating", ...r })),
        ...d.sections.investing.map((r) => ({ section: "Investing", ...r })),
        ...d.sections.financing.map((r) => ({ section: "Financing", ...r })),
      ];
      report = {
        title: "Cash Flow",
        subtitle: `${d.from} → ${d.to}${d.currency ? " · " + d.currency : ""} · Net ${d.netChange}`,
        columns: [
          { key: "section", label: "Activity" }, { key: "account_code", label: "Code" },
          { key: "account_name", label: "Account" }, { key: "amount", label: "Cash in / (out)", type: "money" },
        ],
        rows,
        totals: { amount: d.netChange, section: "Net change in cash" },
      };
    } else {
      return res.status(400).json({ success: false, message: "Unknown report type" });
    }

    return await sendReport(res, report, format);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/gl/fx-revalue  { entityId, asOfDate }
const postFxRevalue = async (req, res) => {
  try {
    if (!(await glReadiness())) return notReady(res);
    const entityId = Number(req.body.entityId);
    const asOfDate = req.body.asOfDate;
    if (!entityId || !asOfDate) {
      return res.status(400).json({ success: false, message: "entityId and asOfDate are required" });
    }
    if (!canActOnEntity(req, entityId)) {
      return res.status(403).json({ success: false, message: "Not authorized for this entity" });
    }
    const data = await fxRevaluationService.revalue({ entityId, asOfDate, userId: req.user?.id });
    return res.json({ success: true, glReady: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/gl/recognition/schedules
const createRecognitionSchedule = async (req, res) => {
  try {
    if (!(await glReadiness())) return notReady(res);
    const entityId = Number(req.body.entityId);
    if (!canActOnEntity(req, entityId)) {
      return res.status(403).json({ success: false, message: "Not authorized for this entity" });
    }
    const data = await recognitionService.createSchedule({ ...req.body, entityId, userId: req.user?.id });
    return res.status(201).json({ success: true, glReady: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/gl/recognition/schedules?entityId=
const listRecognitionSchedules = async (req, res) => {
  try {
    if (!(await glReadiness())) return notReady(res);
    const entityId = req.query.entityId ? Number(req.query.entityId) : undefined;
    if (entityId && !canActOnEntity(req, entityId)) {
      return res.status(403).json({ success: false, message: "Not authorized for this entity" });
    }
    const data = await recognitionService.listSchedules({ entityId });
    return res.json({ success: true, glReady: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/gl/recognition/run  { asOfDate }
const runRecognition = async (req, res) => {
  try {
    if (!(await glReadiness())) return notReady(res);
    if (!req.body.asOfDate) {
      return res.status(400).json({ success: false, message: "asOfDate is required" });
    }
    const data = await recognitionService.runDue({ asOfDate: req.body.asOfDate, userId: req.user?.id });
    return res.json({ success: true, glReady: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/gl/period-close/run  { asOfDate }  — manual monthly-close trigger
const runPeriodClose = async (req, res) => {
  try {
    if (!(await glReadiness())) return notReady(res);
    if (!req.body.asOfDate) {
      return res.status(400).json({ success: false, message: "asOfDate is required" });
    }
    const data = await closeScheduler.runMonthlyClose({ asOfDate: req.body.asOfDate, userId: req.user?.id });
    return res.json({ success: true, glReady: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/gl/period-close/reopen  { asOfDate }  — reopen a closed period.
const reopenPeriod = async (req, res) => {
  try {
    if (!(await glReadiness())) return notReady(res);
    if (!req.body.asOfDate) {
      return res.status(400).json({ success: false, message: "asOfDate is required" });
    }
    const period = await closeScheduler.reopenPeriodFor(req.body.asOfDate);
    if (!period) return res.status(404).json({ success: false, message: "No accounting period covers that date" });
    return res.json({ success: true, glReady: true, data: { period } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  getChartOfAccounts,
  createAccount,
  updateAccount,
  getJournalEntries,
  getJournalEntryById,
  createManualJournalEntry,
  getAccountRegister,
  getGeneralLedger,
  getCashFlow,
  getTrialBalance,
  getProfitAndLoss,
  getBalanceSheet,
  getConsolidated,
  exportReport,
  postFxRevalue,
  createRecognitionSchedule,
  listRecognitionSchedules,
  runRecognition,
  runPeriodClose,
  reopenPeriod,
};

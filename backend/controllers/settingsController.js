const pool = require("../config/db");
const { ensureSettingsSchema, PERMISSION_KEYS } = require("../modules/settings/ensureSettingsSchema");
const { setManualRate } = require("../services/currency/rateService");
const { auditLog } = require("../middleware/auditMiddleware");

const normCode = (c) => String(c || "").trim().toUpperCase();

// ---------------------------------------------------------------------------
// Company settings (group / reporting currency)
// ---------------------------------------------------------------------------
const getCompanySettings = async (_req, res) => {
  try {
    await ensureSettingsSchema();
    const { rows } = await pool.query(
      `SELECT id, group_currency, updated_at FROM company_settings WHERE id = 1`,
    );
    return res.json({ success: true, data: rows[0] || { id: 1, group_currency: "USD" } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const updateCompanySettings = async (req, res) => {
  try {
    const group_currency = normCode(req.body.group_currency);
    if (!group_currency || group_currency.length > 10) {
      return res.status(400).json({ success: false, message: "Valid group currency required" });
    }
    const { rows } = await pool.query(
      `INSERT INTO company_settings (id, group_currency, updated_at)
       VALUES (1, $1, now())
       ON CONFLICT (id) DO UPDATE SET group_currency = EXCLUDED.group_currency, updated_at = now()
       RETURNING id, group_currency, updated_at`,
      [group_currency],
    );
    await auditLog({
      userId: req.user?.id, userEmail: req.user?.email, action: "UPDATE",
      entityType: "company_settings", entityId: 1,
      newValues: { group_currency }, ipAddress: req.ip,
    });
    return res.json({ success: true, message: "Company settings updated", data: rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ---------------------------------------------------------------------------
// Exchange rates (list recent + set a manual override)
// ---------------------------------------------------------------------------
const listExchangeRates = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    // Latest rate per (from,to) preferring MANUAL, then the most recent date.
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (from_currency, to_currency)
              from_currency, to_currency, rate, rate_date, source
         FROM exchange_rates
        WHERE from_currency <> to_currency
        ORDER BY from_currency, to_currency,
                 rate_date DESC, (source = 'MANUAL') DESC
        LIMIT $1`,
      [limit],
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const upsertManualRate = async (req, res) => {
  try {
    const from = normCode(req.body.from_currency);
    const to = normCode(req.body.to_currency);
    const rate = Number(req.body.rate);
    const date = req.body.rate_date || null;
    if (!from || !to) return res.status(400).json({ success: false, message: "from and to currency required" });
    if (from === to) return res.status(400).json({ success: false, message: "from and to must differ" });
    if (!Number.isFinite(rate) || rate <= 0) {
      return res.status(400).json({ success: false, message: "rate must be a positive number" });
    }
    await setManualRate(from, to, rate, date);
    await auditLog({
      userId: req.user?.id, userEmail: req.user?.email, action: "CREATE",
      entityType: "exchange_rates", entityId: 0,
      newValues: { from, to, rate, date, source: "MANUAL" }, ipAddress: req.ip,
    });
    return res.status(201).json({ success: true, message: `Manual rate ${from}->${to} saved` });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ---------------------------------------------------------------------------
// Invoice reminder / notification settings (singleton row id=1)
// ---------------------------------------------------------------------------
const getReminderSettings = async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM invoice_reminder_settings WHERE id = 1`);
    if (!rows.length) {
      // Materialise the default row if it was never seeded.
      const ins = await pool.query(
        `INSERT INTO invoice_reminder_settings (id) VALUES (1)
         ON CONFLICT (id) DO NOTHING RETURNING *`,
      );
      const { rows: again } = await pool.query(`SELECT * FROM invoice_reminder_settings WHERE id = 1`);
      return res.json({ success: true, data: ins.rows[0] || again[0] });
    }
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const updateReminderSettings = async (req, res) => {
  try {
    const enabled = Boolean(req.body.enabled);
    const send_on_due = Boolean(req.body.send_on_due);
    const days_before_due = Math.max(0, Number(req.body.days_before_due) || 0);
    const overdue_days = Array.isArray(req.body.overdue_days)
      ? [...new Set(req.body.overdue_days.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b)
      : [];
    const ch = req.body.channels_json || {};
    const channels_json = { email: Boolean(ch.email), in_app: ch.in_app === undefined ? true : Boolean(ch.in_app) };

    const { rows } = await pool.query(
      `INSERT INTO invoice_reminder_settings
         (id, enabled, days_before_due, send_on_due, overdue_days, channels_json, updated_by, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (id) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         days_before_due = EXCLUDED.days_before_due,
         send_on_due = EXCLUDED.send_on_due,
         overdue_days = EXCLUDED.overdue_days,
         channels_json = EXCLUDED.channels_json,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING *`,
      [enabled, days_before_due, send_on_due, overdue_days, JSON.stringify(channels_json), req.user?.id || null],
    );
    return res.json({ success: true, message: "Reminder settings updated", data: rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ---------------------------------------------------------------------------
// Document numbering config
// ---------------------------------------------------------------------------
const listNumbering = async (_req, res) => {
  try {
    await ensureSettingsSchema();
    const { rows } = await pool.query(
      `SELECT doc_type, label, prefix, padding, include_year, updated_at
         FROM document_numbering_config ORDER BY label`,
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const updateNumbering = async (req, res) => {
  try {
    await ensureSettingsSchema();
    const { doc_type } = req.params;
    const prefix = String(req.body.prefix || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const padding = Number(req.body.padding);
    const include_year = Boolean(req.body.include_year);
    if (!prefix) return res.status(400).json({ success: false, message: "Prefix required (letters/numbers)" });
    if (!Number.isInteger(padding) || padding < 1 || padding > 12) {
      return res.status(400).json({ success: false, message: "Padding must be between 1 and 12" });
    }
    const { rows } = await pool.query(
      `UPDATE document_numbering_config
          SET prefix = $1, padding = $2, include_year = $3, updated_at = now()
        WHERE doc_type = $4
        RETURNING doc_type, label, prefix, padding, include_year, updated_at`,
      [prefix, padding, include_year, doc_type],
    );
    if (!rows.length) return res.status(404).json({ success: false, message: "Unknown document type" });
    await auditLog({
      userId: req.user?.id, userEmail: req.user?.email, action: "UPDATE",
      entityType: "document_numbering_config", entityId: 0,
      newValues: rows[0], ipAddress: req.ip,
    });
    return res.json({ success: true, message: "Numbering updated", data: rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ---------------------------------------------------------------------------
// Tax rates
// ---------------------------------------------------------------------------
const listTaxRates = async (_req, res) => {
  try {
    await ensureSettingsSchema();
    const { rows } = await pool.query(
      `SELECT t.id, t.name, t.rate_percent, t.region_id, t.is_default, t.status, r.region_name
         FROM tax_rates t LEFT JOIN regions r ON r.id = t.region_id
        ORDER BY t.is_default DESC, t.name`,
    );
    return res.json({ success: true, data: rows });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const createTaxRate = async (req, res) => {
  try {
    await ensureSettingsSchema();
    const name = String(req.body.name || "").trim();
    const rate_percent = Number(req.body.rate_percent);
    const region_id = req.body.region_id ? Number(req.body.region_id) : null;
    const is_default = Boolean(req.body.is_default);
    if (!name) return res.status(400).json({ success: false, message: "Name required" });
    if (!Number.isFinite(rate_percent) || rate_percent < 0 || rate_percent > 100) {
      return res.status(400).json({ success: false, message: "Rate must be 0-100%" });
    }
    if (is_default) await pool.query(`UPDATE tax_rates SET is_default = false WHERE is_default = true`);
    const { rows } = await pool.query(
      `INSERT INTO tax_rates (name, rate_percent, region_id, is_default)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, rate_percent, region_id, is_default],
    );
    return res.status(201).json({ success: true, message: "Tax rate created", data: rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const updateTaxRate = async (req, res) => {
  try {
    await ensureSettingsSchema();
    const { id } = req.params;
    const name = String(req.body.name || "").trim();
    const rate_percent = Number(req.body.rate_percent);
    const region_id = req.body.region_id ? Number(req.body.region_id) : null;
    const is_default = Boolean(req.body.is_default);
    const status = req.body.status === "INACTIVE" ? "INACTIVE" : "ACTIVE";
    if (!name) return res.status(400).json({ success: false, message: "Name required" });
    if (!Number.isFinite(rate_percent) || rate_percent < 0 || rate_percent > 100) {
      return res.status(400).json({ success: false, message: "Rate must be 0-100%" });
    }
    if (is_default) await pool.query(`UPDATE tax_rates SET is_default = false WHERE is_default = true AND id <> $1`, [id]);
    const { rows } = await pool.query(
      `UPDATE tax_rates SET name=$1, rate_percent=$2, region_id=$3, is_default=$4, status=$5
        WHERE id=$6 RETURNING *`,
      [name, rate_percent, region_id, is_default, status, id],
    );
    if (!rows.length) return res.status(404).json({ success: false, message: "Tax rate not found" });
    return res.json({ success: true, message: "Tax rate updated", data: rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const deleteTaxRate = async (req, res) => {
  try {
    await ensureSettingsSchema();
    const { rows } = await pool.query(`DELETE FROM tax_rates WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ success: false, message: "Tax rate not found" });
    return res.json({ success: true, message: "Tax rate deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ---------------------------------------------------------------------------
// Permissions catalog + the caller's own effective permissions
// ---------------------------------------------------------------------------
const getPermissionCatalog = async (_req, res) => {
  return res.json({ success: true, data: PERMISSION_KEYS });
};

// Effective permission keys for the currently authenticated user's role. Returns
// null when the role has no rows defined, signalling the frontend to fall back
// to its hardcoded ACL for that role.
const getMyPermissions = async (req, res) => {
  try {
    await ensureSettingsSchema();
    const roleName = String(req.user?.role || "");
    const { rows } = await pool.query(
      `SELECT rp.permission_key
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
        WHERE r.role_name = $1`,
      [roleName],
    );
    return res.json({ success: true, data: rows.length ? rows.map((r) => r.permission_key) : null });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ---------------------------------------------------------------------------
// Fiscal year overview (read-only): current fiscal year + its periods, with a
// derived GL-close / ledger-integrity summary. SELECTs only from the existing
// fiscal_years + accounting_periods tables (no migration, no new table).
// ---------------------------------------------------------------------------
const getFiscalOverview = async (_req, res) => {
  try {
    // Current fiscal year: prefer an OPEN one, else the most recent by start.
    const fy = await pool.query(
      `SELECT id, year_label, start_date, end_date, status
         FROM fiscal_years
        ORDER BY (status = 'OPEN') DESC, start_date DESC
        LIMIT 1`,
    );
    const fiscalYear = fy.rows[0] || null;

    let periods = [];
    if (fiscalYear) {
      const p = await pool.query(
        `SELECT period_no, period_label, start_date, end_date, status
           FROM accounting_periods
          WHERE fiscal_year_id = $1
          ORDER BY period_no`,
        [fiscalYear.id],
      );
      periods = p.rows;
    }

    const openPeriods = periods.filter((x) => String(x.status).toUpperCase() === "OPEN");
    const closedCount = periods.length - openPeriods.length;

    return res.json({
      success: true,
      data: {
        fiscal_year: fiscalYear,
        periods,
        open_periods: openPeriods.map((x) => x.period_label),
        total_periods: periods.length,
        open_count: openPeriods.length,
        closed_count: closedCount,
        // Derived, read-only status summaries (no scheduler/hash tables touched).
        gl_close_status: periods.length
          ? (closedCount === 0 ? "All periods open" : `${closedCount} of ${periods.length} periods closed`)
          : "No periods defined",
        ledger_integrity: fiscalYear
          ? (fiscalYear.status === "OPEN" ? "Active — periods tracked" : "Year closed")
          : "Not configured",
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  getCompanySettings,
  getFiscalOverview,
  updateCompanySettings,
  listExchangeRates,
  upsertManualRate,
  getReminderSettings,
  updateReminderSettings,
  listNumbering,
  updateNumbering,
  listTaxRates,
  createTaxRate,
  updateTaxRate,
  deleteTaxRate,
  getPermissionCatalog,
  getMyPermissions,
};

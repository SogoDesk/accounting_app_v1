
const pool = require("../config/db");
const { getTenantClient, getTenantId } = require("../config/tenantContext");
const { PERMISSION_KEYS } = require("../modules/settings/permissions");
const { setManualRate } = require("../services/currency/rateService");
const { auditLog } = require("../middleware/auditMiddleware");
const { getBranding } = require("../services/branding/brandingService");

const getTenantDb = () => {
  const db = getTenantClient();
  if (!db) throw new Error("Tenant database connection not found.");
  return db;
};

const getCurrentTenantId = (req) => {
  const tenantId = Number(req.user?.tenant_id || getTenantId());

  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error("Valid tenant ID not found.");
  }

  return tenantId;
};

const normCode = (c) => String(c || "").trim().toUpperCase();

// ---------------------------------------------------------------------------
// Company settings
// ---------------------------------------------------------------------------
// Company-wide branding fields (step 0.6). Each is optional; a request that
// leaves one out keeps the stored value, and "" clears it.
const BRANDING_FIELDS = {
  display_name: (v) => (v.length <= 200 ? null : "Display name is too long"),
  logo_url: (v) =>
    v.length <= 1000 && (/^https?:\/\//i.test(v) || v.startsWith("/uploads/"))
      ? null
      : "Logo must be an http(s) URL or an /uploads/ path",
  primary_color: (v) => (/^#[0-9A-Fa-f]{6}$/.test(v) ? null : "Primary colour must look like #111827"),
  accent_color: (v) => (/^#[0-9A-Fa-f]{6}$/.test(v) ? null : "Accent colour must look like #1D4ED8"),
  email_sender_name: (v) => (v.length <= 200 ? null : "Email sender name is too long"),
};

// The branding fields present in the body: { column: value | null }, or an error.
const readBrandingFields = (body) => {
  const values = {};
  for (const [column, check] of Object.entries(BRANDING_FIELDS)) {
    if (body[column] === undefined) continue;
    const v = String(body[column] ?? "").trim();
    if (!v) {
      values[column] = null;
      continue;
    }
    const error = check(v);
    if (error) return { error };
    values[column] = column.endsWith("_color") ? v.toUpperCase() : v;
  }
  return { values };
};

const COMPANY_COLUMNS = "id, group_currency, display_name, logo_url, primary_color, accent_color, email_sender_name, updated_at";

// GET /api/settings/branding — the name, logo and colours the app shows for
// this company. Any signed-in user may read it (the layout needs it).
const getCompanyBranding = async (req, res) => {
  try {
    const branding = await getBranding(getTenantDb());
    return res.json({
      success: true,
      data: {
        name: branding.name,
        logo_url: branding.logoUrl,
        primary_color: branding.primaryColor,
        accent_color: branding.accentColor,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const getCompanySettings = async (req, res) => {
  try {
    const db = getTenantDb();
    const tenantId = getCurrentTenantId(req);

    const { rows } = await db.query(
      `SELECT ${COMPANY_COLUMNS}
         FROM company_settings
        WHERE tenant_id = $1`,
      [tenantId],
    );

    return res.json({
      success: true,
      data: rows[0] || {
        id: 1,
        group_currency: "USD",
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

const updateCompanySettings = async (req, res) => {
  try {
    const db = getTenantDb();
    const tenantId = getCurrentTenantId(req);

    const group_currency = normCode(req.body.group_currency);

    if (!group_currency || group_currency.length > 10) {
      return res.status(400).json({
        success: false,
        message: "Valid group currency required",
      });
    }

    const branding = readBrandingFields(req.body);
    if (branding.error) {
      return res.status(400).json({ success: false, message: branding.error });
    }
    const brandingColumns = Object.keys(branding.values);

    // Branding columns are written only when the request sent them.
    const insertColumns = ["tenant_id", "id", "group_currency", ...brandingColumns, "updated_at"];
    const insertValues = ["$1", "1", "$2", ...brandingColumns.map((_, i) => `$${i + 3}`), "now()"];
    const updates = ["group_currency", ...brandingColumns]
      .map((c) => `${c} = EXCLUDED.${c}`)
      .concat("updated_at = now()");

    const { rows } = await db.query(
      `INSERT INTO company_settings (${insertColumns.join(", ")})
       VALUES (${insertValues.join(", ")})
       ON CONFLICT (tenant_id)
       DO UPDATE SET ${updates.join(", ")}
       RETURNING ${COMPANY_COLUMNS}`,
      [tenantId, group_currency, ...Object.values(branding.values)],
    );

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "UPDATE",
      entityType: "company_settings",
      entityId: 1,
      newValues: { group_currency, ...branding.values },
      ipAddress: req.ip,
    });

    return res.json({
      success: true,
      message: "Company settings updated",
      data: rows[0],
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// ---------------------------------------------------------------------------
// Exchange rates are shared reference data.
// ---------------------------------------------------------------------------
const listExchangeRates = async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);

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

    return res.json({
      success: true,
      data: rows,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

const upsertManualRate = async (req, res) => {
  try {
    const from = normCode(req.body.from_currency);
    const to = normCode(req.body.to_currency);
    const rate = Number(req.body.rate);
    const date = req.body.rate_date || null;

    if (!from || !to) {
      return res.status(400).json({
        success: false,
        message: "from and to currency required",
      });
    }

    if (from === to) {
      return res.status(400).json({
        success: false,
        message: "from and to must differ",
      });
    }

    if (!Number.isFinite(rate) || rate <= 0) {
      return res.status(400).json({
        success: false,
        message: "rate must be a positive number",
      });
    }

    await setManualRate(from, to, rate, date);

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "CREATE",
      entityType: "exchange_rates",
      entityId: 0,
      newValues: { from, to, rate, date, source: "MANUAL" },
      ipAddress: req.ip,
    });

    return res.status(201).json({
      success: true,
      message: `Manual rate ${from}->${to} saved`,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// ---------------------------------------------------------------------------
// Invoice reminder settings - tenant-specific
// ---------------------------------------------------------------------------
const getReminderSettings = async (req, res) => {
  try {
    const db = getTenantDb();
    const tenantId = getCurrentTenantId(req);


    const { rows } = await db.query(
      `SELECT *
         FROM invoice_reminder_settings
        WHERE tenant_id = $1`,
      [tenantId],
    );

    return res.json({
      success: true,
      data: rows[0] || null,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};


const updateReminderSettings = async (req, res) => {
  try {
    const db = getTenantDb();
    const tenantId = getCurrentTenantId(req);


    const enabled = Boolean(req.body.enabled);
    const send_on_due = Boolean(req.body.send_on_due);

    // Support multiple days before the due date.
    const before_due_days = [
      ...new Set(
        (Array.isArray(req.body.before_due_days)
          ? req.body.before_due_days
          : req.body.days_before_due !== undefined
            ? [req.body.days_before_due]
            : [10, 5]
        )
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0 && n <= 365),
      ),
    ].sort((a, b) => b - a);

    // Keep the old single-day column compatible.
    const days_before_due = before_due_days[0] || 0;

    const overdue_days = Array.isArray(req.body.overdue_days)
      ? [
          ...new Set(
            req.body.overdue_days
              .map(Number)
              .filter((n) => Number.isInteger(n) && n > 0 && n <= 365),
          ),
        ].sort((a, b) => a - b)
      : [];

    const ch = req.body.channels_json || {};

    const channels_json = {
      email: Boolean(ch.email),
      in_app: ch.in_app === undefined ? true : Boolean(ch.in_app),
    };

    const { rows } = await db.query(
      `INSERT INTO invoice_reminder_settings
         (tenant_id, enabled, before_due_days, days_before_due,
          send_on_due, overdue_days, channels_json, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (tenant_id)
       DO UPDATE SET
         enabled = EXCLUDED.enabled,
         before_due_days = EXCLUDED.before_due_days,
         days_before_due = EXCLUDED.days_before_due,
         send_on_due = EXCLUDED.send_on_due,
         overdue_days = EXCLUDED.overdue_days,
         channels_json = EXCLUDED.channels_json,
         updated_by = EXCLUDED.updated_by,
         updated_at = now()
       RETURNING *`,
      [
        tenantId,
        enabled,
        before_due_days,
        days_before_due,
        send_on_due,
        overdue_days,
        JSON.stringify(channels_json),
        req.user?.id || null,
      ],
    );

    return res.json({
      success: true,
      message: "Reminder settings updated",
      data: rows[0],
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};


// ---------------------------------------------------------------------------
// Document numbering config - tenant-specific
// ---------------------------------------------------------------------------
const listNumbering = async (_req, res) => {
  try {
    const db = getTenantDb();


    const { rows } = await db.query(
      `SELECT doc_type, label, prefix, padding, include_year, updated_at
         FROM document_numbering_config
        ORDER BY label`,
    );

    return res.json({
      success: true,
      data: rows,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

const updateNumbering = async (req, res) => {
  try {
    const db = getTenantDb();
    const tenantId = getCurrentTenantId(req);


    const { doc_type } = req.params;

    const prefix = String(req.body.prefix || "")
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");

    const padding = Number(req.body.padding);
    const include_year = Boolean(req.body.include_year);

    if (!prefix) {
      return res.status(400).json({
        success: false,
        message: "Prefix required (letters/numbers)",
      });
    }

    if (!Number.isInteger(padding) || padding < 1 || padding > 12) {
      return res.status(400).json({
        success: false,
        message: "Padding must be between 1 and 12",
      });
    }

    const { rows } = await db.query(
      `UPDATE document_numbering_config
          SET prefix = $1,
              padding = $2,
              include_year = $3,
              updated_at = now()
        WHERE doc_type = $4
          AND tenant_id = $5
        RETURNING doc_type, label, prefix, padding, include_year, updated_at`,
      [prefix, padding, include_year, doc_type, tenantId],
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Unknown document type",
      });
    }

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "UPDATE",
      entityType: "document_numbering_config",
      entityId: 0,
      newValues: rows[0],
      ipAddress: req.ip,
    });

    return res.json({
      success: true,
      message: "Numbering updated",
      data: rows[0],
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// ---------------------------------------------------------------------------
// Tax rates - tenant-specific
// ---------------------------------------------------------------------------
const listTaxRates = async (_req, res) => {
  try {
    const db = getTenantDb();


    const { rows } = await db.query(
      `SELECT t.id, t.name, t.rate_percent, t.region_id,
              t.is_default, t.status, r.region_name
         FROM tax_rates t
         LEFT JOIN regions r ON r.id = t.region_id
        ORDER BY t.is_default DESC, t.name`,
    );

    return res.json({
      success: true,
      data: rows,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

const createTaxRate = async (req, res) => {
  try {
    const db = getTenantDb();
    const tenantId = getCurrentTenantId(req);


    const name = String(req.body.name || "").trim();
    const rate_percent = Number(req.body.rate_percent);
    const region_id = req.body.region_id ? Number(req.body.region_id) : null;
    const is_default = Boolean(req.body.is_default);

    if (!name) {
      return res.status(400).json({
        success: false,
        message: "Name required",
      });
    }

    if (!Number.isFinite(rate_percent) || rate_percent < 0 || rate_percent > 100) {
      return res.status(400).json({
        success: false,
        message: "Rate must be 0-100%",
      });
    }

    if (is_default) {
      await db.query(
        `UPDATE tax_rates
            SET is_default = false
          WHERE is_default = true`,
      );
    }

    const { rows } = await db.query(
      `INSERT INTO tax_rates
         (tenant_id, name, rate_percent, region_id, is_default)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [tenantId, name, rate_percent, region_id, is_default],
    );

    return res.status(201).json({
      success: true,
      message: "Tax rate created",
      data: rows[0],
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

const updateTaxRate = async (req, res) => {
  try {
    const db = getTenantDb();


    const { id } = req.params;
    const name = String(req.body.name || "").trim();
    const rate_percent = Number(req.body.rate_percent);
    const region_id = req.body.region_id ? Number(req.body.region_id) : null;
    const is_default = Boolean(req.body.is_default);
    const status = req.body.status === "INACTIVE" ? "INACTIVE" : "ACTIVE";

    if (!name) {
      return res.status(400).json({
        success: false,
        message: "Name required",
      });
    }

    if (!Number.isFinite(rate_percent) || rate_percent < 0 || rate_percent > 100) {
      return res.status(400).json({
        success: false,
        message: "Rate must be 0-100%",
      });
    }

    if (is_default) {
      await db.query(
        `UPDATE tax_rates
            SET is_default = false
          WHERE is_default = true
            AND id <> $1`,
        [id],
      );
    }

    const { rows } = await db.query(
      `UPDATE tax_rates
          SET name = $1,
              rate_percent = $2,
              region_id = $3,
              is_default = $4,
              status = $5
        WHERE id = $6
        RETURNING *`,
      [name, rate_percent, region_id, is_default, status, id],
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Tax rate not found",
      });
    }

    return res.json({
      success: true,
      message: "Tax rate updated",
      data: rows[0],
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

const deleteTaxRate = async (req, res) => {
  try {
    const db = getTenantDb();


    const { rows } = await db.query(
      `DELETE FROM tax_rates
        WHERE id = $1
        RETURNING id`,
      [req.params.id],
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Tax rate not found",
      });
    }

    return res.json({
      success: true,
      message: "Tax rate deleted",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// ---------------------------------------------------------------------------
// Permissions catalog and caller's effective permissions
// ---------------------------------------------------------------------------
const getPermissionCatalog = async (_req, res) => {
  return res.json({
    success: true,
    data: PERMISSION_KEYS,
  });
};

const getMyPermissions = async (req, res) => {
  try {
    const db = getTenantDb();


    const roleName = String(req.user?.role || "");

    const { rows } = await db.query(
      `SELECT rp.permission_key
         FROM role_permissions rp
         JOIN roles r ON r.id = rp.role_id
        WHERE r.role_name = $1`,
      [roleName],
    );

    return res.json({
      success: true,
      data: rows.length ? rows.map((r) => r.permission_key) : null,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// ---------------------------------------------------------------------------
// Fiscal year overview
// ---------------------------------------------------------------------------
const getFiscalOverview = async (_req, res) => {
  try {
    const db = getTenantDb();

    const fy = await db.query(
      `SELECT id, year_label, start_date, end_date, status
         FROM fiscal_years
        ORDER BY (status = 'OPEN') DESC, start_date DESC
        LIMIT 1`,
    );

    const fiscalYear = fy.rows[0] || null;

    let periods = [];

    if (fiscalYear) {
      const p = await db.query(
        `SELECT period_no, period_label, start_date, end_date, status
           FROM accounting_periods
          WHERE fiscal_year_id = $1
          ORDER BY period_no`,
        [fiscalYear.id],
      );

      periods = p.rows;
    }

    const openPeriods = periods.filter(
      (x) => String(x.status).toUpperCase() === "OPEN",
    );

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
        gl_close_status: periods.length
          ? closedCount === 0
            ? "All periods open"
            : `${closedCount} of ${periods.length} periods closed`
          : "No periods defined",
        ledger_integrity: fiscalYear
          ? fiscalYear.status === "OPEN"
            ? "Active — periods tracked"
            : "Year closed"
          : "Not configured",
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

module.exports = {
  getCompanyBranding,
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

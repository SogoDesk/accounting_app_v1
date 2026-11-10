const pool = require("../config/db");
const { auditLog } = require("../middleware/auditMiddleware");
const { generateRegionCode } = require("../utils/codeGenerator");
const { canActOnEntity } = require("../middleware/scopeMiddleware");

const INVOICE_TEMPLATE_OPTIONS = new Set(["CLASSIC", "EXECUTIVE", "MINIMAL"]);
const DATE_FORMAT_OPTIONS = new Set(["MM/DD/YYYY", "DD/MM/YYYY", "YYYY-MM-DD"]);
const CURRENCY_FORMAT_OPTIONS = new Set(["SYMBOL", "CODE"]);

const toNullable = (value) => {
  if (value === undefined || value === null || value === "") return null;
  return value;
};

const toBoolean = (value) => {
  return value === true || value === "true" || value === 1 || value === "1";
};

const normalizeInvoiceTemplate = (value) => {
  const normalized = String(value || "CLASSIC").trim().toUpperCase();
  return INVOICE_TEMPLATE_OPTIONS.has(normalized) ? normalized : "CLASSIC";
};

const normalizeHexColor = (value, fallback) => {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  const withHash = raw.startsWith("#") ? raw : `#${raw}`;
  return /^#[0-9a-fA-F]{6}$/.test(withHash) ? withHash.toUpperCase() : fallback;
};

const normalizeDateFormat = (value) => {
  const format = String(value || "MM/DD/YYYY").trim().toUpperCase();
  return DATE_FORMAT_OPTIONS.has(format) ? format : "MM/DD/YYYY";
};

const normalizeCurrencyFormat = (value) => {
  const format = String(value || "SYMBOL").trim().toUpperCase();
  return CURRENCY_FORMAT_OPTIONS.has(format) ? format : "SYMBOL";
};

const normalizeMonthNumber = (value, fallback) => {
  const num = Number(value);
  if (Number.isInteger(num) && num >= 1 && num <= 12) return num;
  return fallback;
};

// Memoized per process: these columns are provided by migration 000_base, so
// the safety-net ALTERs run at most once per boot instead of on every request.
let _brandingEnsured = false;
const ensureRegionBrandingColumns = async (db) => {
  if (_brandingEnsured) return;
  try {
    await db.query(`
      ALTER TABLE regions
      ADD COLUMN IF NOT EXISTS invoice_template varchar(30) DEFAULT 'CLASSIC'
    `);
    await db.query(`
      ALTER TABLE regions
      ADD COLUMN IF NOT EXISTS invoice_brand_primary_color varchar(7) DEFAULT '#111827'
    `);
    await db.query(`
      ALTER TABLE regions
      ADD COLUMN IF NOT EXISTS invoice_brand_accent_color varchar(7) DEFAULT '#1D4ED8'
    `);
    await db.query(`
      ALTER TABLE regions
      ADD COLUMN IF NOT EXISTS invoice_brand_footer_note text
    `);
    _brandingEnsured = true;
  } catch (err) {
    console.error("ensureRegionBrandingColumns warning:", err.message);
  }
};

let _preferencesEnsured = false;
const ensureRegionPreferenceColumns = async (db) => {
  if (_preferencesEnsured) return;
  try {
    await db.query(`
      ALTER TABLE regions
      ADD COLUMN IF NOT EXISTS date_format varchar(20) DEFAULT 'MM/DD/YYYY'
    `);
    await db.query(`
      ALTER TABLE regions
      ADD COLUMN IF NOT EXISTS currency_format varchar(20) DEFAULT 'SYMBOL'
    `);
    await db.query(`
      ALTER TABLE regions
      ADD COLUMN IF NOT EXISTS customer_label varchar(80) DEFAULT 'Client'
    `);
    await db.query(`
      ALTER TABLE regions
      ADD COLUMN IF NOT EXISTS warn_duplicate_invoice_number boolean DEFAULT true
    `);
    await db.query(`
      ALTER TABLE regions
      ADD COLUMN IF NOT EXISTS first_month_fiscal_year smallint DEFAULT 1
    `);
    await db.query(`
      ALTER TABLE regions
      ADD COLUMN IF NOT EXISTS first_month_tax_year smallint DEFAULT 4
    `);
    // Mirrors migration 015: whichever runs first adds the column and backfills
    // India; the other no-ops. Kept together so the two paths can't disagree.
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'regions'
            AND column_name = 'tds_applicable'
        ) THEN
          ALTER TABLE regions
            ADD COLUMN tds_applicable boolean NOT NULL DEFAULT false;

          UPDATE regions
             SET tds_applicable = true
           WHERE upper(coalesce(country_code, '')) = 'IN'
              OR upper(coalesce(default_currency, '')) = 'INR';
        END IF;
      END $$;
    `);
    _preferencesEnsured = true;
  } catch (err) {
    console.error("ensureRegionPreferenceColumns warning:", err.message);
  }
};

const getAllRegions = async (req, res) => {
  try {
    await ensureRegionBrandingColumns(pool);
    await ensureRegionPreferenceColumns(pool);
    // Row-level RBAC: a region IS the legal entity, so restrict the list to the
    // caller's allowed entities (regions.id ∈ allowedEntityIds).
    let result;
    if (req.scopeEnforced && Array.isArray(req.allowedEntityIds)) {
      result = await pool.query("SELECT * FROM regions WHERE id = ANY($1) ORDER BY id DESC", [req.allowedEntityIds]);
    } else {
      result = await pool.query("SELECT * FROM regions ORDER BY id DESC");
    }
    return res.json({ success: true, data: result.rows });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

const createRegion = async (req, res) => {
  try {
    const {
      region_name,
      region_code,
      country_name,
      country_code,
      default_currency,
      status,
      company_name,
      company_address,
      company_id_label,
      company_id_value,
      invoice_terms_label,
      bank_name,
      bank_account_name,
      bank_account_number,
      bank_routing_number,
      bank_swift_ifsc,
      bank_branch_details,
      date_format,
      currency_format,
      customer_label,
      warn_duplicate_invoice_number,
      first_month_fiscal_year,
      first_month_tax_year,
      tds_applicable,
      invoice_template,
      invoice_brand_primary_color,
      invoice_brand_accent_color,
      invoice_brand_footer_note,
    } = req.body;

    if (!region_name || !default_currency) {
      return res.status(400).json({
        success: false,
        message: "Region name and currency are required",
      });
    }

    await ensureRegionBrandingColumns(pool);
    await ensureRegionPreferenceColumns(pool);

    const finalRegionCode = String(
      region_code || (await generateRegionCode(pool, region_name)),
    ).toUpperCase();

    const logo_url = req.file ? `/uploads/logos/${req.file.filename}` : null;

    const result = await pool.query(
      `INSERT INTO regions (
        region_name,
        region_code,
        default_currency,
        status,
        company_name,
        company_address,
        company_id_label,
        company_id_value,
        logo_url,
        invoice_terms_label,
        bank_name,
        bank_account_name,
        bank_account_number,
        bank_routing_number,
        bank_swift_ifsc,
        bank_branch_details,
        invoice_template,
        invoice_brand_primary_color,
        invoice_brand_accent_color,
        invoice_brand_footer_note,
        country_name,
        country_code,
        date_format,
        currency_format,
        customer_label,
        warn_duplicate_invoice_number,
        first_month_fiscal_year,
        first_month_tax_year,
        tds_applicable
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
        $23,$24,$25,$26,$27,$28,$29
      )
      RETURNING *`,
      [
        region_name,
        finalRegionCode,
        String(default_currency).toUpperCase(),
        status || "ACTIVE",
        toNullable(company_name),
        toNullable(company_address),
        toNullable(company_id_label),
        toNullable(company_id_value),
        toNullable(logo_url),
        toNullable(invoice_terms_label),
        toNullable(bank_name),
        toNullable(bank_account_name),
        toNullable(bank_account_number),
        toNullable(bank_routing_number),
        toNullable(bank_swift_ifsc),
        toNullable(bank_branch_details),
        normalizeInvoiceTemplate(invoice_template),
        normalizeHexColor(invoice_brand_primary_color, "#111827"),
        normalizeHexColor(invoice_brand_accent_color, "#1D4ED8"),
        toNullable(invoice_brand_footer_note),
        toNullable(country_name),
        toNullable(country_code),
        normalizeDateFormat(date_format),
        normalizeCurrencyFormat(currency_format),
        toNullable(customer_label) || "Client",
        toBoolean(warn_duplicate_invoice_number),
        normalizeMonthNumber(first_month_fiscal_year, 1),
        normalizeMonthNumber(first_month_tax_year, 4),
        toBoolean(tds_applicable),
      ],
    );

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "CREATE",
      entityType: "regions",
      entityId: result.rows[0].id,
      newValues: result.rows[0],
      ipAddress: req.ip,
    });

    return res.status(201).json({
      success: true,
      message: "Region created",
      data: result.rows[0],
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({
        success: false,
        message: "Region name or code already exists",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

const updateRegion = async (req, res) => {
  try {
    const { id } = req.params;

    const {
      region_name,
      region_code,
      country_name,
      country_code,
      default_currency,
      status,
      company_name,
      company_address,
      company_id_label,
      company_id_value,
      invoice_terms_label,
      bank_name,
      bank_account_name,
      bank_account_number,
      bank_routing_number,
      bank_swift_ifsc,
      bank_branch_details,
      logo_url: bodyLogoUrl,
      remove_logo,
      date_format,
      currency_format,
      customer_label,
      warn_duplicate_invoice_number,
      first_month_fiscal_year,
      first_month_tax_year,
      tds_applicable,
      invoice_template,
      invoice_brand_primary_color,
      invoice_brand_accent_color,
      invoice_brand_footer_note,
    } = req.body;

    await ensureRegionBrandingColumns(pool);
    await ensureRegionPreferenceColumns(pool);

    const existing = await pool.query("SELECT * FROM regions WHERE id=$1", [
      id,
    ]);
    if (!existing.rows.length || !canActOnEntity(req, id)) {
      return res
        .status(404)
        .json({ success: false, message: "Region not found" });
    }

    const current = existing.rows[0];

    const finalRegionCode = String(
      region_code ||
        current.region_code ||
        (await generateRegionCode(pool, region_name || current.region_name)),
    ).toUpperCase();

    let finalLogoUrl = current.logo_url;

    if (toBoolean(remove_logo)) {
      finalLogoUrl = null;
    } else if (req.file) {
      finalLogoUrl = `/uploads/logos/${req.file.filename}`;
    } else if (bodyLogoUrl !== undefined) {
      finalLogoUrl = bodyLogoUrl || null;
    }

    const result = await pool.query(
      `UPDATE regions
       SET region_name=$1,
           region_code=$2,
           default_currency=$3,
           status=$4,
           company_name=$5,
           company_address=$6,
           company_id_label=$7,
           company_id_value=$8,
           logo_url=$9,
           invoice_terms_label=$10,
           bank_name=$11,
           bank_account_name=$12,
           bank_account_number=$13,
           bank_routing_number=$14,
           bank_swift_ifsc=$15,
           bank_branch_details=$16,
           invoice_template=$17,
           invoice_brand_primary_color=$18,
           invoice_brand_accent_color=$19,
           invoice_brand_footer_note=$20,
           country_name=$21,
           country_code=$22,
           date_format=$23,
           currency_format=$24,
           customer_label=$25,
           warn_duplicate_invoice_number=$26,
           first_month_fiscal_year=$27,
           first_month_tax_year=$28,
           tds_applicable=$29,
           updated_at=NOW()
       WHERE id=$30
       RETURNING *`,
      [
        // Coalesce required (NOT NULL) fields with the existing row so a partial
        // PUT that omits them does not overwrite with NULL/"UNDEFINED".
        region_name ?? current.region_name,
        finalRegionCode,
        String(default_currency ?? current.default_currency).toUpperCase(),
        status ?? current.status,
        toNullable(company_name),
        toNullable(company_address),
        toNullable(company_id_label),
        toNullable(company_id_value),
        finalLogoUrl,
        toNullable(invoice_terms_label),
        toNullable(bank_name),
        toNullable(bank_account_name),
        toNullable(bank_account_number),
        toNullable(bank_routing_number),
        toNullable(bank_swift_ifsc),
        toNullable(bank_branch_details),
        normalizeInvoiceTemplate(invoice_template),
        normalizeHexColor(invoice_brand_primary_color, "#111827"),
        normalizeHexColor(invoice_brand_accent_color, "#1D4ED8"),
        toNullable(invoice_brand_footer_note),
        toNullable(country_name),
        toNullable(country_code),
        normalizeDateFormat(date_format || current.date_format),
        normalizeCurrencyFormat(currency_format || current.currency_format),
        toNullable(customer_label) || current.customer_label || "Client",
        warn_duplicate_invoice_number === undefined
          ? current.warn_duplicate_invoice_number !== false
          : toBoolean(warn_duplicate_invoice_number),
        normalizeMonthNumber(
          first_month_fiscal_year === undefined
            ? current.first_month_fiscal_year
            : first_month_fiscal_year,
          1,
        ),
        normalizeMonthNumber(
          first_month_tax_year === undefined
            ? current.first_month_tax_year
            : first_month_tax_year,
          4,
        ),
        tds_applicable === undefined
          ? current.tds_applicable === true
          : toBoolean(tds_applicable),
        id,
      ],
    );

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "UPDATE",
      entityType: "regions",
      entityId: Number(id),
      oldValues: current,
      newValues: result.rows[0],
      ipAddress: req.ip,
    });

    return res.json({
      success: true,
      message: "Region updated",
      data: result.rows[0],
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(400).json({
        success: false,
        message: "Region name or code already exists",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message,
    });
  }
};

const deleteRegion = async (req, res) => {
  try {
    const { id } = req.params;

    const regionExists = await pool.query("SELECT * FROM regions WHERE id=$1", [
      id,
    ]);
    if (!regionExists.rows.length || !canActOnEntity(req, id)) {
      return res
        .status(404)
        .json({ success: false, message: "Region not found" });
    }

    const deps = await pool.query(
      `SELECT
        (SELECT COUNT(*) FROM clients WHERE region_id=$1)::int AS clients_count,
        (SELECT COUNT(*) FROM placements WHERE region_id=$1)::int AS placements_count,
        (SELECT COUNT(*) FROM invoices WHERE region_id=$1)::int AS invoices_count`,
      [id],
    );

    const d = deps.rows[0];
    if (d.clients_count || d.placements_count || d.invoices_count) {
      return res.status(400).json({
        success: false,
        message:
          "Cannot delete region with linked clients, placements, or invoices",
      });
    }

    const result = await pool.query(
      "DELETE FROM regions WHERE id=$1 RETURNING *",
      [id],
    );

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "DELETE",
      entityType: "regions",
      entityId: Number(id),
      oldValues: result.rows[0],
      ipAddress: req.ip,
    });

    return res.json({ success: true, message: "Region deleted" });
  } catch (err) {
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: err.message });
  }
};

module.exports = {
  getAllRegions,
  createRegion,
  updateRegion,
  deleteRegion,
};

// Branding — the one place customer-facing names, logos and colours come from
// (workflow step 0.6). Nothing here is specific to any one customer: every
// value is read from the tenant's own data, and the fallbacks are neutral.
//
// Precedence, per value:
//   1. the entity's regions row  (when an entityId is given)
//   2. company_settings          (company-wide branding)
//   3. tenants.tenant_name       (name only)
//   4. neutral defaults          (colours only; no default logo)

// Used only when neither the entity nor the company set colours. These were
// the regions columns' old defaults, so invoices look as they always have.
const DEFAULT_PRIMARY_COLOR = "#111827";
const DEFAULT_ACCENT_COLOR = "#1D4ED8";

const hexColor = (value) => {
  const v = String(value || "").trim();
  return /^#[0-9A-Fa-f]{6}$/.test(v) ? v.toUpperCase() : null;
};
const text = (value) => {
  const v = String(value ?? "").trim();
  return v || null;
};

/**
 * Branding for the current tenant (db must have app.tenant_id set), optionally
 * narrowed to one entity (regions.id).
 * Returns { name, logoUrl, primaryColor, accentColor, senderName, footerNote, address }.
 */
async function getBranding(db, entityId = null) {
  const company = (await db.query(
    `SELECT t.tenant_name, cs.display_name, cs.logo_url, cs.primary_color,
            cs.accent_color, cs.email_sender_name
       FROM tenants t
       LEFT JOIN company_settings cs ON cs.tenant_id = t.id
      WHERE t.id = NULLIF(current_setting('app.tenant_id', true), '')::integer
      LIMIT 1`,
  )).rows[0] || {};

  let region = {};
  if (entityId) {
    region = (await db.query(
      `SELECT company_name, company_address, logo_url, invoice_brand_primary_color,
              invoice_brand_accent_color, invoice_brand_footer_note
         FROM regions WHERE id = $1 LIMIT 1`,
      [entityId],
    )).rows[0] || {};
  }

  const companyName = text(company.display_name) || text(company.tenant_name);
  return {
    name: text(region.company_name) || companyName || "",
    logoUrl: text(region.logo_url) || text(company.logo_url),
    primaryColor:
      hexColor(region.invoice_brand_primary_color) || hexColor(company.primary_color) || DEFAULT_PRIMARY_COLOR,
    accentColor:
      hexColor(region.invoice_brand_accent_color) || hexColor(company.accent_color) || DEFAULT_ACCENT_COLOR,
    senderName: text(company.email_sender_name) || companyName || "",
    footerNote: text(region.invoice_brand_footer_note),
    address: text(region.company_address),
  };
}

module.exports = { getBranding, DEFAULT_PRIMARY_COLOR, DEFAULT_ACCENT_COLOR };

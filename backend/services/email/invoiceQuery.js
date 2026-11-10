const pool = require("../../config/db");

const SELECT = `
  SELECT i.*, c.client_name, c.primary_contact_name, c.primary_contact_email,
         c.default_payment_terms, r.region_name, r.company_name,
         r.company_address, r.logo_url
    FROM invoices i
    LEFT JOIN clients c ON c.id = i.client_id
    LEFT JOIN regions r ON r.id = i.region_id
`;

const OPEN_STATUSES = ["GENERATED", "SENT", "PARTIALLY_PAID", "OVERDUE"];

async function byId(invoiceId, { allowedEntityIds } = {}, db = pool) {
  const params = [invoiceId];
  let scope = "";
  if (Array.isArray(allowedEntityIds)) {
    params.push(allowedEntityIds);
    scope = ` AND i.region_id = ANY($${params.length})`;
  }
  const { rows } = await db.query(`${SELECT} WHERE i.id = $1${scope} LIMIT 1`, params);
  return rows[0] || null;
}

async function openWithDueDates(dueDates, db = pool) {
  if (!dueDates.length) return [];
  const { rows } = await db.query(
    `SELECT i.id, i.invoice_number, i.due_date::text AS due_date, c.primary_contact_email
       FROM invoices i
       JOIN clients c ON c.id = i.client_id
      WHERE i.due_date = ANY($1::date[])
        AND i.invoice_status = ANY($2)
        AND COALESCE(i.balance_outstanding, 0) > 0
        AND COALESCE(NULLIF(TRIM(c.primary_contact_email), ''), NULL) IS NOT NULL`,
    [dueDates, OPEN_STATUSES],
  );
  return rows;
}

async function pickable({ allowedEntityIds, limit = 25 } = {}, db = pool) {
  const params = [];
  const where = ["i.client_id IS NOT NULL"];
  if (Array.isArray(allowedEntityIds)) {
    params.push(allowedEntityIds);
    where.push(`i.region_id = ANY($${params.length})`);
  }
  params.push(limit);
  const { rows } = await db.query(
    `SELECT i.id, i.invoice_number, i.total_amount, i.currency,
            c.client_name, c.primary_contact_email
       FROM invoices i
       JOIN clients c ON c.id = i.client_id
      WHERE ${where.join(" AND ")}
      ORDER BY (c.primary_contact_email IS NOT NULL) DESC, i.id DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows;
}

module.exports = { byId, openWithDueDates, pickable, OPEN_STATUSES, SELECT };

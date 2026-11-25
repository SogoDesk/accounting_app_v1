// A small, fully wired company for tests, built on the seeded tenant (#1, ACME).
//
// Regions alone cannot post: posting needs an ENTITY org unit with an HQ
// branch under it, a functional currency, and a user granted access to them.
// The app does not create these when a region is added, so the fixture does.

const bcrypt = require("bcryptjs");
const { withTenant } = require("./db");

const TENANT_ID = 1;
const TENANT_CODE = "ACME";
const PASSWORD = "Test#Password1";

// USD -> INR rates used by the foreign-currency tests.
const RATES = [
  ["2026-01-01", 83],
  ["2026-03-15", 84],
  ["2026-03-31", 85],
];

async function insertOne(db, sql, params) {
  const { rows } = await db.query(sql, params);
  return rows[0];
}

async function seedCompany({ tenantId = TENANT_ID, suffix = "" } = {}) {
  return withTenant(tenantId, async (db) => {
    const role = await insertOne(
      db,
      "SELECT id FROM roles WHERE role_name = 'SUPER_ADMIN' LIMIT 1",
    );
    const user = await insertOne(
      db,
      `INSERT INTO users (full_name, email, password_hash, role_id, status)
       VALUES ('Test Admin', $1, $2, $3, 'ACTIVE') RETURNING id, email`,
      [`admin${suffix}@books.test`, await bcrypt.hash(PASSWORD, 4), role.id],
    );

    const region = async (code, name, ccy) =>
      insertOne(
        db,
        `INSERT INTO regions (region_name, region_code, default_currency, functional_currency,
                              country_name, tds_applicable)
         VALUES ($1, $2, $3, $3, $1, $4) RETURNING id`,
        [name, code, ccy, ccy === "INR"],
      );
    const india = await region(`IN${suffix}`, `India${suffix}`, "INR");
    const usa = await region(`US${suffix}`, `United States${suffix}`, "USD");

    const group = await insertOne(
      db,
      `INSERT INTO org_units (parent_id, unit_type, code, name, is_legal_entity)
       VALUES (NULL, 'GROUP', $1, 'Group', false) RETURNING id`,
      [`GRP${suffix}`],
    );
    const locations = {};
    for (const [key, r, code, ccy] of [
      ["india", india, `IN${suffix}`, "INR"],
      ["usa", usa, `US${suffix}`, "USD"],
    ]) {
      const entity = await insertOne(
        db,
        `INSERT INTO org_units (parent_id, unit_type, code, name, is_legal_entity, functional_currency, region_id)
         VALUES ($1, 'ENTITY', $2, $2, true, $3, $4) RETURNING id`,
        [group.id, code, ccy, r.id],
      );
      const branch = await insertOne(
        db,
        `INSERT INTO org_units (parent_id, unit_type, code, name, is_legal_entity, region_id)
         VALUES ($1, 'BRANCH', $2, $2, false, $3) RETURNING id`,
        [entity.id, `${code}-HQ`, r.id],
      );
      locations[key] = Number(branch.id);
    }
    await db.query(
      "INSERT INTO user_org_access (user_id, org_unit_id, access) VALUES ($1, $2, 'ADMIN')",
      [user.id, group.id],
    );

    for (const [date, rate] of RATES) {
      await db.query(
        `INSERT INTO exchange_rates (from_currency, to_currency, rate, rate_date, source)
         VALUES ('USD', 'INR', $1, $2, 'MANUAL') ON CONFLICT DO NOTHING`,
        [rate, date],
      );
    }

    const client = async (name, code, ccy) =>
      insertOne(
        db,
        `INSERT INTO clients (client_name, client_code, region_id, currency, primary_contact_email,
                              default_payment_terms)
         VALUES ($1, $2, $3, $4, $5, 'NET_30') RETURNING id`,
        [name, code, india.id, ccy, `${code.toLowerCase()}@client.test`],
      );
    const clientInr = await client(`Local Client${suffix}`, `CLI-INR${suffix}`, "INR");
    const clientUsd = await client(`Export Client${suffix}`, `CLI-USD${suffix}`, "USD");

    const candidate = await insertOne(
      db,
      `INSERT INTO candidates (full_name, email, job_title, region_id)
       VALUES ('Asha Rao', $1, 'Engineer', $2) RETURNING id`,
      [`asha${suffix}@candidate.test`, india.id],
    );
    const placement = async (clientRow, ccy, rate) =>
      insertOne(
        db,
        `INSERT INTO placements (candidate_id, region_id, client_id, job_title, employment_type,
                                 billing_type, bill_rate, currency, invoice_cycle, payment_terms, start_date)
         VALUES ($1, $2, $3, 'Engineer', 'CONTRACT', 'HOURLY', $4, $5, 'MONTHLY', 'NET_30', '2026-01-01')
         RETURNING id`,
        [candidate.id, india.id, clientRow.id, rate, ccy],
      );
    const placementInr = await placement(clientInr, "INR", 1000);
    const placementUsd = await placement(clientUsd, "USD", 50);

    const vendor = await insertOne(
      db,
      `INSERT INTO vendors (vendor_name, vendor_code, region_id, currency)
       VALUES ('Office Supplier', $1, $2, 'INR') RETURNING id`,
      [`VEN${suffix}`, india.id],
    );

    const accountId = async (code) =>
      (await insertOne(db, "SELECT id FROM chart_of_accounts WHERE account_code = $1", [code])).id;
    const category = await insertOne(
      db,
      "INSERT INTO expense_categories (name, gl_account_id) VALUES ('Software', $1) RETURNING id",
      [await accountId("5200")],
    );
    const bank = await insertOne(
      db,
      `INSERT INTO payment_methods (name, method_type, gl_account_id, entity_id)
       VALUES ('Operating bank', 'BANK', $1, $2) RETURNING id`,
      [await accountId("1000"), india.id],
    );

    return {
      tenantId,
      tenantCode: TENANT_CODE,
      userId: Number(user.id),
      email: user.email,
      password: PASSWORD,
      india: Number(india.id),
      usa: Number(usa.id),
      locations,
      clientInr: Number(clientInr.id),
      clientUsd: Number(clientUsd.id),
      candidate: Number(candidate.id),
      placementInr: Number(placementInr.id),
      placementUsd: Number(placementUsd.id),
      vendor: Number(vendor.id),
      expenseCategory: Number(category.id),
      bankMethod: Number(bank.id),
    };
  });
}

// Log in through the real route and return a bearer token.
async function login(request, company) {
  const res = await request
    .post("/api/auth/login")
    .send({ email: company.email, password: company.password, tenant: company.tenantCode });
  if (res.status !== 200 || !res.body?.data?.token) {
    throw new Error(`Login failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.token;
}

module.exports = { seedCompany, login, TENANT_ID, RATES };

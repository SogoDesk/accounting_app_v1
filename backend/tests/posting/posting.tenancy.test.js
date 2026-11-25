// Two tenants posting in the same process must each hit their own chart of
// accounts, and must not see each other's entries.

const posting = require("../../services/gl/postingService");
const { provisionTenant } = require("../../services/tenants/provisionTenant");
const { withTenant } = require("../helpers/db");
const { seedCompany } = require("../helpers/fixtures");

let a;
let b;
beforeAll(async () => {
  a = await seedCompany();
  const { tenant } = await provisionTenant({
    tenantName: "Second Co",
    tenantCode: "SECOND",
    adminName: "Second Admin",
    adminEmail: "owner@second.test",
    currency: "INR",
  });
  b = await seedCompany({ tenantId: tenant.id, suffix: "-B" });
});

const invoice = (co, id) => ({
  id,
  invoice_number: `INV-${id}`,
  region_id: co.india,
  invoice_date: "2026-02-01",
  currency: "INR",
  subtotal: 100,
  tax_amount: 0,
  total_amount: 100,
  client_id: co.clientInr,
  placement_id: co.placementInr,
  created_by: co.userId,
});

const postedAccountTenants = (tenantId, entryId) =>
  withTenant(tenantId, async (db) =>
    (await db.query(
      `SELECT DISTINCT a.tenant_id FROM journal_lines jl
         JOIN chart_of_accounts a ON a.id = jl.account_id
        WHERE jl.entry_id = $1`,
      [entryId],
    )).rows.map((r) => r.tenant_id),
  );

test("each tenant's entries use its own accounts", async () => {
  const first = await withTenant(a.tenantId, (db) => posting.postInvoiceIssued(db, invoice(a, 1)));
  const second = await withTenant(b.tenantId, (db) => posting.postInvoiceIssued(db, invoice(b, 1)));

  expect(await postedAccountTenants(a.tenantId, first.id)).toEqual([a.tenantId]);
  expect(await postedAccountTenants(b.tenantId, second.id)).toEqual([b.tenantId]);
});

test("a tenant cannot see another tenant's entries", async () => {
  const seen = await withTenant(b.tenantId, async (db) =>
    (await db.query("SELECT DISTINCT tenant_id FROM journal_entries")).rows.map((r) => r.tenant_id),
  );
  expect(seen).toEqual([b.tenantId]);
});

test("the same document id in two tenants is not treated as already posted", async () => {
  const again = await withTenant(b.tenantId, (db) => posting.postInvoiceIssued(db, invoice(b, 1)));
  expect(again.skipped).toBe(true);
  const fresh = await withTenant(b.tenantId, (db) => posting.postInvoiceIssued(db, invoice(b, 2)));
  expect(fresh.skipped).toBeUndefined();
});

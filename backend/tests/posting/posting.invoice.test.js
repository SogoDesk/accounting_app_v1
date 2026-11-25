// AR invoice issued: Dr Receivable (1100) / Cr Revenue (4000) / Cr Tax (2100),
// valued into the entity's functional currency at the invoice date's rate.

const posting = require("../../services/gl/postingService");
const { withTenant, entryLines, lineSummary, totals } = require("../helpers/db");
const { seedCompany } = require("../helpers/fixtures");

let co;
beforeAll(async () => {
  co = await seedCompany();
});

const invoice = (overrides) => ({
  invoice_number: `INV-${overrides.id}`,
  region_id: co.india,
  client_id: co.clientInr,
  placement_id: co.placementInr,
  created_by: co.userId,
  ...overrides,
});

const post = (doc) => withTenant(co.tenantId, (db) => posting.postInvoiceIssued(db, doc));
const linesOf = (id) => withTenant(co.tenantId, (db) => entryLines(db, id));

test("single-currency invoice with tax", async () => {
  const entry = await post(invoice({
    id: 101, invoice_date: "2026-03-15", currency: "INR",
    subtotal: 1000, tax_amount: 180, total_amount: 1180,
  }));
  const lines = await linesOf(entry.id);

  expect(lineSummary(lines)).toEqual([
    ["1100", 1180, 0, 1180, 0],
    ["4000", 0, 1000, 0, 1000],
    ["2100", 0, 180, 0, 180],
  ]);
  expect(totals(lines)).toEqual({ debitBase: 1180, creditBase: 1180 });

  const header = await withTenant(co.tenantId, async (db) =>
    (await db.query(
      "SELECT source, source_ref, status, location_id, description, entry_date::text AS entry_date FROM journal_entries WHERE id = $1",
      [entry.id],
    )).rows[0],
  );
  expect(header).toEqual({
    source: "AR_INVOICE",
    source_ref: "101",
    status: "POSTED",
    location_id: String(co.locations.india),
    description: "Invoice INV-101",
    entry_date: "2026-03-15",
  });
});

test("invoice without tax has no tax line", async () => {
  const entry = await post(invoice({
    id: 102, invoice_date: "2026-03-15", currency: "INR",
    subtotal: 500, tax_amount: 0, total_amount: 500,
  }));
  expect(lineSummary(await linesOf(entry.id))).toEqual([
    ["1100", 500, 0, 500, 0],
    ["4000", 0, 500, 0, 500],
  ]);
});

test("foreign-currency invoice uses the invoice date's rate", async () => {
  const entry = await post(invoice({
    id: 103, invoice_date: "2026-03-15", currency: "USD",
    client_id: co.clientUsd, placement_id: co.placementUsd,
    subtotal: 100, tax_amount: 18, total_amount: 118,
  }));
  const lines = await linesOf(entry.id);

  // USD -> INR on 2026-03-15 is 84.
  expect(lineSummary(lines)).toEqual([
    ["1100", 118, 0, 9912, 0],
    ["4000", 0, 100, 0, 8400],
    ["2100", 0, 18, 0, 1512],
  ]);
  expect(lines.every((l) => l.currency === "USD" && l.exchange_rate === 84)).toBe(true);
  expect(totals(lines)).toEqual({ debitBase: 9912, creditBase: 9912 });
});

test("a date between rates uses the latest earlier rate", async () => {
  const entry = await post(invoice({
    id: 104, invoice_date: "2026-03-20", currency: "USD",
    client_id: co.clientUsd, placement_id: co.placementUsd,
    subtotal: 10, tax_amount: 0, total_amount: 10,
  }));
  expect(lineSummary(await linesOf(entry.id))).toEqual([
    ["1100", 10, 0, 840, 0],
    ["4000", 0, 10, 0, 840],
  ]);
});

test("a date before the first rate uses the nearest later rate", async () => {
  const entry = await post(invoice({
    id: 105, invoice_date: "2025-12-01", currency: "USD",
    client_id: co.clientUsd, placement_id: co.placementUsd,
    subtotal: 10, tax_amount: 0, total_amount: 10,
  }));
  expect(lineSummary(await linesOf(entry.id))).toEqual([
    ["1100", 10, 0, 830, 0],
    ["4000", 0, 10, 0, 830],
  ]);
});

test("rounding is absorbed by the receivable line so the entry balances", async () => {
  const entry = await post(invoice({
    id: 106, invoice_date: "2026-03-15", currency: "USD",
    client_id: co.clientUsd, placement_id: co.placementUsd,
    subtotal: 33.33, tax_amount: 6.01, total_amount: 39.34,
  }));
  const lines = await linesOf(entry.id);
  expect(lineSummary(lines)).toEqual([
    ["1100", 39.34, 0, 3304.56, 0],
    ["4000", 0, 33.33, 0, 2799.72],
    ["2100", 0, 6.01, 0, 504.84],
  ]);
  expect(totals(lines).debitBase).toBe(totals(lines).creditBase);
});

test("posting the same invoice twice is a no-op", async () => {
  const again = await post(invoice({
    id: 101, invoice_date: "2026-03-15", currency: "INR",
    subtotal: 1000, tax_amount: 180, total_amount: 1180,
  }));
  expect(again.skipped).toBe(true);
  const count = await withTenant(co.tenantId, async (db) =>
    (await db.query("SELECT count(*)::int AS n FROM journal_entries WHERE source_ref = '101'")).rows[0].n,
  );
  expect(count).toBe(1);
});

test("an invoice can be re-posted after its entry is reversed", async () => {
  const original = await withTenant(co.tenantId, async (db) =>
    (await db.query("SELECT id FROM journal_entries WHERE source = 'AR_INVOICE' AND source_ref = '102'")).rows[0].id,
  );
  await withTenant(co.tenantId, (db) => posting.reverseEntry(db, original, "edit", co.userId));
  const reposted = await post(invoice({
    id: 102, invoice_date: "2026-03-15", currency: "INR",
    subtotal: 600, tax_amount: 0, total_amount: 600,
  }));
  expect(reposted.skipped).toBeUndefined();
  expect(lineSummary(await linesOf(reposted.id))).toEqual([
    ["1100", 600, 0, 600, 0],
    ["4000", 0, 600, 0, 600],
  ]);
});

// Customer receipt: Dr Bank (1000) [+ Dr TDS receivable (1200)] / Cr Receivable
// (1100). Cash is valued at the payment date's rate, the receivable at the
// invoice's rate, and any difference goes to realised FX gain (4900) or loss (5900).

const posting = require("../../services/gl/postingService");
const { withTenant, entryLines, lineSummary, totals, accountBalance } = require("../helpers/db");
const { seedCompany } = require("../helpers/fixtures");

let co;
beforeAll(async () => {
  co = await seedCompany();
  // A lower rate after the invoice dates, for the realised-loss case.
  await withTenant(co.tenantId, (db) =>
    db.query(
      "INSERT INTO exchange_rates (from_currency, to_currency, rate, rate_date, source) VALUES ('USD','INR',82,'2026-04-15','MANUAL')",
    ),
  );
});

const inrInvoice = (id, total) => ({
  id, invoice_number: `INV-${id}`, region_id: co.india, invoice_date: "2026-03-15",
  currency: "INR", subtotal: total, tax_amount: 0, total_amount: total,
  client_id: co.clientInr, placement_id: co.placementInr, created_by: co.userId,
});
const usdInvoice = (id, total) => ({
  ...inrInvoice(id, total), currency: "USD", client_id: co.clientUsd, placement_id: co.placementUsd,
});

const issue = (inv) => withTenant(co.tenantId, (db) => posting.postInvoiceIssued(db, inv));
const receive = (payment, inv) =>
  withTenant(co.tenantId, (db) =>
    posting.postCustomerReceipt(db, { created_by: co.userId, ...payment }, inv),
  );
const linesOf = (id) => withTenant(co.tenantId, (db) => entryLines(db, id));
const receivable = () => withTenant(co.tenantId, (db) => accountBalance(db, co.india, "1100"));

test("full payment clears the receivable", async () => {
  const inv = inrInvoice(201, 1180);
  await issue(inv);
  const before = await receivable();

  const entry = await receive({ id: 1, payment_date: "2026-03-20", amount_received: 1180, currency: "INR" }, inv);

  expect(lineSummary(await linesOf(entry.id))).toEqual([
    ["1000", 1180, 0, 1180, 0],
    ["1100", 0, 1180, 0, 1180],
  ]);
  expect(await receivable()).toBe(before - 1180);
});

test("part payments clear only what was paid", async () => {
  const inv = inrInvoice(202, 1000);
  await issue(inv);
  const before = await receivable();

  const first = await receive({ id: 2, payment_date: "2026-03-20", amount_received: 400, currency: "INR" }, inv);
  expect(lineSummary(await linesOf(first.id))).toEqual([
    ["1000", 400, 0, 400, 0],
    ["1100", 0, 400, 0, 400],
  ]);
  expect(await receivable()).toBe(before - 400);

  await receive({ id: 3, payment_date: "2026-03-25", amount_received: 600, currency: "INR" }, inv);
  expect(await receivable()).toBe(before - 1000);
});

test("tax withheld by the customer is posted to TDS receivable", async () => {
  const inv = inrInvoice(203, 1000);
  await issue(inv);

  const entry = await receive(
    { id: 4, payment_date: "2026-03-20", amount_received: 900, tds_amount: 100, currency: "INR" },
    inv,
  );
  const lines = await linesOf(entry.id);

  expect(lineSummary(lines)).toEqual([
    ["1000", 900, 0, 900, 0],
    ["1200", 100, 0, 100, 0],
    ["1100", 0, 1000, 0, 1000],
  ]);
  expect(totals(lines)).toEqual({ debitBase: 1000, creditBase: 1000 });
});

test("foreign payment at a higher rate books a realised gain", async () => {
  const inv = usdInvoice(204, 100); // issued at 84
  await issue(inv);

  const entry = await receive({ id: 5, payment_date: "2026-03-31", amount_received: 100, currency: "USD" }, inv);

  // Cash at the payment day's rate (85); receivable cleared at the invoice's (84).
  expect(lineSummary(await linesOf(entry.id))).toEqual([
    ["1000", 100, 0, 8500, 0],
    ["1100", 0, 100, 0, 8400],
    ["4900", 0, 100, 0, 100],
  ]);
});

test("foreign payment at a lower rate books a realised loss", async () => {
  const inv = usdInvoice(205, 50); // issued at 84
  await issue(inv);

  const entry = await receive({ id: 6, payment_date: "2026-04-20", amount_received: 50, currency: "USD" }, inv);

  expect(lineSummary(await linesOf(entry.id))).toEqual([
    ["1000", 50, 0, 4100, 0],
    ["1100", 0, 50, 0, 4200],
    ["5900", 100, 0, 100, 0],
  ]);
});

test("a zero receipt is refused", async () => {
  await expect(
    receive({ id: 7, payment_date: "2026-03-20", amount_received: 0, currency: "INR" }, inrInvoice(201, 1180)),
  ).rejects.toThrow(/greater than 0/);
});

test("posting the same receipt twice is a no-op", async () => {
  const again = await receive(
    { id: 1, payment_date: "2026-03-20", amount_received: 1180, currency: "INR" },
    inrInvoice(201, 1180),
  );
  expect(again.skipped).toBe(true);
});

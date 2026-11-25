// Period-end revaluation of foreign-currency balances: the unrealised gain
// (4910) or loss (5910) equals balance x (closing rate - booked rate), and is
// reversed on the next day.

const posting = require("../../services/gl/postingService");
const fx = require("../../services/gl/fxRevaluationService");
const { withTenant, entryLines, lineSummary, accountBalance } = require("../helpers/db");
const { seedCompany } = require("../helpers/fixtures");

let co;
let result;
beforeAll(async () => {
  co = await seedCompany();
  await withTenant(co.tenantId, async (db) => {
    // USD 100 receivable and USD 50 payable, both booked at 84 on 2026-03-15.
    await posting.postInvoiceIssued(db, {
      id: 9501, invoice_number: "INV-9501", region_id: co.india, invoice_date: "2026-03-15",
      currency: "USD", subtotal: 100, tax_amount: 0, total_amount: 100,
      client_id: co.clientUsd, placement_id: co.placementUsd, created_by: co.userId,
    });
    await posting.postBillEntered(db, {
      id: 9501, bill_number: "B-9501", region_id: co.india, bill_date: "2026-03-15",
      currency: "USD", subtotal: 50, tax_amount: 0, total_amount: 50,
      vendor_id: co.vendor, created_by: co.userId,
    });
  });
  // revalue() runs its own transaction on the tenant connection.
  result = await withTenant(
    co.tenantId,
    () => fx.revalue({ entityId: co.india, asOfDate: "2026-03-31", userId: co.userId }),
    { transaction: false },
  );
});

const linesOf = (id) => withTenant(co.tenantId, (db) => entryLines(db, id));
const byAccount = (code) => result.revaluations.find((r) => r.account_code === code);

test("revalues each foreign balance at the closing rate", () => {
  expect(result.count).toBe(2);
  // Receivable: 100 x (85 - 84) = gain of 100.
  expect(byAccount("1100")).toMatchObject({
    currency: "USD", book_base: 8400, revalued_base: 8500, gain_loss: 100, reversal_date: "2026-04-01",
  });
  // Payable (credit balance): -50 x (85 - 84) = loss of 50.
  expect(byAccount("2000")).toMatchObject({
    currency: "USD", book_base: -4200, revalued_base: -4250, gain_loss: -50, reversal_date: "2026-04-01",
  });
});

test("a gain debits the balance and credits unrealised gain", async () => {
  expect(lineSummary(await linesOf(byAccount("1100").entry_id))).toEqual([
    ["1100", 100, 0, 100, 0],
    ["4910", 0, 100, 0, 100],
  ]);
});

test("a loss debits unrealised loss and credits the balance", async () => {
  expect(lineSummary(await linesOf(byAccount("2000").entry_id))).toEqual([
    ["5910", 50, 0, 50, 0],
    ["2000", 0, 50, 0, 50],
  ]);
});

test("each revaluation is reversed the next day", async () => {
  const reversal = byAccount("1100").reversal_entry_id;
  expect(lineSummary(await linesOf(reversal))).toEqual([
    ["1100", 0, 100, 0, 100],
    ["4910", 100, 0, 100, 0],
  ]);
  const date = await withTenant(co.tenantId, async (db) =>
    (await db.query("SELECT entry_date::text AS d FROM journal_entries WHERE id = $1", [reversal])).rows[0].d,
  );
  expect(date).toBe("2026-04-01");

  // Net effect after the reversal date is nil.
  const net = await withTenant(co.tenantId, (db) => accountBalance(db, co.india, "4910"));
  expect(net).toBe(0);
});

test("running the same date again changes nothing", async () => {
  const again = await withTenant(
    co.tenantId,
    () => fx.revalue({ entityId: co.india, asOfDate: "2026-03-31", userId: co.userId }),
    { transaction: false },
  );
  expect(again.count).toBe(0);
  expect(again.revaluations.every((r) => r.skipped)).toBe(true);
});

// AP bill: Dr Cost (5000) [+ Dr Input tax (2100)] / Cr Payable (2000).
// Vendor payment: Dr Payable / Cr Bank (1000).
// Covered twice: through postingService directly, and through the bill routes
// (create with line items -> approve -> pay), which is how the app posts.

const request = require("supertest");
const app = require("../../server");
const posting = require("../../services/gl/postingService");
const { withTenant, entryLines, lineSummary, totals, accountBalance } = require("../helpers/db");
const { seedCompany, login } = require("../helpers/fixtures");

let co;
let token;
beforeAll(async () => {
  co = await seedCompany();
  token = await login(request(app), co);
});

const linesOf = (id) => withTenant(co.tenantId, (db) => entryLines(db, id));
const payable = () => withTenant(co.tenantId, (db) => accountBalance(db, co.india, "2000"));
const api = () => ({
  get: (url) => request(app).get(`/api${url}`).set("Authorization", `Bearer ${token}`),
  post: (url, body) => request(app).post(`/api${url}`).set("Authorization", `Bearer ${token}`).send(body),
  patch: (url, body) => request(app).patch(`/api${url}`).set("Authorization", `Bearer ${token}`).send(body),
});

// Documents posted directly use ids far above the ones the routes create, because
// posting is idempotent per (source, document id).
describe("postingService", () => {
  const bill = {
    id: 9301, bill_number: "B-9301", region_id: null, bill_date: "2026-03-10", currency: "INR",
    subtotal: 500, tax_amount: 90, total_amount: 590, vendor_id: null, created_by: null,
  };
  beforeAll(() => Object.assign(bill, { region_id: co.india, vendor_id: co.vendor, created_by: co.userId }));

  test("bill with tax", async () => {
    const entry = await withTenant(co.tenantId, (db) => posting.postBillEntered(db, bill));
    const lines = await linesOf(entry.id);
    expect(lineSummary(lines)).toEqual([
      ["5000", 500, 0, 500, 0],
      ["2100", 90, 0, 90, 0],
      ["2000", 0, 590, 0, 590],
    ]);
    expect(totals(lines)).toEqual({ debitBase: 590, creditBase: 590 });
  });

  test("vendor payment clears the payable", async () => {
    const before = await payable();
    const entry = await withTenant(co.tenantId, (db) =>
      posting.postVendorPayment(
        db,
        { id: 9301, payment_date: "2026-03-20", amount_paid: 590, currency: "INR", created_by: co.userId },
        bill,
      ),
    );
    expect(lineSummary(await linesOf(entry.id))).toEqual([
      ["2000", 590, 0, 590, 0],
      ["1000", 0, 590, 0, 590],
    ]);
    expect(await payable()).toBe(before + 590);
  });
});

describe("bill routes", () => {
  let billId;

  test("a bill with line items posts on approval", async () => {
    const created = await api().post("/bills", {
      bill_number: "B-ROUTE-1",
      vendor_id: co.vendor,
      region_id: co.india,
      bill_date: "2026-03-12",
      due_date: "2026-04-11",
      currency: "INR",
      line_items: [
        { description: "Laptops", quantity: 2, unit_price: 300 },
        { description: "Setup", quantity: 1, unit_price: 150 },
      ],
      tax_lines: [{ tax_name: "GST", tax_percent: 18 }],
    });
    expect(created.status).toBe(201);
    billId = created.body.data.id;

    const draftEntries = await withTenant(co.tenantId, async (db) =>
      (await db.query("SELECT count(*)::int AS n FROM journal_entries WHERE source = 'AP_BILL' AND source_ref = $1", [String(billId)])).rows[0].n,
    );
    expect(draftEntries).toBe(0);

    const approved = await api().patch(`/bills/${billId}/status`, { status: "APPROVED" });
    expect(approved.status).toBe(200);

    const entry = await withTenant(co.tenantId, async (db) =>
      (await db.query("SELECT id FROM journal_entries WHERE source = 'AP_BILL' AND source_ref = $1 AND status = 'POSTED'", [String(billId)])).rows[0],
    );
    expect(lineSummary(await linesOf(entry.id))).toEqual([
      ["5000", 750, 0, 750, 0],
      ["2100", 135, 0, 135, 0],
      ["2000", 0, 885, 0, 885],
    ]);
  });

  test("paying the bill clears its payable", async () => {
    const before = await payable();
    const paid = await api().post("/vendor-payments", {
      bill_id: billId,
      amount_paid: 885,
      payment_date: "2026-03-25",
      payment_method: "BANK_TRANSFER",
    });
    expect({ status: paid.status, body: paid.body }).toMatchObject({ status: 201 });

    const entry = await withTenant(co.tenantId, async (db) =>
      (await db.query(
        `SELECT je.id FROM journal_entries je
           JOIN vendor_payments vp ON je.source_ref = vp.id::text
          WHERE je.source = 'AP_PAYMENT' AND je.status = 'POSTED' AND vp.bill_id = $1`,
        [billId],
      )).rows[0],
    );
    expect(lineSummary(await linesOf(entry.id))).toEqual([
      ["2000", 885, 0, 885, 0],
      ["1000", 0, 885, 0, 885],
    ]);
    expect(await payable()).toBe(before + 885);

    const bill = await api().get(`/bills/${billId}`);
    expect(bill.body.data).toMatchObject({ bill_status: "PAID" });
    expect(Number(bill.body.data.balance_outstanding)).toBe(0);
  });
});

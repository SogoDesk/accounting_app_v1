// Characterisation tests for the payment routes (see invoices.routes.test.js).
// Update snapshots with `npm test -- -u` only after reviewing the diff.

const request = require("supertest");
const app = require("../../server");
const { withTenant, entryLines, lineSummary } = require("../helpers/db");
const { seedCompany, login } = require("../helpers/fixtures");
const { stable } = require("../helpers/snapshot");

let co;
let token;
let invoiceId;
let paymentId;

const api = (method, url, body) => {
  const req = request(app)[method](`/api${url}`).set("Authorization", `Bearer ${token}`);
  return body === undefined ? req : req.send(body);
};

const invoiceView = async () => {
  const res = await api("get", `/invoices/${invoiceId}`);
  const d = res.body.data;
  return {
    invoice_status: d.invoice_status,
    payment_received_amount: Number(d.payment_received_amount),
    balance_outstanding: Number(d.balance_outstanding),
  };
};

const paymentEntry = async (id) =>
  withTenant(co.tenantId, async (db) => {
    const { rows } = await db.query(
      "SELECT id FROM journal_entries WHERE source = 'AR_PAYMENT' AND source_ref = $1 AND status = 'POSTED'",
      [String(id)],
    );
    return rows.length ? lineSummary(await entryLines(db, rows[0].id)) : null;
  });

beforeAll(async () => {
  co = await seedCompany();
  token = await login(request(app), co);
  const inv = await api("post", "/invoices", {
    invoice_number: "INV-P-0001",
    client_id: co.clientInr,
    region_id: co.india,
    placement_id: co.placementInr,
    invoice_date: "2026-03-15",
    due_date: "2026-04-14",
    currency: "INR",
    invoice_status: "GENERATED",
    line_items: [{ placement_id: co.placementInr, quantity: 10, rate: 1000, description: "Hours" }],
    tax_lines: [{ tax_name: "GST", tax_percent: 18 }],
  });
  if (inv.status !== 201) throw new Error(`invoice setup failed: ${JSON.stringify(inv.body)}`);
  invoiceId = inv.body.data.id;
});

test("create a part payment with TDS", async () => {
  const res = await api("post", "/payments", {
    payment_code: "PAY-T-0001",
    invoice_id: invoiceId,
    payment_date: "2026-03-25",
    amount_received: 4500,
    payment_mode: "BANK_TRANSFER",
    reference_number: "UTR-1",
    tds_applicable: true,
    tds_percent: 10,
    notes: "First instalment",
  });
  expect(res.status).toBe(201);
  expect(stable(res.body)).toMatchSnapshot();
  paymentId = res.body.data.payment.id;

  expect(await paymentEntry(paymentId)).toMatchSnapshot("ledger lines");
  expect(await invoiceView()).toMatchSnapshot("invoice after first payment");
});

test("list", async () => {
  const res = await api("get", "/payments");
  expect(res.status).toBe(200);
  expect(stable(res.body)).toMatchSnapshot();
});

test("get", async () => {
  const res = await api("get", `/payments/${paymentId}`);
  expect(res.status).toBe(200);
  expect(stable(res.body)).toMatchSnapshot();
});

test("get a missing payment", async () => {
  const res = await api("get", "/payments/999999");
  expect(res.body).toMatchSnapshot({}, `status ${res.status}`);
});

test("update", async () => {
  const res = await api("put", `/payments/${paymentId}`, {
    payment_code: "PAY-T-0001",
    invoice_id: invoiceId,
    payment_date: "2026-03-26",
    amount_received: 5000,
    payment_mode: "BANK_TRANSFER",
    reference_number: "UTR-1",
    tds_applicable: false,
    notes: "First instalment (corrected)",
  });
  expect(res.status).toBe(200);
  expect(stable(res.body)).toMatchSnapshot();
  expect(await invoiceView()).toMatchSnapshot("invoice after update");
});

test("create the final payment", async () => {
  const before = await invoiceView();
  const res = await api("post", "/payments", {
    payment_code: "PAY-T-0002",
    invoice_id: invoiceId,
    payment_date: "2026-03-31",
    amount_received: before.balance_outstanding,
    payment_mode: "BANK_TRANSFER",
    reference_number: "UTR-2",
  });
  expect(res.status).toBe(201);
  expect(stable(res.body)).toMatchSnapshot();
  expect(await invoiceView()).toMatchSnapshot("invoice after final payment");
});

test("overpayment is refused", async () => {
  const res = await api("post", "/payments", {
    payment_code: "PAY-T-0003",
    invoice_id: invoiceId,
    payment_date: "2026-03-31",
    amount_received: 1,
    payment_mode: "BANK_TRANSFER",
  });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.body).toMatchSnapshot({}, `status ${res.status}`);
});

test("delete", async () => {
  const res = await api("delete", `/payments/${paymentId}`);
  expect(res.status).toBe(200);
  expect(stable(res.body)).toMatchSnapshot();
  expect(await invoiceView()).toMatchSnapshot("invoice after delete");

  // Every entry ever posted for this payment, oldest first. Deleting reverses
  // rather than removes, so the receivable effect nets to zero.
  const history = await withTenant(co.tenantId, async (db) =>
    (await db.query(
      `SELECT je.status,
              (SELECT sum(jl.debit_base - jl.credit_base)::float8 FROM journal_lines jl
                 JOIN chart_of_accounts a ON a.id = jl.account_id
                WHERE jl.entry_id = je.id AND a.account_code = '1100') AS receivable
         FROM journal_entries je
        WHERE je.source = 'AR_PAYMENT' AND je.source_ref = $1 ORDER BY je.id`,
      [String(paymentId)],
    )).rows,
  );
  expect(history).toMatchSnapshot("ledger history after delete");
  expect(history.reduce((s, e) => s + (e.status === "POSTED" || e.status === "REVERSED" ? e.receivable : 0), 0)).toBe(0);
});

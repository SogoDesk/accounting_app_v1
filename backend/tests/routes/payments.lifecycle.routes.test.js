// More characterisation tests for the payment routes: lookups, exports, the
// receipt PDF, multi-invoice receipts and the validation branches.

const request = require("supertest");
const app = require("../../server");
const { withTenant } = require("../helpers/db");
const { seedCompany, login } = require("../helpers/fixtures");
const { stable, maskYear } = require("../helpers/snapshot");

let co;
let token;
const inv = {};

const api = (method, url, body) => {
  const req = request(app)[method](`/api${url}`).set("Authorization", `Bearer ${token}`);
  return body === undefined ? req : req.send(body);
};

const createInvoice = async (number, overrides = {}) => {
  const res = await api("post", "/invoices", {
    invoice_number: number,
    client_id: co.clientInr,
    region_id: co.india,
    placement_id: co.placementInr,
    invoice_date: "2026-03-15",
    due_date: "2026-04-14",
    currency: "INR",
    invoice_status: "GENERATED",
    line_items: [{ placement_id: co.placementInr, quantity: 1, rate: 1000, description: "Fee" }],
    tax_lines: [],
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`invoice ${number}: ${JSON.stringify(res.body)}`);
  return res.body.data.id;
};

const receipt = (overrides = {}) => ({
  invoice_id: inv.a,
  payment_date: "2026-03-20",
  amount_received: 100,
  payment_mode: "BANK_TRANSFER",
  ...overrides,
});

beforeAll(async () => {
  co = await seedCompany();
  token = await login(request(app), co);
  inv.a = await createInvoice("INV-PL-A");
  inv.b = await createInvoice("INV-PL-B");
  inv.c = await createInvoice("INV-PL-C");
  inv.usd = await createInvoice("INV-PL-USD", {
    client_id: co.clientUsd,
    placement_id: co.placementUsd,
    currency: "USD",
    line_items: [{ placement_id: co.placementUsd, quantity: 1, rate: 100, description: "Fee" }],
  });
  inv.cancelled = await createInvoice("INV-PL-X", { invoice_status: "DRAFT" });
  await api("patch", `/invoices/${inv.cancelled}/status`, { status: "CANCELLED" });
});

describe("lookups", () => {
  test("invoice options exclude cancelled invoices", async () => {
    const res = await api("get", "/payments/invoice-options");
    expect(res.status).toBe(200);
    expect(stable(res.body)).toMatchSnapshot();
  });

  test("next code", async () => {
    const res = await api("get", "/payments/next-code");
    expect(res.status).toBe(200);
    expect(stable(res.body)).toMatchSnapshot();
  });
});

describe("validation", () => {
  test.each([
    ["no invoice", () => receipt({ invoice_id: undefined })],
    ["no date", () => receipt({ payment_date: "" })],
    ["missing invoice", () => receipt({ invoice_id: 999999 })],
    ["cancelled invoice", () => receipt({ invoice_id: inv.cancelled })],
    ["invalid mode", () => receipt({ payment_mode: "BARTER" })],
    ["zero amount", () => receipt({ amount_received: 0 })],
    ["more than the balance", () => receipt({ amount_received: 5000 })],
    ["TDS without a percentage", () => receipt({ tds_applicable: true })],
    ["mixed currencies", () => receipt({ invoice_id: undefined, invoice_ids: [inv.a, inv.usd] })],
  ])("%s", async (_label, body) => {
    const res = await api("post", "/payments", body());
    expect({ status: res.status, body: res.body }).toMatchSnapshot();
  });

  test("duplicate payment code", async () => {
    const first = await api("post", "/payments", receipt({ payment_code: "PAY-PL-DUP", amount_received: 10 }));
    expect(first.status).toBe(201);
    const again = await api("post", "/payments", receipt({ payment_code: "pay-pl-dup", amount_received: 10 }));
    expect({ status: again.status, body: again.body }).toMatchSnapshot();
  });
});

describe("receipts", () => {
  test("one receipt across several invoices settles them in order", async () => {
    const res = await api("post", "/payments", {
      invoice_ids: [inv.b, inv.c],
      payment_date: "2026-03-22",
      amount_received: 1500,
      payment_mode: "NEFT",
      reference_number: "utr-multi",
    });
    expect(res.status).toBe(201);
    expect(stable(res.body)).toMatchSnapshot();
  });

  test("an amount left blank pays the full net balance", async () => {
    const res = await api("post", "/payments", {
      invoice_id: inv.usd, payment_date: "2026-03-31", payment_mode: "WIRE_TRANSFER",
    });
    expect(res.status).toBe(201);
    expect(stable(res.body)).toMatchSnapshot();
    const ledger = await withTenant(co.tenantId, async (db) =>
      (await db.query(
        `SELECT a.account_code, jl.debit_base::float8 AS dr, jl.credit_base::float8 AS cr
           FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
           JOIN chart_of_accounts a ON a.id = jl.account_id
          WHERE je.source = 'AR_PAYMENT' AND je.source_ref = $1 ORDER BY jl.id`,
        [String(res.body.data.payment.id)],
      )).rows,
    );
    expect(ledger).toMatchSnapshot("ledger");
  });

  test("updating a missing payment", async () => {
    const res = await api("put", "/payments/999999", receipt());
    expect({ status: res.status, body: res.body }).toMatchSnapshot();
  });

  test("moving a payment to another invoice recalculates both", async () => {
    const created = await api("post", "/payments", receipt({ amount_received: 200 }));
    const moved = await api("put", `/payments/${created.body.data.payment.id}`, { invoice_id: inv.cancelled });
    expect({ status: moved.status, body: moved.body }).toMatchSnapshot("to a cancelled invoice");

    const ok = await api("put", `/payments/${created.body.data.payment.id}`, { invoice_id: inv.c, amount_received: 100 });
    expect(ok.status).toBe(200);
    expect(stable(ok.body)).toMatchSnapshot();
  });

  test("deleting a missing payment", async () => {
    const res = await api("delete", "/payments/999999");
    expect({ status: res.status, body: res.body }).toMatchSnapshot();
  });
});

describe("list and export", () => {
  test.each([
    ["by invoice", () => `?invoice_id=${inv.b}`],
    ["by mode", () => "?payment_mode=neft"],
    ["search", () => "?search=UTR-MULTI"],
    ["by client", () => `?client_id=${co.clientUsd}`],
  ])("list %s", async (_label, query) => {
    const res = await api("get", `/payments${query()}`);
    expect(res.status).toBe(200);
    expect(stable(res.body).data.map((p) => [p.payment_code, p.invoice_number, p.amount_received])).toMatchSnapshot();
  });

  test("CSV export", async () => {
    const res = await api("get", "/payments/export?format=csv");
    expect(res.status).toBe(200);
    expect(maskYear(res.text)).toMatchSnapshot();
  });

  test("CSV export for a date range", async () => {
    const res = await api("get", "/payments/export?format=csv&from=2026-03-21&to=2026-03-31");
    expect(maskYear(res.text)).toMatchSnapshot();
  });
});

describe("receipt PDF", () => {
  test("download", async () => {
    const list = await api("get", "/payments");
    const res = await api("get", `/payments/${list.body.data[0].id}/receipt`).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.body.slice(0, 5).toString()).toBe("%PDF-");
  });

  test("missing payment", async () => {
    const res = await api("get", "/payments/999999/receipt");
    expect(res.status).toBe(404);
  });
});

// Characterisation tests for the invoice routes. They record today's response
// bodies as snapshots so the controller split (workflow step 0.5) can be
// checked for unintended changes. If a change is intended, review the diff
// and update with `npm test -- -u`.

const request = require("supertest");
const app = require("../../server");
const { withTenant, entryLines, lineSummary } = require("../helpers/db");
const { seedCompany, login } = require("../helpers/fixtures");
const { stable } = require("../helpers/snapshot");

let co;
let token;
let invoiceId;

beforeAll(async () => {
  co = await seedCompany();
  token = await login(request(app), co);
});

const api = (method, url, body) => {
  const req = request(app)[method](`/api${url}`).set("Authorization", `Bearer ${token}`);
  return body === undefined ? req : req.send(body);
};

const newInvoice = (overrides = {}) => ({
  invoice_number: "INV-T-0001",
  client_id: co.clientInr,
  region_id: co.india,
  placement_id: co.placementInr,
  invoice_date: "2026-03-15",
  due_date: "2026-04-14",
  billing_period_start: "2026-03-01",
  billing_period_end: "2026-03-31",
  currency: "INR",
  invoice_status: "GENERATED",
  notes: "March services",
  line_items: [
    { placement_id: co.placementInr, quantity: 160, rate: 1000, description: "March hours" },
  ],
  tax_lines: [{ tax_name: "GST", tax_percent: 18 }],
  ...overrides,
});

test("create", async () => {
  const res = await api("post", "/invoices", newInvoice());
  expect(res.status).toBe(201);
  invoiceId = res.body.data.id;
  expect(stable(res.body)).toMatchSnapshot();

  // A GENERATED invoice posts to the ledger in the same transaction.
  const lines = await withTenant(co.tenantId, async (db) => {
    const { rows } = await db.query(
      "SELECT id FROM journal_entries WHERE source = 'AR_INVOICE' AND source_ref = $1",
      [String(invoiceId)],
    );
    return entryLines(db, rows[0].id);
  });
  expect(lineSummary(lines)).toEqual([
    ["1100", 188800, 0, 188800, 0],
    ["4000", 0, 160000, 0, 160000],
    ["2100", 0, 28800, 0, 28800],
  ]);
});

test("create a draft (not posted)", async () => {
  const res = await api("post", "/invoices", newInvoice({ invoice_number: "INV-T-0002", invoice_status: "DRAFT" }));
  expect(res.status).toBe(201);
  expect(stable(res.body)).toMatchSnapshot();
  const posted = await withTenant(co.tenantId, async (db) =>
    (await db.query("SELECT count(*)::int AS n FROM journal_entries WHERE source_ref = $1", [String(res.body.data.id)])).rows[0].n,
  );
  expect(posted).toBe(0);
});

test("create rejects a duplicate number", async () => {
  const res = await api("post", "/invoices", newInvoice());
  expect(res.status).toBe(409);
  expect(res.body).toMatchSnapshot();
});

test("create rejects a missing date", async () => {
  const res = await api("post", "/invoices", newInvoice({ invoice_number: "INV-T-0003", invoice_date: "" }));
  expect(res.status).toBe(400);
  expect(res.body).toMatchSnapshot();
});

test("list", async () => {
  const res = await api("get", "/invoices");
  expect(res.status).toBe(200);
  expect(stable(res.body)).toMatchSnapshot();
});

test("get", async () => {
  const res = await api("get", `/invoices/${invoiceId}`);
  expect(res.status).toBe(200);
  expect(stable(res.body)).toMatchSnapshot();
});

test("get a missing invoice", async () => {
  const res = await api("get", "/invoices/999999");
  expect(res.status).toBe(404);
  expect(res.body).toMatchSnapshot();
});

test("update", async () => {
  const res = await api(
    "put",
    `/invoices/${invoiceId}`,
    newInvoice({
      notes: "March services (revised)",
      line_items: [
        { placement_id: co.placementInr, quantity: 150, rate: 1000, description: "March hours" },
      ],
    }),
  );
  expect(res.status).toBe(200);
  expect(stable(res.body)).toMatchSnapshot();

  // Editing a posted invoice reverses the old entry and posts the new amounts.
  const entries = await withTenant(co.tenantId, async (db) =>
    (await db.query(
      `SELECT status, (SELECT sum(debit_base)::float8 FROM journal_lines WHERE entry_id = je.id) AS amount
         FROM journal_entries je WHERE source = 'AR_INVOICE' AND source_ref = $1 ORDER BY id`,
      [String(invoiceId)],
    )).rows,
  );
  expect(entries).toEqual([
    { status: "REVERSED", amount: 188800 },
    { status: "POSTED", amount: 188800 },
    { status: "POSTED", amount: 177000 },
  ]);
});

test("send", async () => {
  const res = await api("post", `/invoices/${invoiceId}/send-email`, {});
  expect(res.status).toBe(201);
  expect(stable(res.body)).toMatchSnapshot();

  const outbox = await withTenant(co.tenantId, async (db) =>
    (await db.query(
      "SELECT template_key, invoice_id, to_email, attach_pdf, status FROM email_outbox WHERE invoice_id = $1",
      [invoiceId],
    )).rows,
  );
  expect(outbox).toMatchSnapshot();

  const history = await api("get", `/invoices/${invoiceId}/email-history`);
  expect(history.status).toBe(200);
  expect(stable(history.body)).toMatchSnapshot();
});

test("status change to SENT", async () => {
  const res = await api("patch", `/invoices/${invoiceId}/status`, { status: "SENT" });
  expect(res.status).toBe(200);
  expect(stable(res.body)).toMatchSnapshot();
});

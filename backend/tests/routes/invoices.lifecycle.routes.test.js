// More characterisation tests for the invoice routes: the routes and branches
// invoices.routes.test.js does not reach. Together they guard the controller
// split (workflow step 0.5).

const request = require("supertest");
const app = require("../../server");
const { withTenant } = require("../helpers/db");
const { seedCompany, login } = require("../helpers/fixtures");
const { stable, maskYear } = require("../helpers/snapshot");

let co;
let token;
const ids = {};

const api = (method, url, body) => {
  const req = request(app)[method](`/api${url}`).set("Authorization", `Bearer ${token}`);
  return body === undefined ? req : req.send(body);
};

// Every entry posted for an invoice: source, entity, status and receivable-side total.
const ledgerFor = (invoiceId) =>
  withTenant(co.tenantId, async (db) =>
    (await db.query(
      `SELECT je.source, je.entity_id, je.status,
              (SELECT sum(debit_base)::float8 FROM journal_lines WHERE entry_id = je.id) AS amount
         FROM journal_entries je
        WHERE je.source IN ('AR_INVOICE', 'IC_INVOICE') AND je.source_ref = $1
        ORDER BY je.id`,
      [String(invoiceId)],
    )).rows,
  );

const clientInvoice = (overrides = {}) => ({
  client_id: co.clientInr,
  region_id: co.india,
  placement_id: co.placementInr,
  invoice_date: "2026-03-15",
  due_date: "2026-04-14",
  currency: "INR",
  invoice_status: "GENERATED",
  line_items: [{ placement_id: co.placementInr, quantity: 10, rate: 1000, description: "Hours" }],
  tax_lines: [{ tax_name: "GST", tax_percent: 18 }],
  ...overrides,
});

beforeAll(async () => {
  co = await seedCompany();
  token = await login(request(app), co);
});

describe("lookups", () => {
  test("placement options", async () => {
    const res = await api("get", "/invoices/placement-options");
    expect(res.status).toBe(200);
    expect(stable(res.body)).toMatchSnapshot();
  });

  test("next number preview draws from the client and inter-company series", async () => {
    const client = await api("get", "/invoices/next-number-preview");
    const ic = await api("get", "/invoices/next-number-preview?type=INTER_COMPANY");
    expect(stable(client.body)).toMatchSnapshot();
    expect(stable(ic.body)).toMatchSnapshot();
  });
});

describe("create", () => {
  test("without a number takes the next one in the series", async () => {
    const res = await api("post", "/invoices", clientInvoice({ invoice_status: "DRAFT" }));
    expect(res.status).toBe(201);
    ids.autoNumbered = res.body.data.id;
    expect(maskYear(res.body.data.invoice_number)).toMatchSnapshot();
  });

  test("due date defaults from the payment terms", async () => {
    const res = await api("post", "/invoices", clientInvoice({ invoice_number: "INV-L-TERMS", due_date: "" }));
    expect(res.status).toBe(201);
    expect(res.body.data.due_date).toBe("2026-04-14"); // Net 30 from the placement
    ids.terms = res.body.data.id;
  });

  test("foreign-currency invoice records the rate and base amount", async () => {
    const res = await api("post", "/invoices", clientInvoice({
      invoice_number: "INV-L-USD",
      client_id: co.clientUsd,
      placement_id: co.placementUsd,
      currency: "USD",
      line_items: [{ placement_id: co.placementUsd, quantity: 10, rate: 50, description: "Hours" }],
      tax_lines: [],
    }));
    expect(res.status).toBe(201);
    expect(stable(res.body)).toMatchSnapshot();
    ids.usd = res.body.data.id;
  });

  test("currency must match the placement", async () => {
    const res = await api("post", "/invoices", clientInvoice({ invoice_number: "INV-L-BAD", currency: "USD" }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchSnapshot();
  });

  test("line items are required", async () => {
    const res = await api("post", "/invoices", clientInvoice({ invoice_number: "INV-L-EMPTY", line_items: [] }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchSnapshot();
  });

  // Current behaviour, not the intended one: 2026-02-31 passes sanitizeDateInput and
  // Postgres rejects it as out of range (22008), which is not mapped to a 400.
  test("an impossible date is currently a 500", async () => {
    const created = await api("post", "/invoices", clientInvoice({
      invoice_number: "INV-L-FEB31", billing_period_start: "2026-02-31",
    }));
    expect({ status: created.status, body: created.body }).toMatchSnapshot("create");
    const updated = await api("put", `/invoices/${ids.terms}`, clientInvoice({
      invoice_number: "INV-L-TERMS", billing_period_end: "2026-02-31",
    }));
    expect({ status: updated.status, body: updated.body }).toMatchSnapshot("update");
  });

  test("an unknown invoice type is refused", async () => {
    const res = await api("post", "/invoices", clientInvoice({ invoice_number: "INV-L-TYPE", invoice_type: "BARTER" }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchSnapshot();
  });
});

describe("inter-company", () => {
  const icInvoice = (overrides = {}) => ({
    invoice_type: "INTER_COMPANY",
    invoice_number: "IC-L-0001",
    region_id: co.india,
    bill_to_region_id: co.usa,
    currency: "USD",
    invoice_date: "2026-03-15",
    due_date: "2026-04-14",
    invoice_status: "GENERATED",
    line_items: [{ description: "Shared services", quantity: 1, rate: 500 }],
    ...overrides,
  });

  test("create posts one entry in each entity", async () => {
    const res = await api("post", "/invoices", icInvoice());
    expect(res.status).toBe(201);
    expect(stable(res.body)).toMatchSnapshot();
    ids.ic = res.body.data.id;
    expect(await ledgerFor(ids.ic)).toMatchSnapshot("ledger");
  });

  test("tax lines are refused", async () => {
    const res = await api("post", "/invoices", icInvoice({
      invoice_number: "IC-L-TAX", tax_lines: [{ tax_name: "GST", tax_percent: 18 }],
    }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchSnapshot();
  });

  test("an entity cannot invoice itself", async () => {
    const res = await api("post", "/invoices", icInvoice({ invoice_number: "IC-L-SELF", bill_to_region_id: co.india }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchSnapshot();
  });

  test("update reposts both legs", async () => {
    const res = await api("put", `/invoices/${ids.ic}`, icInvoice({
      line_items: [{ description: "Shared services", quantity: 2, rate: 500 }],
    }));
    expect(res.status).toBe(200);
    expect(stable(res.body)).toMatchSnapshot();
    expect(await ledgerFor(ids.ic)).toMatchSnapshot("ledger");
  });

  test("the type cannot be changed", async () => {
    const res = await api("put", `/invoices/${ids.ic}`, icInvoice({ invoice_type: "CLIENT" }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchSnapshot();
  });

  test("cancelling reverses both legs", async () => {
    const res = await api("patch", `/invoices/${ids.ic}/status`, { status: "CANCELLED" });
    expect(res.status).toBe(200);
    expect(stable(res.body)).toMatchSnapshot();
    expect(await ledgerFor(ids.ic)).toMatchSnapshot("ledger");
  });
});

describe("status changes", () => {
  test("invalid status is refused", async () => {
    const res = await api("patch", `/invoices/${ids.terms}/status`, { status: "LOST" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchSnapshot();
  });

  test("PAID in a TDS region needs the TDS answer", async () => {
    const res = await api("patch", `/invoices/${ids.terms}/status`, { status: "PAID" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchSnapshot();
  });

  test("TDS percent is required when TDS was withheld", async () => {
    const res = await api("patch", `/invoices/${ids.terms}/status`, { status: "PAID", tds_applicable: true });
    expect(res.status).toBe(400);
    expect(res.body).toMatchSnapshot();
  });

  test("a future payment date is refused", async () => {
    const res = await api("patch", `/invoices/${ids.terms}/status`, {
      status: "PAID", tds_applicable: false, payment_date: "2099-01-01",
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchSnapshot();
  });

  test("PARTIALLY_PAID records an automatic payment", async () => {
    const res = await api("patch", `/invoices/${ids.terms}/status`, {
      status: "PARTIALLY_PAID", tds_applicable: false, amount_received: 3000,
    });
    expect(res.status).toBe(200);
    expect(stable(res.body)).toMatchSnapshot();
  });

  test("a partial payment above the balance is refused", async () => {
    const res = await api("patch", `/invoices/${ids.terms}/status`, {
      status: "PARTIALLY_PAID", tds_applicable: false, amount_received: 100000,
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchSnapshot();
  });

  test("PAID with TDS settles the rest, net of TDS", async () => {
    const res = await api("patch", `/invoices/${ids.terms}/status`, {
      status: "PAID", tds_applicable: true, tds_percent: 10, payment_date: "2026-03-31",
    });
    expect(res.status).toBe(200);
    expect(stable(res.body)).toMatchSnapshot();
    const payments = await withTenant(co.tenantId, async (db) =>
      (await db.query(
        `SELECT payment_mode, amount_received::float8 AS amount,
                CASE WHEN payment_date = CURRENT_DATE THEN '<today>' ELSE payment_date::text END AS payment_date,
                tds_amount::float8 AS tds, notes
           FROM payments WHERE invoice_id = $1 ORDER BY id`,
        [ids.terms],
      )).rows,
    );
    expect(payments).toMatchSnapshot("payments");
  });

  test("print data includes the payments", async () => {
    const res = await api("get", `/invoices/${ids.terms}/print`);
    expect(res.status).toBe(200);
    expect(stable(res.body)).toMatchSnapshot();
  });

  test("an invoice with payments cannot be cancelled or deleted", async () => {
    const cancel = await api("patch", `/invoices/${ids.terms}/status`, { status: "CANCELLED" });
    const del = await api("delete", `/invoices/${ids.terms}`);
    expect([cancel.status, del.status]).toEqual([400, 400]);
    expect([cancel.body, del.body]).toMatchSnapshot();
  });

  test("moving back to SENT removes the automatic payments", async () => {
    const res = await api("patch", `/invoices/${ids.terms}/status`, { status: "SENT" });
    expect(res.status).toBe(200);
    expect(stable(res.body)).toMatchSnapshot();
  });

  test("promoting a draft posts it", async () => {
    expect(await ledgerFor(ids.autoNumbered)).toEqual([]);
    const res = await api("patch", `/invoices/${ids.autoNumbered}/status`, { status: "GENERATED" });
    expect(res.status).toBe(200);
    expect(await ledgerFor(ids.autoNumbered)).toMatchSnapshot();
  });
});

describe("documents", () => {
  test("PDF download", async () => {
    const res = await api("get", `/invoices/${ids.usd}/pdf`).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.body.slice(0, 5).toString()).toBe("%PDF-");
  });

  test("PDF of a missing invoice", async () => {
    const res = await api("get", "/invoices/999999/pdf");
    expect(res.status).toBe(404);
  });
});

describe("list filters", () => {
  test.each([
    ["status=OVERDUE", "?status=OVERDUE"],
    ["scope=outstanding", "?scope=outstanding"],
    ["scope=collected", "?scope=collected"],
    ["search", "?search=Export"],
    ["client", () => `?client_id=${co.clientUsd}`],
    ["currency", "?currency=usd"],
    ["date range", "?from=2026-04-01&to=2026-04-30"],
    ["paging", "?page=2&limit=1"],
  ])("%s", async (_label, query) => {
    const res = await api("get", `/invoices${typeof query === "function" ? query() : query}`);
    expect(res.status).toBe(200);
    const { data, ...rest } = stable(res.body);
    expect({ invoice_numbers: data.map((i) => i.invoice_number), ...rest }).toMatchSnapshot();
  });
});

describe("export", () => {
  test("CSV", async () => {
    const res = await api("get", "/invoices/export?format=csv");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(maskYear(res.text)).toMatchSnapshot();
  });

  test("CSV filtered by status", async () => {
    const res = await api("get", "/invoices/export?format=csv&status=CANCELLED");
    expect(maskYear(res.text)).toMatchSnapshot();
  });
});

describe("delete", () => {
  test("a draft without payments is deleted", async () => {
    const draft = await api("post", "/invoices", clientInvoice({ invoice_number: "INV-L-DEL", invoice_status: "DRAFT" }));
    const res = await api("delete", `/invoices/${draft.body.data.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchSnapshot();
    const gone = await api("get", `/invoices/${draft.body.data.id}`);
    expect(gone.status).toBe(404);
  });

  test("a posted invoice is reversed when deleted", async () => {
    const res = await api("delete", `/invoices/${ids.usd}`);
    expect(res.status).toBe(200);
    expect(await ledgerFor(ids.usd)).toMatchSnapshot();
  });
});

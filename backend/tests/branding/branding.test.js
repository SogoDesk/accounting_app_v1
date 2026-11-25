// Step 0.6: every customer-facing name, logo and colour comes from data.
// A company named "Acme" (the seeded tenant) gets Acme on its invoices and
// emails, never another customer's name or logo.

const zlib = require("zlib");
const request = require("supertest");
const app = require("../../server");
const { getBranding, DEFAULT_PRIMARY_COLOR, DEFAULT_ACCENT_COLOR } = require("../../services/branding/brandingService");
const { renderInvoicePdfBuffer } = require("../../utils/invoicePdfGenerator");
const renderer = require("../../services/email/renderer");
const invoiceQueries = require("../../services/invoices/invoiceQueries");
const { withTenant } = require("../helpers/db");
const { seedCompany, login } = require("../helpers/fixtures");

let co;
let token;
let invoiceId;

const api = (method, url, body) => {
  const req = request(app)[method](`/api${url}`).set("Authorization", `Bearer ${token}`);
  return body === undefined ? req : req.send(body);
};

// The text a pdfkit PDF draws: inflate each content stream and decode the hex
// strings pdfkit writes glyphs as (<48656c6c6f> Tj / [<..> 12 <..>] TJ).
function pdfText(buffer) {
  const raw = buffer.toString("latin1");
  const streams = [];
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    const bytes = Buffer.from(raw.slice(start, end), "latin1");
    try {
      streams.push(zlib.inflateSync(bytes).toString("latin1"));
    } catch (_) {
      streams.push(bytes.toString("latin1"));
    }
    re.lastIndex = end;
  }
  const content = streams.join("\n");
  const hex = content.match(/<([0-9a-fA-F\s]+)>/g) || [];
  return hex
    .map((h) => Buffer.from(h.slice(1, -1).replace(/\s/g, ""), "hex").toString("latin1"))
    .join("");
}

const renderPdf = async (id) =>
  withTenant(co.tenantId, async (db) => {
    const invoice = await invoiceQueries.getInvoiceDetail(db, id, { canAct: () => true });
    const buffer = await renderInvoicePdfBuffer(invoice, await getBranding(db, invoice.region_id));
    return { buffer, text: pdfText(buffer), raw: buffer.toString("latin1") };
  }, { transaction: false });

beforeAll(async () => {
  co = await seedCompany();
  token = await login(request(app), co);
  const res = await api("post", "/invoices", {
    invoice_number: "INV-BR-0001",
    client_id: co.clientInr,
    region_id: co.india,
    placement_id: co.placementInr,
    invoice_date: "2026-03-15",
    due_date: "2026-04-14",
    currency: "INR",
    invoice_status: "GENERATED",
    line_items: [{ placement_id: co.placementInr, quantity: 1, rate: 1000, description: "Consulting" }],
    tax_lines: [],
  });
  invoiceId = res.body.data.id;
});

describe("getBranding", () => {
  test("falls back to the tenant name and neutral colours", async () => {
    const branding = await withTenant(co.tenantId, (db) => getBranding(db, co.india));
    expect(branding).toEqual({
      name: "Acme Company",
      logoUrl: null,
      primaryColor: DEFAULT_PRIMARY_COLOR,
      accentColor: DEFAULT_ACCENT_COLOR,
      senderName: "Acme Company",
      footerNote: null,
      address: null,
    });
  });

  test("company settings override the tenant, the entity overrides both", async () => {
    // The seeded tenant has no company_settings row yet, as on older databases.
    await withTenant(co.tenantId, async (db) => {
      await db.query(
        `INSERT INTO company_settings (id, group_currency, display_name, primary_color, email_sender_name)
         VALUES (1, 'USD', 'Acme Group', '#112233', 'Acme Billing')`,
      );
      await db.query("UPDATE regions SET company_name = 'Acme India Pvt Ltd', invoice_brand_accent_color = '#445566' WHERE id = $1", [co.india]);
    });
    try {
      const company = await withTenant(co.tenantId, (db) => getBranding(db));
      const entity = await withTenant(co.tenantId, (db) => getBranding(db, co.india));
      expect(company).toMatchObject({ name: "Acme Group", primaryColor: "#112233", senderName: "Acme Billing" });
      expect(entity).toMatchObject({
        name: "Acme India Pvt Ltd", primaryColor: "#112233", accentColor: "#445566", senderName: "Acme Billing",
      });
    } finally {
      // Put the data back for the tests below.
      await withTenant(co.tenantId, async (db) => {
        await db.query("DELETE FROM company_settings");
        await db.query("UPDATE regions SET company_name = NULL, invoice_brand_accent_color = NULL WHERE id = $1", [co.india]);
      });
    }
  });
});

describe("invoice PDF", () => {
  test("shows the company's own name and nothing of Tetriq", async () => {
    const { buffer, text } = await renderPdf(invoiceId);
    expect(buffer.slice(0, 5).toString()).toBe("%PDF-");
    expect(text).toContain("ACME COMPANY"); // the header prints the name in capitals
    expect(text).toContain("For Acme Company.");
    expect(text).toContain("INV-BR-0001");
    expect(text).not.toMatch(/tetriq/i);
  });

  test("has no logo when none is configured", async () => {
    const { raw } = await renderPdf(invoiceId);
    expect(raw).not.toMatch(/\/Subtype\s*\/Image/);
  });

  test("the download route serves the same branded PDF", async () => {
    const res = await api("get", `/invoices/${invoiceId}/pdf`).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    const text = pdfText(res.body);
    expect(text).toContain("ACME COMPANY");
    expect(text).not.toMatch(/tetriq/i);
  });
});

describe("email", () => {
  test("an invoice email names the company when the entity has no company name", async () => {
    const context = renderer.buildContext(
      { invoice_number: "INV-1", region_name: "India", currency: "INR" },
      { branding: { name: "Acme Company", logoUrl: null } },
    );
    expect(context.company_name).toBe("Acme Company");
  });

  test("the template preview uses the company's name, not a sample brand", async () => {
    const res = await api("post", "/email-templates/preview", {
      subject: "Invoice from {{company_name}}",
      body: "<p>{{company_name}} · {{footer_note}}</p>",
    });
    expect(res.status).toBe(200);
    expect(res.body.data.subject).toBe("Invoice from Acme Company");
    expect(JSON.stringify(res.body)).not.toMatch(/tetriq/i);
  });

  test("template samples carry no customer's brand", () => {
    expect(JSON.stringify(renderer.TOKENS)).not.toMatch(/tetriq/i);
  });
});

describe("settings", () => {
  test("GET /settings/branding returns the company's branding", async () => {
    const res = await api("get", "/settings/branding");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      name: "Acme Company",
      logo_url: null,
      primary_color: DEFAULT_PRIMARY_COLOR,
      accent_color: DEFAULT_ACCENT_COLOR,
    });
  });

  test("company settings save branding, and leaving a field out keeps it", async () => {
    const saved = await api("put", "/settings/company", {
      group_currency: "USD", display_name: "Acme Holdings", primary_color: "#0a3d62", email_sender_name: "Acme Accounts",
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ display_name: "Acme Holdings", primary_color: "#0A3D62" });

    const currencyOnly = await api("put", "/settings/company", { group_currency: "USD" });
    expect(currencyOnly.body.data).toMatchObject({ display_name: "Acme Holdings", email_sender_name: "Acme Accounts" });

    const branding = await api("get", "/settings/branding");
    expect(branding.body.data).toMatchObject({ name: "Acme Holdings", primary_color: "#0A3D62" });

    const cleared = await api("put", "/settings/company", { group_currency: "USD", display_name: "" });
    expect(cleared.body.data.display_name).toBeNull();
  });

  test("invalid branding values are refused", async () => {
    const color = await api("put", "/settings/company", { group_currency: "USD", primary_color: "teal" });
    const logo = await api("put", "/settings/company", { group_currency: "USD", logo_url: "javascript:alert(1)" });
    expect([color.status, logo.status]).toEqual([400, 400]);
    expect([color.body.message, logo.body.message]).toEqual([
      "Primary colour must look like #111827",
      "Logo must be an http(s) URL or an /uploads/ path",
    ]);
  });
});

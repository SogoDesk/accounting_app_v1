// Expense: Dr Expense account [+ Dr Input GST (1400)] / Cr Bank or
// Reimbursements payable [+ Cr TDS payable (2200)].
// One-off expenses are posted through postingService; recurring expenses are
// generated through the routes, which is the only place that logic lives.

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
const api = (method, url, body) =>
  request(app)[method](`/api${url}`).set("Authorization", `Bearer ${token}`).send(body);

// Ids far above anything the routes create: posting is idempotent per id.
const expense = (overrides) => ({
  region_id: co.india,
  expense_date: "2026-03-05",
  currency: "INR",
  gst_amount: 0,
  tds_amount: 0,
  expense_account_code: "5200",
  credit_account_code: "1000",
  created_by: co.userId,
  ...overrides,
});

describe("one-off expense", () => {
  test("paid from the bank, with GST and TDS", async () => {
    const entry = await withTenant(co.tenantId, (db) =>
      posting.postExpense(db, expense({ id: 9401, amount: 1000, gst_amount: 180, tds_amount: 100, description: "Licences" })),
    );
    const lines = await linesOf(entry.id);
    expect(lineSummary(lines)).toEqual([
      ["5200", 1000, 0, 1000, 0],
      ["1400", 180, 0, 180, 0],
      ["1000", 0, 1080, 0, 1080],
      ["2200", 0, 100, 0, 100],
    ]);
    expect(totals(lines)).toEqual({ debitBase: 1180, creditBase: 1180 });
  });

  test("plain expense has only the expense and bank lines", async () => {
    const entry = await withTenant(co.tenantId, (db) =>
      posting.postExpense(db, expense({ id: 9402, amount: 250, description: "Taxi" })),
    );
    expect(lineSummary(await linesOf(entry.id))).toEqual([
      ["5200", 250, 0, 250, 0],
      ["1000", 0, 250, 0, 250],
    ]);
  });

  test("reimbursable expense goes to reimbursements payable, then is paid out", async () => {
    const recorded = await withTenant(co.tenantId, (db) =>
      posting.postExpense(db, expense({ id: 9403, amount: 300, credit_account_code: "2500", description: "Meals" })),
    );
    expect(lineSummary(await linesOf(recorded.id))).toEqual([
      ["5200", 300, 0, 300, 0],
      ["2500", 0, 300, 0, 300],
    ]);

    const reimbursed = await withTenant(co.tenantId, (db) =>
      posting.postExpenseReimbursement(db, {
        id: 9403, entity_id: co.india, currency: "INR", amount: 300, created_by: co.userId, paid_by: "Asha",
      }),
    );
    expect(lineSummary(await linesOf(reimbursed.id))).toEqual([
      ["2500", 300, 0, 300, 0],
      ["1000", 0, 300, 0, 300],
    ]);
    expect(await withTenant(co.tenantId, (db) => accountBalance(db, co.india, "2500"))).toBe(0);
  });

  test("missing account codes are refused", async () => {
    await expect(
      withTenant(co.tenantId, (db) =>
        posting.postExpense(db, expense({ id: 9404, amount: 10, expense_account_code: null })),
      ),
    ).rejects.toThrow(/expense_account_code and credit_account_code required/);
  });
});

describe("recurring expense", () => {
  test("running a month generates and posts the expense once", async () => {
    const template = await api("post", "/expenses/recurring", {
      entity_id: co.india,
      name: "Cloud hosting",
      category_id: co.expenseCategory,
      payment_method_id: co.bankMethod,
      currency: "INR",
      actual_cost: 1200,
      gst_percent: 18,
      tds_percent: 0,
      period_months: 1,
      start_month: "2026-01-01",
    });
    expect(template.status).toBe(201);

    const run = await api("post", "/expenses/recurring/run", { month: "2026-03-01" });
    expect(run.body).toMatchObject({ success: true, created: 1 });

    const generated = await withTenant(co.tenantId, async (db) =>
      (await db.query(
        "SELECT expense_date::text AS expense_date, amount::float8 AS amount, gst_amount::float8 AS gst, gl_entry_id FROM expenses WHERE recurring_id = $1",
        [template.body.data.id],
      )).rows,
    );
    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({ expense_date: "2026-03-01", amount: 1200, gst: 216 });

    expect(lineSummary(await linesOf(generated[0].gl_entry_id))).toEqual([
      ["5200", 1200, 0, 1200, 0],
      ["1400", 216, 0, 216, 0],
      ["1000", 0, 1416, 0, 1416],
    ]);

    const again = await api("post", "/expenses/recurring/run", { month: "2026-03-01" });
    expect(again.body).toMatchObject({ success: true, created: 0 });
  });

  test("a template spread over several months posts a monthly share", async () => {
    const template = await api("post", "/expenses/recurring", {
      entity_id: co.india,
      name: "Annual insurance",
      category_id: co.expenseCategory,
      payment_method_id: co.bankMethod,
      currency: "INR",
      actual_cost: 12000,
      gst_percent: 0,
      tds_percent: 10,
      period_months: 12,
      start_month: "2026-04-01",
    });
    expect(template.status).toBe(201);

    // The monthly "Cloud hosting" template is due in April too.
    const run = await api("post", "/expenses/recurring/run", { month: "2026-04-01" });
    expect(run.body).toMatchObject({ success: true, created: 2 });

    const row = await withTenant(co.tenantId, async (db) =>
      (await db.query("SELECT gl_entry_id FROM expenses WHERE recurring_id = $1", [template.body.data.id])).rows[0],
    );
    expect(lineSummary(await linesOf(row.gl_entry_id))).toEqual([
      ["5200", 1000, 0, 1000, 0],
      ["1000", 0, 900, 0, 900],
      ["2200", 0, 100, 0, 100],
    ]);
  });
});

// The ledger is append-only and hash-chained: each entry's prev_hash is the
// previous entry's entry_hash for the same entity, and the database refuses
// changes to a posted entry (trg_gl_immutable).

const posting = require("../../services/gl/postingService");
const ledger = require("../../services/gl/ledgerEngine");
const { withTenant, entryLines, lineSummary } = require("../helpers/db");
const { seedCompany } = require("../helpers/fixtures");

let co;
beforeAll(async () => {
  co = await seedCompany();
});

const manual = (amount, date, description) => ({
  entityId: co.india,
  entryDate: date,
  description,
  userId: co.userId,
  lines: [
    { accountCode: "5200", debit: amount },
    { accountCode: "1000", credit: amount },
  ],
});

describe("hash chain", () => {
  let entries;

  beforeAll(async () => {
    entries = [];
    for (const [amount, date] of [[100, "2026-02-01"], [250.5, "2026-02-02"], [75.25, "2026-02-03"]]) {
      const posted = await withTenant(co.tenantId, (db) =>
        posting.postManualEntry(db, manual(amount, date, `Manual ${amount}`)),
      );
      entries.push(posted);
    }
  });

  test("each prev_hash equals the previous entry_hash", async () => {
    const rows = await withTenant(co.tenantId, async (db) =>
      (await db.query(
        `SELECT id, entry_no, prev_hash, entry_hash FROM journal_entries
          WHERE entity_id = $1 ORDER BY id`,
        [co.india],
      )).rows,
    );

    expect(rows).toHaveLength(3);
    expect(rows[0].prev_hash).toBe("GENESIS");
    expect(rows[1].prev_hash).toBe(rows[0].entry_hash);
    expect(rows[2].prev_hash).toBe(rows[1].entry_hash);
    for (const row of rows) expect(row.entry_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(rows.map((r) => r.entry_hash)).size).toBe(3);
    expect(rows.map((r) => r.entry_no)).toEqual([
      `JE-${co.india}-000001`,
      `JE-${co.india}-000002`,
      `JE-${co.india}-000003`,
    ]);
    expect(rows.map((r) => r.id)).toEqual(entries.map((e) => e.id));
  });

  test("each entity has its own chain", async () => {
    const other = await withTenant(co.tenantId, (db) =>
      posting.postManualEntry(db, { ...manual(10, "2026-02-04", "US entry"), entityId: co.usa }),
    );
    const row = await withTenant(co.tenantId, async (db) =>
      (await db.query("SELECT prev_hash FROM journal_entries WHERE id = $1", [other.id])).rows[0],
    );
    expect(row.prev_hash).toBe("GENESIS");
  });

  test("lines are stored as posted", async () => {
    const lines = await withTenant(co.tenantId, (db) => entryLines(db, entries[1].id));
    expect(lineSummary(lines)).toEqual([
      ["5200", 250.5, 0, 250.5, 0],
      ["1000", 0, 250.5, 0, 250.5],
    ]);
  });
});

describe("immutability", () => {
  let entryId;
  beforeAll(async () => {
    entryId = (await withTenant(co.tenantId, (db) =>
      posting.postManualEntry(db, manual(40, "2026-02-10", "To be protected")),
    )).id;
  });

  test("changing a posted entry's date is rejected by trg_gl_immutable", async () => {
    await expect(
      withTenant(co.tenantId, (db) =>
        db.query("UPDATE journal_entries SET entry_date = '2026-02-11' WHERE id = $1", [entryId]),
      ),
    ).rejects.toThrow(/immutable/);
  });

  test("changing a posted entry's hash is rejected", async () => {
    await expect(
      withTenant(co.tenantId, (db) =>
        db.query("UPDATE journal_entries SET entry_hash = 'x' WHERE id = $1", [entryId]),
      ),
    ).rejects.toThrow(/immutable/);
  });

  test("deleting a posted entry is rejected", async () => {
    await expect(
      withTenant(co.tenantId, (db) => db.query("DELETE FROM journal_entries WHERE id = $1", [entryId])),
    ).rejects.toThrow(/immutable/);
  });

  test("lines that would unbalance a posted entry are rejected at commit", async () => {
    await expect(
      withTenant(co.tenantId, (db) =>
        db.query("UPDATE journal_lines SET debit_base = debit_base + 1 WHERE entry_id = $1 AND debit_base > 0", [entryId]),
      ),
    ).rejects.toThrow(/unbalanced/);
  });

  test("a reversal posts an opposite entry and marks the original REVERSED", async () => {
    const reversal = await withTenant(co.tenantId, (db) =>
      posting.reverseEntry(db, entryId, "test", co.userId),
    );
    const { original, lines } = await withTenant(co.tenantId, async (db) => ({
      original: (await db.query("SELECT status, reversed_by FROM journal_entries WHERE id = $1", [entryId])).rows[0],
      lines: await entryLines(db, reversal.id),
    }));
    expect(original).toEqual({ status: "REVERSED", reversed_by: reversal.id });
    expect(lineSummary(lines)).toEqual([
      ["5200", 0, 40, 0, 40],
      ["1000", 40, 0, 40, 0],
    ]);
  });
});

describe("posting rules", () => {
  test("an unbalanced entry is refused before anything is written", async () => {
    await expect(
      withTenant(co.tenantId, (db) =>
        ledger.postEntry(
          db,
          { entityId: co.india, locationId: co.locations.india, entryDate: "2026-02-12", userId: co.userId },
          [
            { accountCode: "5200", debit: 10, debitBase: 10, currency: "INR" },
            { accountCode: "1000", credit: 9.99, creditBase: 9.99, currency: "INR" },
          ],
        ),
      ),
    ).rejects.toThrow(/Unbalanced entry/);
  });

  test("a user without access to the location cannot post", async () => {
    const outsider = await withTenant(co.tenantId, async (db) =>
      (await db.query(
        `INSERT INTO users (full_name, email, password_hash, role_id)
         SELECT 'Outsider', 'outsider@books.test', 'x', id FROM roles WHERE role_name = 'FINANCE_ADMIN'
         RETURNING id`,
      )).rows[0].id,
    );
    await expect(
      withTenant(co.tenantId, (db) =>
        posting.postManualEntry(db, { ...manual(5, "2026-02-12", "No access"), userId: outsider }),
      ),
    ).rejects.toThrow(/not authorized to post/);
  });

  test("posting into a closed period is refused", async () => {
    await withTenant(co.tenantId, (db) =>
      db.query("UPDATE accounting_periods SET status = 'CLOSED' WHERE start_date = '2026-01-01'"),
    );
    await expect(
      withTenant(co.tenantId, (db) => posting.postManualEntry(db, manual(5, "2026-01-15", "Closed"))),
    ).rejects.toThrow(/CLOSED/);
  });

  test("the fiscal year is created on demand", async () => {
    await withTenant(co.tenantId, (db) => posting.postManualEntry(db, manual(5, "2027-06-30", "Next year")));
    const periods = await withTenant(co.tenantId, async (db) =>
      (await db.query(
        `SELECT count(*)::int AS n FROM accounting_periods p
           JOIN fiscal_years f ON f.id = p.fiscal_year_id WHERE f.year_label = '2027'`,
      )).rows[0].n,
    );
    expect(periods).toBe(12);
  });
});

// =============================================================================
// ledgerEngine — the single, race-free, integer-precise, hash-chained,
// immutable, location-aware posting core (Blueprint Step 3 / audit §4.2).
//
// Every subledger (AR/AP/expense/intercompany/FX/recognition) posts through
// postEntry(). It:
//   * asserts a location_id (location tagging is mandatory),
//   * checks the caller may POST to that location (user_allowed_locations),
//   * normalizes money to integer minor units and validates Σbase = 0,
//   * requires an OPEN accounting period,
//   * assigns entry_no from a per-entity Postgres sequence (kills COUNT(*)+1 race),
//   * computes entry_hash = sha256(prev_hash || canonical(entry+lines)),
//   * writes both numeric and *_minor columns + custom_fields.
//
// Pass a pg client (`db`) so posting joins the document's transaction.
// =============================================================================

const crypto = require("crypto");
const pool = require("../../config/db");

// integer-minor-unit helper — no floating point reaches a balance check.
const toMinor = (amount, scale = 2) =>
  Math.round((Number(amount || 0) + Number.EPSILON) * 10 ** scale);

// node-postgres returns DATE columns as JS Date; canonical() must produce the
// SAME string whether the date came in as 'YYYY-MM-DD' (post) or a Date
// (verify), or the hash chain will never re-verify.
const dateKey = (v) => {
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  return String(v).slice(0, 10);
};

// Canonical, stable serialization of an entry + its lines. All numeric fields
// are coerced (pg may return bigint as number/string) so post == verify.
const canonical = (entry, lines) =>
  JSON.stringify({
    e: Number(entry.entityId),
    l: Number(entry.locationId),
    d: dateKey(entry.entryDate),
    s: entry.source || "MANUAL",
    r: entry.sourceRef == null ? null : String(entry.sourceRef),
    L: lines.map((x) => [
      Number(x.accountId),
      Number(x.debitMinor),
      Number(x.creditMinor),
      Number(x.baseDebitMinor),
      Number(x.baseCreditMinor),
      Number(x.locationId),
    ]),
  });

// ---- account-code resolution (subledgers build lines by code) --------------
const _accountCache = new Map();
async function accountIdByCode(code, db) {
  if (_accountCache.has(code)) return _accountCache.get(code);
  const { rows } = await db.query(
    "SELECT id FROM chart_of_accounts WHERE account_code = $1 AND is_active = true",
    [code],
  );
  if (!rows.length) throw new Error(`Account code not found: ${code}`);
  _accountCache.set(code, rows[0].id);
  return rows[0].id;
}

async function nextEntryNo(db, entityId) {
  // race-free: one durable sequence per entity, created on demand.
  const seqName = `je_seq_${Number(entityId)}`;
  await db.query(`CREATE SEQUENCE IF NOT EXISTS ${seqName}`);
  const { rows } = await db.query(`SELECT nextval('${seqName}') AS n`);
  return `JE-${entityId}-${String(rows[0].n).padStart(6, "0")}`;
}

async function assertCanPost(db, userId, locationId) {
  // System/service posts (no userId) are trusted; controller-driven posts must
  // carry the request user, who is checked against their granted locations.
  if (userId == null) return;
  const { rows } = await db.query(
    `SELECT 1 FROM user_allowed_locations($1)
      WHERE org_unit_id = $2 AND access IN ('POST','ADMIN') LIMIT 1`,
    [userId, locationId],
  );
  if (!rows.length)
    throw new Error(`User ${userId} not authorized to post to location ${locationId}`);
}

// Ensure an accounting period covers `dateStr`, auto-creating the whole fiscal
// year (12 OPEN monthly periods) on demand. Idempotent, and only ever ADDS
// missing periods — it never touches or reopens an existing (possibly CLOSED)
// period. This removes the "no accounting period covers <date>" failure class,
// including FX-reversal entries that land on Jan 1 of the following year.
async function ensurePeriodCovers(db, dateStr) {
  const year = Number(String(dateStr || "").slice(0, 4));
  if (!Number.isFinite(year) || year < 1900 || year > 9999) return;
  const hit = await db.query(
    `SELECT 1 FROM accounting_periods WHERE $1 BETWEEN start_date AND end_date LIMIT 1`,
    [dateStr],
  );
  if (hit.rows.length) return;
  await db.query(
    `WITH fy AS (
        INSERT INTO fiscal_years (year_label, start_date, end_date, status)
        VALUES ($1::text, make_date($1::int, 1, 1), make_date($1::int, 12, 31), 'OPEN')
        ON CONFLICT (year_label) DO UPDATE SET year_label = EXCLUDED.year_label
        RETURNING id
     )
     INSERT INTO accounting_periods (fiscal_year_id, period_no, period_label, start_date, end_date, status)
     SELECT fy.id, m,
            to_char(make_date($1::int, m, 1), 'Mon YYYY'),
            make_date($1::int, m, 1),
            (make_date($1::int, m, 1) + INTERVAL '1 month - 1 day')::date,
            'OPEN'
     FROM fy, generate_series(1, 12) AS m
     ON CONFLICT (fiscal_year_id, period_no) DO NOTHING`,
    [year],
  );
}

/**
 * Post a balanced, location-tagged, hash-chained ledger entry.
 * @param db    pg client (the document's transaction)
 * @param entry { entityId, locationId, entryDate (YYYY-MM-DD), source, sourceRef, description, userId }
 * @param lines [{ accountCode|accountId, debit?, credit?, currency, exchangeRate?, debitBase?, creditBase?,
 *                 locationId?, memo?, placementId?, clientId?, vendorId?, customFields? }]
 * @returns { id, entryNo, entryHash }
 */
async function postEntry(db, entry, lines) {
  if (!Array.isArray(lines) || lines.length < 2)
    throw new Error("A journal entry needs at least two lines");
  if (!entry.entityId) throw new Error("entityId is required");
  if (!entry.locationId)
    throw new Error("locationId is required (location tagging is mandatory)");
  await assertCanPost(db, entry.userId, entry.locationId);

  // resolve account ids + normalize to integer minor units
  const L = [];
  for (const x of lines) {
    const accountId = x.accountId || (await accountIdByCode(x.accountCode, db));
    L.push({
      accountId,
      locationId: x.locationId || entry.locationId,
      currency: x.currency,
      exchangeRate: x.exchangeRate || 1,
      debitMinor: toMinor(x.debit),
      creditMinor: toMinor(x.credit),
      baseDebitMinor: toMinor(x.debitBase),
      baseCreditMinor: toMinor(x.creditBase),
      memo: x.memo || null,
      placementId: x.placementId || null,
      clientId: x.clientId || null,
      vendorId: x.vendorId || null,
      customFields: x.customFields || {},
    });
  }

  // validate balance in functional (base) currency using integer minor units
  const sumBase = L.reduce((s, x) => s + x.baseDebitMinor - x.baseCreditMinor, 0);
  if (sumBase !== 0)
    throw new Error(`Unbalanced entry: functional debits ≠ credits by ${sumBase} minor units`);

  // Auto-provision the covering fiscal year on demand so postings never fail at
  // year boundaries (the seed only creates the current year). Only creates when
  // no period exists — never reopens an intentionally CLOSED period.
  await ensurePeriodCovers(db, entry.entryDate);

  // period must be open
  const period = await db.query(
    `SELECT id, status FROM accounting_periods
      WHERE $1 BETWEEN start_date AND end_date ORDER BY id LIMIT 1`,
    [entry.entryDate],
  );
  if (!period.rows.length)
    throw new Error(`No accounting period covers ${entry.entryDate}`);
  if (period.rows[0].status !== "OPEN")
    throw new Error(`Period for ${entry.entryDate} is CLOSED`);

  // Serialize hash-chain construction per entity. Without this, two concurrent
  // posts read the same prev_hash and fork the chain, breaking the tamper-evident
  // links. The lock is transaction-scoped (released on COMMIT/ROLLBACK) and
  // namespaced by a constant classid to avoid collisions.
  await db.query(`SELECT pg_advisory_xact_lock($1, $2)`, [827413, Number(entry.entityId)]);

  // hash chain: link to the entity's previous entry
  const prev = await db.query(
    `SELECT entry_hash FROM journal_entries
      WHERE entity_id = $1 AND entry_hash IS NOT NULL ORDER BY id DESC LIMIT 1`,
    [entry.entityId],
  );
  const prevHash = (prev.rows[0] && prev.rows[0].entry_hash) || "GENESIS";
  const entryHash = crypto
    .createHash("sha256")
    .update(prevHash + canonical(entry, L))
    .digest("hex");
  const entryNo = await nextEntryNo(db, entry.entityId);

  const hdr = await db.query(
    `INSERT INTO journal_entries
       (entry_no, entity_id, location_id, entry_date, period_id, description, source, source_ref,
        status, created_by, posted_at, prev_hash, entry_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'POSTED',$9, now(), $10, $11) RETURNING id`,
    [
      entryNo, entry.entityId, entry.locationId, entry.entryDate, period.rows[0].id,
      entry.description || null, entry.source || "MANUAL",
      entry.sourceRef == null ? null : String(entry.sourceRef),
      entry.userId || null, prevHash, entryHash,
    ],
  );
  const entryId = hdr.rows[0].id;

  for (const x of L) {
    await db.query(
      `INSERT INTO journal_lines
         (entry_id, account_id, entity_id, location_id, currency, debit, credit, exchange_rate,
          debit_base, credit_base, debit_minor, credit_minor, base_minor_debit, base_minor_credit,
          custom_fields, memo, placement_id, client_id, vendor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        entryId, x.accountId, entry.entityId, x.locationId, x.currency,
        x.debitMinor / 100, x.creditMinor / 100, x.exchangeRate,
        x.baseDebitMinor / 100, x.baseCreditMinor / 100,
        x.debitMinor, x.creditMinor, x.baseDebitMinor, x.baseCreditMinor,
        x.customFields, x.memo, x.placementId, x.clientId, x.vendorId,
      ],
    );
  }
  return { id: entryId, entryNo, entryHash };
}

module.exports = { postEntry, toMinor, accountIdByCode };

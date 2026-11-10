// =============================================================================
// intercompanyService — paired inter-branch / inter-company transfers
//                       (Blueprint Step 4 / audit §3.2)
//
// A transfer from location A to location B posts TWO balanced journal entries
// inside one transaction, sharing a transfer_no:
//   from-side:  Dr 1600 Intercompany Receivable (Due From) / Cr 1000 Bank
//   to-side:    Dr 1000 Bank / Cr 2600 Intercompany Payable (Due To)
// Each side is tagged with its own location_id and its owning entity, and the
// pair is recorded in intercompany_transfers linking both entry ids. On
// consolidation, 1600/2600 net to ~0 and are eliminated (see glReports).
// =============================================================================

const pool = require("../../config/db");
const ledger = require("./ledgerEngine");
const currency = require("../currency/currencyService");

// node-postgres returns DATE as a JS Date; normalize to a YYYY-MM-DD key.
const dateKey = (v) => {
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  return String(v).slice(0, 10);
};

// The owning legal entity's region id for an org-unit location.
async function entityRegionForLocation(db, locationId) {
  const { rows } = await db.query(
    `SELECT e.region_id FROM org_units e WHERE e.id = owning_entity_id($1)`,
    [locationId],
  );
  if (!rows.length || rows[0].region_id == null)
    throw new Error(`No owning legal entity (region) for location ${locationId}`);
  return rows[0].region_id;
}

async function nextTransferNo(db) {
  await db.query("CREATE SEQUENCE IF NOT EXISTS intercompany_transfer_seq");
  const { rows } = await db.query("SELECT nextval('intercompany_transfer_seq') AS n");
  const year = new Date().getFullYear();
  return `ICT-${year}-${String(rows[0].n).padStart(6, "0")}`;
}

/**
 * Post a balanced intercompany transfer between two locations.
 * @param params { fromLocationId, toLocationId, amount, currency, date, memo, userId }
 * @returns { transferNo, fromEntryId, toEntryId, id }
 */
async function postTransfer(params) {
  const { fromLocationId, toLocationId, amount, currency: ccy, date, memo, userId } = params;
  if (!fromLocationId || !toLocationId)
    throw new Error("fromLocationId and toLocationId are required");
  if (Number(fromLocationId) === Number(toLocationId))
    throw new Error("from and to locations must differ");
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error("amount must be > 0");
  if (!ccy) throw new Error("currency is required");
  const d = dateKey(date || new Date());

  const db = await pool.connect();
  try {
    await db.query("BEGIN");

    const fromEntity = await entityRegionForLocation(db, fromLocationId);
    const toEntity = await entityRegionForLocation(db, toLocationId);

    // Translate the transfer amount into each entity's functional currency.
    const fromFx = await currency.toFunctional(amt, ccy, fromEntity, d, db);
    const toFx = await currency.toFunctional(amt, ccy, toEntity, d, db);

    const transferNo = await nextTransferNo(db);

    // from-side: Dr Due From (1600) / Cr Bank (1000)
    const fromEntry = await ledger.postEntry(
      db,
      {
        entityId: fromEntity, locationId: Number(fromLocationId), entryDate: d,
        source: "INTERCOMPANY", sourceRef: transferNo,
        description: `Intercompany transfer ${transferNo} (out)${memo ? ": " + memo : ""}`,
        userId,
      },
      [
        { accountCode: "1600", debit: amt, debitBase: fromFx.amountBase, currency: ccy, exchangeRate: fromFx.exchangeRate, memo: "Due from related entity" },
        { accountCode: "1000", credit: amt, creditBase: fromFx.amountBase, currency: ccy, exchangeRate: fromFx.exchangeRate, memo: "Bank — transfer out" },
      ],
    );

    // to-side: Dr Bank (1000) / Cr Due To (2600)
    const toEntry = await ledger.postEntry(
      db,
      {
        entityId: toEntity, locationId: Number(toLocationId), entryDate: d,
        source: "INTERCOMPANY", sourceRef: transferNo,
        description: `Intercompany transfer ${transferNo} (in)${memo ? ": " + memo : ""}`,
        userId,
      },
      [
        { accountCode: "1000", debit: amt, debitBase: toFx.amountBase, currency: ccy, exchangeRate: toFx.exchangeRate, memo: "Bank — transfer in" },
        { accountCode: "2600", credit: amt, creditBase: toFx.amountBase, currency: ccy, exchangeRate: toFx.exchangeRate, memo: "Due to related entity" },
      ],
    );

    const { rows } = await db.query(
      `INSERT INTO intercompany_transfers
         (transfer_no, from_location, to_location, amount, currency, transfer_date, memo,
          from_entry_id, to_entry_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [transferNo, Number(fromLocationId), Number(toLocationId), amt, ccy, d, memo || null,
       fromEntry.id, toEntry.id, userId || null],
    );

    await db.query("COMMIT");
    return { id: rows[0].id, transferNo, fromEntryId: fromEntry.id, toEntryId: toEntry.id };
  } catch (e) {
    try { await db.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally {
    db.release();
  }
}

/** List transfers, optionally restricted to a set of allowed location ids. */
async function listTransfers({ allowedLocationIds } = {}, db = pool) {
  const params = [];
  let where = "";
  if (Array.isArray(allowedLocationIds)) {
    params.push(allowedLocationIds);
    where = `WHERE t.from_location = ANY($1) OR t.to_location = ANY($1)`;
  }
  const { rows } = await db.query(
    `SELECT t.*, fo.name AS from_location_name, tou.name AS to_location_name
       FROM intercompany_transfers t
       LEFT JOIN org_units fo  ON fo.id = t.from_location
       LEFT JOIN org_units tou ON tou.id = t.to_location
       ${where}
      ORDER BY t.id DESC`,
    params,
  );
  return rows;
}

module.exports = { postTransfer, listTransfers };

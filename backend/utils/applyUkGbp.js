// =============================================================================
// applyUkGbp.js — switch TetriQ-UK (region id 2) to a GBP book currency, using
// LIVE FX rates (no manual rate).
//
//   Run:  cd backend && node utils/applyUkGbp.js
//
// Order matters:
//   1) Fetch live rates for USD/GBP/INR/EUR FIRST (via rateService, which uses
//      the configured API key, else the keyless fallback). This guarantees a
//      USD->GBP rate exists before the flip, so a USD invoice under UK can always
//      convert. Fails loudly (nothing changes) if rates can't be fetched.
//   2) In one transaction: set regions.functional_currency='GBP' for UK (keeps
//      default_currency='USD' so income still defaults to USD and converts to
//      GBP), and set currency='GBP' on every UK vendor (consultants paid in GBP).
//   3) Read-only verify: show how 1000 USD income would book in GBP (no GL write).
//
// Idempotent + safe: guards that region 2 is really the UK; region/vendor updates
// touch 0 rows once already GBP.
// =============================================================================

require("dotenv").config();
const pool = require("../config/db");
const rateService = require("../services/currency/rateService");
const currency = require("../services/currency/currencyService");

const UK_ID = Number(process.env.UK_REGION_ID || 2);
// Force GBP into the fetch set even though UK isn't GBP yet (it becomes GBP in
// step 2); the daily cron picks it up automatically thereafter.
const SEED_CCYS = ["USD", "GBP", "INR", "EUR"];

(async () => {
  const db = await pool.connect();
  try {
    const region = (await db.query(
      "SELECT id, region_name, default_currency, functional_currency FROM regions WHERE id=$1", [UK_ID])).rows[0];
    if (!region) throw new Error(`Region ${UK_ID} not found`);
    if (!/uk|united kingdom|britain/i.test(region.region_name)) {
      throw new Error(`Region ${UK_ID} is "${region.region_name}", not the UK — refusing to proceed`);
    }

    // 1) Live rates first — nothing is flipped if this fails.
    const n = await rateService.fetchDailyRates(SEED_CCYS, db);
    console.log(`Fetched ${n} live rates for ${SEED_CCYS.join(", ")}.`);

    // 2) Flip UK books to GBP + set UK vendors to GBP, atomically.
    await db.query("BEGIN");
    const r1 = await db.query(
      `UPDATE regions SET functional_currency='GBP'
        WHERE id=$1 AND functional_currency IS DISTINCT FROM 'GBP'
        RETURNING id, region_name, default_currency, functional_currency`, [UK_ID]);
    const r2 = await db.query(
      `UPDATE vendors SET currency='GBP'
        WHERE region_id=$1 AND currency <> 'GBP'
        RETURNING id, vendor_code, vendor_name, currency`, [UK_ID]);
    await db.query("COMMIT");

    // 3) Read-only proof the conversion resolves via the live rate.
    const sample = await currency.toFunctional(1000, "USD", UK_ID, null, db);

    console.log("Region -> GBP:", r1.rows.length ? r1.rows[0] : "(already GBP, 0 rows)");
    console.log("Vendors -> GBP:", r2.rowCount, "updated:", r2.rows);
    console.log(`Verify: 1000 USD income under UK books as ${sample.amountBase} ${sample.functionalCurrency} @ ${sample.exchangeRate}`);
    console.log("Done.");
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    console.error("FAILED (nothing committed):", e.message);
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
})();

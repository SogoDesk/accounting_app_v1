// =============================================================================
// rateService — fetch daily FX rates + manual overrides
//
// - fetchDailyRates() pulls rates from exchangerate-api.com (v6) and upserts one
//   row per pair into exchange_rates with source = 'API'.
// - setManualRate() lets a finance user pin/correct a rate; source = 'MANUAL',
//   which currencyService prefers over API for the same (from, to, date).
//
// Requires Node 18+ (global fetch). Run fetchDailyRates() from a daily cron /
// scheduled job. Pairs are kept against every functional currency + the group
// currency so both per-entity and consolidated (USD) reporting can resolve.
// =============================================================================

const pool = require("../../config/db");

// Fallback set if the DB can't be read. Normally the live currency set is
// derived from the data (group currency + every region's functional currency)
// by currenciesInUse(), so adding a new region's currency needs no code change.
const CURRENCIES = ["USD", "GBP", "INR", "EUR"];

// The currencies that actually need rates: the group/reporting currency plus
// every functional currency in use across regions. Deriving this from the data
// prevents the "added a region but forgot to fetch its rate" gap.
async function currenciesInUse(db = pool) {
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT code FROM (
         SELECT group_currency AS code FROM company_settings WHERE id = 1
         UNION ALL
         SELECT COALESCE(functional_currency, default_currency) AS code FROM regions
       ) s WHERE code IS NOT NULL AND code <> ''`,
    );
    const set = [...new Set(rows.map((r) => normalizeCode(r.code)).filter(Boolean))];
    return set.length ? set : CURRENCIES;
  } catch {
    return CURRENCIES;
  }
}
// Providers, in order of preference:
//  1. exchangerate-api.com (v6) when EXCHANGE_RATE_API_KEY is set — key in the
//     URL path, response has a `conversion_rates` map.
//  2. open.er-api.com (v6) keyless fallback when no key is configured — same
//     /latest/<base> shape but a `rates` map and no key in the path.
// Both return `result: "success"`. Keeping a keyless default means live rates
// work out of the box in production without a key to expire, leak, or rate-limit.
const RATE_API = process.env.EXCHANGE_RATE_API_URL || "https://v6.exchangerate-api.com/v6";
const RATE_API_KEY = process.env.EXCHANGE_RATE_API_KEY || "";
const KEYLESS_RATE_API = process.env.KEYLESS_EXCHANGE_RATE_API_URL || "https://open.er-api.com/v6";
const rateUrl = (base) =>
  RATE_API_KEY ? `${RATE_API}/${RATE_API_KEY}/latest/${base}` : `${KEYLESS_RATE_API}/latest/${base}`;

const normalizeCode = (c) => String(c || "").trim().toUpperCase();

/**
 * Fetch latest rates for every ordered pair of CURRENCIES and upsert them
 * for today's date with source = 'API'. Returns the number of rows written.
 */
async function fetchDailyRates(currencies = null, db = pool) {
  if (typeof fetch !== "function") {
    throw new Error("global fetch unavailable — Node 18+ required");
  }

  const list = currencies && currencies.length ? currencies : await currenciesInUse(db);
  const today = new Date().toISOString().slice(0, 10);
  const provider = RATE_API_KEY ? "exchangerate-api.com" : "open.er-api.com (keyless)";
  let written = 0;

  for (const base of list) {
    const res = await fetch(rateUrl(base));
    if (!res.ok) {
      console.error(`rateService: ${base} fetch failed (${res.status})`);
      continue;
    }
    const data = await res.json();
    // Both providers signal errors with result:"error" + error-type.
    if (data.result !== "success") {
      throw new Error(
        `rateService: API error for base ${base} via ${provider}: ${data["error-type"] || "unknown"}`,
      );
    }
    // exchangerate-api.com uses `conversion_rates`; open.er-api.com uses `rates`.
    const rates = data.conversion_rates || data.rates || {};

    for (const to of list) {
      if (to === base) continue;
      const rate = Number(rates[to]);
      if (!Number.isFinite(rate) || rate <= 0) continue;
      await upsertRate(base, to, rate, today, "API", db);
      written += 1;
    }
  }

  // Fail loudly instead of silently writing nothing (the old behaviour when the
  // keyless endpoint returned no rates) so the cron/job surfaces the problem.
  if (written === 0) {
    throw new Error(
      "rateService: no FX rates written — check EXCHANGE_RATE_API_KEY and the provider response shape",
    );
  }

  console.log(`rateService: wrote ${written} API rates for ${today}`);
  return written;
}

/**
 * Insert or update a manual rate for a specific date. Manual rows are preferred
 * by currencyService over API rows for the same key.
 */
async function setManualRate(from, to, rate, date, db = pool) {
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) {
    throw new Error("setManualRate: rate must be a positive number");
  }
  const day = (date ? new Date(date) : new Date()).toISOString().slice(0, 10);
  return upsertRate(from, to, r, day, "MANUAL", db);
}

async function upsertRate(from, to, rate, rateDate, source, db = pool) {
  await db.query(
    `INSERT INTO exchange_rates (from_currency, to_currency, rate, rate_date, source)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (from_currency, to_currency, rate_date, source)
     DO UPDATE SET rate = EXCLUDED.rate, created_at = CURRENT_TIMESTAMP`,
    [normalizeCode(from), normalizeCode(to), rate, rateDate, source],
  );
}

module.exports = { fetchDailyRates, setManualRate, CURRENCIES };

// --- Run directly for a one-off / cron invocation: `node rateService.js` -----
if (require.main === module) {
  fetchDailyRates()
    .then((n) => {
      console.log(`Done. ${n} rates upserted.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("rateService failed:", err.message);
      process.exit(1);
    });
}

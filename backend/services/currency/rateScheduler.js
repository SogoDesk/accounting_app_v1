// =============================================================================
// rateScheduler — daily FX rate refresh
//
// Opt-in background timer that calls rateService.fetchDailyRates() once per
// calendar day so currency conversion stays current. Mirrors closeScheduler:
// OFF by default (no surprise external calls); enable with FX_RATE_SCHEDULER=on.
// server.js calls start(), which no-ops unless enabled.
//
// Needs a rate provider configured (EXCHANGE_RATE_API_KEY, else the keyless
// fallback in rateService). On boot it refreshes immediately unless today's
// rates already exist, so frequent restarts don't waste API calls. A failed
// fetch is logged and retried on the next hourly tick.
// =============================================================================

const pool = require("../../config/db");
const rateService = require("./rateService");

let timer = null;

function start() {
  if (String(process.env.FX_RATE_SCHEDULER || "").toLowerCase() !== "on") return;
  const HOUR_MS = 60 * 60 * 1000;
  let lastRunDay = null;

  const runIfDue = async () => {
    const dayKey = new Date().toISOString().slice(0, 10);
    if (lastRunDay === dayKey) return;

    // Skip when today's rates are already stored (avoids redundant provider
    // calls across restarts); mark the day done without fetching.
    try {
      const { rows } = await pool.query(
        "SELECT 1 FROM exchange_rates WHERE rate_date = $1 LIMIT 1", [dayKey]);
      if (rows.length) { lastRunDay = dayKey; return; }
    } catch (err) {
      console.error("[rateScheduler] rate check failed:", err.message);
    }

    try {
      const n = await rateService.fetchDailyRates();
      lastRunDay = dayKey;
      console.log(`[rateScheduler] fetched ${n} FX rates for ${dayKey}`);
    } catch (err) {
      // Leave lastRunDay unset so the next tick retries later today.
      console.error("[rateScheduler] fetch failed:", err.message);
    }
  };

  runIfDue();
  timer = setInterval(runIfDue, HOUR_MS);
  if (timer.unref) timer.unref();
  console.log("[rateScheduler] enabled (daily FX refresh)");
}

function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { start, stop };

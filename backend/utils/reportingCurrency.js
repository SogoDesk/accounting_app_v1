// Reporting-currency consolidation for cross-entity KPI/list totals.
//
// The app runs multiple regions, each with its own functional currency, so any
// figure that spans regions (dashboard + list-page KPI cards) must be translated
// to ONE reporting currency before summing — never SUM raw native amounts.
//
// This lifts the proven pattern already used by the Expenses and GL-report
// controllers into a shared helper:
//   - reporting currency = the selected region's functional currency when a
//     single region is in scope (native books), otherwise the company-wide
//     `company_settings.group_currency` (configurable; defaults USD), with an
//     optional per-request `?reportingCurrency` override.
//   - conversion pivots through USD via fx.rateToUsd, which uses stored
//     exchange_rates and degrades to a static fallback so a missing rate yields
//     an approximate total instead of failing the whole request.
const pool = require("../config/db");
const { rateToUsd } = require("./fx");

// Company-wide reporting currency (configurable in Settings), USD if unset.
const groupCurrency = async (db = pool) => {
  try {
    const { rows } = await db.query("SELECT group_currency FROM company_settings WHERE id = 1");
    return String(rows[0]?.group_currency || "USD").toUpperCase();
  } catch (_) {
    return "USD";
  }
};

// The reporting currency for one request. A single selected entity reports in
// its own functional currency (its books never need conversion); consolidated
// views report in the company group currency, overridable via ?reportingCurrency.
const reportingCurrencyFor = async (req, db = pool) => {
  const entityId = req?.query?.entityId || req?.query?.region_id;
  if (entityId) {
    const { rows } = await db.query(
      "SELECT default_currency, functional_currency FROM regions WHERE id = $1",
      [Number(entityId)]
    );
    const r = rows[0];
    if (r) return String(r.functional_currency || r.default_currency || "USD").toUpperCase();
  }
  if (req?.query?.reportingCurrency) return String(req.query.reportingCurrency).toUpperCase();
  return groupCurrency(db);
};

// Returns an async convert(amount, fromCurrency) => amount-in-`reportingCcy`.
// USD rates are memoised per currency, so the whole list costs one rate lookup
// per distinct currency. Never throws.
const makeConverter = async (reportingCcy, db = pool) => {
  const to = String(reportingCcy || "USD").toUpperCase();
  const usdCache = new Map(); // currency code -> USD-per-unit rate
  const usdRate = async (code) => {
    if (usdCache.has(code)) return usdCache.get(code);
    const v = await rateToUsd(code, db);
    usdCache.set(code, v);
    return v;
  };
  const toUsd = await usdRate(to);
  return async (amount, from) => {
    const a = Number(amount) || 0;
    const f = String(from || to).toUpperCase();
    if (a === 0 || f === to) return a;
    const fromUsd = await usdRate(f);
    return toUsd ? Math.round(((a * fromUsd) / toUsd) * 100) / 100 : a;
  };
};

// Returns an async rate(fromCurrency) => group-per-native factor, for callers
// that must convert a value they compute themselves (e.g. a derived revenue/cost)
// rather than a stored column. Same USD-pivot + memoisation as makeConverter.
const makeRateResolver = async (reportingCcy, db = pool) => {
  const to = String(reportingCcy || "USD").toUpperCase();
  const usdCache = new Map();
  const usdRate = async (code) => {
    if (usdCache.has(code)) return usdCache.get(code);
    const v = await rateToUsd(code, db);
    usdCache.set(code, v);
    return v;
  };
  const toUsd = await usdRate(to);
  return async (from) => {
    const f = String(from || to).toUpperCase();
    if (f === to) return 1;
    const fromUsd = await usdRate(f);
    return toUsd ? fromUsd / toUsd : 1;
  };
};

// Returns an async convert(amount, fromCurrency, toCurrency) for arbitrary
// target currencies — used when one pass must fold amounts into several targets
// (e.g. a consolidated group total AND per-region native/book-currency totals).
// USD rates are memoised across every currency touched, so the whole fold costs
// one lookup per distinct currency. Never throws.
const makeMultiConverter = async (db = pool) => {
  const usdCache = new Map(); // currency code -> USD-per-unit rate
  const usdRate = async (code) => {
    const c = String(code || "USD").toUpperCase();
    if (usdCache.has(c)) return usdCache.get(c);
    const v = await rateToUsd(c, db);
    usdCache.set(c, v);
    return v;
  };
  return async (amount, from, to) => {
    const a = Number(amount) || 0;
    const f = String(from || to || "USD").toUpperCase();
    const t = String(to || "USD").toUpperCase();
    if (a === 0 || f === t) return a;
    const [fu, tu] = [await usdRate(f), await usdRate(t)];
    return tu ? Math.round(((a * fu) / tu) * 100) / 100 : a;
  };
};

// Convenience: enrich each row with reporting-currency copies of the given
// numeric fields. `fieldMap` maps sourceField -> targetField; the source is read
// in the row's own `currencyField` (default "currency").
const attachReportingFields = async (rows, fieldMap, { db = pool, reportingCcy, currencyField = "currency" } = {}) => {
  const convert = await makeConverter(reportingCcy, db);
  for (const row of rows) {
    const from = row[currencyField];
    for (const [src, target] of Object.entries(fieldMap)) {
      row[target] = await convert(row[src], from);
    }
  }
  return rows;
};

module.exports = { groupCurrency, reportingCurrencyFor, makeConverter, makeMultiConverter, makeRateResolver, attachReportingFields };

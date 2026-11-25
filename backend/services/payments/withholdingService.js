// TDS (tax withheld by the customer at source). Only regions configured for it
// (India) withhold; elsewhere any TDS in the request is ignored, so a stale
// client cannot withhold for a region that does not use TDS.

const { hasColumn } = require("../../utils/codeGenerator");

const toMoney = (value) => {
  const num = Number(value || 0);
  return Number.isNaN(num) ? 0 : num;
};

// TDS is a percentage of the invoice's subtotal (before tax), rounded to cents.
const calculateTdsAmount = (invoice, tdsApplicable, tdsPercent) => {
  if (!tdsApplicable) return 0;
  const percent = toMoney(tdsPercent);
  if (percent <= 0) return 0;
  return Number(((toMoney(invoice.subtotal) * percent) / 100).toFixed(2));
};

// What actually applies: TDS only when the region uses it AND the caller said
// it was withheld; the percentage only when TDS applies.
//   regionApplies — the region's tds_applicable
//   selected      — the caller's answer, already turned into a boolean
const resolveTds = ({ regionApplies, selected, percent }) => {
  const applicable = Boolean(regionApplies && selected);
  return { applicable, percent: applicable ? toMoney(percent) : 0 };
};

// Whether a region withholds TDS. Without the column (before its migration)
// the answer is TRUE: asking about TDS when it does not apply is harmless,
// while defaulting to FALSE would silently stop capturing it in India.
let _regionTdsColumn = null;
const regionTdsColumnExists = async (db) => {
  if (_regionTdsColumn === null) _regionTdsColumn = await hasColumn(db, "regions", "tds_applicable");
  return _regionTdsColumn;
};

const getRegionTdsApplicable = async (db, regionId) => {
  if (!(await regionTdsColumnExists(db))) return true;
  if (!regionId) return false;
  const result = await db.query(
    `SELECT tds_applicable FROM regions WHERE id = $1 LIMIT 1`,
    [regionId],
  );
  return result.rows[0]?.tds_applicable === true;
};

// SELECT-list item exposing the region's flag as region_tds_applicable.
const regionTdsSelect = async (db, alias = "r") =>
  (await regionTdsColumnExists(db))
    ? `${alias}.tds_applicable AS region_tds_applicable`
    : "TRUE::boolean AS region_tds_applicable";

module.exports = { calculateTdsAmount, resolveTds, getRegionTdsApplicable, regionTdsSelect };

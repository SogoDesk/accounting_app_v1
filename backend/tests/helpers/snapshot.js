// Make HTTP response bodies stable enough to snapshot: wall-clock timestamps
// and values derived from today's date are replaced with placeholders. Ids,
// amounts, dates on the documents and field names are kept, so any change to
// the shape or content of a response shows up as a snapshot diff.

const VOLATILE_KEY = /(^|_)(created|updated|sent|posted|approved|queued|last_login|uploaded|generated)_at$|At$/;
const TODAY_KEYS = new Set(["days_overdue", "days_past_due", "age_days", "aging_days", "today"]);
// Generated document numbers carry the current year: INV-2026-000001.
const YEAR_IN_NUMBER = new RegExp(`\\b([A-Z]+)-${new Date().getFullYear()}-(\\d+)\\b`, "g");

const maskYear = (text) => text.replace(YEAR_IN_NUMBER, "$1-<year>-$2");

function stable(value, key = "") {
  if (Array.isArray(value)) return value.map((v) => stable(v));
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value)) out[k] = stable(value[k], k);
    return out;
  }
  if (value != null && VOLATILE_KEY.test(key)) return "<timestamp>";
  if (value != null && TODAY_KEYS.has(key)) return "<relative-to-today>";
  if (key === "token") return "<token>";
  if (typeof value === "string") return maskYear(value);
  return value;
}

module.exports = { stable, maskYear };

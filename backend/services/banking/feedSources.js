// =============================================================================
// Bank feed sources — the pluggable adapter layer.
//
// A FILE source turns uploaded statement content (CSV/OFX) into normalized
// transaction lines. A LIVE source would pull from an aggregator API on a
// schedule. The import pipeline (importService) and reconciliation consume the
// same normalized line shape, so dropping in a live aggregator later (Plaid,
// Salt Edge, an India Account Aggregator) requires only implementing fetch()
// here — no changes downstream.
// =============================================================================

const { parseCsv, parseOfx } = require("./parsers");

const sources = {
  CSV: {
    kind: "FILE",
    parse: (content, opts = {}) => parseCsv(content, opts.mapping || {}),
  },
  OFX: {
    kind: "FILE",
    parse: (content) => parseOfx(content),
  },

  // --- Live aggregator adapters (pluggable; not yet configured) -------------
  // To enable: implement fetch({ bankAccount, since }) to return normalized
  // lines [{ txnDate, valueDate, description, reference, amount, externalId,
  // runningBalance }] from the provider, wire credentials via env, and expose a
  // scheduled job that calls importService.importStatement with these lines.
  PLAID: {
    kind: "LIVE",
    fetch: async () => {
      throw new Error("Plaid live feed is not configured. Implement fetch() and supply PLAID credentials to enable.");
    },
  },
  SALTEDGE: {
    kind: "LIVE",
    fetch: async () => {
      throw new Error("Salt Edge live feed is not configured. Implement fetch() and supply SALTEDGE credentials to enable.");
    },
  },
};

function getSource(key) {
  const src = sources[String(key || "").toUpperCase()];
  if (!src) throw new Error(`Unknown bank feed source: ${key}`);
  return src;
}

// Guess the file source from filename/content for uploaded statements.
function detectFileSource(filename, content) {
  const f = String(filename || "").toLowerCase();
  if (f.endsWith(".ofx") || f.endsWith(".qfx") || /<OFX>/i.test(String(content).slice(0, 2000))) {
    return "OFX";
  }
  return "CSV";
}

module.exports = { getSource, detectFileSource, sources };

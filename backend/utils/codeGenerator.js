const sanitizeAlphaNumeric = (value = "") => {
  return String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
};

const padNumber = (value, length = 4) => {
  return String(value).padStart(length, "0");
};

const currentYear = () => new Date().getFullYear();

const hasColumn = async (pool, tableName, columnName) => {
  const result = await pool.query(
    `
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
    ) AS exists
    `,
    [tableName, columnName],
  );

  return Boolean(result.rows[0]?.exists);
};

// Name-prefixed codes (e.g. ACME-0001). Start from the current MAX suffix for
// this prefix instead of scanning from 1 — O(1) instead of O(n) per call and
// O(n^2) growth. The trailing loop + UNIQUE constraint remain the correctness
// backstop for the (now tiny) race window on low-volume manual creation.
// tableName/columnName come only from internal callers (never user input).
const getUniqueCode = async (
  db,
  tableName,
  columnName,
  prefix,
  digits = 4,
) => {
  const maxRes = await db.query(
    `SELECT COALESCE(MAX(substring(${columnName} from '([0-9]+)$')::int), 0) AS mx
       FROM ${tableName} WHERE ${columnName} LIKE $1`,
    [`${prefix}%`],
  );
  let attempt = Number(maxRes.rows[0].mx) + 1;

  while (attempt < 1000000) {
    const code = `${prefix}${padNumber(attempt, digits)}`;

    const existing = await db.query(
      `SELECT id FROM ${tableName} WHERE ${columnName} = $1 LIMIT 1`,
      [code],
    );

    if (!existing.rows.length) {
      return code;
    }

    attempt += 1;
  }

  throw new Error(
    `Unable to generate unique code for ${tableName}.${columnName}`,
  );
};

// Optional per-scope override configured in Settings → Numbering. Returns null
// when there is no config (table absent or no row) so callers fall back to the
// hardcoded defaults and behaviour is unchanged. Wrapped in try/catch because
// this runs on document creation and must never break issuance.
const numberingConfig = async (db, scope) => {
  try {
    const { rows } = await db.query(
      `SELECT prefix, padding, include_year FROM document_numbering_config WHERE doc_type = $1`,
      [scope],
    );
    return rows[0] || null;
  } catch (_e) {
    return null;
  }
};

// Race-free monotonic document numbers via an on-demand per-(scope,year)
// Postgres sequence (same pattern as the ledger's je_seq_<entity>). nextval is
// atomic under concurrency — no SELECT...+1 race. Sequences are non-
// transactional, so a rolled-back document leaves a numbering gap, which is
// acceptable for document identifiers. Migration 009 seeds each sequence from
// the current max so numbering continues unbroken from existing data.
//   scope: a constant token (e.g. 'invoice'); prefix: the human prefix ('INV').
// A Settings → Numbering override (prefix/padding/include_year) takes precedence
// over the passed defaults when one exists for this scope.
const nextDocNumber = async (db, scope, prefix, digits = 6) => {
  const cfg = await numberingConfig(db, scope);
  const usePrefix = cfg?.prefix || prefix;
  const usePad = cfg?.padding || digits;
  const withYear = cfg ? cfg.include_year : true;
  const year = currentYear();
  // Keep the year in the sequence key only when the number embeds the year, so
  // year-less numbering stays continuous instead of resetting (and colliding).
  const seq = withYear ? `doc_seq_${scope}_${year}` : `doc_seq_${scope}_all`;
  await db.query(`CREATE SEQUENCE IF NOT EXISTS ${seq}`);
  const { rows } = await db.query(`SELECT nextval('${seq}') AS n`);
  return withYear
    ? `${usePrefix}-${year}-${padNumber(rows[0].n, usePad)}`
    : `${usePrefix}-${padNumber(rows[0].n, usePad)}`;
};

const generateRegionCodeBase = (regionName = "") => {
  const cleaned = sanitizeAlphaNumeric(regionName);

  if (!cleaned) return "REG";
  if (cleaned.length >= 3) return cleaned.slice(0, 3);
  if (cleaned.length === 2) return `${cleaned}R`;
  return `${cleaned}EG`;
};

const generateClientCodeBase = (clientName = "") => {
  const cleaned = sanitizeAlphaNumeric(clientName);

  if (!cleaned) return "CLI";
  if (cleaned.length >= 3) return cleaned.slice(0, 3);
  if (cleaned.length === 2) return `${cleaned}C`;
  return `${cleaned}LI`;
};

const generateVendorCodeBase = (vendorName = "") => {
  const cleaned = sanitizeAlphaNumeric(vendorName);
  if (!cleaned) return "VEN";
  if (cleaned.length >= 3) return cleaned.slice(0, 3);
  if (cleaned.length === 2) return `${cleaned}V`;
  return `${cleaned}EN`;
};

const generateCandidateCodeBase = (fullName = "") => {
  const words = String(fullName).trim().split(/\s+/).filter(Boolean);

  if (words.length >= 2) {
    const first = sanitizeAlphaNumeric(words[0]).slice(0, 1);
    const second = sanitizeAlphaNumeric(words[1]).slice(0, 2);
    const combined = `${first}${second}`;
    if (combined.length === 3) return combined;
    if (combined.length === 2) return `${combined}C`;
    if (combined.length === 1) return `${combined}AN`;
  }

  const cleaned = sanitizeAlphaNumeric(fullName);

  if (!cleaned) return "CAN";
  if (cleaned.length >= 3) return cleaned.slice(0, 3);
  if (cleaned.length === 2) return `${cleaned}C`;
  return `${cleaned}AN`;
};

const generatePlacementCodeBase = () => "PLC";

const generateUserCodeBase = (fullName = "") => {
  const cleaned = sanitizeAlphaNumeric(fullName);

  if (!cleaned) return "USR";
  if (cleaned.length >= 3) return cleaned.slice(0, 3);
  if (cleaned.length === 2) return `${cleaned}U`;
  return `${cleaned}SR`;
};

const generateBankAccountCodeBase = (accountName = "", bankName = "") => {
  const source = sanitizeAlphaNumeric(`${bankName}${accountName}`);
  if (!source) return "ACC";
  if (source.length >= 3) return source.slice(0, 3);
  if (source.length === 2) return `${source}A`;
  return `${source}CC`;
};

const generateRegionCode = async (pool, regionName = "") => {
  const base = generateRegionCodeBase(regionName);
  return getUniqueCode(pool, "regions", "region_code", `${base}-`, 4);
};

const generateClientCode = async (pool, clientName = "") => {
  const base = generateClientCodeBase(clientName);
  return getUniqueCode(pool, "clients", "client_code", `${base}-`, 4);
};

const generateVendorCode = async (pool, vendorName = "") => {
  const base = generateVendorCodeBase(vendorName);
  return getUniqueCode(pool, "vendors", "vendor_code", `${base}-`, 4);
};

const generateCandidateCode = async (pool, fullName = "") => {
  const base = generateCandidateCodeBase(fullName);
  return getUniqueCode(pool, "candidates", "candidate_code", `${base}-`, 4);
};

const generatePlacementCode = async (pool) => {
  const base = generatePlacementCodeBase();
  return getUniqueCode(pool, "placements", "placement_code", `${base}-`, 5);
};

const generateUserCode = async (pool, fullName = "") => {
  const base = generateUserCodeBase(fullName);
  const userCodeColumnExists = await hasColumn(pool, "users", "user_code");

  if (!userCodeColumnExists) {
    return getUniqueCode(pool, "users", "email", `${base}-TEMP-`, 4);
  }

  return getUniqueCode(pool, "users", "user_code", `${base}-`, 4);
};

const generateInvoiceNumber = async (db) => nextDocNumber(db, "invoice", "INV");

// Inter-company invoices draw from their own (scope, year) sequence so the
// IC-YYYY-NNNNNN series never interleaves with client INV-YYYY-NNNNNN.
const generateIntercompanyInvoiceNumber = async (db) =>
  nextDocNumber(db, "intercompany_invoice", "IC");

const generatePaymentCode = async (db) => {
  const paymentCodeColumnExists = await hasColumn(db, "payments", "payment_code");
  if (!paymentCodeColumnExists) {
    return null;
  }
  return nextDocNumber(db, "payment", "PAY");
};

const generatePaymentReference = async (db) => nextDocNumber(db, "payref", "REF");

const generateBillNumber = async (db) => nextDocNumber(db, "bill", "BILL");

const generateVendorPaymentCode = async (db) => nextDocNumber(db, "vpay", "VPAY");

const generateVendorPaymentReference = async (db) => nextDocNumber(db, "vpayref", "VREF");

const generateBankAccountCode = async (
  pool,
  accountName = "",
  bankName = "",
) => {
  const base = generateBankAccountCodeBase(accountName, bankName);
  return getUniqueCode(pool, "bank_accounts", "account_code", `${base}-`, 4);
};

const generateTransferCode = async (db) => nextDocNumber(db, "transfer", "TRF");

module.exports = {
  hasColumn,
  padNumber,
  sanitizeAlphaNumeric,
  generateRegionCode,
  generateClientCode,
  generateVendorCode,
  generateCandidateCode,
  generatePlacementCode,
  generateUserCode,
  generateInvoiceNumber,
  generateIntercompanyInvoiceNumber,
  generateBillNumber,
  generatePaymentCode,
  generateVendorPaymentCode,
  generateVendorPaymentReference,
  generatePaymentReference,
  generateBankAccountCode,
  generateTransferCode,
};

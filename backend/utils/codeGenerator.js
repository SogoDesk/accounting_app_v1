
const { getTenantId } = require("../config/tenantContext");

// ---------------------------------------------------------------------------
// Common helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tenant helper
// ---------------------------------------------------------------------------

const requireTenantId = () => {
  const tenantId = getTenantId();

  if (!tenantId) {
    throw new Error("Tenant context missing in code generator");
  }

  return tenantId;
};

// ---------------------------------------------------------------------------
// Generate unique entity codes
// Examples: CLI-0001, VEN-0001, REG-0001
// Each tenant generates codes independently.
// ---------------------------------------------------------------------------

const getUniqueCode = async (
  db,
  tableName,
  columnName,
  prefix,
  digits = 4,
) => {
  const tenantId = requireTenantId();

  const maxRes = await db.query(
    `
    SELECT COALESCE(
      MAX(substring(${columnName} from '([0-9]+)$')::int),
      0
    ) AS mx
    FROM ${tableName}
    WHERE tenant_id = $2
      AND ${columnName} LIKE $1
    `,
    [`${prefix}%`, tenantId],
  );

  let attempt = Number(maxRes.rows[0].mx) + 1;

  while (attempt < 1000000) {
    const code = `${prefix}${padNumber(attempt, digits)}`;

    const existing = await db.query(
      `
      SELECT id
      FROM ${tableName}
      WHERE tenant_id = $2
        AND ${columnName} = $1
      LIMIT 1
      `,
      [code, tenantId],
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

// ---------------------------------------------------------------------------
// Document numbering configuration
// Settings -> Numbering
// Each tenant reads its own configuration.
// ---------------------------------------------------------------------------

const numberingConfig = async (db, scope) => {
  try {
    const tenantId = requireTenantId();

    const { rows } = await db.query(
      `
      SELECT prefix, padding, include_year
      FROM document_numbering_config
      WHERE doc_type = $1
        AND tenant_id = $2
      `,
      [scope, tenantId],
    );

    return rows[0] || null;
  } catch (err) {
    console.error("Numbering config error:", err.message);
    return null;
  }
};

// ---------------------------------------------------------------------------
// Tenant-specific document numbering
//
// Examples:
// Tenant 1 -> INV-2026-000001
// Tenant 2 -> INV-2026-000001
//
// Every tenant has its own PostgreSQL sequence.
// ---------------------------------------------------------------------------

const nextDocNumber = async (db, scope, prefix, digits = 6) => {
  const tenantId = requireTenantId();

  const cfg = await numberingConfig(db, scope);

  const usePrefix = cfg?.prefix || prefix;
  const usePad = cfg?.padding || digits;
  const withYear = cfg ? cfg.include_year : true;

  const year = currentYear();

  const safeScope = sanitizeAlphaNumeric(scope);
  const safeTenant = sanitizeAlphaNumeric(tenantId);

  const seq = withYear
    ? `doc_seq_t${safeTenant}_${safeScope}_${year}`
    : `doc_seq_t${safeTenant}_${safeScope}_all`;

  // Create a separate sequence for each tenant and document type.
  await db.query(`CREATE SEQUENCE IF NOT EXISTS ${seq}`);

  // nextval is atomic and safe for concurrent requests.
  const { rows } = await db.query(
    `SELECT nextval($1::regclass) AS n`,
    [seq],
  );

  return withYear
    ? `${usePrefix}-${year}-${padNumber(rows[0].n, usePad)}`
    : `${usePrefix}-${padNumber(rows[0].n, usePad)}`;
};

// ---------------------------------------------------------------------------
// Code base generators
// ---------------------------------------------------------------------------

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
  const words = String(fullName)
    .trim()
    .split(/\s+/)
    .filter(Boolean);

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

const generateBankAccountCodeBase = (
  accountName = "",
  bankName = "",
) => {
  const source = sanitizeAlphaNumeric(`${bankName}${accountName}`);

  if (!source) return "ACC";
  if (source.length >= 3) return source.slice(0, 3);
  if (source.length === 2) return `${source}A`;
  return `${source}CC`;
};

// ---------------------------------------------------------------------------
// Entity code generators
// All generated codes are tenant-specific.
// ---------------------------------------------------------------------------

const generateRegionCode = async (pool, regionName = "") => {
  const base = generateRegionCodeBase(regionName);

  return getUniqueCode(
    pool,
    "regions",
    "region_code",
    `${base}-`,
    4,
  );
};

const generateClientCode = async (pool, clientName = "") => {
  const base = generateClientCodeBase(clientName);

  return getUniqueCode(
    pool,
    "clients",
    "client_code",
    `${base}-`,
    4,
  );
};

const generateVendorCode = async (pool, vendorName = "") => {
  const base = generateVendorCodeBase(vendorName);

  return getUniqueCode(
    pool,
    "vendors",
    "vendor_code",
    `${base}-`,
    4,
  );
};

const generateCandidateCode = async (pool, fullName = "") => {
  const base = generateCandidateCodeBase(fullName);

  return getUniqueCode(
    pool,
    "candidates",
    "candidate_code",
    `${base}-`,
    4,
  );
};

const generatePlacementCode = async (pool) => {
  const base = generatePlacementCodeBase();

  return getUniqueCode(
    pool,
    "placements",
    "placement_code",
    `${base}-`,
    5,
  );
};

const generateUserCode = async (pool, fullName = "") => {
  const base = generateUserCodeBase(fullName);

  const userCodeColumnExists = await hasColumn(
    pool,
    "users",
    "user_code",
  );

  if (!userCodeColumnExists) {
    return getUniqueCode(
      pool,
      "users",
      "email",
      `${base}-TEMP-`,
      4,
    );
  }

  return getUniqueCode(
    pool,
    "users",
    "user_code",
    `${base}-`,
    4,
  );
};

const generateBankAccountCode = async (
  pool,
  accountName = "",
  bankName = "",
) => {
  const base = generateBankAccountCodeBase(
    accountName,
    bankName,
  );

  return getUniqueCode(
    pool,
    "bank_accounts",
    "account_code",
    `${base}-`,
    4,
  );
};

// ---------------------------------------------------------------------------
// Document number generators
// ---------------------------------------------------------------------------

const generateInvoiceNumber = async (db) =>
  nextDocNumber(db, "invoice", "INV");

const generateIntercompanyInvoiceNumber = async (db) =>
  nextDocNumber(db, "intercompany_invoice", "IC");

const generatePaymentCode = async (db) => {
  const paymentCodeColumnExists = await hasColumn(
    db,
    "payments",
    "payment_code",
  );

  if (!paymentCodeColumnExists) {
    return null;
  }

  return nextDocNumber(db, "payment", "PAY");
};

const generatePaymentReference = async (db) =>
  nextDocNumber(db, "payref", "REF");

const generateBillNumber = async (db) =>
  nextDocNumber(db, "bill", "BILL");

const generateVendorPaymentCode = async (db) =>
  nextDocNumber(db, "vpay", "VPAY");

const generateVendorPaymentReference = async (db) =>
  nextDocNumber(db, "vpayref", "VREF");

const generateTransferCode = async (db) =>
  nextDocNumber(db, "transfer", "TRF");

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

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
  generateBankAccountCode,

  generateInvoiceNumber,
  generateIntercompanyInvoiceNumber,
  generateBillNumber,
  generatePaymentCode,
  generateVendorPaymentCode,
  generateVendorPaymentReference,
  generatePaymentReference,
  generateTransferCode,
};

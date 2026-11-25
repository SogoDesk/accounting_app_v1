// Read side of invoices: list, detail, print, placement options and export.
// Every function takes db (a pg client) and the caller's scope where it filters.

const { groupCurrency, attachReportingFields, makeMultiConverter } = require("../../utils/reportingCurrency");
const { convertToUsd } = require("../../utils/fx");
const { sanitizeInvoiceRecord, invoiceDisplayStatus } = require("./invoiceValues");
const { getInvoiceItems, getInvoiceTaxLines } = require("./lineItemService");

// Memoized per process: the column set is fixed by the migrations, so the
// detection query runs once per boot. Columns are never added from code.
let _invoiceColumnsCache = null;
const hasInvoiceColumns = async (db) => {
  if (_invoiceColumnsCache) return _invoiceColumnsCache;
  const result = await db.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'invoices'
      AND column_name IN (
        'invoice_terms_label',
        'customer_message',
        'internal_notes',
        'tax_lines_json',
        'invoice_template',
        'invoice_template_id',
        'invoice_template_name',
        'invoice_template_snapshot_json',
        'template_custom_fields_json',
        'exchange_rate',
        'amount_base',
        'invoice_type',
        'bill_to_region_id'
      )
  `);

  const columns = new Set(result.rows.map((row) => row.column_name));

  _invoiceColumnsCache = {
    invoice_terms_label: columns.has("invoice_terms_label"),
    customer_message: columns.has("customer_message"),
    internal_notes: columns.has("internal_notes"),
    tax_lines_json: columns.has("tax_lines_json"),
    invoice_template: columns.has("invoice_template"),
    invoice_template_id: columns.has("invoice_template_id"),
    invoice_template_name: columns.has("invoice_template_name"),
    invoice_template_snapshot_json: columns.has(
      "invoice_template_snapshot_json",
    ),
    template_custom_fields_json: columns.has("template_custom_fields_json"),
    exchange_rate: columns.has("exchange_rate"),
    amount_base: columns.has("amount_base"),
    invoice_type: columns.has("invoice_type"),
    bill_to_region_id: columns.has("bill_to_region_id"),
  };
  return _invoiceColumnsCache;
};

let _regionBrandingColumnsCache = null;
const hasRegionInvoiceBrandingColumns = async (db) => {
  if (_regionBrandingColumnsCache) return _regionBrandingColumnsCache;
  const result = await db.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'regions'
      AND column_name IN (
        'invoice_template',
        'invoice_brand_primary_color',
        'invoice_brand_accent_color',
        'invoice_brand_footer_note',
        'tds_applicable'
      )
  `);

  const columns = new Set(result.rows.map((row) => row.column_name));

  _regionBrandingColumnsCache = {
    invoice_template: columns.has("invoice_template"),
    invoice_brand_primary_color: columns.has("invoice_brand_primary_color"),
    invoice_brand_accent_color: columns.has("invoice_brand_accent_color"),
    invoice_brand_footer_note: columns.has("invoice_brand_footer_note"),
    tds_applicable: columns.has("tds_applicable"),
  };
  return _regionBrandingColumnsCache;
};

const getRegionBrandingSelects = (regionColumns, alias = "r") => [
  regionColumns.invoice_template
    ? `${alias}.invoice_template AS region_invoice_template`
    : "NULL::text AS region_invoice_template",
  regionColumns.invoice_brand_primary_color
    ? `${alias}.invoice_brand_primary_color`
    : "NULL::text AS invoice_brand_primary_color",
  regionColumns.invoice_brand_accent_color
    ? `${alias}.invoice_brand_accent_color`
    : "NULL::text AS invoice_brand_accent_color",
  regionColumns.invoice_brand_footer_note
    ? `${alias}.invoice_brand_footer_note`
    : "NULL::text AS invoice_brand_footer_note",
  // Falls back to TRUE pre-migration: asking about TDS when it doesn't apply is
  // a harmless extra question, whereas defaulting to FALSE would silently stop
  // capturing TDS for the Indian entities that need it.
  regionColumns.tds_applicable
    ? `${alias}.tds_applicable AS region_tds_applicable`
    : "TRUE::boolean AS region_tds_applicable",
];

const getOptionalInvoiceSelects = (invoiceColumns) => [
  invoiceColumns.invoice_terms_label
    ? "i.invoice_terms_label"
    : "NULL::text AS invoice_terms_label",
  invoiceColumns.customer_message
    ? "i.customer_message"
    : "NULL::text AS customer_message",
  invoiceColumns.internal_notes
    ? "i.internal_notes"
    : "i.notes AS internal_notes",
  invoiceColumns.tax_lines_json
    ? "COALESCE(i.tax_lines_json, '[]'::jsonb) AS tax_lines_json"
    : "'[]'::jsonb AS tax_lines_json",
  invoiceColumns.invoice_template
    ? "i.invoice_template"
    : "NULL::text AS invoice_template",
  invoiceColumns.invoice_template_id
    ? "i.invoice_template_id"
    : "NULL::bigint AS invoice_template_id",
  invoiceColumns.invoice_template_name
    ? "i.invoice_template_name"
    : "NULL::text AS invoice_template_name",
  invoiceColumns.invoice_template_snapshot_json
    ? "COALESCE(i.invoice_template_snapshot_json, '{}'::jsonb) AS invoice_template_snapshot_json"
    : "'{}'::jsonb AS invoice_template_snapshot_json",
  invoiceColumns.template_custom_fields_json
    ? "COALESCE(i.template_custom_fields_json, '[]'::jsonb) AS template_custom_fields_json"
    : "'[]'::jsonb AS template_custom_fields_json",
];

const mapInvoiceResponse = async (db, invoiceRow) => {
  const lineItems = await getInvoiceItems(db, invoiceRow.id);
  const taxLines = await getInvoiceTaxLines(invoiceRow);

  return {
    ...sanitizeInvoiceRecord(invoiceRow),
    line_items: lineItems,
    tax_lines: taxLines,
  };
};

// Derived display status — mirrors the frontend's getInvoiceDisplayStatus so
// status filtering means the SAME thing in the list, its count, and the tab
// counts: an open, dated invoice reads OVERDUE (past due) or DUE (due within
// 15 days); otherwise it keeps its stored status (DRAFT when blank).
const DISPLAY_STATUS_SQL = `
      CASE
        WHEN i.balance_outstanding > 0
         AND UPPER(COALESCE(i.invoice_status, '')) NOT IN ('PAID', 'CANCELLED')
         AND i.due_date IS NOT NULL THEN
           CASE
             WHEN (i.due_date::date - CURRENT_DATE) < 0 THEN 'OVERDUE'
             WHEN (i.due_date::date - CURRENT_DATE) <= 15 THEN 'DUE'
             ELSE COALESCE(NULLIF(UPPER(i.invoice_status), ''), 'DRAFT')
           END
        ELSE COALESCE(NULLIF(UPPER(i.invoice_status), ''), 'DRAFT')
      END`;
const OUTSTANDING_SQL =
  "(i.balance_outstanding > 0 AND UPPER(COALESCE(i.invoice_status, '')) NOT IN ('PAID', 'CANCELLED'))";
const OVERDUE_SQL = `${OUTSTANDING_SQL.slice(0, -1)} AND i.due_date IS NOT NULL AND i.due_date::date < CURRENT_DATE)`;
// Joins the list/count/tab-count queries need for the search predicate
// (client / candidate / region names) and the derived status.
const LIST_JOINS = `
      LEFT JOIN placements p ON i.placement_id = p.id
      LEFT JOIN candidates c ON p.candidate_id = c.id
      LEFT JOIN clients cl ON i.client_id = cl.id
      LEFT JOIN regions r ON i.region_id = r.id`;
const STATUS_FILTER_VALUES = ["DUE", "DRAFT", "GENERATED", "SENT", "PARTIALLY_PAID", "PAID", "OVERDUE", "CANCELLED"];

/**
 * One page of invoices plus the counts and totals the Invoices page shows.
 * filters: the list route's query string (from, to, region_id, currency,
 *          client_id, search, status, scope, page, limit).
 * scope:   requestScope(req); scope.entityIds limits rows to those entities.
 */
const listInvoices = async (db, filters, scope) => {
  const invoiceColumns = await hasInvoiceColumns(db);
  const regionColumns = await hasRegionInvoiceBrandingColumns(db);

  // Row-level RBAC: restrict to the caller's allowed entities (regions).
  const scopeParams = [];
  const conditions = [];
  if (scope.entityIds) {
    scopeParams.push(scope.entityIds);
    conditions.push(`i.region_id = ANY($${scopeParams.length})`);
  }

  // Date range, applied in SQL so the window spans every invoice rather than
  // just the rows this page happened to return. Ignored unless well-formed.
  const isDateKey = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
  const fromDate = String(filters.from || filters.start_date || "").trim();
  const toDate = String(filters.to || filters.end_date || "").trim();

  if (isDateKey(fromDate)) {
    scopeParams.push(fromDate);
    conditions.push(`i.due_date >= $${scopeParams.length}`);
  }
  if (isDateKey(toDate)) {
    scopeParams.push(toDate);
    conditions.push(`i.due_date <= $${scopeParams.length}`);
  }

  const scopeWhere = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  // Filters layer over the whole-book scope (RBAC + date), which the KPI
  // `totals` keep using untouched:
  //  · tab-count scope  = + region + client + search  (mirrors the toolbar
  //    EXCEPT the status/scope the tabs themselves toggle);
  //  · list/count scope = tab scope + status + scope.
  // Region stays OUT of `totals` so `by_region` always covers every region.
  const tabParams = [...scopeParams];
  const tabConditions = [...conditions];

  const regionId = parseInt(filters.region_id, 10);
  if (Number.isInteger(regionId) && regionId > 0) {
    tabParams.push(regionId);
    tabConditions.push(`i.region_id = $${tabParams.length}`);
  }
  const currency = String(filters.currency || "").trim().toUpperCase();
  if (currency) {
    tabParams.push(currency);
    tabConditions.push(`UPPER(i.currency) = $${tabParams.length}`);
  }
  const clientId = parseInt(filters.client_id, 10);
  if (Number.isInteger(clientId) && clientId > 0) {
    tabParams.push(clientId);
    tabConditions.push(`i.client_id = $${tabParams.length}`);
  }
  const searchTerm = String(filters.search || "").trim();
  if (searchTerm) {
    tabParams.push(`%${searchTerm}%`);
    const p = `$${tabParams.length}`;
    tabConditions.push(
      `(i.invoice_number ILIKE ${p} OR cl.client_name ILIKE ${p} OR c.full_name ILIKE ${p} OR r.region_name ILIKE ${p})`,
    );
  }
  const tabWhere = tabConditions.length
    ? `WHERE ${tabConditions.join(" AND ")}`
    : "";

  const listParams = [...tabParams];
  const listConditions = [...tabConditions];
  const statusFilter = String(filters.status || "").toUpperCase();
  if (STATUS_FILTER_VALUES.includes(statusFilter)) {
    listParams.push(statusFilter);
    listConditions.push(`(${DISPLAY_STATUS_SQL}) = $${listParams.length}`);
  }
  const scopeFilter = String(filters.scope || "").toLowerCase();
  if (scopeFilter === "outstanding") {
    listConditions.push(OUTSTANDING_SQL);
  } else if (scopeFilter === "overdue") {
    listConditions.push(OVERDUE_SQL);
  } else if (scopeFilter === "collected") {
    listConditions.push("i.payment_received_amount > 0");
  } else if (scopeFilter === "sent") {
    // "Sent" tab: issued to the client but not yet paid/overdue — matches the
    // tab_counts.sent badge (display IN SENT, GENERATED).
    listConditions.push(`(${DISPLAY_STATUS_SQL}) IN ('SENT', 'GENERATED')`);
  }
  const listWhere = listConditions.length
    ? `WHERE ${listConditions.join(" AND ")}`
    : "";

  // Pagination.
  const pageNum = Math.max(1, parseInt(filters.page, 10) || 1);
  const limitNum = Math.min(
    2000,
    Math.max(1, parseInt(filters.limit, 10) || 100),
  );
  const offset = (pageNum - 1) * limitNum;

  const countResult = await db.query(
    `SELECT COUNT(DISTINCT i.id)::int AS total FROM invoices i ${LIST_JOINS} ${listWhere}`,
    listParams,
  );
  const total = countResult.rows[0]?.total ?? 0;

  // Segmented-tab counts (All / Sent / Overdue / Paid) over the tab scope
  // (search + client + region + date, but NOT the status/scope the tabs
  // toggle), so every tab shows its true count regardless of which is active.
  const tabCountResult = await db.query(
    `SELECT
       COUNT(*)::int AS all,
       COUNT(*) FILTER (WHERE display IN ('SENT', 'GENERATED'))::int AS sent,
       COUNT(*) FILTER (WHERE display = 'OVERDUE')::int AS overdue,
       COUNT(*) FILTER (WHERE display = 'PAID')::int AS paid
     FROM (
       SELECT (${DISPLAY_STATUS_SQL}) AS display
       FROM invoices i ${LIST_JOINS} ${tabWhere}
     ) s`,
    tabParams,
  );
  const tabCounts = tabCountResult.rows[0] || { all: 0, sent: 0, overdue: 0, paid: 0 };

  const limitParamIndex = listParams.length + 1;
  const offsetParamIndex = listParams.length + 2;
  const queryParams = [...listParams, limitNum, offset];

  const result = await db.query(
    `
    SELECT
      i.id,
      i.invoice_number,
      i.placement_id,
      p.placement_code,
      c.full_name AS candidate_name,
      i.client_id,
      cl.client_name,
      i.region_id,
      r.region_name,
      r.functional_currency,
      r.company_name,
      r.company_address,
      r.company_id_label,
      r.company_id_value,
      r.logo_url,
      r.bank_name,
      r.bank_account_name,
      r.bank_account_number,
      r.bank_routing_number,
      r.bank_swift_ifsc,
      r.bank_branch_details,
      ${getRegionBrandingSelects(regionColumns).join(",\n      ")},
      i.invoice_date,
      i.due_date,
      i.billing_period_start,
      i.billing_period_end,
      i.hours_or_units,
      i.bill_rate,
      i.subtotal,
      i.tax_amount,
      i.total_amount,
      i.currency,
      i.exchange_rate,
      i.amount_base,
      i.invoice_status,
      i.payment_received_amount,
      i.balance_outstanding,
      i.notes,
      ${getOptionalInvoiceSelects(invoiceColumns).join(",\n      ")},
      COALESCE(ii_counts.item_count, 0) AS particulars_count,
      i.created_at,
      i.updated_at
    FROM invoices i
    LEFT JOIN placements p ON i.placement_id = p.id
    LEFT JOIN candidates c ON p.candidate_id = c.id
    LEFT JOIN clients cl ON i.client_id = cl.id
    LEFT JOIN regions r ON i.region_id = r.id
    LEFT JOIN (
      SELECT invoice_id, COUNT(*)::int AS item_count
      FROM invoice_items
      GROUP BY invoice_id
    ) ii_counts ON ii_counts.invoice_id = i.id
    ${listWhere}
    ORDER BY i.id DESC
    LIMIT $${limitParamIndex} OFFSET $${offsetParamIndex}
    `,
    queryParams,
  );

  // Consolidate mixed-currency figures into the company group currency so the
  // InvoicesPage/Dashboard KPIs can sum across regions without adding raw £+₹+$.
  const data = result.rows.map(sanitizeInvoiceRecord);
  const reportingCcy = await groupCurrency(db);
  await attachReportingFields(
    data,
    {
      total_amount: "total_amount_reporting",
      payment_received_amount: "payment_received_amount_reporting",
      balance_outstanding: "balance_outstanding_reporting",
    },
    { db, reportingCcy },
  );

  const totals = await invoiceTotals(db, scopeWhere, scopeParams, reportingCcy);

  return { data, total, page: pageNum, limit: limitNum, reportingCcy, totals, tabCounts };
};

// Whole-dataset KPI totals — computed over the FULL filtered set (same RBAC +
// date window, no LIMIT/OFFSET) so the InvoicesPage cards reflect every
// invoice, not just this page. `all` is consolidated into the group currency
// for the all-regions view; `by_region` carries each region's native
// (billing-currency) figures plus its book-currency (`functional`) equivalents
// for the single-region dual display. Book figures use the booked
// amount_base/total ratio, matching the ledger's per-date valuation.
const invoiceTotals = async (db, scopeWhere, scopeParams, reportingCcy) => {
  const totalsResult = await db.query(
    `SELECT
       i.region_id,
       i.currency AS native_currency,
       r.functional_currency,
       SUM(i.total_amount) AS invoiced,
       SUM(i.payment_received_amount) AS received,
       SUM(CASE WHEN i.invoice_status NOT IN ('PAID','CANCELLED') AND i.balance_outstanding > 0
                THEN i.balance_outstanding ELSE 0 END) AS due,
       SUM(CASE WHEN i.invoice_status NOT IN ('PAID','CANCELLED') AND i.balance_outstanding > 0 AND i.due_date < CURRENT_DATE
                THEN i.balance_outstanding ELSE 0 END) AS overdue,
       SUM(COALESCE(i.amount_base, i.total_amount)) AS invoiced_fn,
       SUM(i.payment_received_amount * CASE WHEN i.total_amount > 0
                THEN COALESCE(i.amount_base, i.total_amount) / i.total_amount ELSE 1 END) AS received_fn,
       SUM(CASE WHEN i.invoice_status NOT IN ('PAID','CANCELLED') AND i.balance_outstanding > 0
                THEN i.balance_outstanding * (CASE WHEN i.total_amount > 0
                     THEN COALESCE(i.amount_base, i.total_amount) / i.total_amount ELSE 1 END) ELSE 0 END) AS due_fn,
       SUM(CASE WHEN i.invoice_status NOT IN ('PAID','CANCELLED') AND i.balance_outstanding > 0 AND i.due_date < CURRENT_DATE
                THEN i.balance_outstanding * (CASE WHEN i.total_amount > 0
                     THEN COALESCE(i.amount_base, i.total_amount) / i.total_amount ELSE 1 END) ELSE 0 END) AS overdue_fn,
       COUNT(*)::int AS count
     FROM invoices i
     LEFT JOIN regions r ON i.region_id = r.id
     ${scopeWhere}
     GROUP BY i.region_id, i.currency, r.functional_currency`,
    scopeParams,
  );

  const convert = await makeMultiConverter(db);
  const MONEY = ["invoiced", "received", "due", "overdue"];
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const totals = {
    reporting_currency: reportingCcy,
    all: { invoiced: 0, received: 0, due: 0, overdue: 0, count: 0 },
    by_region: {},
  };
  for (const b of totalsResult.rows) {
    const rid = String(b.region_id);
    const native = String(b.native_currency || reportingCcy).toUpperCase();
    const fnCcy = String(b.functional_currency || native).toUpperCase();
    const cnt = Number(b.count) || 0;
    totals.all.count += cnt;
    if (!totals.by_region[rid]) {
      totals.by_region[rid] = {
        currency: native,
        functional_currency: fnCcy,
        invoiced: 0, received: 0, due: 0, overdue: 0, count: 0,
        functional: { invoiced: 0, received: 0, due: 0, overdue: 0 },
      };
    }
    const br = totals.by_region[rid];
    br.count += cnt;
    for (const m of MONEY) {
      const nativeVal = Number(b[m]) || 0;
      totals.all[m] += await convert(nativeVal, native, reportingCcy);
      br[m] += await convert(nativeVal, native, br.currency);
      br.functional[m] += await convert(Number(b[`${m}_fn`]) || 0, fnCcy, br.functional_currency);
    }
  }
  for (const m of MONEY) totals.all[m] = round2(totals.all[m]);
  for (const rid of Object.keys(totals.by_region)) {
    const br = totals.by_region[rid];
    for (const m of MONEY) {
      br[m] = round2(br[m]);
      br.functional[m] = round2(br.functional[m]);
    }
  }
  return totals;
};

// One invoice with its placement, client and issuing-region details, line
// items and tax lines — the shape the detail, print and PDF routes return.
// null when it does not exist or is outside the caller's scope.
const getInvoiceDetail = async (db, id, scope) => {
  const invoiceColumns = await hasInvoiceColumns(db);
  const regionColumns = await hasRegionInvoiceBrandingColumns(db);

  const invoiceResult = await db.query(
    `
    SELECT
      i.*,
      p.placement_code,
      p.job_title,
      p.billing_type,
      p.invoice_cycle,
      p.payment_terms,
      p.custom_payment_terms_days,
      c.full_name AS candidate_name,
      cl.client_name,
      cl.primary_contact_name,
      cl.primary_contact_email,
      cl.billing_address,
      cl.tax_identifier,
      cl.default_payment_terms,
      r.region_name,
      r.company_name,
      r.company_address,
      r.company_id_label,
      r.company_id_value,
      r.logo_url,
      r.bank_name,
      r.bank_account_name,
      r.bank_account_number,
      r.bank_routing_number,
      r.bank_swift_ifsc,
      r.bank_branch_details,
      ${getRegionBrandingSelects(regionColumns).join(",\n      ")},
      ${getOptionalInvoiceSelects(invoiceColumns).join(",\n      ")}
    FROM invoices i
    LEFT JOIN placements p ON i.placement_id = p.id
    LEFT JOIN candidates c ON p.candidate_id = c.id
    LEFT JOIN clients cl ON i.client_id = cl.id
    LEFT JOIN regions r ON i.region_id = r.id
    WHERE i.id = $1
    LIMIT 1
    `,
    [id],
  );

  const row = invoiceResult.rows[0];
  if (!row || !scope.canAct(row.region_id)) return null;
  return mapInvoiceResponse(db, row);
};

// Payments against an invoice, oldest first (print view).
const listInvoicePayments = async (db, invoiceId) => {
  const result = await db.query(
    `
    SELECT
      id,
      invoice_id,
      payment_date,
      amount_received,
      payment_mode,
      reference_number,
      notes,
      created_at,
      updated_at
    FROM payments
    WHERE invoice_id = $1
    ORDER BY payment_date ASC, id ASC
    `,
    [invoiceId],
  );
  return result.rows;
};

// The raw invoices row (no joins), or null.
const getInvoiceRow = async (db, id) => {
  const result = await db.query(`SELECT * FROM invoices WHERE id = $1 LIMIT 1`, [id]);
  return result.rows[0] || null;
};

// Active placements an invoice can be raised against, newest first.
const listPlacementOptions = async (db) => {
  const regionColumns = await hasRegionInvoiceBrandingColumns(db);
  const result = await db.query(
    `
    SELECT
      p.id,
      p.placement_code,
      p.client_id,
      cl.client_name,
      cl.currency AS client_currency,
      cl.default_payment_terms,
      p.region_id,
      r.region_name,
      r.country_code AS region_country_code,
      r.default_currency AS region_currency,
      r.company_name,
      r.company_address,
      r.company_id_label,
      r.company_id_value,
      r.logo_url,
      r.invoice_terms_label,
      r.bank_name,
      r.bank_account_name,
      r.bank_account_number,
      r.bank_routing_number,
      r.bank_swift_ifsc,
      r.bank_branch_details,
      ${getRegionBrandingSelects(regionColumns).join(",\n      ")},
      p.currency,
      p.bill_rate,
      p.tax_percent,
      p.billing_type,
      p.expected_hours_per_month,
      p.monthly_billing_amount,
      p.one_time_fee_amount,
      p.invoice_cycle,
      p.payment_terms,
      p.custom_payment_terms_days,
      p.start_date,
      p.end_date,
      c.id AS candidate_id,
      c.full_name AS candidate_name,
      c.job_title
    FROM placements p
    JOIN clients cl ON p.client_id = cl.id
    JOIN regions r ON p.region_id = r.id
    JOIN candidates c ON p.candidate_id = c.id
    WHERE p.placement_status = 'ACTIVE'
    ORDER BY p.id DESC
    `,
  );
  return result.rows;
};

/**
 * The invoice export as a report descriptor for services/reports/reportExport.
 * filters: status (display status), scope (outstanding|overdue|collected|sent),
 *          region_id, client_id, currency, search, from, to.
 */
const buildInvoiceExport = async (db, filters, scope) => {
  const { status, region_id, client_id, search, from, to, currency } = filters;
  const conditions = [];
  const values = [];
  let idx = 1;
  if (region_id) { conditions.push(`i.region_id = $${idx++}`); values.push(Number(region_id)); }
  if (client_id) { conditions.push(`i.client_id = $${idx++}`); values.push(Number(client_id)); }
  if (currency) { conditions.push(`UPPER(i.currency) = $${idx++}`); values.push(String(currency).toUpperCase()); }
  if (from) { conditions.push(`i.due_date >= $${idx++}`); values.push(from); }
  if (to) { conditions.push(`i.due_date <= $${idx++}`); values.push(to); }
  if (scope.entityIds) { conditions.push(`i.region_id = ANY($${idx++})`); values.push(scope.entityIds); }
  if (search) {
    conditions.push(`(i.invoice_number ILIKE $${idx} OR cl.client_name ILIKE $${idx} OR COALESCE(c.full_name, '') ILIKE $${idx} OR COALESCE(r.region_name, '') ILIKE $${idx})`);
    values.push(`%${search}%`); idx += 1;
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await db.query(
    `SELECT i.id, i.invoice_number, i.invoice_date, i.due_date, i.total_amount, i.currency, i.invoice_status,
            i.payment_received_amount, i.balance_outstanding,
            cl.client_name, r.region_name, c.full_name AS candidate_name
       FROM invoices i
       LEFT JOIN clients cl ON i.client_id = cl.id
       LEFT JOIN regions r ON i.region_id = r.id
       LEFT JOIN placements p ON i.placement_id = p.id
       LEFT JOIN candidates c ON p.candidate_id = c.id
       ${where}
      ORDER BY i.invoice_date DESC, i.id DESC`, values);

  const wantStatus = status ? String(status).toUpperCase() : "";
  const wantScope = filters.scope ? String(filters.scope).toLowerCase() : "";
  const cache = new Map();
  let totalUsd = 0;
  const rows = [];
  for (const r of result.rows) {
    const display = invoiceDisplayStatus(r);
    if (wantStatus && display !== wantStatus) continue;
    const outstanding = Number(r.balance_outstanding || 0);
    const received = Number(r.payment_received_amount || 0);
    const closed = ["PAID", "CANCELLED"].includes(String(r.invoice_status || "").toUpperCase());
    const isOutstanding = outstanding > 0 && !closed;
    const overdue = isOutstanding && r.due_date && new Date(r.due_date) < new Date(new Date().setHours(0, 0, 0, 0));
    const isCollected = received > 0;
    if (wantScope === "outstanding" && !isOutstanding) continue;
    if (wantScope === "overdue" && !overdue) continue;
    if (wantScope === "collected" && !isCollected) continue;
    if (wantScope === "sent" && !(display === "SENT" || display === "GENERATED")) continue;

    const tUsd = await convertToUsd(r.total_amount, r.currency, cache);
    totalUsd += tUsd;
    rows.push({
      invoice_date: String(r.invoice_date).slice(0, 10),
      invoice_number: r.invoice_number,
      client_name: r.client_name || "",
      region_name: r.region_name || "",
      candidate_name: r.candidate_name || "",
      due_date: r.due_date ? String(r.due_date).slice(0, 10) : "",
      currency: r.currency,
      total_amount: Number(r.total_amount || 0),
      payment_received_amount: received,
      balance_outstanding: outstanding,
      total_usd: tUsd,
      status: display,
    });
  }
  const rangeLabel = (from || to) ? `${from || "…"} to ${to || "…"}` : "All dates";
  return {
    title: "Invoices",
    subtitle: `${rangeLabel} · ${rows.length} invoice(s) · total in USD (consolidated)`,
    columns: [
      { key: "invoice_date", label: "Date", type: "text" },
      { key: "invoice_number", label: "Invoice #", type: "text" },
      { key: "client_name", label: "Client", type: "text" },
      { key: "region_name", label: "Location", type: "text" },
      { key: "candidate_name", label: "Candidate", type: "text" },
      { key: "due_date", label: "Due", type: "text" },
      { key: "currency", label: "Currency", type: "text" },
      { key: "total_amount", label: "Total", type: "money" },
      { key: "payment_received_amount", label: "Received", type: "money" },
      { key: "balance_outstanding", label: "Outstanding", type: "money" },
      { key: "total_usd", label: "Total (USD)", type: "money" },
      { key: "status", label: "Status", type: "text" },
    ],
    rows,
    totals: { total_usd: Math.round(totalUsd * 100) / 100 },
  };
};

module.exports = {
  hasInvoiceColumns,
  hasRegionInvoiceBrandingColumns,
  getRegionBrandingSelects,
  getOptionalInvoiceSelects,
  mapInvoiceResponse,
  listInvoices,
  getInvoiceDetail,
  getInvoiceRow,
  listInvoicePayments,
  listPlacementOptions,
  buildInvoiceExport,
};

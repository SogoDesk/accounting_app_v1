// Invoice line items: validating them against placements (client invoices) or
// the two entities (inter-company), computing totals and tax, and reading and
// writing invoice_items. Every function that touches the database takes db.

const {
  normalizeMoney,
  toNullable,
  sanitizeDateInput,
  resolvePlacementCurrency,
} = require("./invoiceValues");

const buildLineDescription = (item) => {
  if (item.description && String(item.description).trim()) {
    return String(item.description).trim();
  }

  const parts = [];

  if (item.activity_label) parts.push(String(item.activity_label).trim());
  if (item.candidate_name) {
    parts.push(`for ${String(item.candidate_name).trim()}`);
  }
  if (item.job_title) parts.push(`(${String(item.job_title).trim()})`);
  if (item.line_date) parts.push(`dated ${String(item.line_date).trim()}`);

  const combined = parts.join(" ").trim();
  return combined || "Invoice line item";
};

const sanitizeTaxLines = (taxLines = []) => {
  if (!Array.isArray(taxLines)) return [];

  return taxLines
    .filter(
      (line) =>
        String(line?.tax_name || "").trim() ||
        normalizeMoney(line?.tax_percent) > 0 ||
        normalizeMoney(line?.tax_amount) > 0,
    )
    .map((line, index) => ({
      id: index + 1,
      tax_name: String(line.tax_name || "Tax").trim(),
      tax_percent: normalizeMoney(line.tax_percent),
      tax_amount: normalizeMoney(line.tax_amount),
      sort_order: index + 1,
    }));
};

const computeInvoiceAmounts = ({ lineItems = [], taxLines = [] }) => {
  const subtotal = lineItems.reduce((sum, item) => {
    const qty = normalizeMoney(item.quantity);
    const rate = normalizeMoney(item.rate || item.unit_price);
    return sum + qty * rate;
  }, 0);

  const computedTaxLines = sanitizeTaxLines(
    (Array.isArray(taxLines) ? taxLines : []).map((tax) => ({
      ...tax,
      tax_amount: (subtotal * normalizeMoney(tax.tax_percent)) / 100,
    })),
  );

  const taxAmount = computedTaxLines.reduce(
    (sum, line) => sum + normalizeMoney(line.tax_amount),
    0,
  );

  return {
    subtotal,
    taxAmount,
    totalAmount: subtotal + taxAmount,
    computedTaxLines,
  };
};

let _invoiceItemColumnsCache = null;
const hasInvoiceItemColumns = async (db) => {
  if (_invoiceItemColumnsCache) return _invoiceItemColumnsCache;
  const result = await db.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'invoice_items'
      AND column_name IN (
        'placement_id',
        'candidate_id',
        'candidate_name',
        'job_title',
        'activity_label',
        'line_date'
      )
  `);

  const columns = new Set(result.rows.map((row) => row.column_name));

  _invoiceItemColumnsCache = {
    placement_id: columns.has("placement_id"),
    candidate_id: columns.has("candidate_id"),
    candidate_name: columns.has("candidate_name"),
    job_title: columns.has("job_title"),
    activity_label: columns.has("activity_label"),
    line_date: columns.has("line_date"),
  };
  return _invoiceItemColumnsCache;
};

const getOptionalInvoiceItemSelects = (itemColumns) => [
  itemColumns.placement_id ? "ii.placement_id" : "NULL::bigint AS placement_id",
  itemColumns.candidate_id ? "ii.candidate_id" : "NULL::bigint AS candidate_id",
  itemColumns.candidate_name
    ? "ii.candidate_name"
    : "NULL::varchar(150) AS candidate_name",
  itemColumns.job_title ? "ii.job_title" : "NULL::varchar(150) AS job_title",
  itemColumns.activity_label
    ? "ii.activity_label"
    : "NULL::varchar(150) AS activity_label",
  itemColumns.line_date ? "ii.line_date" : "NULL::date AS line_date",
];

const insertInvoiceItems = async (db, invoiceId, lineItems = []) => {
  const itemColumns = await hasInvoiceItemColumns(db);

  for (const item of lineItems) {
    const quantity = normalizeMoney(item.quantity);
    const unitPrice = normalizeMoney(item.rate || item.unit_price);
    const lineTotal = quantity * unitPrice;
    const description = buildLineDescription(item);

    const columns = [
      "invoice_id",
      "description",
      "quantity",
      "unit_price",
      "line_total",
    ];
    const values = [invoiceId, description, quantity, unitPrice, lineTotal];

    if (itemColumns.placement_id) {
      columns.push("placement_id");
      values.push(toNullable(item.placement_id));
    }
    if (itemColumns.candidate_id) {
      columns.push("candidate_id");
      values.push(toNullable(item.candidate_id));
    }
    if (itemColumns.candidate_name) {
      columns.push("candidate_name");
      values.push(toNullable(item.candidate_name));
    }
    if (itemColumns.job_title) {
      columns.push("job_title");
      values.push(toNullable(item.job_title));
    }
    if (itemColumns.activity_label) {
      columns.push("activity_label");
      values.push(toNullable(item.activity_label));
    }
    if (itemColumns.line_date) {
      columns.push("line_date");
      values.push(toNullable(item.line_date));
    }

    const placeholders = columns.map((_, index) => `$${index + 1}`);

    await db.query(
      `
      INSERT INTO invoice_items (${columns.join(", ")})
      VALUES (${placeholders.join(", ")})
      `,
      values,
    );
  }
};

const getInvoiceItems = async (db, invoiceId) => {
  const itemColumns = await hasInvoiceItemColumns(db);
  const joins = itemColumns.placement_id
    ? `
      LEFT JOIN placements p ON p.id = ii.placement_id
      LEFT JOIN candidates c ON c.id = p.candidate_id
    `
    : "";

  const result = await db.query(
    `
    SELECT
      ii.id,
      ii.invoice_id,
      ii.description,
      ii.quantity,
      ii.unit_price AS rate,
      ii.line_total AS amount,
      ${getOptionalInvoiceItemSelects(itemColumns).join(",\n      ")},
      ${itemColumns.placement_id ? "p.placement_code" : "NULL::text AS placement_code"},
      ${itemColumns.placement_id ? "c.full_name AS fallback_candidate_name" : "NULL::text AS fallback_candidate_name"},
      ${itemColumns.placement_id ? "p.job_title AS fallback_job_title" : "NULL::text AS fallback_job_title"},
      ii.created_at
    FROM invoice_items ii
    ${joins}
    WHERE ii.invoice_id = $1
    ORDER BY ii.id ASC
    `,
    [invoiceId],
  );

  return result.rows.map((row) => ({
    ...row,
    candidate_name: row.candidate_name || row.fallback_candidate_name || null,
    job_title: row.job_title || row.fallback_job_title || null,
  }));
};

const getInvoiceTaxLines = async (invoiceRow) => {
  return sanitizeTaxLines(invoiceRow?.tax_lines_json || []);
};

const INVOICE_TYPES = ["CLIENT", "INTER_COMPANY"];

// The CLIENT / INTER_COMPANY discriminator from migration 016. Absent or blank
// means CLIENT, so every existing payload and the timesheet path keep working
// unchanged. An unrecognised value is REJECTED rather than coerced: silently
// downgrading an INTER_COMPANY payload to CLIENT would write the wrong shape and
// then fail confusingly against invoices_type_shape_check.
const normalizeInvoiceType = (value) => {
  if (value == null || String(value).trim() === "") return "CLIENT";
  const normalized = String(value).trim().toUpperCase();
  if (!INVOICE_TYPES.includes(normalized)) {
    throw new Error(
      `Unknown invoice type: ${value}. Expected one of ${INVOICE_TYPES.join(", ")}`,
    );
  }
  return normalized;
};

/**
 * Inter-company line items: free-form, no placement, no candidate, no client.
 *
 * Everything the CLIENT path derives from the primary placement is instead taken
 * from the header — the issuing entity (region_id) and the counterparty
 * (bill_to_region_id), both rows in `regions`.
 */
const validateIntercompanyLineItems = async (db, lineItems = [], context = {}) => {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new Error("At least one invoice line item is required");
  }

  const regionId = Number(context.region_id || 0);
  const billToRegionId = Number(context.bill_to_region_id || 0);

  if (!regionId) throw new Error("Issuing entity (region) is required");
  if (!billToRegionId) {
    throw new Error("Bill-to entity is required for an inter-company invoice");
  }
  if (regionId === billToRegionId) {
    throw new Error("An entity cannot invoice itself");
  }

  const regionResult = await db.query(
    `SELECT id, region_name, default_currency, functional_currency, invoice_terms_label
       FROM regions WHERE id = ANY($1::int[])`,
    [[regionId, billToRegionId]],
  );
  const regionMap = new Map(
    regionResult.rows.map((row) => [Number(row.id), row]),
  );
  const issuerRegion = regionMap.get(regionId);
  const billToRegion = regionMap.get(billToRegionId);
  if (!issuerRegion) throw new Error("Issuing entity (region) not found");
  if (!billToRegion) throw new Error("Bill-to entity not found");

  // Sensible default, still editable: the counterparty's functional currency is
  // what it actually settles in (USD for UK -> USA). A header value wins.
  const currency = String(
    context.currency ||
      billToRegion.functional_currency ||
      billToRegion.default_currency ||
      "",
  )
    .trim()
    .toUpperCase();
  if (!currency) throw new Error("Currency is required");

  // Zero-rated by decision; invoices_ic_zero_rated_check enforces it at the DB
  // too, but reject here so the caller gets a readable message rather than a
  // constraint violation.
  const taxLines = Array.isArray(context.tax_lines) ? context.tax_lines : [];
  if (taxLines.length) {
    throw new Error(
      "Inter-company invoices are zero-rated and cannot carry tax lines",
    );
  }

  const normalizedLineItems = lineItems.map((item, index) => {
    const description = String(item.description || item.activity_label || "").trim();
    if (!description) {
      throw new Error(`Line ${index + 1}: description is required`);
    }

    const quantity = normalizeMoney(item.quantity);
    const rate = normalizeMoney(item.rate || item.unit_price);

    if (quantity <= 0) {
      throw new Error(`Line ${index + 1}: quantity must be greater than 0`);
    }
    if (rate < 0) {
      throw new Error(`Line ${index + 1}: rate cannot be negative`);
    }

    return {
      placement_id: null,
      candidate_id: null,
      candidate_name: null,
      job_title: null,
      activity_label: item.activity_label
        ? String(item.activity_label).trim()
        : null,
      line_date: sanitizeDateInput(item.line_date),
      description,
      quantity,
      rate,
      unit_price: rate,
      amount: quantity * rate,
    };
  });

  return {
    invoiceType: "INTER_COMPANY",
    placementMap: new Map(),
    primaryPlacement: null,
    clientId: null,
    regionId,
    billToRegionId,
    issuerRegion,
    billToRegion,
    currency,
    normalizedLineItems,
  };
};

// Dispatcher. CLIENT keeps the placement-driven path below, byte for byte.
const validateInvoiceLineItems = async (db, lineItems = [], context = {}) => {
  if (normalizeInvoiceType(context.invoice_type) === "INTER_COMPANY") {
    return validateIntercompanyLineItems(db, lineItems, context);
  }
  return validateClientLineItems(db, lineItems);
};

const validateClientLineItems = async (db, lineItems = []) => {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new Error("At least one invoice line item is required");
  }

  const placementIds = lineItems
    .map((item) => Number(item.placement_id || 0))
    .filter((id) => id > 0);

  if (!placementIds.length) {
    throw new Error("At least one valid placement is required");
  }

  const uniquePlacementIds = [...new Set(placementIds)];
  const placementResult = await db.query(
    `
    SELECT
      p.*,
      c.full_name AS candidate_name,
      c.job_title AS candidate_job_title,
      cl.client_name,
      cl.currency AS client_currency,
      cl.default_payment_terms,
      r.region_name,
      r.country_code AS region_country_code,
      r.default_currency AS region_currency,
      r.invoice_terms_label
    FROM placements p
    JOIN candidates c ON p.candidate_id = c.id
    JOIN clients cl ON p.client_id = cl.id
    JOIN regions r ON p.region_id = r.id
    WHERE p.id = ANY($1::int[])
    `,
    [uniquePlacementIds],
  );

  if (placementResult.rows.length !== uniquePlacementIds.length) {
    throw new Error("One or more selected placements were not found");
  }

  const placementMap = new Map(
    placementResult.rows.map((row) => [Number(row.id), row]),
  );

  const primaryPlacement = placementMap.get(Number(placementIds[0]));
  if (!primaryPlacement) throw new Error("Primary placement not found");

  const expectedClientId = Number(primaryPlacement.client_id);
  const expectedRegionId = Number(primaryPlacement.region_id);
  const expectedCurrency = resolvePlacementCurrency(primaryPlacement);

  const normalizedLineItems = lineItems.map((item, index) => {
    const placement = placementMap.get(Number(item.placement_id));
    if (!placement) {
      throw new Error(`Line ${index + 1}: placement not found`);
    }

    if (Number(placement.client_id) !== expectedClientId) {
      throw new Error("All invoice particulars must belong to the same client");
    }

    if (resolvePlacementCurrency(placement) !== expectedCurrency) {
      throw new Error("All invoice particulars must use the same currency");
    }

    const quantity = normalizeMoney(item.quantity);
    const rate = normalizeMoney(item.rate || item.unit_price);

    if (quantity <= 0) {
      throw new Error(`Line ${index + 1}: quantity must be greater than 0`);
    }

    if (rate < 0) {
      throw new Error(`Line ${index + 1}: rate cannot be negative`);
    }

    return {
      placement_id: Number(placement.id),
      candidate_id: placement.candidate_id,
      candidate_name: item.candidate_name || placement.candidate_name,
      job_title:
        item.job_title ||
        item.activity_label ||
        placement.job_title ||
        placement.candidate_job_title,
      activity_label:
        item.activity_label ||
        placement.job_title ||
        placement.candidate_job_title,
      line_date: sanitizeDateInput(item.line_date),
      description: buildLineDescription({
        ...item,
        candidate_name: item.candidate_name || placement.candidate_name,
        job_title:
          item.job_title ||
          placement.job_title ||
          placement.candidate_job_title,
      }),
      quantity,
      rate,
      unit_price: rate,
      amount: quantity * rate,
    };
  });

  return {
    invoiceType: "CLIENT",
    placementMap,
    primaryPlacement,
    clientId: expectedClientId,
    regionId: expectedRegionId,
    billToRegionId: null,
    currency: expectedCurrency,
    normalizedLineItems,
  };
};

module.exports = {
  INVOICE_TYPES,
  normalizeInvoiceType,
  validateInvoiceLineItems,
  validateClientLineItems,
  validateIntercompanyLineItems,
  buildLineDescription,
  sanitizeTaxLines,
  computeInvoiceAmounts,
  insertInvoiceItems,
  getInvoiceItems,
  getInvoiceTaxLines,
};

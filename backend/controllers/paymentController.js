const pool = require("../config/db");
const { auditLog } = require("../middleware/auditMiddleware");
const {
  generatePaymentCode,
  generatePaymentReference,
  hasColumn,
} = require("../utils/codeGenerator");
const { canActOnEntity } = require("../middleware/scopeMiddleware");
const { sendReport } = require("../services/reports/reportExport");
const { convertToUsd } = require("../utils/fx");
const { groupCurrency, attachReportingFields } = require("../utils/reportingCurrency");
const glPosting = require("../services/gl/postingService");

const ALLOWED_PAYMENT_MODES = [
  "BANK_TRANSFER",
  "WIRE_TRANSFER",
  "ACH",
  "CHECK",
  "CASH",
  "CARD",
  "UPI",
  "NEFT",
  "RTGS",
  "IMPS",
  "OTHER",
];

const SUPPORTED_PAYMENT_CURRENCIES = new Set(["USD", "GBP", "INR"]);

const normalizeMoney = (value) => {
  const num = Number(value || 0);
  return Number.isNaN(num) ? 0 : num;
};

const normalizeNullable = (value) => {
  if (value === undefined || value === null || value === "") return null;
  return value;
};

const normalizeUpperNullable = (value) => {
  if (value === undefined || value === null || value === "") return null;
  return String(value).trim().toUpperCase();
};

const normalizeCurrencyCode = (value, fallback = "") => {
  const code = String(value || fallback || "").trim().toUpperCase();
  return code || fallback || "";
};

const normalizeBoolean = (value) => {
  if (value === true || value === 1) return true;
  if (typeof value === "string") {
    return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return false;
};

const sanitizeDateInput = (value) => {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;

  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const ensurePaymentTdsColumns = async (db) => {
  await db.query(`
    ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS tds_applicable boolean DEFAULT false,
    ADD COLUMN IF NOT EXISTS tds_percent numeric(6, 2),
    ADD COLUMN IF NOT EXISTS tds_amount numeric(12, 2) DEFAULT 0
  `);
};

const ensurePaymentCurrencyColumn = async (db) => {
  await db.query(`
    ALTER TABLE payments
    ADD COLUMN IF NOT EXISTS currency varchar(10)
  `);
};

const ensurePaymentSchema = async (db) => {
  await ensurePaymentTdsColumns(db);
  await ensurePaymentCurrencyColumn(db);
};

const getInvoiceStatusFromAmounts = ({ totalAmount, totalReceived, dueDate }) => {
  const total = normalizeMoney(totalAmount);
  const received = normalizeMoney(totalReceived);

  if (total > 0 && received >= total) return "PAID";
  if (received > 0 && received < total) return "PARTIALLY_PAID";

  if (dueDate) {
    const due = new Date(dueDate);
    const today = new Date();
    due.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);

    if (due < today && total > 0) return "OVERDUE";
  }

  return "GENERATED";
};

const recalculateInvoiceTotals = async (db, invoiceId) => {
  const invoiceResult = await db.query(
    `
    SELECT id, total_amount, due_date, invoice_status
    FROM invoices
    WHERE id = $1
    LIMIT 1
    `,
    [invoiceId],
  );

  if (!invoiceResult.rows.length) {
    throw new Error("Invoice not found");
  }

  const invoice = invoiceResult.rows[0];

  if (String(invoice.invoice_status || "").toUpperCase() === "CANCELLED") {
    return invoice;
  }

  const hasTdsAmountColumn = await hasColumn(db, "payments", "tds_amount");
  const creditedResult = await db.query(
    `
    SELECT COALESCE(SUM(amount_received + ${hasTdsAmountColumn ? "COALESCE(tds_amount, 0)" : "0"}), 0) AS total_credited
    FROM payments
    WHERE invoice_id = $1
    `,
    [invoiceId],
  );

  const totalReceived = normalizeMoney(creditedResult.rows[0]?.total_credited || 0);
  const totalAmount = normalizeMoney(invoice.total_amount || 0);
  const balanceOutstanding = Math.max(totalAmount - totalReceived, 0);
  const invoiceStatus = getInvoiceStatusFromAmounts({
    totalAmount,
    totalReceived,
    dueDate: invoice.due_date,
  });

  const updateResult = await db.query(
    `
    UPDATE invoices
    SET
      payment_received_amount = $1,
      balance_outstanding = $2,
      invoice_status = $3,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = $4
    RETURNING *
    `,
    [totalReceived, balanceOutstanding, invoiceStatus, invoiceId],
  );

  return updateResult.rows[0];
};

// TDS is an Indian withholding regime, configured per region. Aliased away from
// invoices.tds_applicable (pulled in by `i.*`), which records what a payment
// actually withheld rather than whether the region withholds at all.
// Pre-migration the column is absent: fall back to TRUE so the question keeps
// being asked rather than silently dropping TDS for the entities that need it.
// Memoized per process: a multi-invoice payment resolves this once per invoice
// inside its transaction, and the column can't disappear under a running server.
let _regionTdsColumnCache = null;
const getRegionTdsSelect = async (db, alias = "r") => {
  if (_regionTdsColumnCache === null) {
    _regionTdsColumnCache = await hasColumn(db, "regions", "tds_applicable");
  }
  return _regionTdsColumnCache
    ? `${alias}.tds_applicable AS region_tds_applicable`
    : "TRUE::boolean AS region_tds_applicable";
};

// An INTER_COMPANY invoice (migration 016) has no clients row — the bill-to
// party is a regions row. The joins to clients must therefore be LEFT, or such
// an invoice silently disappears from every payment query and becomes unpayable
// (createPayment would 404 on it). Where a client name is displayed, fall back
// to the counterparty entity's name so the party is never blank.
// Memoized like _regionTdsColumnCache: the column can't vanish under a running
// server, and a multi-invoice payment would otherwise re-probe per invoice.
let _billToColumnCache = null;
const hasBillToRegion = async (db) => {
  if (_billToColumnCache === null) {
    _billToColumnCache = await hasColumn(db, "invoices", "bill_to_region_id");
  }
  return _billToColumnCache;
};

// LEFT JOIN onto the bill-to entity, plus the party-name expression to use.
const getBillToParts = async (db, alias = "i") => {
  const present = await hasBillToRegion(db);
  return {
    join: present
      ? `LEFT JOIN regions btr ON ${alias}.bill_to_region_id = btr.id`
      : "",
    partyName: present
      ? "COALESCE(cl.client_name, btr.region_name)"
      : "cl.client_name",
  };
};

const getInvoiceWithContext = async (db, invoiceId) => {
  const billTo = await getBillToParts(db);
  const result = await db.query(
    `
    SELECT
      i.*,
      ${billTo.partyName} AS client_name,
      r.region_name,
      ${await getRegionTdsSelect(db)},
      p.placement_code,
      p.job_title,
      c.full_name AS candidate_name
    FROM invoices i
    LEFT JOIN clients cl ON i.client_id = cl.id
    JOIN regions r ON i.region_id = r.id
    ${billTo.join}
    LEFT JOIN placements p ON i.placement_id = p.id
    LEFT JOIN candidates c ON p.candidate_id = c.id
    WHERE i.id = $1
    LIMIT 1
    `,
    [invoiceId],
  );

  return result.rows[0] || null;
};

const calculateTdsAmount = (invoice, tdsApplicable, tdsPercent) => {
  if (!tdsApplicable) return 0;
  const percent = normalizeMoney(tdsPercent);
  if (percent <= 0) return 0;
  return Number(((normalizeMoney(invoice.subtotal) * percent) / 100).toFixed(2));
};

const buildPaymentSelectQuery = async (db) => {
  await ensurePaymentSchema(db);
  const hasPaymentCodeColumn = await hasColumn(db, "payments", "payment_code");
  const billTo = await getBillToParts(db);

  return `
    SELECT
      p.id,
      p.invoice_id,
      p.payment_date,
      p.amount_received,
      p.payment_mode,
      p.reference_number,
      p.exchange_rate,
      p.amount_in_base_currency,
      p.fx_gain_loss,
      p.tds_applicable,
      p.tds_percent,
      p.tds_amount,
      p.notes,
      p.created_by,
      p.created_at,
      p.updated_at,
      ${hasPaymentCodeColumn ? "p.payment_code" : "NULL::varchar AS payment_code"},
      i.region_id,
      i.invoice_number,
      i.invoice_date,
      i.due_date,
      i.invoice_status,
      i.total_amount AS invoice_total_amount,
      i.subtotal AS invoice_subtotal,
      i.payment_received_amount AS invoice_received_amount,
      i.balance_outstanding AS invoice_balance_outstanding,
      COALESCE(p.currency, i.currency) AS currency,
      ${billTo.partyName} AS client_name,
      r.region_name,
      pl.placement_code,
      pl.job_title,
      c.full_name AS candidate_name,
      u.full_name AS created_by_name
    FROM payments p
    JOIN invoices i ON p.invoice_id = i.id
    LEFT JOIN clients cl ON i.client_id = cl.id
    JOIN regions r ON i.region_id = r.id
    ${billTo.join}
    LEFT JOIN placements pl ON i.placement_id = pl.id
    LEFT JOIN candidates c ON pl.candidate_id = c.id
    LEFT JOIN users u ON p.created_by = u.id
  `;
};

const getAllPayments = async (req, res) => {
  try {
    const { search = "", invoice_id = "", client_id = "", payment_mode = "" } = req.query;
    const hasPaymentCodeColumn = await hasColumn(pool, "payments", "payment_code");
    const baseQuery = await buildPaymentSelectQuery(pool);

    const conditions = [];
    const values = [];
    let idx = 1;

    if (invoice_id) {
      conditions.push(`p.invoice_id = $${idx++}`);
      values.push(Number(invoice_id));
    }

    if (client_id) {
      conditions.push(`i.client_id = $${idx++}`);
      values.push(Number(client_id));
    }

    if (payment_mode) {
      conditions.push(`COALESCE(p.payment_mode, '') = $${idx++}`);
      values.push(String(payment_mode).trim().toUpperCase());
    }

    if (search) {
      const searchParts = [
        `i.invoice_number ILIKE $${idx}`,
        `cl.client_name ILIKE $${idx}`,
        `COALESCE(c.full_name, '') ILIKE $${idx}`,
        `COALESCE(p.reference_number, '') ILIKE $${idx}`,
      ];

      if (hasPaymentCodeColumn) {
        searchParts.push(`COALESCE(p.payment_code, '') ILIKE $${idx}`);
      }

      conditions.push(`(${searchParts.join(" OR ")})`);
      values.push(`%${search}%`);
      idx += 1;
    }

    // Row-level RBAC: restrict to payments on invoices in the caller's entities.
    if (req.scopeEnforced && Array.isArray(req.allowedEntityIds)) {
      conditions.push(`i.region_id = ANY($${idx++})`);
      values.push(req.allowedEntityIds);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pool.query(
      `${baseQuery}
       ${where}
       ORDER BY p.payment_date DESC, p.id DESC`,
      values,
    );

    // Consolidate to the company group currency for cross-region KPI sums.
    const reportingCcy = await groupCurrency(pool);
    await attachReportingFields(
      result.rows,
      { amount_received: "amount_received_reporting" },
      { db: pool, reportingCcy },
    );

    return res.json({ success: true, data: result.rows, reporting_currency: reportingCcy });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch payments",
      error: error.message,
    });
  }
};

const getPaymentById = async (req, res) => {
  try {
    const baseQuery = await buildPaymentSelectQuery(pool);
    const result = await pool.query(
      `${baseQuery}
       WHERE p.id = $1
       LIMIT 1`,
      [req.params.id],
    );

    if (!result.rows.length || !canActOnEntity(req, result.rows[0].region_id)) {
      return res.status(404).json({ success: false, message: "Payment not found" });
    }

    return res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch payment",
      error: error.message,
    });
  }
};

const getPaymentInvoiceOptions = async (req, res) => {
  try {
    await ensurePaymentSchema(pool);
    const result = await pool.query(
      `
      SELECT
        i.id,
        i.invoice_number,
        i.invoice_date,
        i.due_date,
        i.invoice_status,
        i.subtotal,
        i.total_amount,
        i.payment_received_amount,
        i.balance_outstanding,
        i.currency,
        i.client_id,
        i.region_id,
        ${(await getBillToParts(pool)).partyName} AS client_name,
        r.region_name,
        ${await getRegionTdsSelect(pool)},
        p.placement_code,
        p.job_title,
        c.full_name AS candidate_name
      FROM invoices i
      LEFT JOIN clients cl ON i.client_id = cl.id
      JOIN regions r ON i.region_id = r.id
      ${(await getBillToParts(pool)).join}
      LEFT JOIN placements p ON i.placement_id = p.id
      LEFT JOIN candidates c ON p.candidate_id = c.id
      WHERE i.invoice_status <> 'CANCELLED'
      ORDER BY i.id DESC
      `,
    );

    return res.json({ success: true, data: result.rows });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to load invoice options",
      error: error.message,
    });
  }
};

const getNextPaymentCode = async (req, res) => {
  try {
    const paymentCode = await generatePaymentCode(pool);
    const referenceNumber = await generatePaymentReference(pool);

    return res.json({
      success: true,
      data: {
        payment_code: paymentCode,
        reference_number: referenceNumber,
      },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to generate next payment code",
      error: error.message,
    });
  }
};

const createPayment = async (req, res) => {
  const db = await pool.connect();

  try {
    await db.query("BEGIN");
    await ensurePaymentSchema(db);

    const hasPaymentCodeColumn = await hasColumn(db, "payments", "payment_code");

    const {
      payment_code,
      invoice_id,
      invoice_ids,
      payment_date,
      amount_received,
      payment_mode,
      reference_number,
      tds_applicable,
      tds_percent,
      notes,
    } = req.body;

    const targetInvoiceIds = Array.from(
      new Set(
        (Array.isArray(invoice_ids) && invoice_ids.length ? invoice_ids : [invoice_id])
          .filter(Boolean)
          .map((id) => Number(id))
          .filter((id) => Number.isFinite(id) && id > 0),
      ),
    );

    const finalPaymentDate = sanitizeDateInput(payment_date);

    if (!targetInvoiceIds.length || !finalPaymentDate) {
      await db.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "At least one invoice and payment date are required",
      });
    }

    // Lock the target invoice rows for the duration of the transaction so two
    // concurrent payments cannot both read the same outstanding balance and
    // over-collect. The max-receivable checks below then see a serialized view.
    await db.query(`SELECT id FROM invoices WHERE id = ANY($1) FOR UPDATE`, [targetInvoiceIds]);

    const invoices = [];
    for (const targetInvoiceId of targetInvoiceIds) {
      const invoice = await getInvoiceWithContext(db, targetInvoiceId);
      if (!invoice) {
        await db.query("ROLLBACK");
        return res.status(404).json({ success: false, message: `Invoice ${targetInvoiceId} not found` });
      }

      if (String(invoice.invoice_status || "").toUpperCase() === "CANCELLED") {
        await db.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: "Cannot add payment to a cancelled invoice",
        });
      }

      // Row-level RBAC: cannot pay an invoice in an entity outside the caller's scope.
      if (!canActOnEntity(req, invoice.region_id)) {
        await db.query("ROLLBACK");
        return res.status(403).json({ success: false, message: "Not authorized for this entity (region)" });
      }
      invoices.push(invoice);
    }

    // Resolved here rather than from the request alone: TDS can only be withheld
    // when a selected invoice belongs to a region that withholds it, so a stale
    // client posting TDS for a US/UK payment deducts nothing. `some` because a
    // payment may span invoices, and any TDS region in the set makes it apply.
    const regionTdsApplicable = invoices.some(
      (invoice) => invoice.region_tds_applicable === true,
    );
    const tdsApplicable = regionTdsApplicable && normalizeBoolean(tds_applicable);
    const finalTdsPercent = tdsApplicable ? normalizeMoney(tds_percent) : 0;
    if (tdsApplicable && finalTdsPercent <= 0) {
      await db.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "TDS percentage is required when TDS is applicable",
      });
    }

    const invoiceCurrencies = Array.from(
      new Set(
        invoices
          .map((invoice) => normalizeCurrencyCode(invoice.currency, "USD"))
          .filter(Boolean),
      ),
    );

    if (invoiceCurrencies.length > 1) {
      await db.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Selected invoices must use the same currency for a single payment",
      });
    }

    const paymentCurrency = invoiceCurrencies[0] || "USD";
    if (
      paymentCurrency &&
      SUPPORTED_PAYMENT_CURRENCIES.size &&
      !SUPPORTED_PAYMENT_CURRENCIES.has(paymentCurrency)
    ) {
      await db.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `Unsupported payment currency ${paymentCurrency}`,
      });
    }

    const invoiceCredits = invoices.map((invoice) => {
      const tdsAmount = calculateTdsAmount(invoice, tdsApplicable, finalTdsPercent);
      const balance = normalizeMoney(invoice.balance_outstanding);
      return {
        invoice,
        tdsAmount,
        maxCashAmount: Math.max(balance - tdsAmount, 0),
        balance,
      };
    });

    const suggestedCashTotal = invoiceCredits.reduce((sum, item) => sum + item.maxCashAmount, 0);
    let remainingCashAmount = amount_received !== undefined && amount_received !== ""
      ? normalizeMoney(amount_received)
      : suggestedCashTotal;

    const totalTds = invoiceCredits.reduce((sum, item) => sum + item.tdsAmount, 0);
    if (remainingCashAmount <= 0 && totalTds <= 0) {
      await db.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Amount received or TDS amount must be greater than zero",
      });
    }

    if (remainingCashAmount > suggestedCashTotal) {
      await db.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `Amount cannot exceed current net receivable of ${suggestedCashTotal.toFixed(2)}`,
      });
    }

    let finalPaymentCode = null;
    if (hasPaymentCodeColumn) {
      if (payment_code && String(payment_code).trim()) {
        finalPaymentCode = String(payment_code).trim().toUpperCase();
        const existingCode = await db.query(
          `SELECT id FROM payments WHERE payment_code = $1 LIMIT 1`,
          [finalPaymentCode],
        );

        if (existingCode.rows.length) {
          await db.query("ROLLBACK");
          return res.status(400).json({
            success: false,
            message: "Payment code already exists",
          });
        }
      } else {
        finalPaymentCode = await generatePaymentCode(db);
      }
    }

    const finalReferenceNumber = reference_number && String(reference_number).trim()
      ? String(reference_number).trim().toUpperCase()
      : await generatePaymentReference(db);

    const normalizedPaymentMode = normalizeUpperNullable(payment_mode);
    if (normalizedPaymentMode && !ALLOWED_PAYMENT_MODES.includes(normalizedPaymentMode)) {
      await db.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Invalid payment mode",
      });
    }

    const insertColumns = [
      "invoice_id",
      "payment_date",
      "currency",
      "amount_received",
      "payment_mode",
      "reference_number",
      "tds_applicable",
      "tds_percent",
      "tds_amount",
      "notes",
      "created_by",
    ];

    if (hasPaymentCodeColumn) {
      insertColumns.splice(1, 0, "payment_code");
    }

    const placeholders = insertColumns.map((_, index) => `$${index + 1}`).join(", ");
    const createdPayments = [];
    const updatedInvoices = [];

    for (let index = 0; index < invoiceCredits.length; index += 1) {
      const item = invoiceCredits[index];
      const cashAmount = Math.min(item.maxCashAmount, remainingCashAmount);
      remainingCashAmount = Number((remainingCashAmount - cashAmount).toFixed(2));
      const creditedAmount = cashAmount + item.tdsAmount;

      if (creditedAmount <= 0) {
        continue;
      }

      if (creditedAmount > item.balance) {
        await db.query("ROLLBACK");
        return res.status(400).json({
          success: false,
          message: `Credited amount cannot exceed balance for invoice ${item.invoice.invoice_number}`,
        });
      }

      let paymentCodeForRow = finalPaymentCode;
      if (hasPaymentCodeColumn && (!paymentCodeForRow || index > 0)) {
        paymentCodeForRow = await generatePaymentCode(db);
      }

      const insertValues = [
        Number(item.invoice.id),
        finalPaymentDate,
        paymentCurrency,
        cashAmount,
        normalizedPaymentMode,
        finalReferenceNumber,
        tdsApplicable,
        finalTdsPercent || null,
        item.tdsAmount,
        normalizeNullable(notes),
        req.user?.id || null,
      ];
      if (hasPaymentCodeColumn) insertValues.splice(1, 0, paymentCodeForRow);

      const paymentResult = await db.query(
        `
        INSERT INTO payments (${insertColumns.join(", ")})
        VALUES (${placeholders})
        RETURNING *
        `,
        insertValues,
      );

      const payment = paymentResult.rows[0];
      createdPayments.push(payment);

      // Inter-company settlements clear the 1600/2600 pair on BOTH entities,
      // atomically with the payment row. Client payments deliberately post
      // nothing here — that is a pre-existing gap, not an omission of this
      // change; see docs/ARCHITECTURE_AUDIT_MULTILOCATION.md.
      // amount_received holds the cash leg (TDS rides separately), which is
      // what actually moves through 1000 Bank.
      if (await glPosting.glAvailable(db)) {
        if (String(item.invoice.invoice_type) === "INTER_COMPANY") {
          await glPosting.postIcInvoiceSettled(db, item.invoice, {
            id: payment.id,
            amount: payment.amount_received,
            payment_date: payment.payment_date,
            created_by: req.user?.id || null,
          });
        } else {
          // Ordinary customer receipt → Dr Bank (+ Dr TDS receivable), Cr AR,
          // with realized FX as the residual.
          await glPosting.postCustomerReceipt(db, {
            id: payment.id,
            invoice_id: item.invoice.id,
            payment_date: payment.payment_date,
            amount_received: payment.amount_received,
            tds_amount: payment.tds_amount,
            currency: payment.currency || item.invoice.currency,
            payment_code: payment.payment_code,
            created_by: req.user?.id || null,
          }, item.invoice);
        }
      }

      updatedInvoices.push(await recalculateInvoiceTotals(db, item.invoice.id));
    }

    if (!createdPayments.length) {
      await db.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "No payable invoice balance found for the selected invoices",
      });
    }

    const payment = createdPayments[0];

    await db.query("COMMIT");

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "CREATE_PAYMENT",
      entityType: "PAYMENT",
      entityId: payment.id,
      newValues: createdPayments,
      ipAddress: req.ip,
    });

    return res.status(201).json({
      success: true,
      message: "Payment created successfully",
      data: {
        payment,
        payments: createdPayments,
        invoices: updatedInvoices,
      },
    });
  } catch (error) {
    await db.query("ROLLBACK");
    return res.status(500).json({
      success: false,
      message: "Failed to create payment",
      error: error.message,
    });
  } finally {
    db.release();
  }
};

const updatePayment = async (req, res) => {
  const db = await pool.connect();

  try {
    await db.query("BEGIN");
    await ensurePaymentSchema(db);

    const paymentId = Number(req.params.id);
    const hasPaymentCodeColumn = await hasColumn(db, "payments", "payment_code");

    const existingResult = await db.query(`SELECT * FROM payments WHERE id = $1 LIMIT 1`, [paymentId]);
    if (!existingResult.rows.length) {
      await db.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Payment not found" });
    }

    const existingPayment = existingResult.rows[0];

    const {
      payment_code,
      invoice_id,
      payment_date,
      amount_received,
      payment_mode,
      reference_number,
      tds_applicable,
      tds_percent,
      notes,
    } = req.body;

    const targetInvoiceId = Number(invoice_id || existingPayment.invoice_id);
    const finalPaymentDate = payment_date !== undefined
      ? sanitizeDateInput(payment_date)
      : sanitizeDateInput(existingPayment.payment_date);
    const finalAmount = amount_received !== undefined
      ? normalizeMoney(amount_received)
      : normalizeMoney(existingPayment.amount_received);

    if (!targetInvoiceId || !finalPaymentDate) {
      await db.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Invoice and payment date are required",
      });
    }

    if (finalAmount <= 0) {
      await db.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Amount received must be greater than zero",
      });
    }

    const targetInvoice = await getInvoiceWithContext(db, targetInvoiceId);
    if (!targetInvoice) {
      await db.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Invoice not found" });
    }
    if (!canActOnEntity(req, targetInvoice.region_id)) {
      await db.query("ROLLBACK");
      return res.status(403).json({ success: false, message: "Not authorized for this invoice's entity" });
    }

    if (String(targetInvoice.invoice_status || "").toUpperCase() === "CANCELLED") {
      await db.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Cannot attach payment to a cancelled invoice",
      });
    }

    const targetCurrency = normalizeCurrencyCode(targetInvoice.currency, "USD");
    if (
      targetCurrency &&
      SUPPORTED_PAYMENT_CURRENCIES.size &&
      !SUPPORTED_PAYMENT_CURRENCIES.has(targetCurrency)
    ) {
      await db.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `Unsupported payment currency ${targetCurrency}`,
      });
    }

    // Same server-side gate as createPayment: no withholding outside a region
    // configured for TDS, whatever the request (or the stored payment) claims.
    const finalTdsApplicable = targetInvoice.region_tds_applicable === true &&
      (tds_applicable !== undefined
        ? normalizeBoolean(tds_applicable)
        : normalizeBoolean(existingPayment.tds_applicable));
    const finalTdsPercent = finalTdsApplicable
      ? normalizeMoney(tds_percent !== undefined ? tds_percent : existingPayment.tds_percent)
      : 0;
    if (finalTdsApplicable && finalTdsPercent <= 0) {
      await db.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "TDS percentage is required when TDS is applicable",
      });
    }
    const finalTdsAmount = calculateTdsAmount(targetInvoice, finalTdsApplicable, finalTdsPercent);

    const allPaymentsResult = await db.query(
      `
      SELECT COALESCE(SUM(amount_received + COALESCE(tds_amount, 0)), 0) AS total_received
      FROM payments
      WHERE invoice_id = $1 AND id <> $2
      `,
      [targetInvoiceId, paymentId],
    );

    const otherPaymentsTotal = normalizeMoney(allPaymentsResult.rows[0]?.total_received || 0);
    const invoiceTotal = normalizeMoney(targetInvoice.total_amount);
    const allowedMax = Math.max(invoiceTotal - otherPaymentsTotal - finalTdsAmount, 0);

    if (finalAmount > allowedMax) {
      await db.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `Amount cannot exceed remaining allowable balance of ${allowedMax.toFixed(2)}`,
      });
    }

    let finalPaymentCode = hasPaymentCodeColumn ? existingPayment.payment_code : null;
    if (hasPaymentCodeColumn) {
      if (payment_code && String(payment_code).trim()) {
        finalPaymentCode = String(payment_code).trim().toUpperCase();
        const duplicate = await db.query(
          `SELECT id FROM payments WHERE payment_code = $1 AND id <> $2 LIMIT 1`,
          [finalPaymentCode, paymentId],
        );
        if (duplicate.rows.length) {
          await db.query("ROLLBACK");
          return res.status(400).json({
            success: false,
            message: "Payment code already exists",
          });
        }
      } else if (!existingPayment.payment_code) {
        finalPaymentCode = await generatePaymentCode(db);
      }
    }

    const normalizedPaymentMode = payment_mode !== undefined
      ? normalizeUpperNullable(payment_mode)
      : normalizeUpperNullable(existingPayment.payment_mode);

    if (normalizedPaymentMode && !ALLOWED_PAYMENT_MODES.includes(normalizedPaymentMode)) {
      await db.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: "Invalid payment mode",
      });
    }

    const updatedReferenceNumber =
      reference_number !== undefined
        ? normalizeNullable(String(reference_number).trim().toUpperCase())
        : existingPayment.reference_number;

    const updateFields = [
      { column: "invoice_id", value: targetInvoiceId },
      { column: "payment_date", value: finalPaymentDate },
      { column: "currency", value: targetCurrency },
      { column: "amount_received", value: finalAmount },
      { column: "payment_mode", value: normalizedPaymentMode },
      { column: "reference_number", value: updatedReferenceNumber },
      { column: "tds_applicable", value: finalTdsApplicable },
      { column: "tds_percent", value: finalTdsPercent || null },
      { column: "tds_amount", value: finalTdsAmount },
      {
        column: "notes",
        value: notes !== undefined ? normalizeNullable(notes) : existingPayment.notes,
      },
    ];

    if (hasPaymentCodeColumn) {
      updateFields.splice(1, 0, { column: "payment_code", value: finalPaymentCode });
    }

    const setClause = updateFields
      .map((field, index) => `${field.column} = $${index + 1}`)
      .join(", ");
    const values = updateFields.map((field) => field.value);
    values.push(paymentId);

    const updateResult = await db.query(
      `
      UPDATE payments
      SET ${setClause}, updated_at = CURRENT_TIMESTAMP
      WHERE id = $${values.length}
      RETURNING *
      `,
      values,
    );

    if (Number(existingPayment.invoice_id) !== targetInvoiceId) {
      await recalculateInvoiceTotals(db, existingPayment.invoice_id);
    }

    const updatedInvoice = await recalculateInvoiceTotals(db, targetInvoiceId);

    // Re-sync the GL: reverse the payment's prior entry(ies) and re-post at the
    // new amount/date/invoice so the ledger tracks the edit.
    if (await glPosting.glAvailable(db)) {
      const posted = await glPosting.postedEntryIds("AR_PAYMENT", paymentId, db);
      for (const e of posted) await glPosting.reverseEntry(db, e.id, "Payment edited", req.user?.id || null);
      const inv = await getInvoiceWithContext(db, targetInvoiceId);
      const p = updateResult.rows[0];
      if (inv && String(inv.invoice_type) === "INTER_COMPANY") {
        await glPosting.postIcInvoiceSettled(db, inv, { id: p.id, amount: p.amount_received, payment_date: p.payment_date, created_by: req.user?.id || null });
      } else if (inv) {
        await glPosting.postCustomerReceipt(db, {
          id: p.id, invoice_id: inv.id, payment_date: p.payment_date, amount_received: p.amount_received,
          tds_amount: p.tds_amount, currency: p.currency || inv.currency, payment_code: p.payment_code, created_by: req.user?.id || null,
        }, inv);
      }
    }

    await db.query("COMMIT");

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "UPDATE_PAYMENT",
      entityType: "PAYMENT",
      entityId: paymentId,
      oldValues: existingPayment,
      newValues: updateResult.rows[0],
      ipAddress: req.ip,
    });

    return res.json({
      success: true,
      message: "Payment updated successfully",
      data: {
        payment: updateResult.rows[0],
        invoice: updatedInvoice,
      },
    });
  } catch (error) {
    await db.query("ROLLBACK");
    return res.status(500).json({
      success: false,
      message: "Failed to update payment",
      error: error.message,
    });
  } finally {
    db.release();
  }
};

const deletePayment = async (req, res) => {
  const db = await pool.connect();

  try {
    await db.query("BEGIN");

    const paymentId = Number(req.params.id);
    const existingResult = await db.query(
      `SELECT p.*, i.region_id FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.id = $1 LIMIT 1`,
      [paymentId],
    );

    if (!existingResult.rows.length || !canActOnEntity(req, existingResult.rows[0].region_id)) {
      await db.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "Payment not found" });
    }

    const existingPayment = existingResult.rows[0];

    // Reverse the receipt's ledger entry(ies) so the GL stays balanced when the
    // payment is removed (posted+reversal pair retained for audit).
    if (await glPosting.glAvailable(db)) {
      const posted = await glPosting.postedEntryIds("AR_PAYMENT", paymentId, db);
      for (const e of posted) await glPosting.reverseEntry(db, e.id, "Payment deleted", req.user?.id || null);
    }

    await db.query(`DELETE FROM payments WHERE id = $1`, [paymentId]);
    const updatedInvoice = await recalculateInvoiceTotals(db, existingPayment.invoice_id);

    await db.query("COMMIT");

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "DELETE_PAYMENT",
      entityType: "PAYMENT",
      entityId: paymentId,
      oldValues: existingPayment,
      newValues: null,
      ipAddress: req.ip,
    });

    return res.json({
      success: true,
      message: "Payment deleted successfully",
      data: {
        invoice: updatedInvoice,
      },
    });
  } catch (error) {
    await db.query("ROLLBACK");
    return res.status(500).json({
      success: false,
      message: "Failed to delete payment",
      error: error.message,
    });
  } finally {
    db.release();
  }
};

// GET /api/payments/export?format=xlsx&from=&to=&search=&invoice_id=&payment_mode=&region_id=&region_name=
const exportPayments = async (req, res) => {
  try {
    const { search = "", invoice_id = "", payment_mode = "", region_id = "", region_name = "", from = "", to = "" } = req.query;
    const baseQuery = await buildPaymentSelectQuery(pool);
    const conditions = [];
    const values = [];
    let idx = 1;
    if (invoice_id) { conditions.push(`p.invoice_id = $${idx++}`); values.push(Number(invoice_id)); }
    if (payment_mode) { conditions.push(`COALESCE(p.payment_mode, '') = $${idx++}`); values.push(String(payment_mode).trim().toUpperCase()); }
    if (region_id) { conditions.push(`i.region_id = $${idx++}`); values.push(Number(region_id)); }
    if (region_name) { conditions.push(`r.region_name = $${idx++}`); values.push(region_name); }
    if (from) { conditions.push(`p.payment_date >= $${idx++}`); values.push(from); }
    if (to) { conditions.push(`p.payment_date <= $${idx++}`); values.push(to); }
    if (req.scopeEnforced && Array.isArray(req.allowedEntityIds)) { conditions.push(`i.region_id = ANY($${idx++})`); values.push(req.allowedEntityIds); }
    if (search) {
      conditions.push(`(i.invoice_number ILIKE $${idx} OR cl.client_name ILIKE $${idx} OR COALESCE(c.full_name, '') ILIKE $${idx} OR COALESCE(p.reference_number, '') ILIKE $${idx})`);
      values.push(`%${search}%`); idx += 1;
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await pool.query(`${baseQuery} ${where} ORDER BY p.payment_date DESC, p.id DESC`, values);

    const cache = new Map();
    let totalUsd = 0;
    const rows = [];
    for (const r of result.rows) {
      const usd = await convertToUsd(r.amount_received, r.currency, cache);
      totalUsd += usd;
      rows.push({
        payment_date: String(r.payment_date).slice(0, 10),
        payment_code: r.payment_code || "",
        invoice_number: r.invoice_number || "",
        client_name: r.client_name || "",
        region_name: r.region_name || "",
        payment_mode: r.payment_mode || "",
        reference_number: r.reference_number || "",
        currency: r.currency,
        amount_received: Number(r.amount_received || 0),
        amount_usd: usd,
      });
    }
    const rangeLabel = (from || to) ? `${from || "…"} to ${to || "…"}` : "All dates";
    const report = {
      title: "Payments",
      subtitle: `${rangeLabel} · ${rows.length} payment(s) · collected total in USD (consolidated)`,
      columns: [
        { key: "payment_date", label: "Date", type: "text" },
        { key: "payment_code", label: "Payment #", type: "text" },
        { key: "invoice_number", label: "Invoice #", type: "text" },
        { key: "client_name", label: "Client", type: "text" },
        { key: "region_name", label: "Location", type: "text" },
        { key: "payment_mode", label: "Mode", type: "text" },
        { key: "reference_number", label: "Reference", type: "text" },
        { key: "currency", label: "Currency", type: "text" },
        { key: "amount_received", label: "Amount", type: "money" },
        { key: "amount_usd", label: "Amount (USD)", type: "money" },
      ],
      rows,
      totals: { amount_usd: Math.round(totalUsd * 100) / 100 },
    };
    return await sendReport(res, report, req.query.format || "xlsx");
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to export payments", error: error.message });
  }
};

const downloadReceiptPdf = async (req, res) => {
  try {
    const baseQuery = await buildPaymentSelectQuery(pool);
    const result = await pool.query(`${baseQuery} WHERE p.id = $1 LIMIT 1`, [req.params.id]);
    const payment = result.rows[0];
    if (!payment || !canActOnEntity(req, payment.region_id)) {
      return res.status(404).json({ success: false, message: "Payment not found" });
    }
    const { generatePaymentReceiptPdf } = require("../utils/paymentReceiptPdf");
    return generatePaymentReceiptPdf(payment, res);
  } catch (error) {
    return res.status(500).json({ success: false, message: "Failed to generate receipt", error: error.message });
  }
};

module.exports = {
  getAllPayments,
  exportPayments,
  getPaymentById,
  downloadReceiptPdf,
  getPaymentInvoiceOptions,
  getNextPaymentCode,
  createPayment,
  updatePayment,
  deletePayment,
};

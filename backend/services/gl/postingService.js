// =============================================================================
// postingService — map subledger documents (AR invoice, AP bill, expense,
// reimbursement) to balanced journal entries and post them via ledgerEngine.
//
// Each helper resolves the operational location, builds its line array, and
// delegates to ledgerEngine.postEntry — the single race-free, hash-chained,
// integer-precise posting core. reverseEntry posts a reversing entry through
// the same path for corrections.
//
// Pass a pg client (`db`) to post inside the same transaction as the document.
// =============================================================================

const pool = require("../../config/db");
const currency = require("../currency/currencyService");
const ledger = require("./ledgerEngine");

// Resolve the operational location for a posting: an explicit location_id on the
// source document wins; otherwise default to the owning entity's HQ branch.
// entity_id == region_id (see migration 004); location_id references org_units.
async function resolveLocationId(entityId, explicitLocationId, db = pool) {
  if (explicitLocationId) return Number(explicitLocationId);
  const { rows } = await db.query(
    `SELECT b.id
       FROM org_units e
       JOIN org_units b ON b.parent_id = e.id AND b.unit_type = 'BRANCH'
      WHERE e.unit_type = 'ENTITY' AND e.region_id = $1
      ORDER BY (b.code LIKE '%-HQ') DESC, b.id
      LIMIT 1`,
    [entityId],
  );
  if (!rows.length)
    throw new Error(`No branch/location found for entity (region) ${entityId}`);
  return Number(rows[0].id);
}

// node-postgres returns DATE columns as JS Date objects; String(d).slice(0,10)
// would yield "Thu Jan 01". Normalize any date value to a local YYYY-MM-DD key.
const dateKey = (v) => {
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  }
  return String(v).slice(0, 10);
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// ---- lookups ---------------------------------------------------------------
const _accountCache = new Map();
async function accountIdByCode(code, db = pool) {
  if (_accountCache.has(code)) return _accountCache.get(code);
  const { rows } = await db.query(
    "SELECT id FROM chart_of_accounts WHERE account_code = $1 AND is_active = true",
    [code],
  );
  if (!rows.length) throw new Error(`Account code not found: ${code}`);
  _accountCache.set(code, rows[0].id);
  return rows[0].id;
}

// True only once migration 002 has created the GL tables. Lets controllers
// wire posting in safely before the GL is rolled out (skips silently if absent).
async function glAvailable(db = pool) {
  const { rows } = await db.query(
    "SELECT to_regclass('public.journal_entries') AS t",
  );
  return rows[0].t !== null;
}

// Has this source document already been posted? Keeps posting idempotent.
//
// A reversal entry inherits its target's source + source_ref (see reverseEntry)
// and is itself POSTED, so it MUST be excluded — otherwise, after an edit
// reverses the original, this guard sees the reversal, reports the document as
// still posted, and the re-post silently skips. That left six live invoices with
// negated revenue in the GL (e.g. PRODAPT-21 at -412,800). A reversal is exactly
// an entry some other row points at via reversed_by.
async function alreadyPosted(source, sourceRef, db = pool) {
  const { rows } = await db.query(
    `SELECT je.id FROM journal_entries je
      WHERE je.source = $1 AND je.source_ref = $2 AND je.status = 'POSTED'
        AND NOT EXISTS (
          SELECT 1 FROM journal_entries o WHERE o.reversed_by = je.id
        )
      LIMIT 1`,
    [source, String(sourceRef)],
  );
  return rows.length ? rows[0].id : null;
}

async function entityFunctional(entityId, db = pool) {
  const { rows } = await db.query(
    "SELECT COALESCE(functional_currency, default_currency) AS ccy FROM regions WHERE id = $1",
    [entityId],
  );
  if (!rows.length) throw new Error(`Entity (region) ${entityId} not found`);
  return rows[0].ccy;
}

// ---- core ------------------------------------------------------------------

/** Post a reversing entry for an existing POSTED entry (corrections). */
async function reverseEntry(db, entryId, reason, createdBy) {
  const { rows: hdr } = await db.query(
    "SELECT * FROM journal_entries WHERE id = $1",
    [entryId],
  );
  if (!hdr.length) throw new Error(`Entry ${entryId} not found`);
  if (hdr[0].status !== "POSTED")
    throw new Error(`Only POSTED entries can be reversed`);
  const { rows: ls } = await db.query(
    "SELECT * FROM journal_lines WHERE entry_id = $1",
    [entryId],
  );

  const today = new Date().toISOString().slice(0, 10);
  const locationId = await resolveLocationId(hdr[0].entity_id, hdr[0].location_id, db);
  const reversed = await ledger.postEntry(
    db,
    {
      entityId: hdr[0].entity_id,
      locationId,
      entryDate: today,
      source: hdr[0].source,
      sourceRef: hdr[0].source_ref,
      description: `Reversal of ${hdr[0].entry_no}: ${reason || ""}`,
      userId: createdBy,
    },
    ls.map((l) => ({
      accountId: l.account_id, // reuse resolved account id
      locationId: l.location_id,
      currency: l.currency,
      debit: l.credit,
      credit: l.debit, // swap sides
      exchangeRate: l.exchange_rate,
      debitBase: l.credit_base,
      creditBase: l.debit_base,
      memo: "reversal",
    })),
  );

  await db.query(
    "UPDATE journal_entries SET status = 'REVERSED', reversed_by = $1 WHERE id = $2",
    [reversed.id, entryId],
  );
  return reversed;
}

/**
 * Manual journal entry posted by a finance user from the UI.
 * Lines are entered directly in the entity's functional currency, so the
 * transaction amount equals the base amount (exchangeRate = 1). Validation of
 * balance, period-open and location authorization is handled by ledgerEngine.
 * payload: { entityId, entryDate, description, locationId?, userId,
 *            lines: [{ accountId|accountCode, debit?, credit?, memo? }] }
 */
async function postManualEntry(db, payload) {
  const entityId = Number(payload.entityId);
  const date = dateKey(payload.entryDate);
  const functional = await entityFunctional(entityId, db);

  const lines = (payload.lines || []).map((l) => {
    const debit = round2(Number(l.debit || 0));
    const credit = round2(Number(l.credit || 0));
    return {
      accountId: l.accountId ? Number(l.accountId) : undefined,
      accountCode: l.accountCode || undefined,
      currency: functional,
      exchangeRate: 1,
      debit,
      credit,
      debitBase: debit,
      creditBase: credit,
      memo: l.memo || null,
    };
  });

  const locationId = await resolveLocationId(entityId, payload.locationId, db);
  return ledger.postEntry(
    db,
    {
      entityId,
      locationId,
      entryDate: date,
      source: "MANUAL",
      sourceRef: payload.sourceRef == null ? null : String(payload.sourceRef),
      description: payload.description || "Manual journal entry",
      userId: payload.userId,
    },
    lines,
  );
}

// ---- subledger -> GL posting helpers --------------------------------------

/**
 * AR invoice issued:  Dr Accounts Receivable (total)
 *                     Cr Staffing Revenue (subtotal); Cr Taxes Payable (tax)
 * invoice: { id, region_id, invoice_date, currency, subtotal, tax_amount, total_amount, client_id, placement_id, created_by }
 */
async function postInvoiceIssued(db, invoice) {
  const existing = await alreadyPosted("AR_INVOICE", invoice.id, db);
  if (existing) return { id: existing, entryNo: null, skipped: true };

  const entityId = invoice.region_id;
  const date = dateKey(invoice.invoice_date);
  const functional = await entityFunctional(entityId, db);
  const { exchangeRate } = await currency.toFunctional(
    1,
    invoice.currency,
    entityId,
    date,
    db,
  );
  const base = (amt) => round2(Number(amt) * exchangeRate);

  // Convert the credit side, then make the AR (control) line the residual so the
  // entry always balances to the cent regardless of FX rounding.
  const revenueBase = base(invoice.subtotal);
  const taxBase = Number(invoice.tax_amount) > 0 ? base(invoice.tax_amount) : 0;
  const arBase = round2(revenueBase + taxBase);

  const lines = [
    {
      accountCode: "1100",
      debit: invoice.total_amount,
      debitBase: arBase,
      currency: invoice.currency,
      exchangeRate,
      memo: "AR invoice",
      clientId: invoice.client_id,
      placementId: invoice.placement_id,
    },
    {
      accountCode: "4000",
      credit: invoice.subtotal,
      creditBase: revenueBase,
      currency: invoice.currency,
      exchangeRate,
      memo: "Revenue",
      clientId: invoice.client_id,
      placementId: invoice.placement_id,
    },
  ];
  if (taxBase > 0) {
    lines.push({
      accountCode: "2100",
      credit: invoice.tax_amount,
      creditBase: taxBase,
      currency: invoice.currency,
      exchangeRate,
      memo: "Output tax",
      clientId: invoice.client_id,
    });
  }

  const locationId = await resolveLocationId(entityId, invoice.location_id, db);
  return ledger.postEntry(
    db,
    {
      entityId,
      locationId,
      entryDate: date,
      source: "AR_INVOICE",
      sourceRef: String(invoice.id),
      description: `Invoice ${invoice.invoice_number || invoice.id}`,
      userId: invoice.created_by,
    },
    lines,
  );
}

/**
 * All POSTED entry ids for a source document. Unlike alreadyPosted (which
 * answers "is it posted?" with one id), an inter-company document has TWO
 * legs sharing source + source_ref, told apart by entity_id — both are needed
 * to reverse or repost it.
 */
async function postedEntryIds(source, sourceRef, db = pool) {
  const { rows } = await db.query(
    `SELECT je.id, je.entity_id FROM journal_entries je
      WHERE je.source = $1 AND je.source_ref = $2 AND je.status = 'POSTED'
        AND NOT EXISTS (
          SELECT 1 FROM journal_entries o WHERE o.reversed_by = je.id
        )
      ORDER BY je.id`,
    [source, String(sourceRef)],
  );
  return rows;
}

/**
 * Inter-company invoice issued — TWO balanced entries, one per entity, posted
 * atomically in the caller's transaction:
 *
 *   issuer (invoice.region_id):        Dr 1600 Due From  / Cr 4600 IC Revenue
 *   counterparty (bill_to_region_id):  Dr 5700 IC Cost   / Cr 2600 Due To
 *
 * Each leg is valued into ITS OWN entity's functional currency at the invoice
 * date, so the two legs match in transaction currency but deliberately not in
 * base (e.g. GBP 3,750 against USD 5,000). Each balances within its own entity,
 * which is what trg_je_balanced checks.
 *
 * Inter-company invoices are zero-rated (migration 016), so subtotal == total
 * and 2100 is never touched.
 *
 * Both legs carry the creating user's id, so ledgerEngine.assertCanPost demands
 * POST/ADMIN on BOTH entities' locations — same rule intercompanyService.
 * postTransfer already applies to transfers. A user scoped to one entity alone
 * cannot raise an inter-company invoice; that is deliberate, not an oversight.
 *
 * invoice: { id, invoice_number, region_id, bill_to_region_id, invoice_date,
 *            currency, subtotal, tax_amount, total_amount, created_by, location_id }
 */
async function postIcInvoiceIssued(db, invoice) {
  const existing = await alreadyPosted("IC_INVOICE", invoice.id, db);
  if (existing) return { id: existing, skipped: true };

  const issuerEntity = Number(invoice.region_id);
  const counterpartyEntity = Number(invoice.bill_to_region_id);

  if (!counterpartyEntity)
    throw new Error("bill_to_region_id is required to post an inter-company invoice");
  if (issuerEntity === counterpartyEntity)
    throw new Error("An entity cannot invoice itself");
  if (Number(invoice.tax_amount) > 0)
    throw new Error("Inter-company invoices are zero-rated; tax_amount must be 0");

  const date = dateKey(invoice.invoice_date);
  const total = Number(invoice.total_amount);
  const ccy = invoice.currency;

  // One rate date (the document date), two directions — each into its own
  // entity's functional currency.
  const issuerFx = await currency.toFunctional(total, ccy, issuerEntity, date, db);
  const counterpartyFx = await currency.toFunctional(total, ccy, counterpartyEntity, date, db);

  const issuerLocation = await resolveLocationId(issuerEntity, invoice.location_id, db);
  const counterpartyLocation = await resolveLocationId(counterpartyEntity, null, db);
  const label = invoice.invoice_number || invoice.id;

  const issuerEntry = await ledger.postEntry(
    db,
    {
      entityId: issuerEntity,
      locationId: issuerLocation,
      entryDate: date,
      source: "IC_INVOICE",
      sourceRef: String(invoice.id),
      description: `Inter-company invoice ${label} (issued)`,
      userId: invoice.created_by,
    },
    [
      { accountCode: "1600", debit: total, debitBase: issuerFx.amountBase, currency: ccy, exchangeRate: issuerFx.exchangeRate, memo: "Due from related entity" },
      { accountCode: "4600", credit: total, creditBase: issuerFx.amountBase, currency: ccy, exchangeRate: issuerFx.exchangeRate, memo: "Inter-company revenue" },
    ],
  );

  const counterpartyEntry = await ledger.postEntry(
    db,
    {
      entityId: counterpartyEntity,
      locationId: counterpartyLocation,
      entryDate: date,
      source: "IC_INVOICE",
      sourceRef: String(invoice.id),
      description: `Inter-company invoice ${label} (received)`,
      userId: invoice.created_by,
    },
    [
      { accountCode: "5700", debit: total, debitBase: counterpartyFx.amountBase, currency: ccy, exchangeRate: counterpartyFx.exchangeRate, memo: "Inter-company cost" },
      { accountCode: "2600", credit: total, creditBase: counterpartyFx.amountBase, currency: ccy, exchangeRate: counterpartyFx.exchangeRate, memo: "Due to related entity" },
    ],
  );

  return {
    skipped: false,
    issuerEntryId: issuerEntry.id,
    counterpartyEntryId: counterpartyEntry.id,
  };
}

/**
 * Inter-company settlement — clears the 1600/2600 pair raised by
 * postIcInvoiceIssued, on both sides, when the counterparty pays:
 *
 *   issuer (is paid):        Dr 1000 Bank        / Cr 1600 Due From
 *   counterparty (pays):     Dr 2600 Due To      / Cr 1000 Bank
 *
 * The monetary account is cleared at the rate it was CARRIED at (the invoice
 * date), while cash moves at the SETTLEMENT rate. The difference is a realized
 * FX gain (4900) or loss (5900) — booked in the entity's functional currency at
 * rate 1, the same shape fxRevaluationService uses for 4910/5910.
 *
 * Because the ledger validates balance in base only (ledgerEngine), the FX line
 * is derived as the residual, so each leg balances to the cent regardless of
 * rounding. An entity whose functional currency equals the invoice currency
 * gets rate 1 on both dates and therefore no FX line at all.
 *
 * Partial payments are supported: `amount` is settled proportionally at the
 * invoice-date rate.
 *
 * NOTE: this is the ONLY payment path in the codebase that posts to the GL.
 * Client (non inter-company) payments post nothing — see docs/
 * ARCHITECTURE_AUDIT_MULTILOCATION.md §"AR payments post no GL".
 *
 * payment: { id, amount, payment_date, created_by }
 */
async function postIcInvoiceSettled(db, invoice, payment) {
  const existing = await alreadyPosted("AR_PAYMENT", payment.id, db);
  if (existing) return { id: existing, skipped: true };

  const issuerEntity = Number(invoice.region_id);
  const counterpartyEntity = Number(invoice.bill_to_region_id);
  if (!counterpartyEntity)
    throw new Error("bill_to_region_id is required to settle an inter-company invoice");

  const invoiceDate = dateKey(invoice.invoice_date);
  const settleDate = dateKey(payment.payment_date);
  const amount = Number(payment.amount);
  const ccy = invoice.currency;

  if (!Number.isFinite(amount) || amount <= 0)
    throw new Error("Settlement amount must be greater than 0");

  // Build one leg: two main lines plus an FX residual line when the carrying
  // rate and the settlement rate disagree.
  const buildLeg = async (entityId, monetaryCode, monetaryIsDebit, memoPair) => {
    const functional = await entityFunctional(entityId, db);
    const carried = await currency.toFunctional(amount, ccy, entityId, invoiceDate, db);
    const settled = await currency.toFunctional(amount, ccy, entityId, settleDate, db);

    // Cash always moves at the settlement rate; the monetary account clears at
    // the rate it was carried at.
    const bankBase = settled.amountBase;
    const monetaryBase = carried.amountBase;

    const lines = monetaryIsDebit
      ? [
          { accountCode: monetaryCode, debit: amount, debitBase: monetaryBase, currency: ccy, exchangeRate: carried.exchangeRate, memo: memoPair[0] },
          { accountCode: "1000", credit: amount, creditBase: bankBase, currency: ccy, exchangeRate: settled.exchangeRate, memo: memoPair[1] },
        ]
      : [
          { accountCode: "1000", debit: amount, debitBase: bankBase, currency: ccy, exchangeRate: settled.exchangeRate, memo: memoPair[1] },
          { accountCode: monetaryCode, credit: amount, creditBase: monetaryBase, currency: ccy, exchangeRate: carried.exchangeRate, memo: memoPair[0] },
        ];

    // Residual = base debits - base credits. >0 needs a credit (gain); <0 needs
    // a debit (loss).
    const residual = round2(
      lines.reduce((s, l) => s + Number(l.debitBase || 0) - Number(l.creditBase || 0), 0),
    );
    if (Math.abs(residual) >= 0.005) {
      const a = Math.abs(residual);
      lines.push(
        residual > 0
          ? { accountCode: "4900", credit: a, creditBase: a, currency: functional, exchangeRate: 1, memo: "Realized FX gain on inter-company settlement" }
          : { accountCode: "5900", debit: a, debitBase: a, currency: functional, exchangeRate: 1, memo: "Realized FX loss on inter-company settlement" },
      );
    }
    return lines;
  };

  const label = invoice.invoice_number || invoice.id;

  const issuerLines = await buildLeg(issuerEntity, "1600", false, [
    "Clear due from related entity",
    "Bank — inter-company receipt",
  ]);
  const issuerEntry = await ledger.postEntry(
    db,
    {
      entityId: issuerEntity,
      locationId: await resolveLocationId(issuerEntity, invoice.location_id, db),
      entryDate: settleDate,
      source: "AR_PAYMENT",
      sourceRef: String(payment.id),
      description: `Inter-company settlement ${label} (received)`,
      userId: payment.created_by,
    },
    issuerLines,
  );

  const counterpartyLines = await buildLeg(counterpartyEntity, "2600", true, [
    "Clear due to related entity",
    "Bank — inter-company payment",
  ]);
  const counterpartyEntry = await ledger.postEntry(
    db,
    {
      entityId: counterpartyEntity,
      locationId: await resolveLocationId(counterpartyEntity, null, db),
      entryDate: settleDate,
      source: "AR_PAYMENT",
      sourceRef: String(payment.id),
      description: `Inter-company settlement ${label} (paid)`,
      userId: payment.created_by,
    },
    counterpartyLines,
  );

  return {
    skipped: false,
    issuerEntryId: issuerEntry.id,
    counterpartyEntryId: counterpartyEntry.id,
  };
}

/**
 * Ordinary customer receipt (non-inter-company):
 *   Dr Bank (cash received, at the settlement rate)
 *   Dr TDS Receivable (tax the customer withheld, if any)
 *   Cr Accounts Receivable (amount applied, cleared at the invoice's carrying rate)
 *   ± Realized FX gain/loss (the residual when the two rates disagree)
 * payment: { id, invoice_id, payment_date, amount_received, tds_amount, currency, created_by }
 * invoice: { region_id, invoice_date, currency, client_id, location_id }
 */
async function postCustomerReceipt(db, payment, invoice) {
  const existing = await alreadyPosted("AR_PAYMENT", payment.id, db);
  if (existing) return { id: existing, skipped: true };

  const entityId = Number(invoice.region_id);
  const ccy = payment.currency || invoice.currency;
  const cash = round2(payment.amount_received);
  const tds = round2(payment.tds_amount || 0);
  const applied = round2(cash + tds); // total reduction of the invoice's AR
  if (!(cash > 0) && !(tds > 0)) throw new Error("Receipt amount must be greater than 0");

  const functional = await entityFunctional(entityId, db);
  const settled = await currency.toFunctional(1, ccy, entityId, dateKey(payment.payment_date), db);
  const carried = await currency.toFunctional(1, ccy, entityId, dateKey(invoice.invoice_date), db);
  const rate = settled.exchangeRate, arRate = carried.exchangeRate;

  const lines = [
    { accountCode: "1000", debit: cash, debitBase: round2(cash * rate), currency: ccy, exchangeRate: rate, memo: "Bank — customer receipt", clientId: invoice.client_id },
  ];
  if (tds > 0) {
    lines.push({ accountCode: "1200", debit: tds, debitBase: round2(tds * rate), currency: ccy, exchangeRate: rate, memo: "TDS withheld by customer", clientId: invoice.client_id });
  }
  lines.push({ accountCode: "1100", credit: applied, creditBase: round2(applied * arRate), currency: ccy, exchangeRate: arRate, memo: "Clear accounts receivable", clientId: invoice.client_id });

  const residual = round2(lines.reduce((s, l) => s + Number(l.debitBase || 0) - Number(l.creditBase || 0), 0));
  if (Math.abs(residual) >= 0.005) {
    const a = Math.abs(residual);
    lines.push(residual > 0
      ? { accountCode: "4900", credit: a, creditBase: a, currency: functional, exchangeRate: 1, memo: "Realized FX gain on receipt" }
      : { accountCode: "5900", debit: a, debitBase: a, currency: functional, exchangeRate: 1, memo: "Realized FX loss on receipt" });
  }

  return ledger.postEntry(db, {
    entityId,
    locationId: await resolveLocationId(entityId, invoice.location_id, db),
    entryDate: dateKey(payment.payment_date),
    source: "AR_PAYMENT",
    sourceRef: String(payment.id),
    description: `Receipt ${payment.payment_code || payment.id}`,
    userId: payment.created_by,
  }, lines);
}

/**
 * Vendor payment (AP disbursement):
 *   Dr Accounts Payable (amount, cleared at the bill's carrying rate)
 *   Cr Bank (cash paid, at the settlement rate)
 *   ± Realized FX gain/loss (residual)
 * vpayment: { id, bill_id, payment_date, amount_paid, currency, created_by }
 * bill: { region_id, bill_date, currency, vendor_id, location_id }
 */
async function postVendorPayment(db, vpayment, bill) {
  const existing = await alreadyPosted("AP_PAYMENT", vpayment.id, db);
  if (existing) return { id: existing, skipped: true };

  const entityId = Number(bill.region_id);
  const ccy = vpayment.currency || bill.currency;
  const cash = round2(vpayment.amount_paid);
  if (!(cash > 0)) throw new Error("Payment amount must be greater than 0");

  const functional = await entityFunctional(entityId, db);
  const settled = await currency.toFunctional(1, ccy, entityId, dateKey(vpayment.payment_date), db);
  const carried = await currency.toFunctional(1, ccy, entityId, dateKey(bill.bill_date), db);
  const rate = settled.exchangeRate, apRate = carried.exchangeRate;

  const lines = [
    { accountCode: "2000", debit: cash, debitBase: round2(cash * apRate), currency: ccy, exchangeRate: apRate, memo: "Clear accounts payable", vendorId: bill.vendor_id },
    { accountCode: "1000", credit: cash, creditBase: round2(cash * rate), currency: ccy, exchangeRate: rate, memo: "Bank — vendor payment", vendorId: bill.vendor_id },
  ];
  const residual = round2(lines.reduce((s, l) => s + Number(l.debitBase || 0) - Number(l.creditBase || 0), 0));
  if (Math.abs(residual) >= 0.005) {
    const a = Math.abs(residual);
    lines.push(residual > 0
      ? { accountCode: "4900", credit: a, creditBase: a, currency: functional, exchangeRate: 1, memo: "Realized FX gain on vendor payment" }
      : { accountCode: "5900", debit: a, debitBase: a, currency: functional, exchangeRate: 1, memo: "Realized FX loss on vendor payment" });
  }

  return ledger.postEntry(db, {
    entityId,
    locationId: await resolveLocationId(entityId, bill.location_id, db),
    entryDate: dateKey(vpayment.payment_date),
    source: "AP_PAYMENT",
    sourceRef: String(vpayment.id),
    description: `Vendor payment ${vpayment.payment_code || vpayment.id}`,
    userId: vpayment.created_by,
  }, lines);
}

/**
 * AP bill entered:  Dr Contractor Cost (subtotal); Dr Input Tax (if any)
 *                   Cr Accounts Payable (total)
 * bill: { id, region_id, bill_date, currency, subtotal, tax_amount, total_amount, vendor_id, created_by }
 */
async function postBillEntered(db, bill) {
  const existing = await alreadyPosted("AP_BILL", bill.id, db);
  if (existing) return { id: existing, entryNo: null, skipped: true };

  const entityId = bill.region_id;
  const date = dateKey(bill.bill_date);
  const { exchangeRate } = await currency.toFunctional(
    1,
    bill.currency,
    entityId,
    date,
    db,
  );
  const base = (amt) => round2(Number(amt) * exchangeRate);

  // Convert the debit side, then make AP (control) the residual to avoid FX rounding drift.
  const costBase = base(bill.subtotal);
  const taxBase = Number(bill.tax_amount) > 0 ? base(bill.tax_amount) : 0;
  const apBase = round2(costBase + taxBase);

  const lines = [
    {
      accountCode: "5000",
      debit: bill.subtotal,
      debitBase: costBase,
      currency: bill.currency,
      exchangeRate,
      memo: "Contractor/vendor cost",
      vendorId: bill.vendor_id,
    },
    {
      accountCode: "2000",
      credit: bill.total_amount,
      creditBase: apBase,
      currency: bill.currency,
      exchangeRate,
      memo: "AP bill",
      vendorId: bill.vendor_id,
    },
  ];
  if (taxBase > 0) {
    lines.splice(1, 0, {
      accountCode: "2100",
      debit: bill.tax_amount,
      debitBase: taxBase,
      currency: bill.currency,
      exchangeRate,
      memo: "Input tax",
      vendorId: bill.vendor_id,
    });
  }

  const locationId = await resolveLocationId(entityId, bill.location_id, db);
  return ledger.postEntry(
    db,
    {
      entityId,
      locationId,
      entryDate: date,
      source: "AP_BILL",
      sourceRef: String(bill.id),
      description: `Bill ${bill.bill_number || bill.id}`,
      userId: bill.created_by,
    },
    lines,
  );
}

/**
 * Operating expense recorded:
 *   Dr Expense (category account)         amount
 *   Dr Input GST Recoverable (1400)       gst        (if > 0)
 *      Cr Payment account / Reimbursements payable    amount + gst - tds
 *      Cr TDS Payable (2200)              tds        (if > 0)
 * expense: { id, region_id, expense_date, currency, amount, gst_amount, tds_amount,
 *            expense_account_code, credit_account_code, description, vendor_id, created_by }
 */
async function postExpense(db, expense) {
  const existing = await alreadyPosted("EXPENSE", expense.id, db);
  if (existing) return { id: existing, entryNo: null, skipped: true };

  const entityId = expense.region_id;
  const date = dateKey(expense.expense_date);
  const { exchangeRate } = await currency.toFunctional(1, expense.currency, entityId, date, db);
  const base = (a) => round2(Number(a) * exchangeRate);

  const amount = Number(expense.amount || 0);
  const gst = Number(expense.gst_amount || 0);
  const tds = Number(expense.tds_amount || 0);
  const net = round2(amount + gst - tds);

  const amountBase = base(amount);
  const gstBase = gst > 0 ? base(gst) : 0;
  const tdsBase = tds > 0 ? base(tds) : 0;
  const netBase = round2(amountBase + gstBase - tdsBase); // residual -> always balances

  if (!expense.expense_account_code || !expense.credit_account_code) {
    throw new Error("postExpense: expense_account_code and credit_account_code required");
  }

  const lines = [
    { accountCode: expense.expense_account_code, debit: amount, debitBase: amountBase,
      currency: expense.currency, exchangeRate, memo: expense.description || "Expense", vendorId: expense.vendor_id || null },
  ]
  if (gst > 0) lines.push({ accountCode: "1400", debit: gst, debitBase: gstBase, currency: expense.currency, exchangeRate, memo: "Input GST" })
  lines.push({ accountCode: expense.credit_account_code, credit: net, creditBase: netBase, currency: expense.currency, exchangeRate, memo: "Payment", vendorId: expense.vendor_id || null })
  if (tds > 0) lines.push({ accountCode: "2200", credit: tds, creditBase: tdsBase, currency: expense.currency, exchangeRate, memo: "TDS withheld" })

  const locationId = await resolveLocationId(entityId, expense.location_id, db);
  return ledger.postEntry(db, {
    entityId, locationId, entryDate: date, source: "EXPENSE", sourceRef: String(expense.id),
    description: expense.description || `Expense ${expense.id}`, userId: expense.created_by,
  }, lines);
}

/**
 * Reimbursement of an out-of-pocket expense:
 *   Dr Reimbursements Payable (clearing)   net
 *      Cr Bank / payment account           net
 * Routes through the hash-chained, location-aware engine like every other
 * subledger (was the last path still using the legacy createJournalEntry).
 * expense: { id, entity_id, currency, amount, gst_amount, tds_amount,
 *            location_id?, paid_by?, created_by? }
 */
async function postExpenseReimbursement(db, expense, opts = {}) {
  const existing = await alreadyPosted("EXPENSE_REIMBURSE", expense.id, db);
  if (existing) return { id: existing, entryNo: null, skipped: true };

  const entityId = expense.entity_id;
  const reimbursementCode = String(opts.reimbursementCode || "2500");
  const bankCode = String(opts.bankCode || "1000");
  const date = new Date().toISOString().slice(0, 10);
  const { exchangeRate } = await currency.toFunctional(1, expense.currency, entityId, date, db);
  const net = round2(
    Number(expense.amount || 0) + Number(expense.gst_amount || 0) - Number(expense.tds_amount || 0),
  );
  const netBase = round2(net * exchangeRate);

  const lines = [
    { accountCode: reimbursementCode, debit: net, debitBase: netBase, currency: expense.currency,
      exchangeRate, memo: `Reimburse ${expense.paid_by || ""}` },
    { accountCode: bankCode, credit: net, creditBase: netBase, currency: expense.currency,
      exchangeRate, memo: "Reimbursement paid" },
  ];

  const locationId = await resolveLocationId(entityId, expense.location_id, db);
  return ledger.postEntry(db, {
    entityId, locationId, entryDate: date, source: "EXPENSE_REIMBURSE", sourceRef: String(expense.id),
    description: `Reimbursement for expense ${expense.id}`, userId: expense.created_by,
  }, lines);
}

module.exports = {
  postManualEntry,
  reverseEntry,
  postInvoiceIssued,
  postIcInvoiceIssued,
  postIcInvoiceSettled,
  postCustomerReceipt,
  postVendorPayment,
  postedEntryIds,
  postBillEntered,
  postExpense,
  postExpenseReimbursement,
  glAvailable,
  alreadyPosted,
  accountIdByCode,
  entityFunctional,
  resolveLocationId,
  round2,
};

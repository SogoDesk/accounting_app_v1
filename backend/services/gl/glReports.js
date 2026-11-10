// =============================================================================
// glReports — Trial Balance, Profit & Loss, Balance Sheet over the GL
//
// Two modes for every report:
//   * Per entity  -> pass { entityId }; amounts are in that entity's functional
//                    currency, no translation.
//   * Consolidated-> omit entityId; each entity's functional amounts are
//                    translated to the group currency (USD) at the report date
//                    using the dated exchange_rates table.
//
// Only POSTED entries are included. All figures derive from journal_lines, so a
// balanced ledger guarantees a balanced trial balance.
// =============================================================================

const pool = require("../../config/db");
const currency = require("../currency/currencyService");

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// The calendar day before an ISO date — used for "opening balance" cutoffs so
// the period's first day isn't double-counted in both opening and movement.
const dayBeforeISO = (iso) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

async function groupCurrency(db = pool) {
  const { rows } = await db.query("SELECT group_currency FROM company_settings WHERE id = 1");
  return rows.length ? rows[0].group_currency : "USD";
}

// Translate a functional-currency amount to the group currency as of a date.
async function toGroup(amount, fromCcy, groupCcy, asOf, cache, db) {
  if (fromCcy === groupCcy) return amount;
  const key = `${fromCcy}->${groupCcy}@${asOf}`;
  if (!cache.has(key)) {
    const { rate } = await currency.getRate(fromCcy, groupCcy, asOf, db);
    cache.set(key, rate);
  }
  return round2(amount * cache.get(key));
}

// Shared aggregation: net movement per account (+ entity + functional ccy).
async function accountMovements({ entityId, allowedEntityIds, from, to, types }, db = pool) {
  const params = [];
  const where = ["je.status = 'POSTED'"];
  if (to) { params.push(to); where.push(`je.entry_date <= $${params.length}`); }
  if (from) { params.push(from); where.push(`je.entry_date >= $${params.length}`); }
  if (entityId) { params.push(entityId); where.push(`jl.entity_id = $${params.length}`); }
  // Row-level RBAC: restrict consolidated/per-entity totals to allowed entities.
  if (Array.isArray(allowedEntityIds)) {
    params.push(allowedEntityIds); where.push(`jl.entity_id = ANY($${params.length})`);
  }
  if (types && types.length) {
    params.push(types);
    where.push(`a.account_type = ANY($${params.length})`);
  }

  const { rows } = await db.query(
    `SELECT a.account_code, a.account_name, a.account_type, a.normal_balance,
            jl.entity_id,
            COALESCE(reg.functional_currency, reg.default_currency) AS func_ccy,
            SUM(jl.debit_base)  AS debit_base,
            SUM(jl.credit_base) AS credit_base
       FROM journal_lines jl
       JOIN journal_entries je ON jl.entry_id = je.id
       JOIN chart_of_accounts a ON jl.account_id = a.id
       JOIN regions reg ON jl.entity_id = reg.id
      WHERE ${where.join(" AND ")}
      GROUP BY a.account_code, a.account_name, a.account_type, a.normal_balance,
               jl.entity_id, reg.functional_currency, reg.default_currency
      ORDER BY a.account_code`,
    params,
  );
  return rows;
}

/**
 * Trial Balance as of a date.
 * @returns { currency, asOf, rows:[{account_code,account_name,account_type,debit,credit,balance}], totals:{debit,credit,balanced} }
 */
async function trialBalance({ entityId, allowedEntityIds, asOf } = {}, db = pool) {
  const date = asOf || new Date().toISOString().slice(0, 10);
  const grpCcy = entityId ? null : await groupCurrency(db);
  const rateCache = new Map();
  const movements = await accountMovements({ entityId, allowedEntityIds, to: date }, db);

  const byAccount = new Map();
  for (const m of movements) {
    const d = entityId ? Number(m.debit_base) : await toGroup(Number(m.debit_base), m.func_ccy, grpCcy, date, rateCache, db);
    const c = entityId ? Number(m.credit_base) : await toGroup(Number(m.credit_base), m.func_ccy, grpCcy, date, rateCache, db);
    const cur = byAccount.get(m.account_code) || {
      account_code: m.account_code, account_name: m.account_name,
      account_type: m.account_type, debit: 0, credit: 0,
    };
    cur.debit += d; cur.credit += c;
    byAccount.set(m.account_code, cur);
  }

  let totalDebit = 0, totalCredit = 0;
  const rows = [...byAccount.values()].map((r) => {
    const net = round2(r.debit - r.credit); // +ve = net debit
    const debit = net >= 0 ? net : 0;
    const credit = net < 0 ? -net : 0;
    totalDebit += debit; totalCredit += credit;
    return { ...r, debit: round2(r.debit), credit: round2(r.credit), balance: net,
             tb_debit: debit, tb_credit: credit };
  });

  return {
    currency: entityId ? movements[0]?.func_ccy || null : grpCcy,
    asOf: date,
    rows,
    totals: { debit: round2(totalDebit), credit: round2(totalCredit),
              balanced: Math.abs(totalDebit - totalCredit) < 0.01 },
  };
}

/**
 * Profit & Loss for a date range.
 * @returns { currency, from, to, income:[...], expense:[...], totals:{income,expense,netProfit} }
 */
async function profitAndLoss({ entityId, allowedEntityIds, from, to } = {}, db = pool) {
  const start = from || new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
  const end = to || new Date().toISOString().slice(0, 10);
  const grpCcy = entityId ? null : await groupCurrency(db);
  const rateCache = new Map();
  const movements = await accountMovements({ entityId, allowedEntityIds, from: start, to: end, types: ["INCOME", "EXPENSE"] }, db);

  const income = [], expense = [];
  let totalIncome = 0, totalExpense = 0;
  for (const m of movements) {
    const d = entityId ? Number(m.debit_base) : await toGroup(Number(m.debit_base), m.func_ccy, grpCcy, end, rateCache, db);
    const c = entityId ? Number(m.credit_base) : await toGroup(Number(m.credit_base), m.func_ccy, grpCcy, end, rateCache, db);
    if (m.account_type === "INCOME") {
      const amt = round2(c - d);                 // income is credit-normal
      totalIncome += amt;
      income.push({ account_code: m.account_code, account_name: m.account_name, amount: amt });
    } else {
      const amt = round2(d - c);                 // expense is debit-normal
      totalExpense += amt;
      expense.push({ account_code: m.account_code, account_name: m.account_name, amount: amt });
    }
  }

  return {
    currency: entityId ? movements[0]?.func_ccy || null : grpCcy,
    from: start, to: end,
    income, expense,
    totals: { income: round2(totalIncome), expense: round2(totalExpense),
              netProfit: round2(totalIncome - totalExpense) },
  };
}

/**
 * Balance Sheet as of a date. Equity includes retained earnings + current
 * net income (income - expense to date), so Assets = Liabilities + Equity.
 */
async function balanceSheet({ entityId, allowedEntityIds, asOf } = {}, db = pool) {
  const date = asOf || new Date().toISOString().slice(0, 10);
  const grpCcy = entityId ? null : await groupCurrency(db);
  const rateCache = new Map();
  const movements = await accountMovements({ entityId, allowedEntityIds, to: date }, db);

  const section = { ASSET: [], LIABILITY: [], EQUITY: [] };
  let assets = 0, liabilities = 0, equity = 0, income = 0, expense = 0;

  for (const m of movements) {
    const d = entityId ? Number(m.debit_base) : await toGroup(Number(m.debit_base), m.func_ccy, grpCcy, date, rateCache, db);
    const c = entityId ? Number(m.credit_base) : await toGroup(Number(m.credit_base), m.func_ccy, grpCcy, date, rateCache, db);
    if (m.account_type === "ASSET") {
      const amt = round2(d - c); assets += amt;
      section.ASSET.push({ account_code: m.account_code, account_name: m.account_name, amount: amt });
    } else if (m.account_type === "LIABILITY") {
      const amt = round2(c - d); liabilities += amt;
      section.LIABILITY.push({ account_code: m.account_code, account_name: m.account_name, amount: amt });
    } else if (m.account_type === "EQUITY") {
      const amt = round2(c - d); equity += amt;
      section.EQUITY.push({ account_code: m.account_code, account_name: m.account_name, amount: amt });
    } else if (m.account_type === "INCOME") {
      income += round2(c - d);
    } else if (m.account_type === "EXPENSE") {
      expense += round2(d - c);
    }
  }

  const netIncome = round2(income - expense);
  section.EQUITY.push({ account_code: "RE", account_name: "Retained earnings (incl. current period)", amount: netIncome });
  const totalEquity = round2(equity + netIncome);

  return {
    currency: entityId ? movements[0]?.func_ccy || null : grpCcy,
    asOf: date,
    assets: section.ASSET, liabilities: section.LIABILITY, equity: section.EQUITY,
    totals: {
      assets: round2(assets), liabilities: round2(liabilities), equity: totalEquity,
      balanced: Math.abs(assets - (liabilities + totalEquity)) < 0.01,
    },
  };
}

/**
 * Consolidated statements over an org subtree, with intercompany eliminations.
 * (Blueprint Step 4 / audit §4.3.) Restricts to locations under rootLocationId
 * (default the GRP root), translates each entity's functional totals to the
 * group currency at the report date, EXCLUDES the reciprocal intercompany
 * control accounts 1600/2600 from the statements, and returns their net as an
 * `eliminations` reconciliation figure that must be ≈ 0.
 *
 * @returns { currency, asOf, rootLocationId, accounts, profitAndLoss,
 *            balanceSheet, eliminations:{ intercompanyNet, balanced } }
 */
async function consolidated({ rootLocationId, asOf, allowedEntityIds } = {}, db = pool) {
  const date = asOf || new Date().toISOString().slice(0, 10);
  const grpCcy = await groupCurrency(db);

  // resolve the subtree root path (default GRP)
  let rootPath = null;
  let rootId = rootLocationId ? Number(rootLocationId) : null;
  if (rootId) {
    const r = await db.query("SELECT path FROM org_units WHERE id = $1", [rootId]);
    if (!r.rows.length) throw new Error(`Org unit ${rootId} not found`);
    rootPath = r.rows[0].path;
  } else {
    const r = await db.query("SELECT id, path FROM org_units WHERE code = 'GRP' LIMIT 1");
    if (r.rows.length) { rootId = Number(r.rows[0].id); rootPath = r.rows[0].path; }
  }

  const params = [date, rootPath ? rootPath + "%" : "%"];
  let scopeFilter = "";
  if (Array.isArray(allowedEntityIds)) {
    params.push(allowedEntityIds);
    scopeFilter = `AND jl.entity_id = ANY($${params.length})`;
  }

  const { rows } = await db.query(
    `SELECT a.account_code, a.account_name, a.account_type, jl.entity_id,
            COALESCE(reg.functional_currency, reg.default_currency) AS func_ccy,
            SUM(jl.base_minor_debit - jl.base_minor_credit) AS net_minor
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'POSTED' AND je.entry_date <= $1
       JOIN chart_of_accounts a ON a.id = jl.account_id
       JOIN regions reg ON reg.id = jl.entity_id
      WHERE jl.location_id IN (SELECT id FROM org_units WHERE path LIKE $2) ${scopeFilter}
      GROUP BY a.account_code, a.account_name, a.account_type, jl.entity_id,
               reg.functional_currency, reg.default_currency
      ORDER BY a.account_code`,
    params,
  );

  const rateCache = new Map();
  const byAccount = new Map();
  // Balance-sheet elimination: 1600 + 2600 must net ~0 once both sides are
  // translated. They only do because fxRevaluationService remeasures them to
  // the closing rate; without that the issue-rate and closing-rate sides differ.
  let intercompanyNet = 0; // translated, debit-positive
  // P&L elimination: 4600 + 5700. These are NOT monetary items — revenue and
  // cost are booked at the transaction-date rate and never remeasured, so once
  // rates move the two sides translate to different group amounts. The residual
  // is a genuine translation difference, not a break, and is reported on its own
  // rather than being folded into `balanced`.
  let intercompanyPnlNet = 0;
  // Gross inter-company volume (sum of absolute translated legs), used to scale
  // the balance tolerance below. Accumulated, not derived from the nets, which
  // cancel by construction.
  let intercompanyGross = 0;

  for (const m of rows) {
    const netFunc = Number(m.net_minor) / 100; // debit - credit; +ve = net debit
    const netGrp = await toGroup(netFunc, m.func_ccy, grpCcy, date, rateCache, db);
    if (m.account_code === "1600" || m.account_code === "2600") {
      intercompanyNet = round2(intercompanyNet + netGrp);
      intercompanyGross = round2(intercompanyGross + Math.abs(netGrp));
      continue; // ELIMINATED from the consolidated statements
    }
    if (m.account_code === "4600" || m.account_code === "5700") {
      intercompanyPnlNet = round2(intercompanyPnlNet + netGrp);
      continue; // ELIMINATED — inter-company revenue/cost is not group revenue
    }
    const cur = byAccount.get(m.account_code) || {
      account_code: m.account_code, account_name: m.account_name,
      account_type: m.account_type, net: 0,
    };
    cur.net = round2(cur.net + netGrp);
    byAccount.set(m.account_code, cur);
  }

  const accounts = [...byAccount.values()];
  const income = [], expense = [], assetRows = [], liabilityRows = [], equityRows = [];
  let totalIncome = 0, totalExpense = 0, assets = 0, liabilities = 0, equity = 0;

  for (const r of accounts) {
    if (r.account_type === "INCOME") {
      const amt = round2(-r.net); totalIncome += amt;
      income.push({ account_code: r.account_code, account_name: r.account_name, amount: amt });
    } else if (r.account_type === "EXPENSE") {
      const amt = round2(r.net); totalExpense += amt;
      expense.push({ account_code: r.account_code, account_name: r.account_name, amount: amt });
    } else if (r.account_type === "ASSET") {
      const amt = round2(r.net); assets += amt;
      assetRows.push({ account_code: r.account_code, account_name: r.account_name, amount: amt });
    } else if (r.account_type === "LIABILITY") {
      const amt = round2(-r.net); liabilities += amt;
      liabilityRows.push({ account_code: r.account_code, account_name: r.account_name, amount: amt });
    } else if (r.account_type === "EQUITY") {
      const amt = round2(-r.net); equity += amt;
      equityRows.push({ account_code: r.account_code, account_name: r.account_name, amount: amt });
    }
  }

  const netIncome = round2(totalIncome - totalExpense);
  equityRows.push({ account_code: "RE", account_name: "Retained earnings (incl. current period)", amount: netIncome });

  // Translation adjustment — the residual left by the two eliminations above.
  //
  // Dropping 1600/2600 removes (net1600 + net2600) from assets/liabilities;
  // dropping 4600/5700 removes (net4600 + net5700) from retained earnings. Both
  // pairs derive from the SAME transaction, so with a single rate they cancel
  // and this is 0. Once rates move they don't: the monetary pair is remeasured
  // to the closing rate by fxRevaluationService while the P&L pair stays at its
  // transaction-date rate. The gap is a real translation difference — the CTA
  // concept (account 3200) — and the balance sheet would be out by exactly this
  // much if it weren't carried back into equity.
  //
  // Derivation: post-elimination, assets - (liabilities + equity + RE) equals
  // -(intercompanyNet + intercompanyPnlNet), so equity needs that negated.
  //
  // Presented, never posted — a report must not write journal entries. Booking
  // it to 3200 is a ledger concern and belongs in the close process.
  const translationDifference = round2(-(intercompanyNet + intercompanyPnlNet));

  // Elimination tolerance, scaled to inter-company volume.
  //
  // A flat 0.01 only ever worked for same-currency transfers, where the
  // round-trip is exact. exchange_rates stores each direction INDEPENDENTLY and
  // the pairs are not reciprocal (e.g. USD->GBP 0.74150000 against GBP->USD
  // 1.34870000, whose true inverse is 1.34861767). A leg posted through one
  // direction and translated back through the other therefore cannot close: on
  // USD 5,000 the gap is ~0.31, which is rate precision, not a real break.
  //
  // 5bp of gross absorbs that while still catching a genuinely unmatched leg,
  // which would be orders of magnitude larger. Deliberately scoped to this
  // check — toGroup's lookup is the global conversion path and is left alone.
  const icTolerance = round2(Math.max(0.01, intercompanyGross * 0.0005));
  if (Math.abs(translationDifference) >= 0.01) {
    equityRows.push({
      account_code: "CTA",
      account_name: "Translation adjustment (inter-company elimination)",
      amount: translationDifference,
    });
  }
  const totalEquity = round2(equity + netIncome + translationDifference);

  return {
    currency: grpCcy,
    asOf: date,
    rootLocationId: rootId,
    accounts,
    profitAndLoss: {
      income, expense,
      totals: { income: round2(totalIncome), expense: round2(totalExpense), netProfit: netIncome },
    },
    balanceSheet: {
      assets: assetRows, liabilities: liabilityRows, equity: equityRows,
      totals: {
        assets: round2(assets), liabilities: round2(liabilities), equity: totalEquity,
        balanced: Math.abs(assets - (liabilities + totalEquity)) < 0.01,
      },
    },
    eliminations: {
      // Balance-sheet pair (1600/2600). Nets to ~0 once revalued — this is the
      // reconciliation figure worth alerting on.
      intercompanyNet: round2(intercompanyNet),
      // P&L pair (4600/5700), removed from group revenue and cost.
      intercompanyPnlNet: round2(intercompanyPnlNet),
      // The residual carried into equity as "Translation adjustment". Expected
      // to be non-zero whenever rates move; NOT a break.
      translationDifference,
      // Gross inter-company volume the tolerance is scaled against.
      intercompanyGross: round2(intercompanyGross),
      // What `balanced` actually tolerated, surfaced so the number is auditable
      // rather than silently absorbed. Non-zero is normal for cross-currency.
      eliminationResidual: round2(intercompanyNet),
      eliminationTolerance: icTolerance,
      // Keyed on the monetary pair only. The P&L residual is a translation
      // difference, so folding it in here would report a false break.
      balanced: Math.abs(intercompanyNet) <= icTolerance,
    },
  };
}

/**
 * Account register — the running transaction history for ONE account.
 * Opening balance = net movement before `from`; each line carries a running
 * balance in the account's normal-balance direction. Per-entity only (amounts
 * in that entity's functional currency); requires entityId for an unambiguous
 * single-currency running balance.
 * @returns { account, currency, from, to, opening, closing, rows:[...] }
 */
async function accountRegister({ accountId, entityId, allowedEntityIds, from, to } = {}, db = pool) {
  const acc = await db.query(
    "SELECT id, account_code, account_name, account_type, normal_balance FROM chart_of_accounts WHERE id = $1",
    [accountId],
  );
  if (!acc.rows.length) throw new Error(`Account ${accountId} not found`);
  const account = acc.rows[0];
  const sign = account.normal_balance === "DEBIT" ? 1 : -1; // running balance direction

  const ccyRow = entityId
    ? await db.query("SELECT COALESCE(functional_currency, default_currency) AS ccy FROM regions WHERE id = $1", [entityId])
    : { rows: [] };
  const currencyCode = ccyRow.rows[0]?.ccy || null;

  const scope = [];
  const scopeParams = [accountId];
  if (entityId) { scopeParams.push(entityId); scope.push(`jl.entity_id = $${scopeParams.length}`); }
  if (Array.isArray(allowedEntityIds)) { scopeParams.push(allowedEntityIds); scope.push(`jl.entity_id = ANY($${scopeParams.length})`); }
  const scopeSql = scope.length ? `AND ${scope.join(" AND ")}` : "";

  // opening balance (everything strictly before `from`)
  let opening = 0;
  if (from) {
    const op = await db.query(
      `SELECT COALESCE(SUM(jl.debit_base - jl.credit_base), 0) AS net
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'POSTED'
        WHERE jl.account_id = $1 AND je.entry_date < $${scopeParams.length + 1} ${scopeSql}`,
      [...scopeParams, from],
    );
    opening = round2(Number(op.rows[0].net) * sign);
  }

  const params = [accountId];
  const where = ["jl.account_id = $1", "je.status = 'POSTED'"];
  if (from) { params.push(from); where.push(`je.entry_date >= $${params.length}`); }
  if (to) { params.push(to); where.push(`je.entry_date <= $${params.length}`); }
  if (entityId) { params.push(entityId); where.push(`jl.entity_id = $${params.length}`); }
  if (Array.isArray(allowedEntityIds)) { params.push(allowedEntityIds); where.push(`jl.entity_id = ANY($${params.length})`); }

  const { rows } = await db.query(
    `SELECT je.id AS entry_id, je.entry_no, je.entry_date, je.source, je.description,
            r.region_name AS entity_name, jl.debit_base, jl.credit_base, jl.memo
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN regions r ON r.id = jl.entity_id
      WHERE ${where.join(" AND ")}
      ORDER BY je.entry_date ASC, je.id ASC, jl.id ASC`,
    params,
  );

  let running = opening;
  let debitTotal = 0, creditTotal = 0;
  const lines = rows.map((m) => {
    const debit = round2(Number(m.debit_base));
    const credit = round2(Number(m.credit_base));
    running = round2(running + sign * (debit - credit));
    debitTotal += debit; creditTotal += credit;
    return {
      entry_id: m.entry_id, entry_no: m.entry_no,
      entry_date: m.entry_date, source: m.source,
      description: m.description, entity_name: m.entity_name,
      memo: m.memo, debit, credit, balance: running,
    };
  });

  return {
    account,
    currency: currencyCode,
    from: from || null,
    to: to || null,
    opening,
    closing: running,
    totals: { debit: round2(debitTotal), credit: round2(creditTotal) },
    rows: lines,
  };
}

/**
 * General Ledger — every account with its opening balance, period movement and
 * closing balance. A compact, drill-down-friendly version of the full GL.
 * @returns { currency, from, to, rows:[{account_code,account_name,account_type,opening,debit,credit,closing}] }
 */
async function generalLedger({ entityId, allowedEntityIds, from, to } = {}, db = pool) {
  const end = to || new Date().toISOString().slice(0, 10);
  const grpCcy = entityId ? null : await groupCurrency(db);
  const rateCache = new Map();

  // opening (strictly before `from`) and period movements, per account + entity
  const openingMoves = from ? await accountMovements({ entityId, allowedEntityIds, to: dayBeforeISO(from) }, db) : [];
  const periodMoves = await accountMovements({ entityId, allowedEntityIds, from, to: end }, db);

  const sign = (t) => (t === "ASSET" || t === "EXPENSE" ? 1 : -1);
  const byAccount = new Map();
  const ensure = (m) =>
    byAccount.get(m.account_code) ||
    byAccount.set(m.account_code, {
      account_code: m.account_code, account_name: m.account_name,
      account_type: m.account_type, opening: 0, debit: 0, credit: 0,
    }).get(m.account_code);

  for (const m of openingMoves) {
    const d = entityId ? Number(m.debit_base) : await toGroup(Number(m.debit_base), m.func_ccy, grpCcy, from, rateCache, db);
    const c = entityId ? Number(m.credit_base) : await toGroup(Number(m.credit_base), m.func_ccy, grpCcy, from, rateCache, db);
    const a = ensure(m);
    a.opening = round2(a.opening + sign(m.account_type) * (d - c));
  }
  for (const m of periodMoves) {
    const d = entityId ? Number(m.debit_base) : await toGroup(Number(m.debit_base), m.func_ccy, grpCcy, end, rateCache, db);
    const c = entityId ? Number(m.credit_base) : await toGroup(Number(m.credit_base), m.func_ccy, grpCcy, end, rateCache, db);
    const a = ensure(m);
    a.debit = round2(a.debit + d);
    a.credit = round2(a.credit + c);
  }

  const rows = [...byAccount.values()].map((a) => ({
    ...a,
    closing: round2(a.opening + sign(a.account_type) * (a.debit - a.credit)),
  }));

  return {
    currency: entityId ? periodMoves[0]?.func_ccy || openingMoves[0]?.func_ccy || null : grpCcy,
    from: from || null,
    to: end,
    rows,
  };
}

/**
 * Cash Flow (direct method, derived straight from the ledger).
 * Looks at every entry that moves a cash/bank account, then attributes each
 * cash movement to Operating / Investing / Financing using the OTHER side of
 * the entry. Because every cash movement is captured, the three buckets always
 * reconcile to (closing cash − opening cash).
 *
 * Cash accounts: ASSET accounts whose code starts with "10" (Bank/Cash range).
 * Bucketing of the contra line by its account family:
 *   INCOME / EXPENSE / LIABILITY -> Operating
 *   ASSET (non-cash)             -> Investing
 *   EQUITY                       -> Financing
 * @returns { currency, from, to, opening, closing, netChange,
 *            operating, investing, financing, sections:{...} }
 */
async function cashFlow({ entityId, allowedEntityIds, from, to } = {}, db = pool) {
  const start = from || new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
  const end = to || new Date().toISOString().slice(0, 10);
  const grpCcy = entityId ? null : await groupCurrency(db);
  const rateCache = new Map();

  const params = [];
  const where = ["je.status = 'POSTED'"];
  if (entityId) { params.push(entityId); where.push(`jl.entity_id = $${params.length}`); }
  if (Array.isArray(allowedEntityIds)) { params.push(allowedEntityIds); where.push(`jl.entity_id = ANY($${params.length})`); }
  const baseWhere = where.join(" AND ");

  // Entries that touch a cash account (ASSET, code like '10%').
  const cashEntrySql = `
    SELECT DISTINCT je.id
      FROM journal_entries je
      JOIN journal_lines jl ON jl.entry_id = je.id
      JOIN chart_of_accounts a ON a.id = jl.account_id
     WHERE ${baseWhere} AND a.account_type = 'ASSET' AND a.account_code LIKE '10%'`;

  // Opening cash (before start) and closing cash (through end), translated.
  const cashBalanceAsOf = async (cutoff, rateDate) => {
    const p = [...params, cutoff];
    const { rows } = await db.query(
      `SELECT COALESCE(reg.functional_currency, reg.default_currency) AS func_ccy,
              SUM(jl.debit_base - jl.credit_base) AS net
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'POSTED'
         JOIN chart_of_accounts a ON a.id = jl.account_id
         JOIN regions reg ON reg.id = jl.entity_id
        WHERE a.account_type = 'ASSET' AND a.account_code LIKE '10%'
          AND je.entry_date <= $${p.length}
          ${entityId ? `AND jl.entity_id = $1` : ""}
          ${Array.isArray(allowedEntityIds) ? `AND jl.entity_id = ANY($${entityId ? 2 : 1})` : ""}
        GROUP BY reg.functional_currency, reg.default_currency`,
      p,
    );
    let total = 0;
    for (const r of rows) {
      const net = Number(r.net);
      total += entityId ? net : await toGroup(net, r.func_ccy, grpCcy, rateDate, rateCache, db);
    }
    return round2(total);
  };

  const opening = await cashBalanceAsOf(dayBeforeISO(start), start);
  const closing = await cashBalanceAsOf(end, end);

  // Contra lines (non-cash) of cash-touching entries within the period.
  const contraParams = [...params, start, end];
  const { rows: contra } = await db.query(
    `SELECT a.account_type, a.account_code, a.account_name,
            COALESCE(reg.functional_currency, reg.default_currency) AS func_ccy,
            SUM(jl.credit_base - jl.debit_base) AS cash_in
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN chart_of_accounts a ON a.id = jl.account_id
       JOIN regions reg ON reg.id = jl.entity_id
      WHERE je.id IN (${cashEntrySql})
        AND NOT (a.account_type = 'ASSET' AND a.account_code LIKE '10%')
        AND je.entry_date >= $${contraParams.length - 1}
        AND je.entry_date <= $${contraParams.length}
      GROUP BY a.account_type, a.account_code, a.account_name, reg.functional_currency, reg.default_currency
      ORDER BY a.account_code`,
    contraParams,
  );

  const bucketOf = (type) => {
    if (type === "EQUITY") return "financing";
    if (type === "ASSET") return "investing";
    return "operating"; // INCOME, EXPENSE, LIABILITY
  };

  const sections = { operating: [], investing: [], financing: [] };
  const totals = { operating: 0, investing: 0, financing: 0 };
  const merge = new Map();
  for (const r of contra) {
    const amtFunc = Number(r.cash_in); // +ve = cash inflow
    const amt = entityId ? round2(amtFunc) : await toGroup(amtFunc, r.func_ccy, grpCcy, end, rateCache, db);
    const bucket = bucketOf(r.account_type);
    const key = `${bucket}:${r.account_code}`;
    const cur = merge.get(key) || { bucket, account_code: r.account_code, account_name: r.account_name, amount: 0 };
    cur.amount = round2(cur.amount + amt);
    merge.set(key, cur);
  }
  for (const r of merge.values()) {
    sections[r.bucket].push({ account_code: r.account_code, account_name: r.account_name, amount: r.amount });
    totals[r.bucket] = round2(totals[r.bucket] + r.amount);
  }

  const netChange = round2(totals.operating + totals.investing + totals.financing);
  // In a single currency this is ~0. Consolidated to USD, opening and closing are
  // translated at different dates, so the gap is the translation effect on cash —
  // the standard "effect of exchange rate changes on cash" reconciling line.
  const fxEffect = round2(closing - opening - netChange);

  return {
    currency: entityId ? contra[0]?.func_ccy || null : grpCcy,
    from: start,
    to: end,
    opening,
    closing,
    netChange,
    fxEffect,
    operating: totals.operating,
    investing: totals.investing,
    financing: totals.financing,
    // opening + netChange + fxEffect = closing, by construction
    reconciles: Math.abs(round2(opening + netChange + fxEffect) - closing) < 0.01,
    sections,
  };
}

module.exports = {
  trialBalance,
  profitAndLoss,
  balanceSheet,
  consolidated,
  accountRegister,
  generalLedger,
  cashFlow,
};

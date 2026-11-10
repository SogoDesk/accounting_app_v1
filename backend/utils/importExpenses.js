// =============================================================================
// importExpenses.js — load the Office Expense Tracker spreadsheet into the DB
//
//   Run:  cd backend && node utils/importExpenses.js
//   Data: utils/expenses_import_data.json (parsed from your .xlsx)
//
// Loads recurring (fixed) expenses and all transactions into the new Expenses
// module, posting each transaction to the general ledger. Idempotent: every
// imported row is tagged in notes ([imp:tx<n>] / [imp:fx<n>]) and skipped on
// re-run, so you can run it again safely.
//
// Requires migration 003 applied. GL posting also needs 001 + 002; if the GL
// isn't ready the rows still load (just unposted).
// =============================================================================

require("dotenv").config();
const path = require("path");
const fs = require("fs");
const pool = require("../config/db");
const glPosting = require("../services/gl/postingService");
const currency = require("../services/currency/currencyService");

const REIMBURSEMENTS_ACCOUNT = "2500";
const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const num = (v) => { const n = Number(v || 0); return Number.isNaN(n) ? 0 : n; };

function classifyMethod(name) {
  const s = String(name || "").toLowerCase();
  if (/card|amex|icici|rbl|one card|\bcc\b|credit/.test(s)) return { type: "CARD", code: "2400" };
  if (/cash|petty/.test(s)) return { type: "CASH", code: "1050" };
  return { type: "BANK", code: "1000" };
}

async function main() {
  const dataPath = path.join(__dirname, "expenses_import_data.json");
  if (!fs.existsSync(dataPath)) { console.error("Missing", dataPath); process.exit(1); }
  const { recurring, transactions } = JSON.parse(fs.readFileSync(dataPath, "utf8"));

  const db = await pool.connect();
  try {
    // schema present?
    const ready = (await db.query("SELECT to_regclass('public.expenses') AS t")).rows[0].t;
    if (!ready) { console.error("Expenses tables not found — apply migration 003 first."); process.exit(1); }

    // resolve the entity (India by default; override with IMPORT_REGION_CODE/ID)
    let entityId;
    if (process.env.IMPORT_REGION_ID) entityId = Number(process.env.IMPORT_REGION_ID);
    else {
      const code = process.env.IMPORT_REGION_CODE || "IN";
      const r = await db.query(
        `SELECT id, region_name FROM regions WHERE region_code = $1 OR region_name ILIKE '%india%' ORDER BY (region_code=$1) DESC LIMIT 1`, [code]);
      if (!r.rows.length) {
        const all = await db.query("SELECT id, region_code, region_name FROM regions ORDER BY id");
        console.error("No India region found. Set IMPORT_REGION_ID to one of:");
        all.rows.forEach((x) => console.error(`   ${x.id}  ${x.region_code}  ${x.region_name}`));
        process.exit(1);
      }
      entityId = r.rows[0].id;
      console.log("Importing into entity:", r.rows[0].region_name, `(id ${entityId})`);
    }

    // caches
    const acctCodeCache = new Map();
    const accountCodeById = async (id) => {
      if (!id) return null;
      if (acctCodeCache.has(id)) return acctCodeCache.get(id);
      const { rows } = await db.query("SELECT account_code FROM chart_of_accounts WHERE id=$1", [id]);
      const code = rows.length ? rows[0].account_code : null;
      acctCodeCache.set(id, code); return code;
    };

    // category name -> id (create missing -> 6000)
    const catMap = new Map();
    (await db.query("SELECT id, lower(name) AS n FROM expense_categories")).rows.forEach((r) => catMap.set(r.n, r.id));
    async function categoryId(name) {
      if (!name) return null;
      const key = name.toLowerCase();
      if (catMap.has(key)) return catMap.get(key);
      // Reference data is created on `pool` (own commit), NOT the per-row txn `db`,
      // on purpose: the id is cached in catMap, so it must survive a later row's
      // ROLLBACK or subsequent rows would reference a rolled-back category. Inserts
      // are idempotent (ON CONFLICT), so independent commit is safe here.
      const acct = (await pool.query("SELECT id FROM chart_of_accounts WHERE account_code='6000'")).rows[0]?.id || null;
      const ins = await pool.query("INSERT INTO expense_categories (name, gl_account_id) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id", [name, acct]);
      catMap.set(key, ins.rows[0].id); return ins.rows[0].id;
    }

    // payment method name -> id (create missing, classified)
    const pmMap = new Map();
    (await db.query("SELECT id, lower(name) AS n FROM payment_methods")).rows.forEach((r) => pmMap.set(r.n, r.id));
    async function paymentMethodId(name) {
      if (!name) return null;
      const key = name.toLowerCase();
      if (pmMap.has(key)) return pmMap.get(key);
      const { type, code } = classifyMethod(name);
      const acct = (await pool.query("SELECT id FROM chart_of_accounts WHERE account_code=$1", [code])).rows[0]?.id || null;
      const ins = await pool.query("INSERT INTO payment_methods (name, method_type, gl_account_id) VALUES ($1,$2,$3) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id", [name, type, acct]);
      pmMap.set(key, ins.rows[0].id); return ins.rows[0].id;
    }

    const glReady = await glPosting.glAvailable(db);
    if (!glReady) console.log("Note: GL not enabled (migrations 001/002) — rows will load unposted.");

    // ---- recurring templates ----
    let recCreated = 0, recSkipped = 0;
    for (const t of recurring) {
      const marker = `[imp:fx${t.row}]`;
      const exists = await db.query("SELECT 1 FROM recurring_expenses WHERE notes LIKE $1 LIMIT 1", [`%${marker}%`]);
      if (exists.rowCount) { recSkipped++; continue; }
      const catId = await categoryId(t.category);
      const pmId = await paymentMethodId(t.payment_method);
      await db.query(
        `INSERT INTO recurring_expenses
          (entity_id, name, category_id, vendor_name, payment_method_id, currency,
           actual_cost, gst_percent, tds_percent, amount, period_months, monthly_equiv,
           start_month, end_month, is_active, notes)
         VALUES ($1,$2,$3,$4,$5,'INR',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [entityId, t.name, catId, t.vendor_name, pmId, t.actual_cost, t.gst_percent, t.tds_percent,
         t.amount, t.period_months, t.monthly_equiv, t.start_month, t.end_month, t.active,
         `${t.notes || ""} ${marker}`.trim()]);
      recCreated++;
    }

    // ---- transactions ----
    let txCreated = 0, txSkipped = 0, txFailed = 0;
    for (const t of transactions) {
      const marker = `[imp:tx${t.row}]`;
      const exists = await db.query("SELECT 1 FROM expenses WHERE notes LIKE $1 LIMIT 1", [`%${marker}%`]);
      if (exists.rowCount) { txSkipped++; continue; }
      try {
        await db.query("BEGIN");
        const catId = await categoryId(t.category);
        const pmId = await paymentMethodId(t.payment_method);
        const amount = round2(t.amount);
        const gst = round2(t.gst_amount);
        const total = round2(amount + gst);
        const date = t.date;
        const desc = t.description || t.type || "Expense";

        let exchangeRate = 1, amountBase = total;
        if (glReady) { try { const f = await currency.toFunctional(total, "INR", entityId, date, db); amountBase = f.amountBase; exchangeRate = f.exchangeRate; } catch (_) {} }

        const ins = await db.query(
          `INSERT INTO expenses
            (entity_id, expense_date, category_id, expense_type, vendor_name, description,
             payment_method_id, currency, amount, gst_amount, tds_amount, total_amount,
             exchange_rate, amount_base, is_reimbursable, paid_by, status, notes)
           VALUES ($1,$2,$3,'VARIABLE',$4,$5,$6,'INR',$7,$8,0,$9,$10,$11,$12,$13,'RECORDED',$14)
           RETURNING *`,
          [entityId, date, catId, null, desc, pmId, amount, gst, total, exchangeRate, amountBase,
           !!t.reimbursable, t.paid_by, `${t.status || ""} ${marker}`.trim()]);
        const expense = ins.rows[0];

        if (glReady) {
          const catCode = await accountCodeById((await db.query("SELECT gl_account_id FROM expense_categories WHERE id=$1", [catId])).rows[0]?.gl_account_id);
          let creditCode = REIMBURSEMENTS_ACCOUNT;
          if (!expense.is_reimbursable) creditCode = (await accountCodeById((await db.query("SELECT gl_account_id FROM payment_methods WHERE id=$1", [pmId])).rows[0]?.gl_account_id)) || "1000";
          if (catCode) {
            const posted = await glPosting.postExpense(db, { ...expense, region_id: entityId, expense_account_code: catCode, credit_account_code: creditCode, created_by: null });
            if (posted?.id) await db.query("UPDATE expenses SET gl_entry_id=$1 WHERE id=$2", [posted.id, expense.id]);
          }
        }
        await db.query("COMMIT");
        txCreated++;
      } catch (err) {
        await db.query("ROLLBACK").catch(() => {});
        txFailed++;
        console.error(`  row ${t.row} failed:`, err.message);
      }
    }

    console.log("\n✅ Import complete");
    console.table({
      recurring: { created: recCreated, skipped: recSkipped },
      transactions: { created: txCreated, skipped: txSkipped, failed: txFailed },
    });
    console.log("Re-running is safe — already-imported rows are skipped.");
  } catch (err) {
    console.error("Import failed:", err.message);
    process.exitCode = 1;
  } finally {
    db.release();
    await pool.end();
  }
}

main();

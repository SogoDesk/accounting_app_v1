# Accounting App — Honest Code Review & Multi-Currency Plan

_Reviewed: 27 June 2026 • Stack: React + Vite / Node + Express / PostgreSQL_

---

## 1. What this app actually is

This is **not** a general accounting system in the QuickBooks/Zoho sense. It is a **staffing/recruiting revenue-operations platform** with bolt-on AR and AP:

- **AR side:** Region → Client → Candidate → Placement → Invoice → Payment
- **AP side:** Vendor → Bill → Approval → Vendor Payment
- Plus: users/roles, audit log, notifications, dashboard, reports, PDF invoices

That distinction matters for your goal. QuickBooks and Zoho Books are **double-entry general-ledger systems** (chart of accounts, journal entries, trial balance, P&L, balance sheet). This app has **none of that** — there is no ledger, no accounts, no journals. It tracks *who owes what and who got paid*, which is operational AR/AP, not bookkeeping. You cannot close a month or produce statutory financials from it today.

**The good news:** for your specific cross-border problem (UK employee paid in GBP, US client pays in USD), the app's *shape* is already right. The placement/invoice carries the client's currency and the bill/vendor-payment carries the vendor/employee's currency. What's missing is the currency *engine* underneath. More on that in §5.

---

## 2. What's genuinely good

The fundamentals are more solid than most internal tools I review.

- **Clean, conventional structure.** routes → controllers → middleware → config. Easy for a new developer to navigate.
- **SQL is parameterized.** Dynamic `WHERE` clauses are built with `$1, $2…` placeholders and values pushed separately; `ORDER BY` clauses are static. I did **not** find SQL-injection holes — this is the single most common failure in apps like this, and you avoided it.
- **Transactions where money moves.** `BEGIN/COMMIT` is used in the payment, bill, vendor-payment and invoice controllers, so partial writes are handled.
- **Security middleware present.** Helmet, CORS, rate limiting, JWT auth, and a role-based `authorize()` guard.
- **Audit logging + soft-delete** (AP tables) — good instincts for a finance app.
- **Real domain modeling.** Placement billing types (hourly/monthly/one-time), payment terms, tax lines, TDS on payments, bill approval workflow. Someone understood the staffing business.
- **The planning docs** (`AP_GAP_ANALYSIS.md`, `UNIFIED_ACCOUNTING_ARCHITECTURE.md`) are honest and self-aware — they already name several issues below.

---

## 3. Critical issues — fix these first

### 3.1 Secrets are committed to git 🔴
`backend/.env` is **tracked in the repository**. Your database password and `JWT_SECRET` are in version history. Anyone with repo access (or a leaked clone) has your production credentials, and anyone with the JWT secret can mint admin tokens.

**Do now:**
```bash
git rm --cached backend/.env
git commit -m "Remove .env from tracking"
# then ROTATE: new DB password + new JWT_SECRET (old ones are compromised)
# scrub history with git-filter-repo or BFG if the repo is shared
```

### 3.2 `node_modules` is committed 🔴
**9,407 dependency files are tracked in git** despite being in `.gitignore` (they were committed before the ignore rule). This bloats the repo, pollutes every diff, and is why `git status` is noisy.
```bash
git rm -r --cached backend/node_modules frontend/node_modules frontend/dist
git commit -m "Stop tracking build artifacts and dependencies"
```

### 3.3 No automated tests at all 🟠
Zero test files in the entire codebase. For software that calculates money, this is the biggest *risk* even though it isn't a *bug*. A single rounding or balance-recalc regression can quietly corrupt financials. Start with the highest-stakes pure functions: balance recalculation, tax/TDS math, and (soon) currency conversion.

---

## 4. Architectural weaknesses

### 4.1 Business logic lives inside controllers
`invoiceController.js` is **2,265 lines**. SQL, validation, and business rules are all mixed into HTTP handlers, so AR and AP can't share logic and everything is hard to test. Your own gap analysis flags this. Extract a **service layer** (`services/invoiceService.js`, `services/paymentService.js`) holding pure business logic that controllers call.

### 4.2 Two sources of schema truth
Core tables live in `database/schema.sql`, but AP tables are created **at runtime** via `ensureApSchema.js` (`CREATE TABLE IF NOT EXISTS`). There is **no migration tool**. This guarantees schema drift between environments and makes changes risky. Adopt a migration framework (Knex, Prisma, or node-pg-migrate) and make *all* schema changes versioned migrations.

### 4.3 Frontend has accumulated cruft from a pivot
Duplicate/legacy files signal an app that started as a recruiting tool and grew an accounting module: `Login.jsx` **and** `LoginPage.jsx`; `Sidebar.jsx` **and** `AppSidebar.jsx`; four parallel dashboards (`admin/`, `manager/`, `recruiter/`, `dashboard/`); leftover resume features (`TailorResumeModal.jsx`, `applySkillMapping.js`). Dead code confuses new contributors and hides bugs. Delete what isn't routed.

### 4.4 Auth hardening (internal-tool acceptable, but note it)
JWT is stored in `localStorage` (readable by any XSS) with a 12-hour expiry and no refresh token. For an internal finance tool this is tolerable, but `httpOnly` cookies are safer and you should confirm `JWT_SECRET` is long and random (no weak fallback in production).

---

## 5. Multi-currency & multi-location — your core requirement

This is where the app is **half-built and currently unsafe for real numbers.** Here is the exact state and the fix.

### 5.1 What exists today
- `regions`, `clients`, `placements`, `invoices` each carry a `currency` field. ✔️
- AR `payments` have `exchange_rate` and `amount_in_base_currency` columns. ✔️ (but manually entered)
- The dashboard shows a "USD equivalent" total. ⚠️

### 5.2 What's broken or missing
1. **No company/entity base currency is defined anywhere.** There is no setting for "our books are kept in USD." Everything implicitly assumes USD.
2. **AP has no FX at all.** `bills` and `vendor_payments` have a `currency` label but **no `exchange_rate` and no base-currency amount**. So you literally cannot convert a GBP payable into your reporting currency. For your UK-employee scenario, this is the missing half.
3. **Conversion happens in the browser with hard-coded rates.** `DashboardPage.jsx` contains `USD_FALLBACK_RATE = { INR: 0.012, JPY: 0.0067, … }`. Financial conversion must never live in frontend constants — it's wrong the day rates move, and different users see different totals.
4. **No exchange-rate history.** Rates are point-in-time; you need the rate *as of the transaction date* and it must be stored, not recomputed.
5. **No FX gain/loss.** When you invoice a US client 10,000 USD and collect it weeks later, the USD→your-base rate has moved. That difference is a realized FX gain/loss and must be recorded. The app has no concept of it.

### 5.3 The model you actually need

```
company_settings
  base_currency            -- e.g. USD; the one reporting currency for consolidated books
  (or, if you have legal entities in US/UK/India that each file locally:)

legal_entities             -- one per country you operate/file in
  id, name, country, functional_currency   -- US entity=USD, UK entity=GBP, India entity=INR

exchange_rates             -- dated, stored, never recomputed
  id, from_currency, to_currency, rate, rate_date, source

-- every monetary document stores BOTH amounts + the rate used:
invoices / bills / payments / vendor_payments
  currency                 -- transaction currency (USD invoice, GBP bill)
  exchange_rate            -- rate to entity functional currency on doc date
  amount_base              -- precomputed amount in functional currency
  fx_gain_loss             -- realized difference at settlement (payments only)
```

**Your concrete example handled correctly:**
- US client invoice: `currency = USD`, billed from your **US entity** (functional USD) → `exchange_rate = 1`.
- UK employee/vendor bill: `currency = GBP`, paid from your **UK entity** (functional GBP) → `exchange_rate = 1` locally; converted to USD only for the **consolidated** group view via a dated `exchange_rates` row.
- Placement gross margin (US revenue USD − UK cost GBP) is then computed in **one consolidated currency** using stored dated rates — not browser constants.

### 5.4 Where rates come from
Pull daily from a real source (e.g. **exchangerate.host**, **Open Exchange Rates**, or your bank's published rates), store one row per currency-pair-per-day in `exchange_rates`, and **freeze the rate onto each transaction** when it's created. Never convert live at read time.

---

## 6. The build-vs-buy decision (important)

You asked whether to build something like QuickBooks/Zoho. My honest recommendation: **do not build a general-ledger accounting system from scratch.** That's thousands of hours and you'd be reinventing solved problems (tax engines, statutory reports, multi-currency consolidation, audit compliance).

Two realistic paths:

**Path A — Keep this as your staffing operations layer; sync to real accounting software (recommended).**
Your schema already has `quickbooks_customer_id`, `quickbooks_invoice_id`, and `quickbooks_sync_status` columns — someone already intended this. Use **Zoho Books or QuickBooks Online** as the system of record for the actual ledger, multi-currency, FX gain/loss, and tax filing (they do all of §5 natively, including base currency per organization). This app stays the staffing-native front end (placements, bill rates, margins) and **pushes** invoices/bills into the accounting system via API. Lowest risk, fastest to "real books."

**Path B — Extend this app into a proper multi-entity system.**
Justified only if off-the-shelf can't model your staffing workflows the way you need. If you go here, the minimum to be trustworthy is: base/functional currency per entity, a dated `exchange_rates` table, **all FX math in the backend**, AP-side FX columns, FX gain/loss on settlement, a migration tool, and a test suite around money math. Realistically a 3–6 month focused effort before you'd trust it for filing.

For most companies in your position, **Path A** gets you compliant books in weeks and keeps the operational tooling you've already built.

---

## 7. Prioritized action list

**This week (stop the bleeding)**
1. Remove `.env` and `node_modules` from git; rotate DB password + JWT secret.
2. Add a migration tool; fold `ensureApSchema.js` into versioned migrations.
3. Decide Path A vs Path B (§6).

**This month (make currency real)**
4. Add `base_currency` (company or per-entity) and a dated `exchange_rates` table.
5. Add `exchange_rate` + `amount_base` to **bills and vendor_payments**.
6. Move all currency conversion out of `DashboardPage.jsx` into backend aggregates.
7. Delete duplicate/legacy frontend files.

**This quarter (durability)**
8. Extract service layer from the fat controllers (start with invoices/payments).
9. Add tests for balance, tax/TDS, and currency-conversion math.
10. Implement realized FX gain/loss on settlement; build consolidated multi-currency reporting.

---

## 8. Bottom line

This is a **competent, working internal tool** with clean SQL practices and a sensible domain model — better than typical for its category. But it is an **AR/AP operations app, not accounting software**, and its multi-currency support is the weakest, least-finished part precisely where your business needs it most: FX logic lives in the browser with hard-coded rates, and the entire AP side has no currency conversion at all.

Don't rebuild QuickBooks. Either sync this to Zoho/QuickBooks (recommended) or invest specifically in a real backend currency engine (base currency + dated rates + FX gain/loss + AP FX). And before any of that: get your secrets out of git and rotate them today.

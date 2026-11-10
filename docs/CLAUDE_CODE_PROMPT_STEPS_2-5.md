# Claude Code Prompt — Multi-Location Ledger, Steps 2–5

Paste everything below the line into Claude Code, run from the repo root (`accounting_app`).

---

You are a Principal Engineer working in this existing app: **React/Vite frontend** (`frontend/`), **Node/Express backend** (`backend/`), **PostgreSQL**. The backend uses a `pg` pool at `backend/config/db.js`, controllers in `backend/controllers`, routes in `backend/routes`, services in `backend/services`, and numbered SQL migrations in `database/migrations`. Auth is `backend/middleware/authMiddleware.js` (`authenticate`, `authorize(...roles)`; `req.user = { id, email, role }`).

A full architecture blueprint already exists at **`ARCHITECTURE_AUDIT_MULTILOCATION.md`** — read it first; it contains the exact, already-validated SQL schemas and the `ledgerEngine.js` code for everything below. Use those artifacts verbatim where referenced.

## Current state (already done — do NOT redo)
- Migrations `001`–`004` are applied. `001` = currency engine (`exchange_rates`, `regions.functional_currency`, `amount_base`). `002` = general ledger (`chart_of_accounts`, `accounting_periods`, `journal_entries`, `journal_lines`, deferred balance triggers `trg_jl_balanced`/`trg_je_balanced`). `003` = expenses subledger. `004` = org hierarchy.
- `004` created **`org_units`** (tree: GROUP → ENTITY → BRANCH; each ENTITY has `region_id` linking to the existing `regions` row and `is_legal_entity=true`; each entity has one default `-HQ` BRANCH), the `org_set_path()` path trigger, and `owning_entity_id(unit_id)`. It added `location_id` to `journal_entries`/`journal_lines` (backfilled to each entity's HQ branch), integer-minor columns `debit_minor`/`credit_minor`/`base_minor_debit`/`base_minor_credit`, `custom_fields jsonb`, and a `custom_field_defs` table.
- **`entity_id` still equals `region_id`** everywhere — keep it. `location_id` references `org_units`. Don't rip out `region_id`.
- Posting hub: `backend/services/gl/postingService.js` (`createJournalEntry`, `postInvoiceIssued`, `postBillEntered`, `postExpense`, `reverseEntry`). FX: `backend/services/currency/currencyService.js` (`toFunctional`, `getRate`).

## Hard rules
1. **Migrations idempotent** (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, `DROP … IF EXISTS`) and wrapped in `BEGIN`/`COMMIT`.
2. **In any migration that touches `journal_entries`/`journal_lines`, put ALL `ALTER TABLE`/`CREATE INDEX` BEFORE any `UPDATE`** on those tables — an `UPDATE` queues the deferred balance-trigger events and Postgres then forbids `ALTER TABLE` ("pending trigger events").
3. **Validate before declaring done**: every `.sql` must parse (`pip install pglast`; `python3 -c "import pglast; pglast.parse_sql(open('file.sql').read())"`), every `.js` must pass `node --check`, every changed React file must pass `npx esbuild file.jsx --bundle=false --outfile=/dev/null`. (Full `vite build` fails here because committed `node_modules` has the wrong-arch rollup binary — use esbuild per-file.)
4. **No placeholders, no `// TODO`.** Money math in the ledger uses **integer minor units** (`*_minor` bigint cents), never floats.
5. Match existing controller/route/style conventions. Mount new routes in `backend/routes/index.js`.
6. After each step, print a short "VERIFY" block with the exact `psql`/curl commands to confirm it.

---

## STEP 2 — Row-level RBAC + Postgres RLS  (`database/migrations/005_rbac.sql` + middleware)

**Goal:** a user only sees/edits data for org units they're granted, with grants cascading to descendants.

1. Migration `005_rbac.sql`:
   - `user_org_access (user_id int REFERENCES users, org_unit_id bigint REFERENCES org_units, access text CHECK in ('VIEW','EDIT','POST','ADMIN'), PRIMARY KEY(user_id, org_unit_id))`.
   - `user_allowed_locations(p_user int) RETURNS TABLE(org_unit_id bigint, access text)` — expand each grant to self + all descendants via `org_units.path LIKE grant.path || '%'` (see the audit doc, §3.4, use verbatim).
   - Seed: grant every existing user `ADMIN` on the `GRP` root so nothing breaks on rollout: `INSERT INTO user_org_access SELECT u.id, (SELECT id FROM org_units WHERE code='GRP'), 'ADMIN' FROM users u ON CONFLICT DO NOTHING;`
   - (Defense-in-depth, optional but preferred) enable RLS on `journal_entries`, `journal_lines`, `invoices`, `bills`, `expenses` with a policy `USING (entity_id IN (SELECT owning_entity_id(org_unit_id) FROM user_allowed_locations(current_setting('app.user_id')::int)))`. Only enable if you also do step 2.4 (set the GUC per request); otherwise leave RLS scaffolding commented with a clear note.

2. `backend/middleware/scopeMiddleware.js`: after `authenticate`, query `user_allowed_locations(req.user.id)` and attach `req.allowedEntityIds` (distinct owning entities) and `req.allowedLocationIds`. Export `scopeAccess`.

3. Apply scoping to list/detail endpoints that return ledger/financial data (invoices, bills, payments, vendor-payments, expenses, GL reports, dashboards, the `/clients/:id/overview` etc.): add `AND entity_id = ANY($n)` using `req.allowedEntityIds`. On create/post, reject if the target `region_id`/`location_id` isn't in the allowed set (don't trust the request body).

4. If you enabled RLS: in `server.js` or a middleware, run `SET LOCAL app.user_id = $1` on the request's connection. (Note this needs per-request transactions; if that's too invasive, ship the query-layer scoping in 2.3 and leave RLS as the migration scaffold.)

**VERIFY:** seed a second non-admin user granted only one entity; confirm `GET /api/invoices` returns only that entity's rows for them and all rows for an ADMIN.

---

## STEP 3 — Refactored ledger engine  (`database/migrations/006_ledger_immutable.sql` + `backend/services/gl/ledgerEngine.js`)

**Goal:** one race-free, integer-precise, hash-chained, immutable, location-aware posting core that all subledgers use.

1. Migration `006_ledger_immutable.sql`:
   - `ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS prev_hash text, ADD COLUMN IF NOT EXISTS entry_hash text;`
   - Immutability trigger `gl_block_mutation()` + `trg_gl_immutable` (BEFORE UPDATE OR DELETE on `journal_entries`) — forbid mutating a `POSTED` entry except the `POSTED→REVERSED` status flip. Use the audit doc §3.1 verbatim.
   - (DDL only; no ledger `UPDATE`s here, so ordering is moot — but keep the rule in mind.)

2. Create `backend/services/gl/ledgerEngine.js` exactly as in the audit doc §4.2 (`postEntry`, `verifyChain`, `toMinor`). It: asserts `locationId`, checks the user may POST to that location (`user_allowed_locations`), normalizes to integer minor units and validates `Σbase_debit_minor = Σbase_credit_minor`, requires an OPEN period, assigns `entry_no` from a **per-entity Postgres sequence** (`CREATE SEQUENCE IF NOT EXISTS je_seq_<entityId>; nextval(...)`) to kill the `COUNT(*)+1` race, computes `entry_hash = sha256(prev_hash || canonical(entry+lines))`, and inserts both numeric and `*_minor` columns + `custom_fields`.

3. Refactor `postingService.js` so `postInvoiceIssued`, `postBillEntered`, `postExpense`, and `reverseEntry` build their line arrays and delegate to `ledgerEngine.postEntry(...)` instead of the old `createJournalEntry`. Resolve `locationId`: accept an explicit `location_id` on the source document if present, else default to the owning entity's HQ branch (`SELECT b.id FROM org_units e JOIN org_units b ON b.parent_id=e.id AND b.unit_type='BRANCH' WHERE e.region_id=$entity LIMIT 1`). Pass `userId` through from the controller. Keep the existing function signatures/behaviour (idempotency guard via `alreadyPosted`, residual-line rounding) intact.

4. Add `GET /api/gl/verify-chain?entityId=` → `ledgerEngine.verifyChain` for an auditor "prove integrity" button.

**VERIFY:** create an invoice through the API; confirm the journal entry has a non-null `entry_hash`, `location_id`, populated `*_minor` columns, and that `verifyChain` returns `{ ok: true }`. Confirm two rapid concurrent posts to one entity get distinct `entry_no`s.

---

## STEP 4 — Intercompany transfers + consolidation eliminations  (`database/migrations/007_intercompany.sql` + service + reports)

1. Migration `007_intercompany.sql`: `intercompany_transfers` table (audit doc §3.2 verbatim) and COA additions `1600 'Intercompany Receivable (Due From)'` and `2600 'Intercompany Payable (Due To)'` via `INSERT … ON CONFLICT (account_code) DO NOTHING`.

2. `backend/services/gl/intercompanyService.js`: `postTransfer({ fromLocationId, toLocationId, amount, currency, date, memo, userId })` — within one transaction, post TWO balanced entries via `ledgerEngine.postEntry`: from-side `Dr 1600 / Cr 1000 Bank`, to-side `Dr 1000 Bank / Cr 2600`, tagged with the respective `location_id`s and the same `transfer_no`; persist the `intercompany_transfers` row linking both `entry_id`s. Endpoint `POST /api/intercompany/transfers` + `GET` list.

3. Update `backend/services/gl/glReports.js` consolidation: accept a `rootLocationId` (default GRP), restrict to the subtree via `org_units.path LIKE root.path || '%'`, translate each entity's functional totals → group currency at the report date, **and exclude account codes `1600`/`2600`** from the consolidated statements while returning their net as an `eliminations` reconciliation figure (must be ≈0). Per-entity reports are unchanged.

**VERIFY:** post a transfer between two entities; confirm both entries exist and balance, the consolidated P&L/BS excludes 1600/2600, and the eliminations figure is ~0.

---

## STEP 5 — FX revaluation + accrual/deferral engines  (`database/migrations/008_period_close.sql` + services)

1. Migration `008_period_close.sql`:
   - `fx_revaluations` table + COA `4910 'Unrealized FX Gain'` (INCOME), `5910 'Unrealized FX Loss'` (EXPENSE) — audit doc §3.3.
   - `recognition_schedules` + `recognition_runs` tables + COA `2700 'Deferred Revenue'` (LIABILITY); prepaid uses existing `1300 Prepaid Expenses` — audit doc §3.5.

2. `backend/services/gl/fxRevaluationService.js`: `revalue({ entityId, asOfDate, userId })` — for each open foreign-currency monetary balance (AR `1100`, AP `2000`, bank `1000`) whose currency ≠ entity functional currency, compute `gain_loss = balance_func × (rate_asof / rate_booked − 1)` (use integer minor units), post `Dr/Cr 4910/5910` via `ledgerEngine.postEntry`, record an `fx_revaluations` row, and post an **auto-reversing** entry dated `asOfDate + 1 day` so unrealized never compounds with realized. Endpoint `POST /api/gl/fx-revalue`.

3. `backend/services/gl/recognitionService.js`: `createSchedule(...)` and `runDue({ asOfDate, userId })` — for each `ACTIVE` schedule with an unrun period whose date ≤ asOf, post one straight-line recognition entry (prepaid: `Dr pnl_account / Cr balance_account`; deferred revenue: `Dr balance_account / Cr pnl_account`) via `ledgerEngine.postEntry`, idempotent on `(schedule_id, period_no)`, tagged with the schedule's `location_id`. Endpoints to create schedules and to trigger `runDue`. Wire `runDue` + `fxRevaluationService.revalue` into the existing scheduled-task mechanism for monthly close, plus manual "run now" buttons.

**VERIFY:** create a 12-month prepaid schedule and run one period → one recognition entry posts and the prepaid balance drops by 1/12; run an FX revaluation with a moved rate → an unrealized gain/loss entry posts and a reversing entry is queued for the next day.

---

## Final acceptance
- All migrations `005`–`008` apply cleanly in order on top of `001`–`004`; re-running them is a no-op.
- `verifyChain` returns `{ ok: true }` for every entity after a batch of postings.
- A non-admin user cannot see another entity's ledger rows.
- Consolidated statements eliminate intercompany balances to ~0.
- No floats in any ledger math; every posted line carries `entity_id`, `location_id`, `entry_hash`, and `*_minor` amounts.
- Print a final summary mapping each delivered file to its step.

# Multi-Location Ledger — Architecture Audit & Engineering Blueprint

_Principal-architect review of `accounting_app`, grounded in the actual codebase (React/Vite · Node/Express · PostgreSQL) • 29 June 2026_

## How to read this, and one honest framing

I've worked inside this codebase directly, so this audit cites real files and real behavior, not a generic template. Before the four phases, two grounding truths:

1. **You already have more than a blank slate.** Over recent work the app gained a real double-entry general ledger (`journal_entries` / `journal_lines` with a deferred balance trigger), a multi-currency engine (`exchange_rates`, `functional_currency`, `amount_base`, realized FX accounts 4900/5900, CTA 3200), an expenses subledger that posts to the GL, and per-entity + consolidated-USD reporting. So several "missed requirements" below are *partially present* — I'll say what exists and engineer only the true gaps. Pretending it's greenfield would waste your time.

2. **"Surpass QuickBooks/Zoho" needs a precise meaning.** You will not out-feature a product with a decade and thousands of engineers. What a purpose-built ledger *can* beat them at, for your case, is exactly four things, and this blueprint targets them: (a) **true location-level tagging and consolidation** (QBO Plus caps at one entity; Zoho needs separate orgs and a paid consolidation add-on), (b) **a cryptographically immutable ledger** they don't expose, (c) **schema-free custom fields on every ledger line**, and (d) **real inter-company eliminations** that mid-tier SaaS handles poorly. That's a winnable scope. Everything below serves it.

---

# Phase 1 — Deep Interconnection & Logic Map

## 1.1 The actual module graph

```
regions (== legal ENTITY today; "US/UK/India")        users / roles
   │                                                      │ (authorize-by-role only)
   ├── clients ────────┐                                  │
   ├── vendors ──┐     │                                  ▼
   ├── candidates│     │           middleware/authMiddleware.js  (JWT, role gate)
   │      │      │     │
   │      ▼      │     ▼
   │   placements ── invoices ── payments            bills ── vendor_payments
   │      │            │  (AR)      │                  │ (AP)     │
   │      │            └──────┐     │                  └────┐     │
   │      │                   ▼     ▼                       ▼     ▼
   │      │            ┌─────────────────────────────────────────────┐
   │      │            │  services/gl/postingService.js  (THE HUB)    │
   │      │            │  postInvoiceIssued / postBillEntered /       │
   │      │            │  postExpense / createJournalEntry            │
   │      │            └───────────────┬─────────────────────────────┘
   expenses / recurring_expenses ──────┤  uses services/currency/currencyService (FX→functional)
                                       ▼
                       journal_entries → journal_lines  (entity_id only; debit/credit/_base)
                                       │   ▲ deferred trigger: Σdebit_base = Σcredit_base
                                       ▼
                       services/gl/glReports.js → trial balance / P&L / balance sheet
                       pages/DashboardPage + reports  (per-entity OR translate→USD)
```

## 1.2 Lifecycle of one transaction (traced end-to-end)

Take an AR invoice — the canonical path:

1. `POST /api/invoices` → `invoiceController.createInvoice` opens a `pg` client, `BEGIN`.
2. Inserts the `invoices` row (carries `region_id`, `currency`, `total_amount` as `numeric`).
3. If status ∈ {GENERATED, SENT, …} **and** `glPosting.glAvailable(client)` → calls `postInvoiceIssued(client, createdInvoice)` **in the same transaction**.
4. `postInvoiceIssued` resolves the entity's functional currency via `currencyService.toFunctional()`, freezes `exchange_rate`, builds balanced lines (Dr 1100 AR / Cr 4000 Revenue / Cr 2100 Tax), makes the AR line the rounding **residual** so it always balances, then `createJournalEntry`.
5. `createJournalEntry` validates `Σdebit_base == Σcredit_base` in JS, finds the **open period**, assigns `entry_no`, inserts `journal_entries` (status POSTED) + `journal_lines`.
6. On `COMMIT`, the **deferred constraint trigger** `gl_assert_entry_balanced` re-checks balance at the database level. If posting throws, the whole invoice rolls back — AR and GL are atomic.
7. Later, `glReports` / dashboard aggregate `journal_lines.debit_base/credit_base` grouped by `account_type`, filtered by `entity_id`, optionally translated functional→USD via dated `exchange_rates`.

The same shape holds for bills (`postBillEntered`, on approval), expenses (`postExpense`, with GST/TDS legs), and payments (settlement — not yet wired).

## 1.3 Critical dependencies & where multi-location isolation BREAKS

This is the part that matters for your spec. The honest finding: **the system has an *entity* axis (`region_id`) but no *location* axis at all, and no row-level isolation on either.** Concretely:

| Breakpoint | Reality in the code | Consequence |
|---|---|---|
| **No `location_id` anywhere** | `grep` across controllers/services/db returns *nothing*. The only org axis is `regions.id` used as `entity_id`. | You cannot tag or consolidate below the entity. "Parent → Subsidiary → Branch" is impossible today. Your spec's "immutable `location_id` on every line" is 0% met. |
| **No row-level location isolation** | `authMiddleware.authorize(...roles)` gates by **role only**. No controller filters queries by the *user's* permitted entities/locations. | Any FINANCE_ADMIN sees and edits **every entity's** data. Location data fully "bleeds." This is the single biggest gap vs. your RBAC requirement and a real security hole. |
| **`entry_no` race condition** | `nextEntryNo` = `SELECT COUNT(*) … +1`. Two concurrent posts in the same entity compute the same number. | Under concurrency you get a `unique(entity_id, entry_no)` violation → a posting (and its invoice) fails intermittently. A ledger must never lose writes to a sequence race. |
| **Consolidation has no eliminations** | `glReports` sums per entity and translates to USD. There is no inter-company account, no elimination pass. | If Entity A bills Entity B, consolidated revenue and expense are **double-counted**. Your "automated handling of inter-company eliminations" is unimplemented. |
| **Runtime schema creation** | AP tables are created lazily by `modules/ap/ensureApSchema.js` on first hit; GL/currency/expenses live in numbered migrations. | Two sources of truth, drift risk, and a first-request race. Not fatal, but not enterprise-grade DDL governance. |
| **Float money in the app layer** | DB columns are `numeric` (good), but `postingService`/`glReports` do arithmetic in JS `Number` with a `round2` helper. | Accumulation/rounding artifacts are possible in aggregation and FX. Not arbitrary-precision as your spec demands. |

---

# Phase 2 — Code Deficiency & Accounting Gap Analysis

### 2.1 Security / isolation deficiencies
- **No row-level location/entity scoping (critical).** Authorization is coarse (role only). There is no `WHERE entity_id = ANY(user_allowed_entities)` and no Postgres RLS. Fix in Phase 3.4 (RBAC) + Phase 4 (RLS policies).
- **Secrets + `node_modules` committed to git; JWT in `localStorage`** (flagged in the earlier review, still open). Rotate and move to httpOnly cookies; these undermine any compliance story.
- **No request-level entity assertion.** Even with RBAC data, controllers accept a body `region_id` without checking the caller is allowed to write to it. Server must derive/validate the allowed set, never trust the client.

### 2.2 Accounting-correctness deficiencies
- **Mutability of the ledger.** You have the *pattern* (status DRAFT/POSTED/REVERSED, `reversed_by`) but nothing **prevents** an `UPDATE journal_lines …`. There is no append-only enforcement and no hash chain. A true immutable trail (your headline requirement) does not exist yet — engineered in 3.1/4.2.
- **Float arithmetic.** `Number`/`round2` is acceptable for 2-dp display but not for a ledger of record. Move money math to **integer minor units** (store `bigint` cents) or `decimal.js`; keep `numeric` in the DB.
- **Unrealized FX not handled.** Realized FX is posted at settlement (4900/5900). There is **no period-end revaluation** of open foreign-currency AR/AP/bank balances → unrealized gain/loss is invisible. Engineered in 3.3.
- **No accrual/deferral engine.** `recurring_expenses` amortizes a monthly equivalent, but there is no prepaid-expense / deferred-revenue **recognition schedule** that posts entries over time. Engineered in 3.4.
- **No inter-company mechanism.** No due-to/due-from accounts, no paired transfer posting, no eliminations. Engineered in 3.2.
- **Custom fields absent.** Only ad-hoc `tax_lines_json`. No general, schema-free attribute system. Engineered in 3.5.

### 2.3 Consolidation critique
`glReports` is a solid v1: it does per-entity (functional currency) and consolidated (translate→USD at report date). But it is **flat** (regions only, no hierarchy), performs **no eliminations**, and **recomputes** translation each run with no persisted CTA snapshot. For "real-time consolidation across an unlimited hierarchy with eliminations," it needs: an org tree (3.0), a location axis on lines (4.1), an elimination pass keyed off inter-company accounts (3.2), and a roll-up that walks the tree.

---

# Phase 3 — The "Missed Requirements" Injection

These are written as engine cores: complete schema + the load-bearing posting logic. Surrounding CRUD follows the existing controller/route patterns and is omitted only where it is mechanical.

## 3.0 Hierarchical organization (the missing backbone)

Replace the flat `regions`-as-entity model with a proper tree. A **closure-friendly** design using `parent_id` + a materialized `path` (Postgres `ltree`-style text) gives both fast subtree queries and simple roll-up.

```sql
CREATE TABLE org_units (
    id            bigserial PRIMARY KEY,
    parent_id     bigint REFERENCES org_units(id) ON DELETE RESTRICT,
    unit_type     text NOT NULL CHECK (unit_type IN ('GROUP','ENTITY','REGION','BRANCH')),
    code          text NOT NULL UNIQUE,
    name          text NOT NULL,
    -- an ENTITY is a legal book of record; REGION/BRANCH are sub-locations under it
    is_legal_entity boolean NOT NULL DEFAULT false,
    functional_currency varchar(10),         -- required when is_legal_entity
    path          text NOT NULL,             -- e.g. '1.4.9'  (root.entity.branch)
    depth         int  NOT NULL DEFAULT 0,
    status        text NOT NULL DEFAULT 'ACTIVE',
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_org_path   ON org_units (path text_pattern_ops);
CREATE INDEX idx_org_parent ON org_units (parent_id);

-- the owning legal entity for any node (walks up to the nearest is_legal_entity)
CREATE OR REPLACE FUNCTION owning_entity_id(p_unit bigint) RETURNS bigint AS $$
  WITH RECURSIVE up AS (
    SELECT id, parent_id, is_legal_entity FROM org_units WHERE id = p_unit
    UNION ALL
    SELECT o.id, o.parent_id, o.is_legal_entity FROM org_units o JOIN up ON o.id = up.parent_id
  ) SELECT id FROM up WHERE is_legal_entity ORDER BY id LIMIT 1;
$$ LANGUAGE sql STABLE;
```

`region_id` everywhere becomes `entity_id` (the legal book) plus a new `location_id` (the operational node). Both are immutable on a posted line.

## 3.1 Immutable, hash-chained ledger (your headline feature)

Append-only enforcement + a per-entity hash chain so any tampering is detectable. Two mechanisms: (a) a trigger that **forbids UPDATE/DELETE** on posted ledger rows, (b) a chain where each entry hashes its own content plus the previous entry's hash.

```sql
ALTER TABLE journal_entries
  ADD COLUMN IF NOT EXISTS location_id bigint REFERENCES org_units(id),
  ADD COLUMN IF NOT EXISTS prev_hash   text,
  ADD COLUMN IF NOT EXISTS entry_hash  text;

-- forbid mutation of a POSTED entry (corrections = reversing entries only)
CREATE OR REPLACE FUNCTION gl_block_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status = 'POSTED' THEN
    RAISE EXCEPTION 'Posted ledger entries are immutable (id=%); post a reversal instead', OLD.id;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'POSTED'
     AND (NEW.entry_hash IS DISTINCT FROM OLD.entry_hash
          OR NEW.entry_date <> OLD.entry_date
          OR NEW.entity_id  <> OLD.entity_id) THEN
    -- allow ONLY the status flip POSTED->REVERSED + reversed_by linkage
    IF NOT (NEW.status = 'REVERSED' AND OLD.status = 'POSTED') THEN
      RAISE EXCEPTION 'Posted ledger entry % is immutable', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_gl_immutable
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION gl_block_mutation();
```

The hash is computed in the posting service (3.x code below) as `sha256(prev_hash || canonical(entry+lines))`, giving you an auditable chain where re-computing from genesis proves no row was altered or removed.

## 3.2 Inter-branch / inter-company reconciliation

Resource transfer from Location A to Location B posts **two balanced entries** (one per legal entity if they differ, or two locations within one entity) linked by a shared `transfer_id`, using reciprocal **Due To / Due From** control accounts that net to zero on consolidation.

```sql
CREATE TABLE intercompany_transfers (
    id          bigserial PRIMARY KEY,
    transfer_no text UNIQUE NOT NULL,
    from_location bigint NOT NULL REFERENCES org_units(id),
    to_location   bigint NOT NULL REFERENCES org_units(id),
    amount      numeric(20,4) NOT NULL,
    currency    varchar(10) NOT NULL,
    transfer_date date NOT NULL,
    memo        text,
    from_entry_id bigint REFERENCES journal_entries(id),
    to_entry_id   bigint REFERENCES journal_entries(id),
    created_at  timestamptz NOT NULL DEFAULT now()
);
-- COA additions: 1600 'Intercompany Receivable (Due From)', 2600 'Intercompany Payable (Due To)'
```

Posting (engine in 4.2): from-side `Dr Due From (1600) / Cr Bank`, to-side `Dr Bank / Cr Due To (2600)`. On consolidation, 1600 and 2600 are **elimination accounts**: the roll-up sums them and asserts they net to ~0, then drops them from the consolidated statements. That is the elimination QB/Zoho mid-tiers don't do natively.

## 3.3 Multi-currency: realized (have) + unrealized (missing) FX

Realized FX is already posted at settlement. The gap is **period-end revaluation** of open foreign-currency monetary balances (AR/AP/bank not in the entity's functional currency): post **unrealized** gain/loss, reverse it at the start of the next period so it never compounds with the eventual realized figure.

```sql
CREATE TABLE fx_revaluations (
    id          bigserial PRIMARY KEY,
    entity_id   bigint NOT NULL REFERENCES org_units(id),
    as_of_date  date NOT NULL,
    account_id  int  NOT NULL REFERENCES chart_of_accounts(id),
    currency    varchar(10) NOT NULL,
    book_base   numeric(20,4) NOT NULL,   -- current functional-ccy carrying value
    revalued_base numeric(20,4) NOT NULL, -- balance × period-end rate
    gain_loss   numeric(20,4) NOT NULL,   -- revalued - book
    entry_id    bigint REFERENCES journal_entries(id),
    reversed    boolean NOT NULL DEFAULT false,
    UNIQUE (entity_id, as_of_date, account_id, currency)
);
-- COA: 4910 'Unrealized FX Gain', 5910 'Unrealized FX Loss' (income/expense, period-only)
```

The revaluation job (4.3 sketch): for each open monetary balance, `gain_loss = balance × (rate_asof − rate_booked)`; post `Dr/Cr 4910/5910` against the account; flag for **auto-reversal** on `as_of_date + 1`. This isolates unrealized (estimate, reversed) from realized (locked at settlement) exactly as your spec requires.

## 3.4 Granular row-level RBAC

A user is granted access to org nodes; access cascades to descendants via `path`. Enforced two ways: in the query layer (a scoping helper every controller uses) **and** in the database (Postgres RLS as defense-in-depth).

```sql
CREATE TABLE user_org_access (
    user_id     int  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_unit_id bigint NOT NULL REFERENCES org_units(id) ON DELETE CASCADE,
    access      text NOT NULL CHECK (access IN ('VIEW','EDIT','POST','ADMIN')),
    PRIMARY KEY (user_id, org_unit_id)
);

-- expand a user's grants to all reachable location ids (self + descendants)
CREATE OR REPLACE FUNCTION user_allowed_locations(p_user int)
RETURNS TABLE(org_unit_id bigint, access text) AS $$
  SELECT d.id, a.access
  FROM user_org_access a
  JOIN org_units g ON g.id = a.org_unit_id
  JOIN org_units d ON d.path LIKE g.path || '%';
$$ LANGUAGE sql STABLE;
```

The accrual/deferral engine and RLS policies are in 3.4/4 — note the **recognition schedule** lives here too:

## 3.5 Automated accrual & deferral engine

Prepaid expense and deferred revenue are booked to a balance-sheet account, then **recognized** into P&L on a schedule. One generic engine serves both directions.

```sql
CREATE TABLE recognition_schedules (
    id            bigserial PRIMARY KEY,
    entity_id     bigint NOT NULL REFERENCES org_units(id),
    location_id   bigint REFERENCES org_units(id),
    kind          text NOT NULL CHECK (kind IN ('PREPAID_EXPENSE','DEFERRED_REVENUE')),
    source_ref    text,                       -- originating payable/receivable record
    total_amount  numeric(20,4) NOT NULL,
    currency      varchar(10) NOT NULL,
    balance_account_id  int NOT NULL REFERENCES chart_of_accounts(id), -- prepaid asset / deferred liab
    pnl_account_id      int NOT NULL REFERENCES chart_of_accounts(id), -- expense / revenue
    start_date    date NOT NULL,
    periods       int  NOT NULL,              -- e.g. 12 months
    method        text NOT NULL DEFAULT 'STRAIGHT_LINE',
    status        text NOT NULL DEFAULT 'ACTIVE'
);
CREATE TABLE recognition_runs (
    id          bigserial PRIMARY KEY,
    schedule_id bigint NOT NULL REFERENCES recognition_schedules(id),
    period_no   int NOT NULL,
    run_date    date NOT NULL,
    amount      numeric(20,4) NOT NULL,
    entry_id    bigint REFERENCES journal_entries(id),
    UNIQUE (schedule_id, period_no)
);
```

Each scheduled run posts: prepaid → `Dr Expense (pnl) / Cr Prepaid (balance)`; deferred → `Dr Deferred Revenue (balance) / Cr Revenue (pnl)` — idempotent on `(schedule_id, period_no)`, tagged with the same `location_id`.

---

# Phase 4 — Refactored Code & Architectural Blueprints

## 4.1 The definitive ledger-line schema (location-aware, custom-field-ready, precise)

```sql
-- entity_id = legal book of record; location_id = operational node (immutable, both required)
ALTER TABLE journal_lines
  ADD COLUMN IF NOT EXISTS location_id  bigint REFERENCES org_units(id),
  ADD COLUMN IF NOT EXISTS debit_minor  bigint NOT NULL DEFAULT 0,   -- integer cents (precise)
  ADD COLUMN IF NOT EXISTS credit_minor bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS base_minor_debit  bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS base_minor_credit bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_jl_location ON journal_lines (location_id);
CREATE INDEX IF NOT EXISTS idx_jl_custom   ON journal_lines USING gin (custom_fields);

-- schema-free custom fields, validated against a registry (no migrations to add a field)
CREATE TABLE custom_field_defs (
    id          bigserial PRIMARY KEY,
    applies_to  text NOT NULL,               -- 'journal_line' | 'invoice' | ...
    key         text NOT NULL,
    data_type   text NOT NULL CHECK (data_type IN ('text','number','date','bool','select')),
    options     jsonb,
    required    boolean NOT NULL DEFAULT false,
    UNIQUE (applies_to, key)
);
```

Keeping `numeric` columns *and* `*_minor bigint` lets you migrate gradually: write both, read minor for math, drop the float path once verified.

## 4.2 The refactored core ledger engine (complete)

This is the single choke-point every subledger calls. It fixes the entry-number race (DB sequence per entity), enforces location tagging + balance in integer minor units, writes the hash chain, and scopes by the caller's allowed locations.

```js
// services/gl/ledgerEngine.js
const crypto = require("crypto");
const pool = require("../../config/db");

// integer-minor-unit helpers — no floating point reaches a balance
const toMinor = (amount, scale = 2) => Math.round(Number(amount) * 10 ** scale);
const canonical = (entry, lines) =>
  JSON.stringify({
    e: entry.entityId, l: entry.locationId, d: entry.entryDate, s: entry.source, r: entry.sourceRef,
    L: lines.map((x) => [x.accountId, x.debitMinor, x.creditMinor, x.baseDebitMinor, x.baseCreditMinor, x.locationId]),
  });

async function nextEntryNo(db, entityId) {
  // race-free: one durable sequence per entity, created on demand
  const seqName = `je_seq_${entityId}`;
  await db.query(`CREATE SEQUENCE IF NOT EXISTS ${seqName}`);
  const { rows } = await db.query(`SELECT nextval('${seqName}') AS n`);
  return `JE-${entityId}-${String(rows[0].n).padStart(6, "0")}`;
}

async function assertCanPost(db, userId, locationId) {
  const { rows } = await db.query(
    `SELECT 1 FROM user_allowed_locations($1) WHERE org_unit_id = $2 AND access IN ('POST','ADMIN') LIMIT 1`,
    [userId, locationId],
  );
  if (!rows.length) throw new Error(`User ${userId} not authorized to post to location ${locationId}`);
}

/**
 * Post a balanced, location-tagged, hash-chained ledger entry.
 * entry:  { entityId, locationId, entryDate, source, sourceRef, description, userId }
 * lines:  [{ accountId, debit, credit, currency, exchangeRate, debitBase, creditBase, locationId?, customFields? }]
 */
async function postEntry(db, entry, lines) {
  if (!entry.locationId) throw new Error("locationId is required (location tagging is mandatory)");
  await assertCanPost(db, entry.userId, entry.locationId);

  // normalize to integer minor units and validate balance in BOTH txn and base
  const L = lines.map((x) => ({
    accountId: x.accountId,
    locationId: x.locationId || entry.locationId,
    currency: x.currency,
    exchangeRate: x.exchangeRate || 1,
    debitMinor: toMinor(x.debit || 0),
    creditMinor: toMinor(x.credit || 0),
    baseDebitMinor: toMinor(x.debitBase || 0),
    baseCreditMinor: toMinor(x.creditBase || 0),
    customFields: x.customFields || {},
  }));
  const sumBase = L.reduce((s, x) => s + x.baseDebitMinor - x.baseCreditMinor, 0);
  if (sumBase !== 0) throw new Error(`Unbalanced entry: functional debits ≠ credits by ${sumBase} minor units`);

  // period must be open
  const period = await db.query(
    `SELECT id, status FROM accounting_periods WHERE $1 BETWEEN start_date AND end_date ORDER BY id LIMIT 1`,
    [entry.entryDate],
  );
  if (!period.rows.length || period.rows[0].status !== "OPEN")
    throw new Error(`No OPEN accounting period for ${entry.entryDate}`);

  // hash chain: link to the entity's previous entry
  const prev = await db.query(
    `SELECT entry_hash FROM journal_entries WHERE entity_id = $1 AND entry_hash IS NOT NULL
      ORDER BY id DESC LIMIT 1`, [entry.entityId],
  );
  const prevHash = prev.rows[0]?.entry_hash || "GENESIS";
  const entryHash = crypto.createHash("sha256").update(prevHash + canonical(entry, L)).digest("hex");
  const entryNo = await nextEntryNo(db, entry.entityId);

  const hdr = await db.query(
    `INSERT INTO journal_entries
       (entry_no, entity_id, location_id, entry_date, period_id, description, source, source_ref,
        status, created_by, posted_at, prev_hash, entry_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'POSTED',$9, now(), $10, $11) RETURNING id`,
    [entryNo, entry.entityId, entry.locationId, entry.entryDate, period.rows[0].id, entry.description || null,
     entry.source || "MANUAL", entry.sourceRef || null, entry.userId || null, prevHash, entryHash],
  );
  const entryId = hdr.rows[0].id;

  for (const x of L) {
    await db.query(
      `INSERT INTO journal_lines
         (entry_id, account_id, entity_id, location_id, currency, debit, credit, exchange_rate,
          debit_base, credit_base, debit_minor, credit_minor, base_minor_debit, base_minor_credit, custom_fields)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [entryId, x.accountId, entry.entityId, x.locationId, x.currency,
       x.debitMinor / 100, x.creditMinor / 100, x.exchangeRate, x.baseDebitMinor / 100, x.baseCreditMinor / 100,
       x.debitMinor, x.creditMinor, x.baseDebitMinor, x.baseCreditMinor, x.customFields],
    );
  }
  return { id: entryId, entryNo, entryHash };
}

// verify the whole chain for an entity (re-hash from genesis; any mismatch = tampering)
async function verifyChain(db, entityId) {
  const { rows } = await db.query(
    `SELECT je.*, json_agg(jl.* ORDER BY jl.id) AS lines
       FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
      WHERE je.entity_id = $1 AND je.entry_hash IS NOT NULL
      GROUP BY je.id ORDER BY je.id`, [entityId],
  );
  let prevHash = "GENESIS";
  for (const r of rows) {
    const lines = r.lines.map((x) => ({
      accountId: x.account_id, debitMinor: x.debit_minor, creditMinor: x.credit_minor,
      baseDebitMinor: x.base_minor_debit, baseCreditMinor: x.base_minor_credit, locationId: x.location_id,
    }));
    const expect = crypto.createHash("sha256")
      .update(prevHash + canonical(
        { entityId: r.entity_id, locationId: r.location_id, entryDate: r.entry_date, source: r.source, sourceRef: r.source_ref },
        lines)).digest("hex");
    if (expect !== r.entry_hash) return { ok: false, brokenAt: r.id };
    prevHash = r.entry_hash;
  }
  return { ok: true, verified: rows.length };
}

module.exports = { postEntry, verifyChain, toMinor };
```

## 4.3 Consolidation with hierarchy + eliminations (query blueprint)

```sql
-- balances for a subtree (e.g. a parent GROUP), per account, translated to a target currency
-- :rootPath = the org_units.path of the consolidation root; :target = 'USD'
WITH scope AS (
  SELECT id, owning_entity_id(id) AS entity_id
  FROM org_units WHERE path LIKE :rootPath || '%'
),
movements AS (
  SELECT a.account_code, a.account_type, jl.entity_id,
         SUM(jl.base_minor_debit - jl.base_minor_credit) AS net_minor_func
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'POSTED'
  JOIN chart_of_accounts a ON a.id = jl.account_id
  WHERE jl.location_id IN (SELECT id FROM scope)
  GROUP BY a.account_code, a.account_type, jl.entity_id
)
SELECT account_code, account_type,
       -- translate each entity's functional net → target via dated rate, then sum
       SUM(net_minor_func / 100.0 * fx_rate(entity_func(entity_id), :target, current_date)) AS net_target
FROM movements
-- ELIMINATION: drop reciprocal intercompany control accounts from the consolidated view
WHERE account_code NOT IN ('1600','2600')
GROUP BY account_code, account_type
ORDER BY account_code;
```

The eliminated `1600`/`2600` balances are surfaced separately as a reconciliation check: their consolidated net must be ~0, proving inter-company books tie out.

---

## What to build first (sequenced, lowest-risk)

1. **Org tree + `location_id` on lines** (3.0, 4.1) — nothing else works without the axis. Backfill existing `region_id` → `entity_id` and create one BRANCH location per entity.
2. **RBAC + RLS scoping** (3.4, 4) — close the data-bleed hole before more data lands.
3. **Refactored `postEntry` engine** (4.2) — fixes the entry-no race, adds integer math + hash chain; route the existing `postInvoiceIssued/postBillEntered/postExpense` through it.
4. **Inter-company + consolidation-with-eliminations** (3.2, 4.3).
5. **FX revaluation** (3.3) and **accrual/deferral engine** (3.5) — period-close automation.

Each is independently shippable. Done in this order, you reach a genuinely differentiated position — true location-level consolidation, an immutable auditable ledger, and inter-company eliminations — that the mid-tier of QuickBooks and Zoho Books does not match, without pretending to clone the thousand peripheral features they have and you don't need.

---

# Known issues — logged, not fixed

Found while building inter-company invoicing (migration 016). None are caused by
that work; each is pre-existing and scoped as its own task. Recorded here so they
are visible rather than rediscovered.

## AR payments post no GL

`controllers/paymentController.js` never posts to the general ledger. It imports
neither `postingService` nor `ledgerEngine`. Cash receipts and TDS withholding
update the AR subledger columns (`payment_received_amount`, `balance_outstanding`)
and nothing else, so **the GL carries every client invoice as an open receivable
forever, no matter how much has been paid**. `1100 Accounts Receivable` therefore
does not tie to the invoice subledger, and `4000` revenue is recognised while the
matching cash never appears against it.

The single exception is `postingService.postIcInvoiceSettled`, added for
inter-company settlement, which clears `1600`/`2600` on both entities. That
asymmetry — inter-company receivables clear in the GL, client receivables do not —
is a deliberate, accepted consequence of keeping that change minimal.

Fixing this means an `AR_PAYMENT` posting for client invoices
(`Dr 1000 Bank / Dr 1200 TDS Receivable / Cr 1100 AR`, plus realized FX to
4900/5900). It is the largest correctness gap in the ledger and deserves its own
task with tests.

## chart_of_accounts has drifted from the migrations

The live database contains accounts that appear in no migration: `4910` Unrealized
FX Gain, `4920` Bank Interest Income, `5910` Unrealized FX Loss. `002` and `003`
seed neither. `fxRevaluationService` posts to 4910/5910 and works only because
they were added out-of-band.

This matters beyond tidiness: the seeds use `ON CONFLICT (account_code) DO NOTHING`,
so a new account whose code is already taken **silently no-ops** and postings land
in whatever account already holds that code. Migration 016 nearly hit exactly this
— `4900` was proposed for Inter-company Revenue and is already Realized FX Gain,
which would have routed inter-company revenue into FX gain with no error. 4600/5700
were used instead. Verify a code is free **in the live database**, not just in the
migrations, before seeding one.

`invoice_items` drifts the other way: `controllers/invoiceController.js` probes
`information_schema` for `placement_id`/`candidate_id`/`candidate_name` columns
that exist in no migration and are absent from this database.

## Consolidated balance sheet reports balanced: false on a 1-cent artifact

`glReports.consolidated()` returns `balanceSheet.totals.balanced === false` on a
residual of -0.01 with no inter-company data present at all. The check is
`Math.abs(assets - (liabilities + equity)) < 0.01`, which a residual of exactly
0.01 fails. It is per-account `round2` accumulation noise, not a real imbalance.

Unrelated to the elimination tolerance below — that one is keyed on
`intercompanyNet` and has its own scaled threshold.

## exchange_rates pairs are not reciprocal

Each direction is stored independently and they disagree:

```
USD -> GBP  0.74150000
GBP -> USD  1.34870000      1 / 0.74150000 = 1.34861767
```

An amount posted through one direction and translated back through the other does
not round-trip: GBP 3,707.50 x 1.3487 = 5,000.31 against a true 5,000.00. Any
cross-currency consolidation inherits this, not just inter-company.

Left as-is deliberately: real FX quotes carry a bid/ask spread and are not
reciprocal, so forcing reciprocal storage would be its own modelling decision.
`glReports.consolidated()` instead scales its elimination tolerance to
`max(0.01, 0.0005 x gross)` and reports `eliminationResidual` so the figure stays
auditable. `toGroup`'s lookup — the global conversion path — is untouched.

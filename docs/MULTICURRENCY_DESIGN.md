# Multi-Entity Currency Engine — Design

_For: accounting_app • Path chosen: build in-house • 27 June 2026_

## Decisions captured

| Decision | Choice |
|---|---|
| Legal structure | **Separate legal entity per region** — US (USD), UK (GBP), India (INR) |
| Books | Each entity keeps its own books **in its own functional currency** |
| Reporting | **Per-entity reports in functional currency** + **consolidated group reports in USD** |
| Rates | **Auto-fetch daily** from an external source, with **manual override** |

Your existing `regions` table already carries `company_name`, tax-ID fields, bank details and `default_currency` per region — so each region is, in practice, already a legal entity. We build on that rather than adding a parallel table.

---

## 1. The core principle

Every monetary document (invoice, bill, payment, vendor payment) belongs to **one entity** and is recorded in **three layers**:

```
  Layer 1  Transaction currency   — what the document is actually in
           e.g. a bill in GBP, an invoice in USD

  Layer 2  Functional currency    — the owning entity's book currency
           (frozen at the document's date using a stored rate)
           e.g. UK entity books everything in GBP

  Layer 3  Group currency (USD)    — for consolidation only
           (computed at report time from dated rates; never hard-coded)
```

**Rule:** the rate used is the rate **as of the document's date**, read from the `exchange_rates` table, and **frozen onto the row** the moment it is created. You never re-convert a historical document with today's rate. This is the single most important rule and the thing the current frontend (`USD_FALLBACK_RATE` in `DashboardPage.jsx`) gets wrong.

---

## 2. Two kinds of FX effect — keep them separate

These are different things and live in different places. Conflating them is the classic multi-currency bug.

### 2.1 Transaction FX gain/loss (realized, hits P&L)
Occurs **inside one entity** when a document's transaction currency ≠ the entity's functional currency, and the rate moves between **booking** and **settlement**.

> US entity (books in USD) pays an Indian contractor a bill of **₹100,000**.
> Booked when INR→USD = 0.0120 → recorded as **$1,200**.
> Paid 30 days later when INR→USD = 0.0117 → actually costs **$1,170**.
> **Realized FX gain of $30** → posted to a "Foreign Exchange Gain/Loss" line. Stored on the payment as `fx_gain_loss`.

### 2.2 Translation adjustment (consolidation, hits equity/CTA — not P&L)
Occurs when an **entity's functional results** are translated into the **group currency (USD)** for the consolidated report. The UK entity's GBP numbers move against USD over time; that difference is a **Cumulative Translation Adjustment**, not a trading gain/loss.

> UK entity earns **£10,000** profit. For the group USD report you translate at the period rate.
> If GBP→USD drifts from 1.27 to 1.25, the consolidated USD figure changes — but the UK entity didn't lose money. This is a translation effect, reported separately.

### 2.3 What this means for *your* specific scenario
Your headline example — **UK employee paid in GBP, US client pays in USD** — actually generates **zero transaction FX** at the entity level, because each leg is in its own entity's functional currency (UK bill in GBP from the GBP entity; US invoice in USD from the USD entity). The currency story there is **(a) consolidation translation** (GBP cost shown next to USD revenue in the USD group view) and **(b) economic margin exposure** (your real GBP cost vs your real USD revenue).

You only hit **transaction FX gain/loss** when an entity transacts in a currency that isn't its own — e.g. the US entity paying that Indian contractor in INR, or the UK entity invoicing a US client in USD. Both layers are needed, but don't over-invest in transaction FX screens for the legs that are always same-currency.

---

## 3. Schema changes (summary — full SQL in `database/migrations/001_currency_engine.sql`)

**New tables**
- `company_settings` — single row; holds `group_currency = 'USD'`.
- `exchange_rates` — dated rates, one row per `(from, to, date)`, with a `source` flag (`API` / `MANUAL`) so manual overrides win.

**Altered**
- `regions` → add `functional_currency` (the entity's book currency; backfilled from `default_currency`).
- `invoices` → add `exchange_rate`, `amount_base` (functional-currency total).
- `bills` → add `exchange_rate`, `amount_base`. _(AP currently has no FX columns at all — this is the biggest gap.)_
- `vendor_payments` → add `exchange_rate`, `amount_base`, `fx_gain_loss`.
- `payments` (AR) → add `fx_gain_loss` (it already has `exchange_rate` + `amount_in_base_currency`).

`amount_base` is always in the **owning entity's functional currency**. Group/USD figures are derived at report time via `exchange_rates`, so changing the group currency later (or correcting a rate) doesn't require rewriting historical rows.

---

## 4. Exchange-rate sourcing

1. A daily job calls an FX API (e.g. **exchangerate.host**, free; or **Open Exchange Rates** / your bank feed) and upserts one row per currency pair into `exchange_rates` with `source = 'API'`.
2. A finance user can insert a `source = 'MANUAL'` row for any date/pair; the lookup prefers `MANUAL` over `API` for the same `(from, to, date)`.
3. Rate lookup for a document on date *D* uses the rate **for D**, or the most recent rate **on or before D** if that exact day is missing (weekends/holidays).
4. Store pairs you actually use against the group currency and each functional currency: `USD↔INR`, `USD↔GBP`, `GBP↔INR`, plus identity (`USD→USD = 1`).

Starter code for both the fetch job and the conversion lookup is in `backend/services/currency/`.

---

## 5. How each flow uses the engine

**Creating an invoice** (US entity, client in USD)
`currency='USD'`, entity functional = USD → `exchange_rate=1`, `amount_base=total_amount`. Trivial, but the columns are filled consistently so reporting is uniform.

**Creating a bill** (UK entity, vendor/employee in GBP)
`currency='GBP'`, entity functional = GBP → `exchange_rate=1`, `amount_base=total`.

**Creating a bill** (US entity, contractor in INR)
`currency='INR'`, entity functional = USD → look up INR→USD for `bill_date`, store it as `exchange_rate`, store `amount_base = total * rate`.

**Recording settlement** (the INR bill above, paid later)
Look up INR→USD for `payment_date`; `amount_base` of the payment uses that rate; `fx_gain_loss = bill.amount_base_portion − payment.amount_base`. Post the difference.

**Per-entity report**
Sum `amount_base` filtered by `region_id` — already in that entity's functional currency. No conversion needed.

**Consolidated USD report**
For each entity, translate its functional totals → USD via `exchange_rates` at the report/period date, then sum across entities. Translation differences accumulate as CTA. **All of this runs in the backend**, replacing the frontend `USD_FALLBACK_RATE` constants.

---

## 6. Edge cases to handle (don't skip these)

- **Rounding:** convert then round to 2 dp at the line/document level; never sum pre-rounded values and re-round. Keep `exchange_rate` at 6 dp.
- **Missing-day rates:** fall back to most-recent-on-or-before; flag if older than N days so finance knows the rate is stale.
- **Rate corrections:** a manual override for a past date should *not* silently rewrite already-settled documents' frozen rates — frozen is frozen. Apply corrections going forward or via an explicit re-valuation routine.
- **Same-currency fast path:** when transaction currency == functional currency, force `exchange_rate=1` exactly (don't fetch a ~1.0000 rate that introduces rounding noise).
- **Historical backfill:** when you deploy, backfill `amount_base`/`exchange_rate` on existing rows using each document's own date, not today's rate.

---

## 7. Build order

1. Run migration `001_currency_engine.sql` (review first; apply via a migration tool, not by hand on prod).
2. Seed `company_settings.group_currency='USD'` and backfill `regions.functional_currency`.
3. Stand up the daily rate fetch (`rateService.js`) + verify a week of rates land.
4. Wire `currencyService.convert()` into invoice/bill creation to freeze `exchange_rate` + `amount_base`.
5. Add `fx_gain_loss` posting at settlement (payments + vendor_payments).
6. Backfill historical rows.
7. Move dashboard/report aggregation to backend; delete `USD_FALLBACK_RATE`.
8. Add tests around `convert()`, rounding, and FX gain/loss before trusting any number.

---

## 8. One honest caution

This gives you **accurate multi-currency AR/AP and consolidation** — which is what you asked for. It is **not** a general ledger: there are still no journal entries, trial balance, or statutory financial statements. If you later need to *file* in each country, you'll either add a lightweight GL on top of this, or feed these entity-level figures into Zoho Books / QuickBooks per entity (which already do statutory multi-currency reporting). The currency engine here is designed so that either extension is straightforward — the entity model and dated rates are exactly what a GL would need.

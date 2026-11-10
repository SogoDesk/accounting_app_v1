# General Ledger Design — Double-Entry Core

_For: accounting_app • 27 June 2026_

## Decisions captured
| Decision | Choice |
|---|---|
| Architecture | **GL layered under the existing app** — invoices/bills/payments are subledgers that auto-post journal entries |
| Chart of accounts | **One shared COA**, every journal line tagged by entity (region) |
| Reporting | **Management accounts first** — Trial Balance, P&L, Balance Sheet; multi-currency; statutory formatting later |
| Entities / currencies | US (USD), UK (GBP), India (INR); consolidated reporting currency **USD** |

This builds directly on the currency engine in `MULTICURRENCY_DESIGN.md` (dated `exchange_rates`, functional currency per region). The GL stores **functional-currency** amounts on every line; consolidation to USD happens at report time via dated rates.

---

## 1. The mental model

Today the app answers *"who owes us / who do we owe?"*. A general ledger answers *"what is every account worth, and does it all balance?"* Every business event becomes a **journal entry** with two or more **lines**, where **total debits = total credits**. Nothing is ever edited or deleted — corrections are made by posting a **reversing** entry. That immutability is what makes the books trustworthy and auditable.

```
  Business event                 Journal entry (always balances)
  ─────────────────────────────  ──────────────────────────────────────────
  Invoice a US client $15,200    Dr  Accounts Receivable   15,200
                                 Cr    Staffing Revenue            15,200

  Pay UK contractor £8,800       Dr  Contractor Cost        8,800
                                 Cr    Accounts Payable             8,800
```

The existing tables (`invoices`, `bills`, `payments`, `vendor_payments`) become **subledgers**: detailed records that each generate a GL journal entry. The GL is the summarized, balanced system of record underneath them.

---

## 2. Data model (full SQL in `database/migrations/002_general_ledger.sql`)

**`fiscal_years` / `accounting_periods`** — a calendar of periods (usually months) per fiscal year, each `OPEN` or `CLOSED`. You cannot post into a closed period. This is how month-end and year-end close work.

**`chart_of_accounts`** — one shared list of accounts. Each account has:
- `account_code` (e.g. `1100`), `account_name`
- `account_type` ∈ {ASSET, LIABILITY, EQUITY, INCOME, EXPENSE}
- `normal_balance` ∈ {DEBIT, CREDIT} (assets/expenses are debit-normal; liabilities/equity/income are credit-normal)
- `parent_id` for sub-totals (e.g. "Current Assets" → "Bank", "Accounts Receivable")
- `is_control` flag for subledger control accounts (AR, AP) that should only be posted by the system

**`journal_entries`** (header) — `entry_no`, `entity_id` (region), `entry_date`, `period_id`, `description`, `source` (MANUAL / AR_INVOICE / AR_PAYMENT / AP_BILL / AP_PAYMENT / FX_REVAL), `source_ref` (e.g. invoice id), `status` (DRAFT / POSTED / REVERSED), `created_by`.

**`journal_lines`** (detail) — the heart of the system:
- `account_id`, `entity_id`
- `currency` — the **transaction** currency of the line
- `debit`, `credit` — amounts in the **transaction** currency
- `exchange_rate` — transaction → entity functional currency (frozen at entry date)
- `debit_base`, `credit_base` — amounts in the **entity's functional currency**
- `memo`, plus optional dimensions (`placement_id`, `client_id`, `vendor_id`) so you can slice P&L by client/placement later

**The golden rule, enforced on posting:** within one entry, `Σ debit_base = Σ credit_base`. A single-entity entry's lines all share that entity's functional currency, so it always balances cleanly. Group/USD figures are derived at report time, so a later rate revision never unbalances a historical entry.

---

## 3. Multi-currency in the ledger

Three things to keep straight (the §2 of `MULTICURRENCY_DESIGN.md` distinction, now expressed in the GL):

1. **Foreign-currency transaction inside an entity.** US entity (USD books) records a bill in INR. The line stores `currency=INR`, `debit/credit` in INR, plus `debit_base/credit_base` in USD at the bill-date rate. The entry balances in USD.

2. **Realized FX gain/loss (P&L).** When that INR bill is paid later at a different rate, the USD actually paid ≠ the USD originally booked. The settlement entry includes a balancing line to **`4900 Realized FX Gain`** or **`5900 Realized FX Loss`**. This is automatic in the payment posting.

3. **Consolidation translation (equity, not P&L).** Each entity's books are complete in its own functional currency. For the **consolidated USD** statements, translate each entity's balances to USD at the reporting-date rate; the residual that makes the consolidated balance sheet balance posts to **`3200 Cumulative Translation Adjustment`**. This is a reporting-layer calculation, not a journal entry in any entity.

For your headline case (UK contractor paid GBP, US client billed USD): the UK entity books the GBP cost with no transaction FX, the US entity books the USD revenue with no transaction FX, and the GBP-vs-USD difference only appears when you **consolidate** — exactly where it belongs.

---

## 4. Subledger → GL posting matrix

These are the entries the posting service creates automatically. Amounts are shown in the document's transaction currency; the service also fills the functional-currency columns.

| Event | Debit | Credit |
|---|---|---|
| **AR invoice issued** | Accounts Receivable (total) | Staffing Revenue (subtotal); Taxes Payable (tax) |
| **AR payment received** | Bank (cash); Withholding/TDS Receivable (if withheld); FX Loss (if any) | Accounts Receivable (settled); FX Gain (if any) |
| **AP bill entered** | Contractor Cost (subtotal); Input Tax (if recoverable) | Accounts Payable (total) |
| **AP vendor payment** | Accounts Payable (settled); FX Loss (if any) | Bank (cash); FX Gain (if any) |
| **Manual / adjusting** | any | any (must balance) |

Control accounts (AR, AP) are touched **only** by these automated postings, so the GL AR balance always reconciles to the sum of open invoices, and AP to open bills. That reconciliation is your daily proof the system is consistent.

---

## 5. Financial statements (management view)

All three are queries over `journal_lines`, available **per entity** (filter `entity_id`, report in functional currency) and **consolidated** (translate functional → USD via `exchange_rates`):

- **Trial Balance** — every account with total debits, total credits, and net balance. The grand total of debits must equal credits. This is the first report to build; everything else derives from it.
- **Profit & Loss** — sum INCOME and EXPENSE accounts over a date range. Income (credit-normal) less Expense (debit-normal) = net profit.
- **Balance Sheet** — ASSET, LIABILITY, EQUITY balances as of a date. Assets = Liabilities + Equity, where Equity includes Retained Earnings (prior periods' net profit) + current-period net profit + CTA.

`glReports.js` ships with `trialBalance()`, `profitAndLoss()`, and `balanceSheet()` starters.

---

## 6. Integrity & controls (don't skip)

- **Balanced entries only.** Enforced in `postingService` and a DB check; an unbalanced entry must be impossible to post.
- **No edits, only reversals.** A posted entry is immutable; fix mistakes with a system-generated reversing entry. Keeps a clean audit trail (you already have an `audit_logs` table to reference).
- **Closed periods are locked.** Posting into a `CLOSED` period is rejected.
- **One source of truth for rates.** All conversion uses the dated `exchange_rates` table; never re-derive a historical rate.
- **Sequential entry numbers** per entity for auditability.
- **Opening balances** are entered as a dated opening journal entry per entity when you go live.

---

## 7. Build order

1. Run migration `002_general_ledger.sql` (periods, COA, journals, seed COA). Review first.
2. Open the current fiscal year's periods; enter opening balances per entity.
3. Wire `postingService.postInvoiceIssued()` into invoice creation, then `postPaymentReceived()` into payments. Verify AR control = Σ open invoices.
4. Do the same for bills and vendor payments; verify AP control = Σ open bills.
5. Build Trial Balance; confirm it balances. Then P&L and Balance Sheet per entity.
6. Add consolidated USD reporting (translate functional → USD; plug CTA).
7. Add period close (lock period, roll net income to Retained Earnings at year-end).
8. **Tests around posting and balance** before trusting any statement — this is non-negotiable for a ledger.

---

## 8. Honest scope note

This gives you a real, auditable double-entry GL with management-grade Trial Balance, P&L, and Balance Sheet across three currencies — genuinely "QuickBooks-like" at the core. What it deliberately does **not** include yet: statutory report formatting per country, tax-return schedules, fixed-asset depreciation, bank-feed reconciliation, and multi-user approval on journals. Those are additive on top of this foundation, which is designed to carry them. Realistically, getting the posting layer correct and trustworthy (steps 3–8) is several focused weeks of work plus a solid test suite — the schema is the easy part; the posting rules and reconciliation are where the care goes.

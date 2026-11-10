# Operating Expenses — Feature Design

_Adding your "Office Expense Tracker" into accounting_app • 27 June 2026_

## 1. What your spreadsheet does (so we replicate it exactly)

| Sheet | Purpose | Becomes in the app |
|---|---|---|
| Categories | 25 expense categories (Rent, Utilities, Software, Meals, Salaries, EMI, Priest, Assets…) | `expense_categories` master, each mapped to a GL account |
| Fixed_Expenses | Recurring costs with GST 18%, TDS 2–10%, `Amount = Actual + GST − TDS`, `Monthly_Equiv = Amount / Period`, Start/End month, Active flag | `recurring_expenses` (templates that auto-generate monthly expense entries) |
| Transactions | 139 day-to-day variable items: date, type, category, description, payment method, amount, tax, total, **reimbursable Y/N**, **paid-by**, status | `expenses` (the core ledger of actual spend) |
| Monthly_Summary | Category × month matrix combining variable + fixed monthly-equivalents, with YTD | Expense report endpoint + page |
| Dashboard | Year/month picker; Variable (actual) vs Fixed (planned) vs Total; category breakdown | Expense dashboard / report tab |

Key concepts to carry over: **fixed vs variable**, **input GST** (recoverable), **TDS withholding** (a payable to the tax authority), **reimbursable spend** (someone paid personally and is owed back), **payment method** (mostly personal/company credit cards), a **status** workflow, and everything in **INR** under your India entity.

---

## 2. Recommended approach

Add a dedicated **Expenses module** layered on the existing app and general ledger — *not* inside Bills/AP. Reasons:

- Bills are vendor invoices with an approval workflow built for staffing costs; office expenses are high-volume, small, often card-paid and reimbursable. Forcing each through bill approval would be painful.
- Expenses need **category → GL account** mapping, **input GST**, **TDS**, and **reimbursement** tracking that bills don't model.
- It still reuses what you've built: **entities/regions** (India, US, UK), optional **vendor** links, the **GL** (so expenses land in your P&L automatically), and dated **exchange_rates** for consolidation.

So: three new tables, a posting path into the GL, a few endpoints, and an "Expenses" section in the nav.

---

## 3. Data model

```
expense_categories
  id, name, gl_account_id (-> chart_of_accounts), is_active
  -- seeded from your 25 categories, each pointed at an expense account

payment_methods                 -- so card/bank spend posts to the right account
  id, name, type (BANK | CARD | CASH), gl_account_id, entity_id, is_active
  -- e.g. "Amex - Sravan" (CARD -> 2400 Credit Card liability),
  --      "Bank Transfer" (BANK -> 1000 Bank), "Petty Cash" (CASH -> 1050)

recurring_expenses              -- your Fixed_Expenses sheet
  id, entity_id, name, category_id, vendor_id NULL, vendor_name,
  payment_method_id, currency,
  actual_cost, gst_percent, tds_percent,
  amount (= actual + gst - tds), period_months, monthly_equiv (= amount / period),
  start_month, end_month, is_active, notes
  -- a generator turns active templates into dated `expenses` each month

expenses                        -- your Transactions sheet (the core)
  id, entity_id, expense_date, category_id,
  expense_type,                 -- FIXED | VARIABLE (fixed = generated from a template)
  recurring_id NULL,            -- link back to the template if generated
  payee / vendor_id NULL, vendor_name, description,
  payment_method_id, currency,
  amount, gst_amount, tds_amount, total_amount (= amount + gst),
  exchange_rate, amount_base,   -- functional-currency value for the GL (per migration 001)
  is_reimbursable, paid_by,     -- person owed if reimbursable
  status,                       -- DRAFT | RECORDED | REIMBURSED | CANCELLED
  gl_entry_id NULL,             -- the posted journal entry
  created_by, created_at
```

Every column from your spreadsheet has a home; nothing is lost.

---

## 4. GST & TDS — handled correctly (worked from your data)

Your fixed "Office Rent" row: Actual ₹219,432 · GST 18% = ₹39,497.76 · TDS 10% = ₹21,943.20 · Amount ₹236,986.56.

What actually happens: the landlord is owed Actual + GST, you **withhold** TDS and remit it to the tax authority, so net cash out = Actual + GST − TDS. GST is **recoverable** (an asset/credit you reclaim). The journal entry:

```
Dr  Rent expense            219,432.00     (category -> 5500 Rent)
Dr  Input GST recoverable    39,497.76     (2100 / a GST-input account)
    Cr  Bank / payment acct              236,986.56   (net paid)
    Cr  TDS payable                       21,943.20   (2200, remit later)
```

Debits 258,929.76 = Credits 258,929.76 — balanced, and it posts straight into the GL you already built. Variable items usually have GST = TDS = 0, so they reduce to Dr expense / Cr payment account.

---

## 5. Subledger → GL posting matrix

| Event | Debit | Credit |
|---|---|---|
| **Expense recorded (company-paid)** | Expense (category account); Input GST (if any) | Payment account (bank/card); TDS payable (if any) |
| **Expense recorded (reimbursable, paid personally)** | Expense (category account) | Reimbursements payable (to `paid_by`); TDS payable (if any) |
| **Reimbursement settled** | Reimbursements payable | Bank |
| **Recurring template, monthly run** | (same as expense recorded, one entry per active template per month) | |

This means your office expenses flow into the **P&L** automatically (each category is an expense account), input GST accumulates as a recoverable, TDS accumulates as a payable to remit, and reimbursements are tracked as what you owe staff — all things the spreadsheet can't enforce but the ledger can.

---

## 6. Chart-of-accounts additions

Your seeded COA already has 5100 Salaries, 5200 Software, 5300 Bank Charges, 5400 Professional Fees, 6000 G&A, 2100 GST payable, 2200 TDS payable. Add office-expense accounts so categories map cleanly, e.g.: 5500 Rent & Lease, 5510 Utilities, 5520 Internet & Phone, 5530 Office Supplies, 5540 Printing & Postage, 5550 Travel, 5560 Meals & Entertainment, 5570 Maintenance & Repairs, 5580 Marketing, 5590 Insurance, 5600 EMI / Finance, 2400 Credit Card payable, 2500 Reimbursements payable, 1400 Input GST recoverable. Each `expense_category` row simply points at one of these.

---

## 7. API (mirrors your existing route style)

```
GET    /api/expense-categories            list (+ POST/PUT to manage)
GET    /api/payment-methods               list (+ manage)
GET    /api/recurring-expenses            list / create / update
POST   /api/recurring-expenses/run        generate this month's fixed expenses
GET    /api/expenses                       list with filters (entity, category, period, status, reimbursable)
POST   /api/expenses                       create -> posts a GL entry
PUT    /api/expenses/:id                   edit (reverse + repost if already posted)
POST   /api/expenses/:id/reimburse         settle a reimbursable expense
GET    /api/expenses/reports/by-category   category × month matrix (Monthly_Summary)
GET    /api/expenses/reports/summary       fixed vs variable vs total, YTD (Dashboard)
```

---

## 8. Frontend (one new nav section)

Under a new **Expenses** group in the sidebar (sits naturally beside Purchases):

- **Expenses** — the main register: searchable/filterable table (date, category, payee, amount, GST/TDS, payment method, reimbursable, status), with an "Add expense" form. This is your Transactions sheet, but live.
- **Recurring** — manage fixed expenses; a "Generate this month" button creates the monthly entries. Your Fixed_Expenses sheet.
- **Expense reports** — the category × month matrix with fixed/variable toggle and entity + year filters. Your Monthly_Summary + Dashboard, recreated as live reports.
- **Categories & payment methods** — small settings pages mapping each to a GL account.

All reuse the calm card/table styling from the refresh.

---

## 9. Importing your existing spreadsheet

A one-time importer reads the workbook and loads: Categories → `expense_categories`, Fixed_Expenses → `recurring_expenses`, Transactions → `expenses` (parsing GST/TDS, reimbursable, paid-by, payment method, status). It de-duplicates and maps free-text categories/payment methods to the masters, flagging anything unmatched for review. So you start with all 139 transactions and 9 recurring costs already in the system, not a blank slate.

---

## 10. Suggested build order

1. Migration: `expense_categories`, `payment_methods`, `recurring_expenses`, `expenses` + COA additions (seed the 25 categories and your payment methods).
2. Backend: expenses controller + routes; GL posting (extends the posting service you already have).
3. Importer: load the spreadsheet so there's real data day one.
4. Frontend: Expenses register + Add form; then Recurring; then Expense reports.
5. Recurring generator (monthly job, reusing the scheduling you have).
6. Tests on the GST/TDS/reimbursement posting math before trusting the numbers.

---

## 11. Honest scope note

This is a real module — roughly the size of your Bills feature — so it's a few focused days of build plus the importer. The payoff is large: office spend stops living in Excel, every expense lands in the P&L by category, GST-recoverable and TDS-payable are tracked as real balances, reimbursements become a tracked liability to staff, and the India entity's operating costs consolidate into the same USD group view as everything else. It reuses your entities, vendors, GL, and currency engine, so nothing here is throwaway.

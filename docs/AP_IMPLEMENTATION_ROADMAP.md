# AP Implementation Roadmap

## Delivery Principle

Ship AP in phases that preserve production AR stability and progressively improve architecture.

---

## Phase 0: Foundation Alignment

Goal:

- prepare the codebase for AP without changing user workflows yet

Tasks:

1. Create target route namespaces:
   - `/api/dashboard/*`
   - `/api/ar/*`
   - `/api/ap/*`
   - `/api/reports/*`
   - `/api/transactions/*`
2. Add shared constants for statuses, payment modes, and permissions.
3. Introduce validation library standard.
4. Add backend module folders for `ap`, `dashboard`, and `shared`.
5. Define permission matrix for AR/AP/dashboard/reports/approvals.

Deliverables:

- new module skeleton
- permission map
- route naming standard
- validation standard

---

## Phase 1: Database and Shared Backbone

Goal:

- add AP schema and common infrastructure

Tasks:

1. Create `vendors`.
2. Create `bills`.
3. Create `bill_items`.
4. Create `bill_approvals`.
5. Create `attachments`.
6. Create `financial_transactions`.
7. Create `payment_allocations`.
8. Add indexes and `deleted_at` columns for new tables.
9. Create reporting/dashboard SQL views:
   - `vw_ar_aging`
   - `vw_ap_aging`
   - `vw_financial_transactions`
   - `vw_cash_flow_monthly`

Deliverables:

- migration scripts
- schema documentation
- DB indexes in place

Success check:

- migrations run safely on staging
- existing AR queries still work unchanged

---

## Phase 2: Vendor Management

Goal:

- deliver AP master data first

Backend:

1. Build vendor validators.
2. Build vendor service and controller.
3. Add endpoints:
   - `GET /api/ap/vendors`
   - `POST /api/ap/vendors`
   - `GET /api/ap/vendors/:id`
   - `PUT /api/ap/vendors/:id`

Frontend:

1. Add Vendors page.
2. Reuse table, modal, search, and status badge patterns from clients page.
3. Add create/edit vendor modal with smart defaults.

UX:

- keep form small
- contact fields optional where possible
- default status to active

Success check:

- accountants can create and manage vendors in under 1 minute per vendor

---

## Phase 3: Bills

Goal:

- deliver AP document workflow equivalent to invoices, but simpler

Backend:

1. Build bill validators.
2. Build bill service with:
   - totals
   - due date by payment terms
   - status derivation
   - attachment linking
3. Add endpoints:
   - `GET /api/ap/bills`
   - `POST /api/ap/bills`
   - `GET /api/ap/bills/:id`
   - `PUT /api/ap/bills/:id`
   - `PATCH /api/ap/bills/:id/status`

Frontend:

1. Add Bills page.
2. Reuse invoice page layout concepts:
   - summary cards
   - filter toolbar
   - line item modal
   - view drawer/modal
3. Keep the bill form simpler than the invoice form:
   - vendor
   - bill number
   - bill date
   - due date
   - terms
   - line items
   - tax
   - notes
   - attachments

Status model:

- `DRAFT`
- `SUBMITTED`
- `APPROVED`
- `REJECTED`
- `PARTIALLY_PAID`
- `PAID`
- `OVERDUE`

Success check:

- a bill can be created, updated, and viewed end-to-end

---

## Phase 4: Approvals

Goal:

- add lightweight approval workflow without workflow-engine complexity

Backend:

1. Add approval service.
2. Add endpoints:
   - `POST /api/ap/bills/:id/submit`
   - `POST /api/ap/bills/:id/approve`
   - `POST /api/ap/bills/:id/reject`
   - `GET /api/ap/approvals/pending`
3. Write approval history to `bill_approvals`.
4. Write audit log entries for each action.

Frontend:

1. Add Approvals page.
2. Add pending approvals widget on dashboard.
3. Add bill approval timeline panel.
4. Require comments on rejection.

UX:

- one-click approve
- reject with reason
- show amount, vendor, due date, attachment count before opening detail

Success check:

- approvers can process pending bills from one queue with no extra navigation

---

## Phase 5: Vendor Payments

Goal:

- support partial and full vendor payments using shared transaction architecture

Backend:

1. Build payable payment service on top of `financial_transactions`.
2. Add payment allocation logic to `payment_allocations`.
3. Recalculate bill balances and statuses after each payment.
4. Add endpoints:
   - `GET /api/ap/payments`
   - `POST /api/ap/payments`
   - `PUT /api/ap/payments/:id`

Frontend:

1. Add Vendor Payments page.
2. Reuse payment modal patterns from AR Payments.
3. Show:
   - bill summary
   - paid amount
   - outstanding amount
   - payment history
   - payment method

Rules:

- no overpayment
- allow partial payment
- require approved bill before payment unless business says otherwise

Success check:

- bill balance and dashboard cash outflow update correctly after payment

---

## Phase 6: Unified Dashboard

Goal:

- replace AR-only dashboard with one accounting dashboard

Backend:

1. Build dashboard service endpoints:
   - summary
   - recent transactions
   - cash flow
   - AR/AP comparison
   - approvals snapshot
2. Use SQL views for heavy aggregation.

Frontend:

1. Replace current KPI set with unified KPI set:
   - Total Receivables
   - Total Payables
   - Outstanding Invoices
   - Outstanding Bills
   - Overdue AR
   - Overdue AP
   - Cash Inflow
   - Cash Outflow
   - Pending Approvals
2. Add charts:
   - AR vs AP monthly comparison
   - monthly cash flow
   - aging by module
3. Add recent transactions feed.

UX:

- preserve current visual quality
- avoid clutter
- keep filters global

Success check:

- dashboard answers "what is due in, due out, overdue, and awaiting action?" in one screen

---

## Phase 7: Unified Navigation and Shared Components

Goal:

- make the app feel like one accounting platform

Tasks:

1. Introduce `AccountingLayout` or upgrade current main layout.
2. Update sidebar to:
   - Dashboard
   - Receivables
   - Payables
   - Transactions
   - Reports
   - Attachments
   - Settings
3. Extract shared UI components:
   - data table
   - filter toolbar
   - status badge
   - amount display
   - payment modal
   - attachment list
   - empty state card

Success check:

- users do not perceive AR and AP as two separate apps

---

## Phase 8: Reports

Goal:

- deliver unified accounting reports

Reports:

1. AR Aging
2. AP Aging
3. Cash Flow
4. Customer Outstanding
5. Vendor Outstanding
6. Payment Summary
7. Monthly Financial Summary

Technical tasks:

1. Build report query services using views.
2. Add CSV export first.
3. Add consistent filter bar across report pages.

Success check:

- finance team can export the same core AR/AP reporting pack from one reports area

---

## Phase 9: Attachments and Hardening

Goal:

- finish operational details needed for production quality

Tasks:

1. Add secure upload/download endpoints.
2. Attach files to bills and optionally invoices.
3. Add file validation rules.
4. Add audit logging for upload/delete.
5. Add approval comments visibility in bill detail.
6. Add attachment counts to bill lists and dashboard widgets.

Success check:

- users can review supporting documents directly in AP workflows

---

## Phase 10: AR Cleanup and Shared Service Refactor

Goal:

- consolidate architecture after AP is live

Tasks:

1. Extract reusable payment logic from AR controller into shared service.
2. Extract shared status derivation helpers.
3. Move dashboard logic from frontend-heavy computation to backend-first aggregation.
4. Standardize validators and service structure across AR and AP.
5. Optionally add `/api/ar/*` aliases and migrate frontend gradually.

Success check:

- less duplicated logic
- clearer backend boundaries
- easier maintenance

---

## Recommended Build Order Inside the Repo

### Backend first

1. migrations
2. `modules/ap`
3. `modules/shared`
4. dashboard queries
5. reports

### Frontend second

1. vendors
2. bills
3. approvals
4. vendor payments
5. unified dashboard
6. reports

### Refactor third

1. shared components
2. shared services
3. route cleanup

---

## Suggested Milestone Plan

### Milestone 1

- schema
- vendors
- bills draft flow

### Milestone 2

- approvals
- vendor payments
- AP aging

### Milestone 3

- unified dashboard
- transactions
- reports

### Milestone 4

- attachments
- refactor
- hardening

---

## Testing Checklist

For each phase, verify:

- permissions
- audit logs
- status transitions
- total/balance calculations
- overdue calculations
- mobile layout
- dark/light mode
- CSV exports

Critical regression checks:

- existing AR invoice creation
- AR payment creation
- AR dashboard numbers
- invoice status recalculation

---

## Non-Goals for First AP Release

Do not include unless urgently needed:

- purchase orders
- multi-currency revaluation engine
- full general ledger
- multi-step dynamic approval engine
- supplier portal
- budgeting

These can come later.

---

## Final Recommendation

Build AP as a sibling module inside the existing accounting application, then unify dashboard, reports, and shared transactions around both domains.

That gives you:

- a simple user experience
- a low-risk delivery path
- an enterprise-ready internal structure
- room to scale later without overengineering now

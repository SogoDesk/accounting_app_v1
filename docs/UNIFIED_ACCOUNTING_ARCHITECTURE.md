# Unified AR + AP Accounting Architecture

## 1. Product Goal

Convert the current AR-focused accounting app into a single accounting platform that supports:

- Accounts Receivable
- Accounts Payable
- Unified dashboard
- Shared reporting
- Shared transactions and attachments
- Consistent navigation and reusable UI

Design principle:

> Simple for users, robust internally.

This means:

- One Accounting area, not separate AR and AP products
- Minimal-click workflows
- Familiar patterns reused across invoices, bills, and payments
- Modular backend internals without forcing a major rewrite

---

## 2. Recommended Target Architecture

### 2.1 Architecture Style

Use a **modular monolith**.

Why this fits your app:

- You already have a working Express + PostgreSQL system
- AP is closely related to AR and should share auth, audit, reports, and dashboard logic
- A modular monolith keeps deployment simple while still being enterprise-grade

Recommended layers:

- `routes`
- `controllers`
- `services`
- `repositories` or `queries`
- `validators`
- `shared`

Do not jump straight to microservices.

---

## 3. Unified Information Model

### 3.1 Core Domains

Keep AR and AP as separate business domains, but share technical primitives.

Shared primitives:

- parties
- documents
- payments
- attachments
- approvals
- audit logs
- dashboard metrics
- reports

Business domains:

- `AR`: customers, invoices, customer receipts
- `AP`: vendors, bills, vendor disbursements, approvals

### 3.2 Key Design Decision

Do **not** force AR invoices and AP bills into one physical table right now.

Instead:

- Keep AR invoice tables intact
- Add AP bill tables with a matching shape where practical
- Introduce shared cross-cutting tables for payments, attachments, approvals, and transactions
- Add unified SQL views for dashboard/reporting

This is the safest path because your AR module is already in production.

---

## 4. Database Design

### 4.1 Keep Existing AR Tables

Retain current tables:

- `clients`
- `placements`
- `invoices`
- `invoice_items`
- `payments`
- `audit_logs`
- `notifications`
- `users`
- `roles`
- `regions`

### 4.2 Add AP Tables

#### `vendors`

Purpose: AP equivalent of `clients`.

Suggested columns:

- `id`
- `vendor_code`
- `vendor_name`
- `region_id`
- `billing_address`
- `tax_identifier`
- `currency`
- `default_payment_terms`
- `primary_contact_name`
- `primary_contact_email`
- `primary_contact_phone`
- `bank_name`
- `bank_account_name`
- `bank_account_number`
- `bank_routing_number`
- `bank_swift_ifsc`
- `status`
- `created_by`
- `created_at`
- `updated_at`
- `deleted_at`

Indexes:

- unique `vendor_code`
- index `region_id`
- index `status`
- index `deleted_at`

#### `bills`

Purpose: AP header document.

Suggested columns:

- `id`
- `bill_number`
- `vendor_id`
- `region_id`
- `bill_date`
- `due_date`
- `service_period_start`
- `service_period_end`
- `subtotal`
- `tax_amount`
- `total_amount`
- `currency`
- `bill_status`
- `approval_status`
- `payment_paid_amount`
- `balance_outstanding`
- `invoice_reference`
- `external_reference`
- `notes`
- `created_by`
- `approved_by`
- `approved_at`
- `created_at`
- `updated_at`
- `deleted_at`
- `tax_lines_json`

Statuses:

- `DRAFT`
- `SUBMITTED`
- `APPROVED`
- `REJECTED`
- `PARTIALLY_PAID`
- `PAID`
- `OVERDUE`
- `CANCELLED`

Indexes:

- unique `bill_number`
- index `vendor_id`
- index `region_id`
- index `bill_date`
- index `due_date`
- index `bill_status`
- index `approval_status`
- index `deleted_at`

#### `bill_items`

Purpose: AP line items.

Suggested columns:

- `id`
- `bill_id`
- `description`
- `quantity`
- `unit_price`
- `line_total`
- `expense_category`
- `cost_center`
- `created_at`

Indexes:

- index `bill_id`

#### `bill_approvals`

Purpose: approval workflow history.

Suggested columns:

- `id`
- `bill_id`
- `step_no`
- `action`
- `comments`
- `acted_by`
- `acted_at`
- `created_at`

Actions:

- `SUBMITTED`
- `APPROVED`
- `REJECTED`
- `RETURNED`

Indexes:

- index `bill_id`
- index `acted_by`
- index `acted_at`

### 4.3 Shared Tables to Introduce

#### `attachments`

Use one shared attachment table for AR and AP.

Suggested columns:

- `id`
- `entity_type`
- `entity_id`
- `file_name`
- `storage_key`
- `mime_type`
- `file_size`
- `uploaded_by`
- `created_at`
- `deleted_at`

Supported entity types:

- `INVOICE`
- `BILL`
- `PAYMENT`
- `VENDOR`
- `CLIENT`

Indexes:

- index `(entity_type, entity_id)`
- index `uploaded_by`
- index `deleted_at`

#### `financial_transactions`

Use this as the unified transaction history table.

Suggested columns:

- `id`
- `transaction_type`
- `flow_direction`
- `source_module`
- `reference_type`
- `reference_id`
- `counterparty_type`
- `counterparty_id`
- `transaction_date`
- `amount`
- `currency`
- `payment_method`
- `reference_number`
- `status`
- `metadata_json`
- `created_by`
- `created_at`
- `updated_at`
- `deleted_at`

Examples:

- AR customer receipt
- AP vendor payment
- future journal-linked events

Values:

- `transaction_type`: `RECEIPT`, `DISBURSEMENT`, `ADJUSTMENT`
- `flow_direction`: `INFLOW`, `OUTFLOW`
- `source_module`: `AR`, `AP`
- `reference_type`: `INVOICE`, `BILL`, `PAYMENT`
- `counterparty_type`: `CUSTOMER`, `VENDOR`

Indexes:

- index `(source_module, transaction_date)`
- index `(reference_type, reference_id)`
- index `(counterparty_type, counterparty_id)`
- index `status`
- index `deleted_at`

#### `payment_allocations`

Use this if one payment can cover multiple invoices or bills.

Suggested columns:

- `id`
- `transaction_id`
- `document_type`
- `document_id`
- `allocated_amount`
- `created_at`

Values:

- `document_type`: `INVOICE`, `BILL`

Indexes:

- index `transaction_id`
- index `(document_type, document_id)`

This table lets you gradually move from AR-only `payments` to a reusable payment architecture.

### 4.4 Soft Delete

Add `deleted_at` to new AP and shared tables.

For existing AR tables, add soft delete only where it materially helps:

- `clients`
- `vendors`
- `attachments`
- `financial_transactions`
- `bills`

Avoid retrofitting soft delete into every production AR table in phase 1 if it would create migration risk.

### 4.5 Shared Ledger Direction

Do not build a full GL engine in the first AP release.

Recommended path:

Phase 1:

- use `financial_transactions` as unified operational ledger
- support cash inflow/outflow, references, and status

Phase 2:

- add `ledger_accounts`, `journal_entries`, `journal_lines`
- post AR/AP events into ledger automatically

This keeps AP launch simple while preserving an upgrade path.

---

## 5. Backend Architecture

### 5.1 Recommended Folder Structure

```text
backend/
  src/
    app.js
    server.js
    config/
      db.js
    modules/
      ar/
        ar.routes.js
        controllers/
          invoices.controller.js
          payments.controller.js
          customers.controller.js
          aging.controller.js
        services/
          invoice.service.js
          receipt.service.js
          aging.service.js
        validators/
          invoice.validator.js
          receipt.validator.js
        repositories/
          invoice.repo.js
          payment.repo.js
      ap/
        ap.routes.js
        controllers/
          vendors.controller.js
          bills.controller.js
          payments.controller.js
          approvals.controller.js
          aging.controller.js
        services/
          vendor.service.js
          bill.service.js
          payable-payment.service.js
          approval.service.js
          aging.service.js
        validators/
          vendor.validator.js
          bill.validator.js
          payable-payment.validator.js
      dashboard/
        dashboard.routes.js
        controllers/
          dashboard.controller.js
        services/
          dashboard.service.js
      reports/
        reports.routes.js
        controllers/
          reports.controller.js
        services/
          reports.service.js
      shared/
        controllers/
          attachments.controller.js
          transactions.controller.js
        services/
          attachment.service.js
          transaction.service.js
          payment-allocation.service.js
        validators/
          attachment.validator.js
        repositories/
          attachment.repo.js
          transaction.repo.js
      auth/
      users/
    middleware/
      auth.middleware.js
      authorize.middleware.js
      audit.middleware.js
      error.middleware.js
    shared/
      constants/
      utils/
      errors/
      sql/
```

### 5.2 Migration Strategy

Because the current app uses:

- `controllers/*`
- `routes/*`
- shared middleware

you should migrate **incrementally**, not rewrite all AR at once.

Recommended practical path:

1. Keep existing AR controllers working.
2. Add `modules/ap`, `modules/dashboard`, `modules/shared`.
3. Extract common helpers from AR controllers into shared services.
4. Later move AR into the same modular structure.

### 5.3 Controller Responsibilities

Controllers should only:

- parse request
- call validator/service
- return response
- map known errors to HTTP status

No heavy SQL in controllers long term.

### 5.4 Service Responsibilities

Services should handle:

- business rules
- status transitions
- due date logic
- payment allocation
- approval rules
- audit event creation
- dashboard aggregation orchestration

### 5.5 Validation Layer

Use request-level validation for:

- required fields
- enum values
- date formats
- amounts
- attachment constraints
- approval action rules

Good candidates:

- `zod`
- `joi`
- `express-validator`

Pick one and standardize.

### 5.6 Reusable Payment Service

Create a shared payment orchestration service:

- `createFinancialTransaction`
- `allocatePaymentToDocuments`
- `recalculateDocumentBalance`
- `deriveDocumentStatus`
- `writeAuditEvent`

AR uses it for customer receipts.
AP uses it for vendor disbursements.

This is the cleanest shared backend abstraction in the entire project.

---

## 6. Suggested REST API Structure

### 6.1 Naming Principles

- plural resources
- noun-based endpoints
- action endpoints only where workflow requires it
- keep AR and AP explicit in paths

### 6.2 Routes

#### Dashboard

- `GET /api/dashboard/summary`
- `GET /api/dashboard/cash-flow`
- `GET /api/dashboard/recent-transactions`
- `GET /api/dashboard/ar-ap-comparison`

#### AR

- `GET /api/ar/customers`
- `POST /api/ar/customers`
- `PUT /api/ar/customers/:id`
- `GET /api/ar/invoices`
- `POST /api/ar/invoices`
- `GET /api/ar/invoices/:id`
- `PUT /api/ar/invoices/:id`
- `PATCH /api/ar/invoices/:id/status`
- `GET /api/ar/payments`
- `POST /api/ar/payments`
- `PUT /api/ar/payments/:id`
- `GET /api/ar/aging`

#### AP

- `GET /api/ap/vendors`
- `POST /api/ap/vendors`
- `GET /api/ap/vendors/:id`
- `PUT /api/ap/vendors/:id`
- `GET /api/ap/bills`
- `POST /api/ap/bills`
- `GET /api/ap/bills/:id`
- `PUT /api/ap/bills/:id`
- `PATCH /api/ap/bills/:id/status`
- `POST /api/ap/bills/:id/submit`
- `POST /api/ap/bills/:id/approve`
- `POST /api/ap/bills/:id/reject`
- `GET /api/ap/payments`
- `POST /api/ap/payments`
- `PUT /api/ap/payments/:id`
- `GET /api/ap/approvals/pending`
- `GET /api/ap/aging`

#### Shared

- `GET /api/transactions`
- `GET /api/transactions/:id`
- `GET /api/attachments`
- `POST /api/attachments`
- `DELETE /api/attachments/:id`

#### Reports

- `GET /api/reports/ar-aging`
- `GET /api/reports/ap-aging`
- `GET /api/reports/cash-flow`
- `GET /api/reports/customer-outstanding`
- `GET /api/reports/vendor-outstanding`
- `GET /api/reports/payment-summary`
- `GET /api/reports/monthly-financial-summary`

---

## 7. Frontend Architecture

### 7.1 Recommended Folder Structure

```text
frontend/src/
  app/
    routes/
    providers/
  modules/
    accounting/
      dashboard/
        pages/
        components/
      ar/
        customers/
        invoices/
        payments/
        aging/
      ap/
        vendors/
        bills/
        payments/
        approvals/
        aging/
      reports/
      transactions/
      attachments/
    shared/
      api/
      hooks/
      utils/
      constants/
      components/
        DataTable/
        FilterBar/
        EntityDrawer/
        FormModal/
        StatusBadge/
        EmptyState/
        AmountCell/
        AttachmentList/
        PaymentAllocationPanel/
  layouts/
    AccountingLayout.jsx
  services/
  context/
  styles/
```

### 7.2 State Management

Recommended:

- React Query for server state
- Context for auth/theme/app preferences
- local component state for forms and page filters

Why:

- your pages are heavily data-driven
- it reduces manual loading/error state duplication
- it fits incremental adoption

Avoid introducing Redux unless broader app complexity demands it.

### 7.3 Component Reuse Strategy

Create reusable primitives around what AR already does well:

- `EntityTable`
- `FilterToolbar`
- `SummaryCard`
- `StatusBadge`
- `MoneyValue`
- `DateRangeFilter`
- `ApprovalTimeline`
- `AttachmentUploader`
- `DocumentFormModal`
- `PaymentFormModal`
- `EmptyStateCard`

Use configuration instead of duplication:

- invoice table config
- bill table config
- AR/AP aging bucket config

### 7.4 Route Structure

```text
/accounting/dashboard
/accounting/receivables/customers
/accounting/receivables/invoices
/accounting/receivables/payments
/accounting/receivables/aging
/accounting/payables/vendors
/accounting/payables/bills
/accounting/payables/payments
/accounting/payables/approvals
/accounting/payables/aging
/accounting/transactions
/accounting/reports
/accounting/attachments
/accounting/settings
```

### 7.5 Navigation

Recommended sidebar:

- Dashboard
- Receivables
- Payables
- Transactions
- Reports
- Attachments
- Settings

Use grouped child links, but keep the visual shell unified.

Do not show two dashboards.

---

## 8. Unified Dashboard Layout Plan

### 8.1 Dashboard Sections

#### Row 1: Executive KPIs

- Total Receivables
- Total Payables
- Outstanding Invoices
- Outstanding Bills
- Overdue AR
- Overdue AP

#### Row 2: Cash Summary

- Cash Inflow
- Cash Outflow
- Net Cash Position
- Pending Approvals

#### Row 3: Charts

- AR vs AP monthly comparison
- Monthly cash flow summary
- Receivables aging donut
- Payables aging donut

#### Row 4: Operational Lists

- Recent Transactions
- Pending Approvals
- Vendor Payments
- Customer Payments

### 8.2 Widget Strategy

Each widget should be:

- self-contained
- independently loadable
- filter-aware
- reusable

Recommended dashboard widget contract:

- `title`
- `subtitle`
- `value`
- `trend`
- `data`
- `emptyState`
- `actionLink`

### 8.3 Filters

Shared top-level filters:

- date range
- region
- currency or display currency
- status view

Keep filters global to the dashboard, not per-card unless needed.

---

## 9. UX Recommendations

### 9.1 Design Rules

- Keep terminology accountant-friendly
- Prefer "Bills" and "Vendor Payments" over technical wording
- Use clear statuses with color and plain text
- Show balance and due date prominently
- Make primary actions visible
- Keep modals narrow and focused

### 9.2 Minimal-Click Workflows

#### Vendor creation

1. Add vendor
2. Save
3. Immediately available in bill form

#### Bill processing

1. Create bill
2. Save draft
3. Submit for approval
4. Approve
5. Record payment

#### Approvals

1. Open pending approvals
2. Review summary and attachment
3. Approve or reject with comment

#### Dashboard quick actions

- New Invoice
- New Bill
- Record Customer Payment
- Record Vendor Payment
- Review Approvals

### 9.3 Empty States

Examples:

- "No pending vendor approvals."
- "No overdue bills in this period."
- "No recent cash outflow recorded yet."

Each empty state should provide one next action.

---

## 10. Reporting Design

### 10.1 Unified Reports

Deliver first:

- AR Aging
- AP Aging
- Cash Flow
- Customer Outstanding
- Vendor Outstanding
- Payment Summary
- Monthly Financial Summary

### 10.2 Report Implementation Pattern

Each report should support:

- date range
- region
- export CSV
- export PDF later if needed

Use database views or report query services for complex aggregation.

Recommended reporting views:

- `vw_dashboard_ar_summary`
- `vw_dashboard_ap_summary`
- `vw_financial_transactions`
- `vw_ar_aging`
- `vw_ap_aging`
- `vw_cash_flow_monthly`

---

## 11. Security and Audit

### 11.1 Roles

Keep role-based access, but split permission scope more clearly:

- `ACCOUNTING_ADMIN`
- `AR_MANAGER`
- `AR_CLERK`
- `AP_MANAGER`
- `AP_CLERK`
- `APPROVER`
- `AUDITOR`

If you want minimal change, map these capabilities onto current roles first.

### 11.2 Permission Areas

- dashboard.view
- ar.view
- ar.manage
- ar.payments.manage
- ap.view
- ap.manage
- ap.payments.manage
- ap.approve
- reports.view
- attachments.manage
- audit.view

### 11.3 Audit Logging

Audit these events:

- vendor created/updated
- bill created/updated
- bill submitted
- bill approved/rejected
- vendor payment created/updated/deleted
- attachment uploaded/deleted

### 11.4 Attachment Security

- allow whitelist mime types only
- store outside public root if possible
- generate signed download URLs or protected download endpoints
- log upload and delete events

---

## 12. Scalability Guidance

### 12.1 Good Enough for Near Term

- modular monolith
- PostgreSQL indexes
- views for dashboard/reporting
- shared payment orchestration
- React Query caching

### 12.2 Future-Proof Without Overengineering

Prepare for:

- ledger posting
- purchase orders later
- multi-step approvals
- more regions/currencies
- stronger document search

Avoid now:

- event bus
- CQRS
- microservices
- workflow engines

---

## 13. Recommended Implementation Sequence

1. Add AP schema and shared tables.
2. Build vendors, bills, approvals, vendor payments APIs.
3. Add unified transaction history.
4. Build unified dashboard service and UI.
5. Add shared attachments.
6. Build unified reports.
7. Refactor common AR/AP payment logic into shared services.

This delivers user value early while keeping the system coherent.

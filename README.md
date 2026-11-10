# SogoDesk Books — Multi-Entity Accounting & Staffing Platform

A QuickBooks/Zoho-Books–style accounting application built for a multi-location
staffing agency. It combines **Accounts Receivable, Accounts Payable, a
double-entry General Ledger, Banking & Reconciliation, Expenses, and a Workforce
module** (candidates, placements, timesheets) with multi-currency consolidation
and role-based access control.

- **Live (on-prem):** https://books.sogodesk.com/
- **Stack:** React 18 + Vite (frontend) · Node.js + Express (backend) · PostgreSQL

> **Deploying to the on-prem server?** Read [`database/DEPLOYMENT.md`](database/DEPLOYMENT.md)
> first — it lists the exact database migrations to run so the server matches
> local. Skipping them will break the new Workforce/Settings features.

---

## Table of contents
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Local setup](#local-setup)
- [Environment variables](#environment-variables)
- [Running the app](#running-the-app)
- [Database & migrations](#database--migrations)
- [Modules](#modules)
- [Roles & permissions](#roles--permissions)
- [Useful scripts](#useful-scripts)
- [Deployment](#deployment)

---

## Architecture

```
┌───────────────┐        HTTP (/api)        ┌───────────────┐        SQL        ┌──────────────┐
│  React + Vite │  ───────────────────────► │ Express API   │ ───────────────► │  PostgreSQL  │
│  (frontend)   │        JWT auth           │  (backend)    │   pg pool         │              │
└───────────────┘                           └───────────────┘                   └──────────────┘
```

- **Auth:** JWT bearer tokens (`Authorization: Bearer <token>`).
- **Access control:** role-based route guards **plus** an editable permission
  matrix (see [Roles & permissions](#roles--permissions)); row-level region
  scoping via `scopeMiddleware`.
- **Ledger:** immutable, hash-chained journal entries (`postingService` /
  `ledgerEngine`); financial documents post to the GL automatically.
- **Multi-currency:** each region has a functional currency; cross-entity reports
  convert to the group/reporting currency (never sum raw amounts).
- **Self-healing schema:** the `ensure*Schema` modules (attachments, settings, AP)
  create/upgrade their tables on boot, so those features work even before their
  migration is run by hand.

## Repository layout

```
accounting_app/
├── backend/                  # Express API
│   ├── config/               # db pool, etc.
│   ├── controllers/          # route handlers (one per resource)
│   ├── middleware/           # auth, permissions, scope, uploads
│   ├── modules/              # self-healing schema helpers (attachments, settings, ap)
│   ├── routes/               # Express routers, mounted in routes/index.js
│   ├── services/             # gl, currency, banking, reports (business logic)
│   ├── utils/                # code generation, pdf, seed/import scripts
│   ├── storage/              # uploaded documents (git-ignored)
│   ├── uploads/              # region logos (git-ignored)
│   ├── server.js             # app entrypoint
│   └── .env.example          # copy to .env and fill in
├── frontend/                 # React + Vite SPA
│   ├── src/
│   │   ├── pages/            # one folder/file per screen (incl. settings/, accounting/, expenses/)
│   │   ├── components/       # shared UI (ui/index.jsx), attachments, etc.
│   │   ├── layouts/          # MainLayout (sidebar nav, permission-aware)
│   │   ├── context/          # Auth, Theme, Toast
│   │   ├── data/             # static catalogs (billingTypes, permissions, countries)
│   │   └── utils/            # acl, helpers
│   └── .env.example
├── database/
│   ├── migrations/           # numbered SQL migrations (000 → 014)
│   ├── README.md
│   └── DEPLOYMENT.md         # ← how to bring a server up to date
└── docs/                     # design notes & audits
```

## Prerequisites

- **Node.js 20+** (uses global `fetch`)
- **PostgreSQL 13+**
- npm

## Local setup

```bash
# 1. Clone
git clone https://github.com/SogoDesk/accounting_app.git
cd accounting_app

# 2. Database — create it, then apply the migrations in order
createdb accounting_db
for f in database/migrations/*.sql; do psql -d accounting_db -f "$f"; done

# 3. Backend
cd backend
cp .env.example .env          # then edit .env (see below)
npm install
npm run seed                  # create the first admin user (utils/createAdminUser.js)
npm run dev                   # starts on http://localhost:5050

# 4. Frontend (new terminal)
cd ../frontend
cp .env.example .env          # VITE_API_BASE_URL=/api (dev proxy → :5050)
npm install
npm run dev                   # starts on http://localhost:5173
```

## Environment variables

Backend (`backend/.env`) — see [`backend/.env.example`](backend/.env.example):

| Variable | Purpose |
|---|---|
| `PORT` | API port (default `5050`) |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | PostgreSQL connection |
| `JWT_SECRET` | **Change in production.** Signs auth tokens |
| `CLIENT_ORIGIN` | Allowed CORS origin (frontend URL) |
| `NODE_ENV` | `development` / `production` |
| `EXCHANGE_RATE_API_KEY` | exchangerate-api.com v6 key for the daily FX feed |
| `EXCHANGE_RATE_API_URL` | Override the FX provider base URL (optional) |
| `GL_CLOSE_SCHEDULER` | `true` to enable the monthly GL close scheduler |

Frontend (`frontend/.env`): `VITE_API_BASE_URL` (default `/api`).

> `.env` files are git-ignored and must **never** be committed. Only
> `.env.example` (placeholders) is tracked.

## Running the app

| | Command | URL |
|---|---|---|
| Backend (dev) | `cd backend && npm run dev` | http://localhost:5050 |
| Backend (prod) | `cd backend && npm start` | — |
| Frontend (dev) | `cd frontend && npm run dev` | http://localhost:5173 |
| Frontend (build) | `cd frontend && npm run build` | serves `frontend/dist` |

## Database & migrations

Migrations live in `database/migrations/` and are **applied in numeric order**.
They use `IF NOT EXISTS` / `DROP … IF EXISTS` guards and are safe to re-run.

| # | Migration | Adds |
|---|---|---|
| 000 | base | Core schema (users, roles, clients, invoices, …) |
| 001 | currency engine | `company_settings`, `exchange_rates`, functional currencies |
| 002 | general ledger | Chart of accounts, journal entries/lines |
| 003 | expenses | Expense categories, payment methods |
| 004 | org hierarchy | Org units |
| 005 | rbac | Row-level org access |
| 006 | ledger immutable | Hash-chain + immutability triggers |
| 007 | intercompany | Intercompany transfers |
| 008 | period close | Fiscal years, accounting periods |
| 009 | document sequences | Per-year invoice/bill/payment numbering |
| 010 | banking | Bank accounts, reconciliation |
| 011 | workforce billing types | Full staffing billing set on placements |
| 012 | candidate compliance | Contractor compliance fields on candidates |
| 013 | timesheets | `timesheets` table (log → approve → invoice) |
| 014 | settings | Document numbering config, tax rates, role permission matrix |

See [`database/DEPLOYMENT.md`](database/DEPLOYMENT.md) for upgrading an existing
(already-running) server versus a fresh install.

## Modules

- **Sales (AR):** Clients, Invoices, Payments — posts to the GL, multi-currency.
- **Purchases (AP):** Vendors, Bills, Vendor Payments, Approvals.
- **Expenses:** Variable & fixed/recurring expenses, categories, monthly summary.
- **Accounting:** Chart of Accounts, Journal Entries (manual + auto), Financial
  Reports (Trial Balance, P&L, Balance Sheet, General Ledger, Cash Flow),
  Period Close, Banking & Reconciliation.
- **Workforce:** Candidates (with compliance + documents), Placements (margin /
  profitability, 7 billing types), Timesheets (log → approve → one-click invoice
  with client-approved proof attached).
- **Settings:** unified hub — Organization/Regions, Currencies & exchange rates,
  Document numbering, Tax rates, Notifications (invoice reminders), Users,
  Roles & Permissions, Audit Logs.

## Roles & permissions

Built-in roles: `SUPER_ADMIN`, `FINANCE_ADMIN`, `ACCOUNT_MANAGER`, `RECRUITER`.

Access is governed by an **editable permission matrix** (Settings → Roles &
Permissions), enforced on **both** the menu and the backend via the `permit()`
middleware. Granting or revoking a module for a role takes effect immediately.

Two hard floors always remain regardless of permissions:
- **All delete operations** require `SUPER_ADMIN`.
- **User & role administration** (create/update/delete) requires `SUPER_ADMIN`.

Permissions are **module-level** (a grant covers read + write within a module,
except the floors above).

## Useful scripts

```bash
cd backend
npm run seed            # create the initial admin user
npm run hash:password   # generate a bcrypt hash for a password
# FX rates (needs EXCHANGE_RATE_API_KEY): run as a daily cron
node services/currency/rateService.js
```

## Deployment

The app runs on-prem behind `https://books.sogodesk.com/`. For the full
production deploy checklist — including the **exact database changes** needed so
the server matches local — see **[`database/DEPLOYMENT.md`](database/DEPLOYMENT.md)**.

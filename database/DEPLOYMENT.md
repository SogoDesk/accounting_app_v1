# Deployment & Database Changes — On-Prem

This document describes how to deploy the current code to the on-prem server
(`https://books.sogodesk.com/`) and, critically, **the database changes that
must be applied** so the running server behaves exactly like local.

> ⚠️ **The new code will not work correctly against the old database.** The
> Workforce (timesheets, placement billing types, candidate compliance) and
> Settings (numbering, tax rates, roles & permissions) features require the
> schema changes below. Apply them **before or together with** the code deploy.

---

## 0. Before you start — back up the database

```bash
pg_dump -U <db_user> -d <db_name> -Fc -f books_backup_$(date +%F).dump
```

All migration scripts are **idempotent** (`IF NOT EXISTS` / `DROP … IF EXISTS`
guards), so re-running them is safe — but always take a backup first.

---

## 1. Database changes to apply (upgrade an existing server)

The live server already has migrations `000`–`010`. The enhancement work adds
**four new migrations** plus one self-healing constraint. Run them in order
against the production database:

```bash
cd /path/to/accounting_app
DB=<db_name>          # e.g. accounting_db
USER=<db_user>        # e.g. postgres

psql -U "$USER" -d "$DB" -f database/migrations/011_workforce_billing_types.sql
psql -U "$USER" -d "$DB" -f database/migrations/012_candidate_compliance.sql
psql -U "$USER" -d "$DB" -f database/migrations/013_timesheets.sql
psql -U "$USER" -d "$DB" -f database/migrations/014_settings.sql
```

What each one does:

| Migration | Effect on the DB |
|---|---|
| `011_workforce_billing_types.sql` | Migrates legacy `ONE_TIME` placements → `FIXED`; expands the `placements.billing_type` CHECK to the 7-type staffing set (HOURLY, DAILY, WEEKLY, MONTHLY, ANNUAL, FIXED, PERM_FEE). |
| `012_candidate_compliance.sql` | Adds compliance columns to `candidates`: `tax_id`, `is_1099`, `w9_on_file`, `work_authorization`, `work_auth_expiry`, `insurance_expiry`. |
| `013_timesheets.sql` | Creates the `timesheets` table (+ indexes) for the log → approve → invoice flow. |
| `014_settings.sql` | Creates `document_numbering_config` (seeded), `tax_rates`, `role_permissions`; adds `roles.is_system`. Seeds default permissions that reproduce the existing menu, so no role loses access. |

### Attachments constraint (auto-heals, SQL provided as a safety net)

The generic `attachments` table originally only allowed `entity_type IN
('invoice','bill')`. The app now attaches documents to placements, candidates
and timesheets too. **This is fixed automatically on backend startup** by
`backend/modules/attachments/ensureAttachmentsSchema.js`. If you prefer to apply
it manually first, run:

```sql
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_entity_type_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_entity_type_check
  CHECK (entity_type IN ('invoice','bill','placement','candidate','timesheet'));
```

### Self-healing modules (no manual action needed)

On boot the backend calls `ensureSettingsSchema` and `ensureAttachmentsSchema`,
which create/upgrade their tables if missing. So even if `014` is skipped, the
Settings tables are created on first request — but running the migrations
explicitly is the recommended, auditable path.

---

## 2. Fresh install (new server)

Create the database and run **all** migrations in order:

```bash
createdb accounting_db
for f in database/migrations/*.sql; do
  psql -U postgres -d accounting_db -f "$f"
done
# then create the first admin user:
cd backend && npm run seed
```

---

## 3. Application deploy steps

```bash
# 1. Pull the new code
git pull origin main

# 2. Backend deps + restart
cd backend
npm install --omit=dev            # or `npm ci`
# ensure backend/.env has the PRODUCTION values (DB creds, JWT_SECRET,
# CLIENT_ORIGIN=https://books.sogodesk.com, EXCHANGE_RATE_API_KEY)
pm2 restart accounting-backend    # or: systemctl restart <service>  /  npm start

# 3. Frontend build
cd ../frontend
npm install
npm run build                     # outputs frontend/dist → serve via nginx/static host
```

> The repo does **not** contain `node_modules`, `.env`, `frontend/dist`, or
> uploaded documents (`backend/storage`, `backend/uploads`) — install deps and
> build on the server, and keep the production `.env` on the server only.

---

## 4. nginx configuration (Windows — one-time, but verify after any server rebuild)

nginx (Windows) serves `frontend/dist` and proxies the backend on port `5050`.
Two directives are **required** and live only on the server — they are not in
this repo, so a rebuilt box or a regenerated config silently reintroduces the
bugs below. Both belong in the **`:443` server block** for
`books.sogodesk.com` (not the `:80` redirect block), typically in
`C:\nginx\conf\nginx.conf` or an include under `C:\nginx\conf\`.

```nginx
server {
    server_name books.sogodesk.com;

    # Region/company logos are multipart uploads up to 6MB (multer's limit).
    # nginx defaults to 1M and rejects them with a 413 before Express is reached.
    # Keep this above 6M so multer stays the authority and returns its own 400.
    client_max_body_size 10M;

    # Uploaded files are served by Express (`app.use("/uploads", ...)`), not from
    # frontend/dist. Without this block the SPA try_files fallback returns
    # index.html for image requests and logos render blank.
    # Must come BEFORE the catch-all `location /`.
    location /uploads/ {
        proxy_pass http://127.0.0.1:5050;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/ { ... }   # existing
    location /     { ... }   # existing SPA fallback — keep last
}
```

Test the config, then reload (run from the nginx install dir, e.g. `C:\nginx`):

```powershell
cd C:\nginx
.\nginx.exe -t          # validate before reloading
.\nginx.exe -s reload   # graceful; no backend restart needed
```

Notes:

- Use `127.0.0.1`, not `localhost`, in `proxy_pass` — on Windows `localhost` can
  resolve to IPv6 `::1` and fail with 502 if Node is listening on IPv4 only.
- `vite.config.js` proxies both `/api` and `/uploads` in development, which is
  why logo bugs reproduce only in production.
- Paths in `root`/`alias` use forward slashes even on Windows
  (e.g. `root C:/apps/accounting_app/frontend/dist;`).

---

## 5. Post-deploy verification

1. **Login** works at `https://books.sogodesk.com/`.
2. **Settings → Numbering** loads (confirms `014` applied / settings schema present).
3. **Workforce → Timesheets** loads and a placement can be selected (confirms `013`).
4. Create a placement with a new billing type e.g. `WEEKLY` (confirms `011`).
5. Open a candidate → compliance fields render (confirms `012`).
6. Upload a document to a candidate/timesheet (confirms the attachments constraint).
7. Confirm each role still sees its expected menu (Settings → Roles & Permissions).
8. **Settings → Organization → Regions**: edit a region, upload a ~5MB logo, save
   (confirms `client_max_body_size`), then reopen it in View — the logo must
   render (confirms the `/uploads/` proxy). Both fail only in production.

---

## 6. Rollback

If something goes wrong, restore the pre-deploy backup:

```bash
pg_restore -U <db_user> -d <db_name> --clean --if-exists books_backup_<date>.dump
```

The migrations only **add** tables/columns/constraints (they don't drop existing
data), so a code rollback + leaving the new columns in place is also safe: the
old code simply ignores them.

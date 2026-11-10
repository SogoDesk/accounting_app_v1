# Database schema & migrations

The entire schema is reproducible from `database/migrations/` alone. Apply the
files **in numeric order** to a fresh, empty PostgreSQL database:

```bash
cd backend && set -a && . ./.env && set +a
export PGHOST=$DB_HOST PGPORT=$DB_PORT PGDATABASE=$DB_NAME PGUSER=$DB_USER PGPASSWORD=$DB_PASSWORD
for f in ../database/migrations/*.sql; do
  psql -v ON_ERROR_STOP=1 -f "$f" || { echo "FAILED: $f"; break; }
done
```

## Migration map

| File | Adds |
|------|------|
| `000_base.sql` | **Run-once baseline** — original app tables (regions, clients, candidates, placements, invoices, payments, users, roles, audit_logs, notifications), the AP module (vendors, bills, bill_items, bill_approvals, vendor_payments), and the invoice template / reminder / settings tables. These used to be created at runtime; they are now captured here so the schema rebuilds from migrations. |
| `001_currency_engine.sql` | `exchange_rates`, `regions.functional_currency`, `*_base` amount columns |
| `002_general_ledger.sql` | `chart_of_accounts`, `accounting_periods`, `journal_entries`, `journal_lines`, balance triggers |
| `003_expenses.sql` | `expense_categories`, `payment_methods`, `expenses`, `recurring_expenses` |
| `004_org_hierarchy.sql` | `org_units` tree, `location_id` + integer-minor columns + `custom_fields` on the ledger, `custom_field_defs` |
| `005_rbac.sql` | `user_org_access`, `user_allowed_locations()` (row-level RBAC) |
| `006_ledger_immutable.sql` | Hash-chain columns + append-only trigger + per-entity entry-no sequences |
| `007_intercompany.sql` | `intercompany_transfers` + elimination accounts 1600/2600 |
| `008_period_close.sql` | `fx_revaluations`, `recognition_schedules`, `recognition_runs` + FX/deferred accounts |
| `009_document_sequences.sql` | Seeds per-(scope,year) sequences for race-free invoice/bill/payment numbering |
| `015_region_tds.sql` | `regions.tds_applicable` — gates the "TDS paid?" prompt to regions that withhold (India); backfills existing IN/INR regions on first run |

## Notes for the production team

- **`000_base.sql` is a run-once baseline** intended for an empty database. The
  numbered deltas `001`–`009` are idempotent (`IF NOT EXISTS` / `ON CONFLICT` /
  `DROP … IF EXISTS`) and safe to re-run.
- A fresh build was verified end-to-end: applying `000`→`009` on an empty
  database yields the full 39-table schema with no errors.
- The legacy `schema.sql` dump (only 12 tables, badly out of date) has been
  removed — do **not** provision from a snapshot; use the migrations.
- Set `EXCHANGE_RATE_API_KEY` (see `backend/.env.example`) before relying on the
  daily FX-rate job, otherwise it fails loudly instead of writing nothing.

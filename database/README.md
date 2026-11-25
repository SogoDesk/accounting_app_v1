# Database schema & migrations

The schema is managed by [node-pg-migrate](https://salsita.github.io/node-pg-migrate/)
with plain SQL files in `database/migrations/pgm/`. Run every command from `backend/`;
connection settings come from `backend/.env`.

| Command | What it does |
|---|---|
| `npm run migrate:up` | Apply every pending migration |
| `npm run migrate -- up --fake` | Record pending migrations as applied without running them |
| `npm run migrate:new -- <name>` | Create a new SQL migration file |
| `npm run migrate -- down` | Roll back the last migration (only where it has a Down section) |
| `npm run migrate:baseline` | Regenerate `0001_baseline.sql` and `0002_seed_reference.sql` from a database (one-off) |

Applied migrations are recorded in the `pgmigrations` table. To run migrations as a
different role from the server, set `MIGRATE_DB_USER` and `MIGRATE_DB_PASSWORD`, or
`DATABASE_URL`.

## Layout

```
database/migrations/
  pgm/       migrations node-pg-migrate runs, in filename order
    0001_baseline.sql         full schema when the tool was adopted
    0002_seed_reference.sql   tenant #1, roles, permissions, chart of accounts, numbering
  legacy/    the old hand-run files 000–025, kept for history only; never run them
```

## Rules

1. Every schema change is a new migration made with `npm run migrate:new`.
2. Never edit a migration that has been applied anywhere. Fix it with a new one.
3. Never create tables from application code.
4. A migration file has an `-- Up Migration` section and, where possible, a
   `-- Down Migration` section.

## Fresh database

```bash
createdb books_dev
cd backend
npm run migrate:up
npm run seed            # first admin user
```

## Existing database (adopting the tool)

A database that already has the legacy migrations applied must not run the baseline.
Mark the baseline and seed as applied once, then use `migrate:up` from then on:

```bash
cd backend
npm run migrate -- up --fake
```

Take a backup before you do this on a shared or production database.

## Tests

`npm test` (in `backend/`) runs the Jest suite against a throwaway database,
never the one in `DB_*`:

1. Set `TEST_DATABASE_URL` (env or `backend/.env`) to an admin login on a
   **local** Postgres 18, e.g.
   `postgres://postgres:secret@localhost:5432/postgres?sslmode=disable`.
   Remote hosts are refused unless `TEST_DB_ALLOW_REMOTE=1`.
2. Once per run, `books_test_template` is rebuilt by running every migration
   in `pgm/`, so a migration that fails breaks the test run.
3. Each test file gets a fresh `books_test` cloned from the template, and the
   app connects as `books_test_app` (no superuser, no BYPASSRLS), so row-level
   security applies as in production.

Layout: `backend/tests/posting/` pins the ledger postings per document type;
`backend/tests/routes/` records invoice and payment API responses as
snapshots. After an intended response change, review the diff and run
`npm test -- -u`.

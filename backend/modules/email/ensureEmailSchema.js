
const pool = require("../../config/db");
const { getTenantId } = require("../../config/tenantContext");
const { DEFAULT_TEMPLATES } = require("./defaultTemplates");

let schemaPromise = null;

const TEMPLATE_KEYS = ["INVOICE", "REMINDER"];

const TENANT_TABLES = [
  "email_templates",
  "invoice_reminder_settings",
  "invoice_reminder_logs",
  "email_outbox",
];

// Create RLS policies for email tables
const createTenantPolicies = async (db) => {
  for (const table of TENANT_TABLES) {
    await db.query(`
      ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY
    `);

    await db.query(`
      ALTER TABLE ${table} FORCE ROW LEVEL SECURITY
    `);

    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_policies
          WHERE schemaname = 'public'
            AND tablename = '${table}'
            AND policyname = 'tenant_isolation_policy'
        ) THEN
          EXECUTE '
            CREATE POLICY tenant_isolation_policy
            ON public.${table}
            USING (
              tenant_id = NULLIF(
                current_setting(''app.tenant_id'', true), ''''
              )::integer
            )
            WITH CHECK (
              tenant_id = NULLIF(
                current_setting(''app.tenant_id'', true), ''''
              )::integer
            )
          ';
        END IF;
      END
      $$;
    `);
  }
};

// Create tenant-aware email tables
const createSchema = async (db) => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS email_templates (
      tenant_id integer NOT NULL REFERENCES tenants(id),
      template_key text NOT NULL,
      name text NOT NULL,
      description text,
      subject text NOT NULL,
      body text NOT NULL,
      footer_note text,
      is_enabled boolean NOT NULL DEFAULT true,
      updated_by integer,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, template_key),
      CONSTRAINT email_templates_key_check
        CHECK (template_key IN ('INVOICE', 'REMINDER'))
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS invoice_reminder_settings (
      tenant_id integer PRIMARY KEY REFERENCES tenants(id),
      enabled boolean NOT NULL DEFAULT true,
      days_before_due integer NOT NULL DEFAULT 5,
      before_due_days integer[] NOT NULL DEFAULT ARRAY[10,5],
      send_on_due boolean NOT NULL DEFAULT true,
      overdue_days integer[] NOT NULL DEFAULT ARRAY[1,3,7],
      channels_json jsonb NOT NULL
        DEFAULT '{"email": false, "in_app": true}'::jsonb,
      updated_by integer,
      updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS invoice_reminder_logs (
      id bigserial PRIMARY KEY,
      tenant_id integer NOT NULL REFERENCES tenants(id),
      invoice_id integer NOT NULL,
      reminder_key varchar(80) NOT NULL,
      sent_on date NOT NULL,
      channel varchar(30) NOT NULL DEFAULT 'IN_APP',
      created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_logs_once
    ON invoice_reminder_logs
      (tenant_id, invoice_id, reminder_key, channel)
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS email_outbox (
      id bigserial PRIMARY KEY,
      tenant_id integer NOT NULL REFERENCES tenants(id),
      template_key text,
      invoice_id integer,
      to_email text NOT NULL,
      subject text NOT NULL,
      body_html text NOT NULL,
      attach_pdf boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'QUEUED',
      attempts integer NOT NULL DEFAULT 0,
      last_error text,
      dedupe_key text,
      queued_by integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      sent_at timestamptz,
      CONSTRAINT email_outbox_status_check
        CHECK (status IN (
          'QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED'
        ))
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_email_outbox_pending
    ON email_outbox (tenant_id, status, id)
    WHERE status IN ('QUEUED', 'SENDING')
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_email_outbox_dedupe
    ON email_outbox (tenant_id, dedupe_key)
    WHERE dedupe_key IS NOT NULL
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_email_outbox_invoice
    ON email_outbox (tenant_id, invoice_id)
  `);

  await createTenantPolicies(db);
};

// Seed default email templates and reminder settings for one tenant
const seedTenantData = async (db, tenantId) => {
  for (const template of DEFAULT_TEMPLATES) {
    await db.query(
      `INSERT INTO email_templates
        (tenant_id, template_key, name, description, subject, body)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, template_key) DO NOTHING`,
      [
        tenantId,
        template.template_key,
        template.name,
        template.description,
        template.subject,
        template.body,
      ],
    );
  }

  await db.query(
    `INSERT INTO invoice_reminder_settings (tenant_id)
     VALUES ($1)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId],
  );
};

// Public schema initialization function
const ensureEmailSchema = async (db = pool, tenantId = getTenantId()) => {
  if (!Number.isInteger(Number(tenantId)) || Number(tenantId) <= 0) {
    throw new Error("Valid tenant ID required for email schema.");
  }

  tenantId = Number(tenantId);

  if (!schemaPromise) {
    schemaPromise = (async () => {
      const client = await pool.connect();

      try {
        await createSchema(client);
      } finally {
        client.release();
      }
    })().catch((err) => {
      schemaPromise = null;
      throw err;
    });
  }

  await schemaPromise;

  await seedTenantData(db, tenantId);

  return true;
};

module.exports = {
  ensureEmailSchema,
  TEMPLATE_KEYS,
  DEFAULT_TEMPLATES,
};

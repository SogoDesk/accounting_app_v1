const pool = require("../../config/db");
const { DEFAULT_TEMPLATES } = require("./defaultTemplates");

let _ready = false;

const TEMPLATE_KEYS = ["INVOICE", "REMINDER"];


const ensureEmailSchema = async (db = pool) => {
  if (_ready) return true;

  await db.query(`
    CREATE TABLE IF NOT EXISTS email_templates (
      template_key text PRIMARY KEY,
      name         text NOT NULL,
      description  text,
      subject      text NOT NULL,
      body         text NOT NULL,
      footer_note  text,
      is_enabled   boolean NOT NULL DEFAULT true,
      updated_by   integer,
      updated_at   timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT email_templates_key_check CHECK (template_key IN ('INVOICE','REMINDER'))
    )
  `);

  await db.query(`ALTER TABLE email_templates DROP CONSTRAINT IF EXISTS email_templates_key_check`);
  await db.query(
    `ALTER TABLE email_templates ADD CONSTRAINT email_templates_key_check
       CHECK (template_key IN ('INVOICE','REMINDER'))`,
  );

  await db.query(`ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS footer_note text`);

  for (const t of DEFAULT_TEMPLATES) {
    await db.query(
      `INSERT INTO email_templates (template_key, name, description, subject, body)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (template_key) DO NOTHING`,
      [t.template_key, t.name, t.description, t.subject, t.body],
    );
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS invoice_reminder_settings (
      id              integer PRIMARY KEY,
      enabled         boolean NOT NULL DEFAULT true,
      days_before_due integer NOT NULL DEFAULT 5,
      send_on_due     boolean NOT NULL DEFAULT true,
      overdue_days    integer[] NOT NULL DEFAULT ARRAY[1,3,7],
      channels_json   jsonb NOT NULL DEFAULT '{"email": false, "in_app": true}'::jsonb,
      updated_by      integer,
      updated_at      timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT invoice_reminder_settings_id_check CHECK (id = 1)
    )
  `);
  await db.query(
    `INSERT INTO invoice_reminder_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
  );

  await db.query(
    `ALTER TABLE invoice_reminder_settings
       ADD COLUMN IF NOT EXISTS before_due_days integer[] NOT NULL DEFAULT ARRAY[10,5]`,
  );
  await db.query(
    `UPDATE invoice_reminder_settings
        SET before_due_days = ARRAY[days_before_due]
      WHERE id = 1 AND before_due_days = ARRAY[10,5] AND days_before_due NOT IN (10, 5)`,
  );

  await db.query(`
    CREATE TABLE IF NOT EXISTS invoice_reminder_logs (
      id           bigserial PRIMARY KEY,
      invoice_id   integer NOT NULL,
      reminder_key varchar(80) NOT NULL,
      sent_on      date NOT NULL,
      channel      varchar(30) NOT NULL DEFAULT 'IN_APP',
      created_at   timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await db.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_logs_once
       ON invoice_reminder_logs (invoice_id, reminder_key, channel)`,
  );

  await db.query(`
    CREATE TABLE IF NOT EXISTS email_outbox (
      id            bigserial PRIMARY KEY,
      template_key  text,
      invoice_id    integer,
      to_email      text NOT NULL,
      subject       text NOT NULL,
      body_html     text NOT NULL,
      attach_pdf    boolean NOT NULL DEFAULT false,
      status        text NOT NULL DEFAULT 'QUEUED',
      attempts      integer NOT NULL DEFAULT 0,
      last_error    text,
      dedupe_key    text,
      queued_by     integer,
      created_at    timestamptz NOT NULL DEFAULT now(),
      sent_at       timestamptz,
      CONSTRAINT email_outbox_status_check CHECK (status IN ('QUEUED','SENDING','SENT','FAILED','CANCELLED'))
    )
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_email_outbox_pending
       ON email_outbox (status, id) WHERE status IN ('QUEUED','SENDING')`,
  );
  await db.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_email_outbox_dedupe
       ON email_outbox (dedupe_key) WHERE dedupe_key IS NOT NULL`,
  );
  await db.query(`CREATE INDEX IF NOT EXISTS idx_email_outbox_invoice ON email_outbox (invoice_id)`);

  _ready = true;
  return true;
};

module.exports = { ensureEmailSchema, TEMPLATE_KEYS, DEFAULT_TEMPLATES };

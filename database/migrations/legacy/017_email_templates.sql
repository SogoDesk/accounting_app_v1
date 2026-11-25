-- Migration 017 — Email templates, reminder schedule, send outbox.
-- Schema only: default template content is seeded by ensureEmailSchema.

BEGIN;

CREATE TABLE IF NOT EXISTS email_templates (
    template_key text PRIMARY KEY,
    name         text NOT NULL,
    description  text,
    subject      text NOT NULL,
    body         text NOT NULL,
    footer_note  text,
    is_enabled   boolean NOT NULL DEFAULT true,
    updated_by   integer,
    updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS footer_note text;

ALTER TABLE email_templates DROP CONSTRAINT IF EXISTS email_templates_key_check;
ALTER TABLE email_templates ADD  CONSTRAINT email_templates_key_check
    CHECK (template_key IN ('INVOICE','REMINDER'));

CREATE TABLE IF NOT EXISTS invoice_reminder_settings (
    id              integer PRIMARY KEY,
    enabled         boolean NOT NULL DEFAULT true,
    days_before_due integer NOT NULL DEFAULT 5,
    send_on_due     boolean NOT NULL DEFAULT true,
    overdue_days    integer[] NOT NULL DEFAULT ARRAY[1,7,14],
    channels_json   jsonb NOT NULL DEFAULT '{"email": false, "in_app": true}'::jsonb,
    updated_by      integer,
    updated_at      timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT invoice_reminder_settings_id_check CHECK (id = 1)
);
ALTER TABLE invoice_reminder_settings
    ADD COLUMN IF NOT EXISTS before_due_days integer[] NOT NULL DEFAULT ARRAY[10,5];
INSERT INTO invoice_reminder_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS invoice_reminder_logs (
    id           bigserial PRIMARY KEY,
    invoice_id   integer NOT NULL,
    reminder_key varchar(80) NOT NULL,
    sent_on      date NOT NULL,
    channel      varchar(30) NOT NULL DEFAULT 'IN_APP',
    created_at   timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reminder_logs_once
    ON invoice_reminder_logs (invoice_id, reminder_key, channel);

CREATE TABLE IF NOT EXISTS email_outbox (
    id           bigserial PRIMARY KEY,
    template_key text,
    invoice_id   integer,
    to_email     text NOT NULL,
    subject      text NOT NULL,
    body_html    text NOT NULL,
    attach_pdf   boolean NOT NULL DEFAULT false,
    status       text NOT NULL DEFAULT 'QUEUED',
    attempts     integer NOT NULL DEFAULT 0,
    last_error   text,
    dedupe_key   text,
    queued_by    integer,
    created_at   timestamptz NOT NULL DEFAULT now(),
    sent_at      timestamptz,
    CONSTRAINT email_outbox_status_check
        CHECK (status IN ('QUEUED','SENDING','SENT','FAILED','CANCELLED'))
);

CREATE INDEX IF NOT EXISTS idx_email_outbox_pending
    ON email_outbox (status, id) WHERE status IN ('QUEUED','SENDING');
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_outbox_dedupe
    ON email_outbox (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_outbox_invoice ON email_outbox (invoice_id);

COMMIT;

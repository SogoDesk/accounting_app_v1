const pool = require("../../config/db");

// Idempotent, lazily-applied schema for document attachments shared by invoices
// and bills (and easily extendable to other records). Mirrors the ensureApSchema
// pattern: safe to call on every request; the create-if-not-exists work only
// runs meaningfully the first time.
let _ready = false;

const ensureAttachmentsSchema = async (db = pool) => {
  if (_ready) return true;

  await db.query(`
    CREATE TABLE IF NOT EXISTS attachments (
      id            serial PRIMARY KEY,
      entity_type   text    NOT NULL,
      entity_id     integer NOT NULL,
      file_name     text    NOT NULL,
      stored_name   text    NOT NULL,
      mime_type     text,
      file_size     integer,
      uploaded_by   integer,
      created_at    timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT attachments_entity_type_check
        CHECK (entity_type IN ('invoice', 'bill', 'placement', 'candidate', 'timesheet'))
    )
  `);

  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id)`,
  );

  // Self-heal existing databases created before the entity list expanded so
  // candidate/placement/timesheet uploads aren't rejected by the old CHECK.
  await db.query(`ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_entity_type_check`);
  await db.query(`
    ALTER TABLE attachments ADD CONSTRAINT attachments_entity_type_check
      CHECK (entity_type IN ('invoice', 'bill', 'placement', 'candidate', 'timesheet'))
  `);

  _ready = true;
  return true;
};

module.exports = { ensureAttachmentsSchema };

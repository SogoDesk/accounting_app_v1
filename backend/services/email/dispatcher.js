
const pool = require("../../config/db");

const {
  getTenantId,
  getTenantClient,
} = require("../../config/tenantContext");

const renderer = require("./renderer");
const invoiceQuery = require("./invoiceQuery");
const assetStore = require("./assetStore");
const {
  ensureEmailSchema,
} = require("../../modules/email/ensureEmailSchema");

// Get the database connection for the current tenant.
function getTenantDb(db) {
  const tenantDb = db || getTenantClient();

  if (!tenantDb) {
    throw new Error("Tenant database connection is required");
  }

  return tenantDb;
}

// Load an email template belonging to the current tenant.
async function loadTemplate(
  key,
  db,
  tenantId = getTenantId()
) {
  if (!tenantId) {
    throw new Error(
      "Tenant context is required to load an email template"
    );
  }

  const tenantDb = getTenantDb(db);

  const { rows } = await tenantDb.query(
    `SELECT *
       FROM email_templates
      WHERE tenant_id = $1
        AND template_key = $2`,
    [tenantId, key]
  );

  if (!rows.length) {
    throw new Error(`Email template ${key} is missing`);
  }

  return rows[0];
}

// Render the email using the selected template and invoice.
function renderFor(template, invoice) {
  return renderer.renderTemplate(template, {
    ...renderer.buildContext(
      invoice,
      assetStore.brandTokens()
    ),
    footer_note: template.footer_note || "",
  });
}

// Add an email to the tenant's email outbox.
async function queue(
  {
    templateKey,
    invoiceId,
    invoice,
    dedupeKey,
    attachPdf = false,
    userId = null,
  },
  db
) {
  const tenantId = getTenantId();

  if (!tenantId) {
    throw new Error(
      "Tenant context is required to queue an email"
    );
  }

  const tenantDb = getTenantDb(db);

  // Ensure email tables and tenant defaults exist.
  await ensureEmailSchema(tenantDb, tenantId);

  // Use the supplied invoice or fetch it using the tenant connection.
  const target =
    invoice ||
    (await invoiceQuery.byId(invoiceId, {}, tenantDb));

  if (!target) {
    throw new Error(`Invoice ${invoiceId} not found`);
  }

  const to = String(
    target.primary_contact_email || ""
  ).trim();

  if (!to) {
    return {
      skipped: "no_recipient",
      invoiceId: target.id,
    };
  }

  // Load only this tenant's email template.
  const template = await loadTemplate(
    templateKey,
    tenantDb,
    tenantId
  );

  if (template.is_enabled === false) {
    return {
      skipped: "template_disabled",
      invoiceId: target.id,
    };
  }

  // Generate the email subject and HTML.
  const { subject, html } = renderFor(
    template,
    target
  );

  // Insert the email into this tenant's outbox.
  const { rows } = await tenantDb.query(
    `INSERT INTO email_outbox
       (tenant_id, template_key, invoice_id, to_email,
        subject, body_html, attach_pdf, dedupe_key, queued_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tenant_id, dedupe_key)
       WHERE dedupe_key IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [
      tenantId,
      templateKey,
      target.id,
      to,
      subject,
      html,
      attachPdf,
      dedupeKey || null,
      userId,
    ]
  );

  if (!rows.length) {
    return {
      skipped: "already_queued",
      invoiceId: target.id,
    };
  }

  return {
    queued: rows[0].id,
    invoiceId: target.id,
    to,
  };
}

// Queue an invoice email.
const queueInvoiceEmail = (
  invoiceId,
  opts = {},
  db
) =>
  queue(
    {
      templateKey: "INVOICE",
      invoiceId,
      attachPdf: opts.attachPdf !== false,
      dedupeKey: opts.dedupeKey,
      userId: opts.userId,
    },
    db
  );

// Queue a reminder email.
const queueReminder = (
  invoiceId,
  templateKey,
  reminderKey,
  db
) =>
  queue(
    {
      templateKey,
      invoiceId,
      attachPdf: false,
      dedupeKey: `${templateKey}:${invoiceId}:${reminderKey}`,
    },
    db
  );

module.exports = {
  queue,
  queueInvoiceEmail,
  queueReminder,
  loadTemplate,
  renderFor,
};

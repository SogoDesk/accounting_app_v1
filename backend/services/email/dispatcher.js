const pool = require("../../config/db");
const renderer = require("./renderer");
const invoiceQuery = require("./invoiceQuery");
const assetStore = require("./assetStore");
const { ensureEmailSchema } = require("../../modules/email/ensureEmailSchema");

async function loadTemplate(key, db = pool) {
  const { rows } = await db.query(`SELECT * FROM email_templates WHERE template_key = $1`, [key]);
  if (!rows.length) throw new Error(`Email template ${key} is missing`);
  return rows[0];
}

function renderFor(template, invoice) {
  return renderer.renderTemplate(template, {
    ...renderer.buildContext(invoice, assetStore.brandTokens()),
    footer_note: template.footer_note || "",
  });
}

async function queue({ templateKey, invoiceId, invoice, dedupeKey, attachPdf = false, userId = null }, db = pool) {
  await ensureEmailSchema(db);

  const target = invoice || (await invoiceQuery.byId(invoiceId, {}, db));
  if (!target) throw new Error(`Invoice ${invoiceId} not found`);

  const to = String(target.primary_contact_email || "").trim();
  if (!to) return { skipped: "no_recipient", invoiceId: target.id };

  const template = await loadTemplate(templateKey, db);
  if (template.is_enabled === false) return { skipped: "template_disabled", invoiceId: target.id };

  const { subject, html } = renderFor(template, target);

  const { rows } = await db.query(
    `INSERT INTO email_outbox
       (template_key, invoice_id, to_email, subject, body_html, attach_pdf, dedupe_key, queued_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [templateKey, target.id, to, subject, html, attachPdf, dedupeKey || null, userId],
  );

  if (!rows.length) return { skipped: "already_queued", invoiceId: target.id };
  return { queued: rows[0].id, invoiceId: target.id, to };
}

const queueInvoiceEmail = (invoiceId, opts = {}, db = pool) =>
  queue({
    templateKey: "INVOICE",
    invoiceId,
    attachPdf: opts.attachPdf !== false,
    dedupeKey: opts.dedupeKey,
    userId: opts.userId,
  }, db);

const queueReminder = (invoiceId, templateKey, reminderKey, db = pool) =>
  queue({
    templateKey,
    invoiceId,
    attachPdf: false,
    dedupeKey: `${templateKey}:${invoiceId}:${reminderKey}`,
  }, db);

module.exports = { queue, queueInvoiceEmail, queueReminder, loadTemplate, renderFor };

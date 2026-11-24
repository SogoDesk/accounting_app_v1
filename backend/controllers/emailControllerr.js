
const {
  getTenantId,
  getTenantClient,
} = require("../config/tenantContext");

const { auditLog } = require("../middleware/auditMiddleware");

const {
  ensureEmailSchema,
  TEMPLATE_KEYS,
  DEFAULT_TEMPLATES,
} = require("../modules/email/ensureEmailSchema");

const renderer = require("../services/email/renderer");
const invoiceQuery = require("../services/email/invoiceQuery");
const dispatcher = require("../services/email/dispatcher");
const mailer = require("../services/email/mailer");
const assetStore = require("../services/email/assetStore");

// Get the database connection assigned to the current tenant request
const getTenantDb = () => {
  const db = getTenantClient();

  if (!db) {
    throw new Error("Tenant database connection not available");
  }

  return db;
};

// Get and validate the current tenant ID
const tenantIdFor = (req) => {
  const tenantId = Number(req.user?.tenant_id || getTenantId());

  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error("Valid tenant context is required");
  }

  return tenantId;
};

// Get allowed entity IDs for the current user
const scopeIds = (req) =>
  req.scopeEnforced && Array.isArray(req.allowedEntityIds)
    ? req.allowedEntityIds
    : undefined;

// Validate email template key
const normalizeKey = (value) => {
  const k = String(value || "").trim().toUpperCase();
  return TEMPLATE_KEYS.includes(k) ? k : null;
};

// List email templates
const listTemplates = async (req, res) => {
  try {
    const tenantId = tenantIdFor(req);
    const db = getTenantDb();

    await ensureEmailSchema(db, tenantId);

    const { rows } = await db.query(
      `SELECT *
         FROM email_templates
        WHERE tenant_id = $1
        ORDER BY CASE template_key WHEN 'INVOICE' THEN 0 ELSE 1 END`,
      [tenantId]
    );

    return res.json({
      success: true,
      data: rows,
      tokens: renderer.TOKENS,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// Update an email template
const updateTemplate = async (req, res) => {
  try {
    const tenantId = tenantIdFor(req);
    const db = getTenantDb();

    await ensureEmailSchema(db, tenantId);

    const key = normalizeKey(req.params.key);

    if (!key) {
      return res.status(400).json({
        success: false,
        message: "Unknown template",
      });
    }

    const subject = String(req.body.subject || "").trim();
    const body = String(req.body.body || "").trim();

    if (!subject) {
      return res.status(400).json({
        success: false,
        message: "Subject is required",
      });
    }

    if (!body) {
      return res.status(400).json({
        success: false,
        message: "Body is required",
      });
    }

    const footerNote =
      String(req.body.footer_note || "").trim().slice(0, 500) || null;

    const { rows } = await db.query(
      `UPDATE email_templates
          SET subject = $1,
              body = $2,
              footer_note = $3,
              is_enabled = $4,
              updated_by = $5,
              updated_at = now()
        WHERE tenant_id = $6
          AND template_key = $7
        RETURNING *`,
      [
        subject,
        renderer.sanitizeHtml(body),
        footerNote,
        req.body.is_enabled !== false,
        req.user?.id || null,
        tenantId,
        key,
      ]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Template not found",
      });
    }

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "UPDATE",
      entityType: "email_templates",
      entityId: null,
      newValues: { template_key: key },
      ipAddress: req.ip,
    });

    return res.json({
      success: true,
      message: "Template saved",
      data: rows[0],
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// Reset an email template to its default content
const resetTemplate = async (req, res) => {
  try {
    const tenantId = tenantIdFor(req);
    const db = getTenantDb();

    await ensureEmailSchema(db, tenantId);

    const key = normalizeKey(req.params.key);

    if (!key) {
      return res.status(400).json({
        success: false,
        message: "Unknown template",
      });
    }

    const template = DEFAULT_TEMPLATES.find(
      (item) => item.template_key === key
    );

    if (!template) {
      return res.status(404).json({
        success: false,
        message: "Default template not found",
      });
    }

    const { rows } = await db.query(
      `UPDATE email_templates
          SET subject = $1,
              body = $2,
              footer_note = NULL,
              is_enabled = true,
              updated_by = $3,
              updated_at = now()
        WHERE tenant_id = $4
          AND template_key = $5
        RETURNING *`,
      [
        template.subject,
        template.body,
        req.user?.id || null,
        tenantId,
        key,
      ]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Template not found",
      });
    }

    return res.json({
      success: true,
      message: "Reset to default",
      data: rows[0],
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// Preview an email template
const previewTemplate = async (req, res) => {
  try {
    const tenantId = tenantIdFor(req);
    const db = getTenantDb();

    await ensureEmailSchema(db, tenantId);

    const invoiceId = req.body.invoice_id
      ? Number(req.body.invoice_id)
      : null;

    const brand = assetStore.brandTokens();

    let context = {
      ...renderer.sampleContext(),
      ...Object.fromEntries(
        Object.entries({
          logo_url: brand.email_logo_url,
          header_banner_url: brand.header_banner_url,
        }).filter(([, value]) => value)
      ),
    };

    let source = "sample";
    let recipient = "client@example.com";

    if (invoiceId) {
      const invoice = await invoiceQuery.byId(
        invoiceId,
        {
          allowedEntityIds: scopeIds(req),
        },
        db
      );

      if (!invoice) {
        return res.status(404).json({
          success: false,
          message: "Invoice not found",
        });
      }

      context = renderer.buildContext(invoice, brand);
      recipient =
        invoice.primary_contact_email || "(client has no email address)";
      source = invoice.invoice_number;
    }

    const rendered = renderer.renderTemplate(
      {
        subject: req.body.subject || "",
        body: req.body.body || "",
      },
      {
        ...context,
        footer_note: String(req.body.footer_note || "").trim(),
      }
    );

    return res.json({
      success: true,
      data: {
        ...rendered,
        html: renderer.toDisplayHtml(rendered.html),
        recipient,
        source,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// Get invoices available for email preview
const previewInvoiceOptions = async (req, res) => {
  try {
    const db = getTenantDb();

    const rows = await invoiceQuery.pickable(
      {
        allowedEntityIds: scopeIds(req),
      },
      db
    );

    return res.json({
      success: true,
      data: rows,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// Clean reminder day values
const cleanDayList = (value, fallback) => {
  if (!Array.isArray(value)) return fallback;

  return [
    ...new Set(
      value
        .map((n) => Number(n))
        .filter((n) => Number.isInteger(n) && n > 0 && n <= 365)
    ),
  ].sort((a, b) => b - a);
};

// Get reminder schedule
const getSchedule = async (req, res) => {
  try {
    const tenantId = tenantIdFor(req);
    const db = getTenantDb();

    await ensureEmailSchema(db, tenantId);

    const { rows } = await db.query(
      `SELECT *
         FROM invoice_reminder_settings
        WHERE tenant_id = $1`,
      [tenantId]
    );

    return res.json({
      success: true,
      data: rows[0] || null,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// Update reminder schedule
const updateSchedule = async (req, res) => {
  try {
    const tenantId = tenantIdFor(req);
    const db = getTenantDb();

    await ensureEmailSchema(db, tenantId);

    const before = cleanDayList(req.body.before_due_days, [10, 5]);

    const overdue = cleanDayList(
      req.body.overdue_days,
      [1, 7, 14]
    ).sort((a, b) => a - b);

    const channels = req.body.channels_json || {};

    const { rows } = await db.query(
      `UPDATE invoice_reminder_settings
          SET enabled = $1,
              before_due_days = $2,
              send_on_due = $3,
              overdue_days = $4,
              days_before_due = $5,
              channels_json = $6,
              updated_by = $7,
              updated_at = now()
        WHERE tenant_id = $8
        RETURNING *`,
      [
        Boolean(req.body.enabled),
        before,
        Boolean(req.body.send_on_due),
        overdue,
        before[0] || 0,
        {
          email: Boolean(channels.email),
          in_app:
            channels.in_app === undefined
              ? true
              : Boolean(channels.in_app),
        },
        req.user?.id || null,
        tenantId,
      ]
    );

    if (!rows.length) {
      return res.status(404).json({
        success: false,
        message: "Reminder settings not found",
      });
    }

    return res.json({
      success: true,
      message: "Reminder schedule saved",
      data: rows[0],
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// Queue an invoice email
const sendInvoiceEmail = async (req, res) => {
  try {
    const tenantId = tenantIdFor(req);
    const db = getTenantDb();

    await ensureEmailSchema(db, tenantId);

    const invoiceId = Number(req.params.id);

    const invoice = await invoiceQuery.byId(
      invoiceId,
      {
        allowedEntityIds: scopeIds(req),
      },
      db
    );

    if (!invoice) {
      return res.status(404).json({
        success: false,
        message: "Invoice not found",
      });
    }

    if (!String(invoice.primary_contact_email || "").trim()) {
      return res.status(400).json({
        success: false,
        message: `${invoice.client_name || "This client"} has no contact email address.`,
      });
    }

    const out = await dispatcher.queue({
      templateKey: "INVOICE",
      invoice,
      attachPdf: req.body?.attach_pdf !== false,
      userId: req.user?.id || null,
    });

    if (out.skipped) {
      return res.status(409).json({
        success: false,
        message: `Not queued: ${out.skipped}`,
      });
    }

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "EMAIL_QUEUED",
      entityType: "invoices",
      entityId: invoiceId,
      newValues: {
        to: out.to,
        outbox_id: out.queued,
      },
      ipAddress: req.ip,
    });

    return res.status(201).json({
      success: true,
      message: `Queued for ${out.to}`,
      data: {
        ...out,
        driver: mailer.driver(),
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

// Get email sending history for an invoice
const invoiceEmailHistory = async (req, res) => {
  try {
    const tenantId = tenantIdFor(req);
    const db = getTenantDb();

    await ensureEmailSchema(db, tenantId);

    const { rows } = await db.query(
      `SELECT id, template_key, to_email, subject, status,
              attempts, last_error, created_at, sent_at
         FROM email_outbox
        WHERE tenant_id = $1
          AND invoice_id = $2
        ORDER BY id DESC
        LIMIT 20`,
      [tenantId, Number(req.params.id)]
    );

    return res.json({
      success: true,
      data: rows,
      driver: mailer.driver(),
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err.message,
    });
  }
};

module.exports = {
  listTemplates,
  updateTemplate,
  resetTemplate,
  previewTemplate,
  previewInvoiceOptions,
  getSchedule,
  updateSchedule,
  sendInvoiceEmail,
  invoiceEmailHistory,
};

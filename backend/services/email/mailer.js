
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const { getTenantId } = require("../../config/tenantContext");

const OUTBOX_DIR = path.join(
  __dirname,
  "..",
  "..",
  "storage",
  "outbox"
);

const driver = () =>
  String(process.env.MAIL_DRIVER || "console")
    .trim()
    .toLowerCase();

const fromAddress = () =>
  String(process.env.EMAIL_FROM || "").trim();

let _transport = null;

// Create or reuse SMTP transport.
const smtpTransport = () => {
  if (_transport) return _transport;

  const host = String(process.env.EMAIL_HOST || "").trim();
  const port = Number(process.env.EMAIL_PORT) || 587;
  const user = String(process.env.EMAIL_USER || "").trim();
  const pass = String(process.env.EMAIL_PASS || "").trim();

  if (!host) throw new Error("EMAIL_HOST is not set");
  if (!user || !pass) {
    throw new Error("EMAIL_USER / EMAIL_PASS are not set");
  }
  if (!fromAddress()) {
    throw new Error("EMAIL_FROM is not set");
  }

  _transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  return _transport;
};

// Keep generated filenames safe.
const safeName = (value) =>
  String(value || "email")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .slice(0, 60);

// Get the current tenant's local email folder.
const getTenantOutboxDir = () => {
  const tenantId = Number(getTenantId());

  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error(
      "Valid tenant context is required to save an email"
    );
  }

  return path.join(OUTBOX_DIR, `tenant-${tenantId}`);
};

// Save an email locally in console mode.
const writeEml = async (message) => {
  const tenantOutboxDir = getTenantOutboxDir();

  fs.mkdirSync(tenantOutboxDir, { recursive: true });

  const composer = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: "unix",
  });

  const info = await composer.sendMail(message);

  const filename =
    `${Date.now()}-${crypto.randomBytes(6).toString("hex")}-` +
    `${safeName(message.subject)}.eml`;

  fs.writeFileSync(
    path.join(tenantOutboxDir, filename),
    info.message,
    { flag: "wx" }
  );

  return {
    messageId: info.messageId,
    file: path.join(`tenant-${Number(getTenantId())}`, filename),
    driver: "console",
  };
};

// Check whether the selected email driver is configured.
const isConfigured = () => {
  if (driver() === "console") return true;

  return Boolean(
    String(process.env.EMAIL_HOST || "").trim() &&
    String(process.env.EMAIL_USER || "").trim() &&
    String(process.env.EMAIL_PASS || "").trim() &&
    fromAddress()
  );
};

// Return mailer configuration status.
const status = () => ({
  driver: driver(),
  configured: isConfigured(),
  from: fromAddress() || null,
  host: String(process.env.EMAIL_HOST || "").trim() || null,
  outbox_dir: driver() === "console" ? OUTBOX_DIR : null,
});

// Send or locally generate an email.
async function send({
  to,
  subject,
  html,
  attachments = [],
  replyTo,
}) {
  if (!to) {
    throw new Error("Recipient address is required");
  }

  if (!subject) {
    throw new Error("Subject is required");
  }

  const from = fromAddress() || "no-reply@localhost";

  const message = {
    from,
    to,
    subject,
    html,
    attachments,
  };

  if (replyTo) {
    message.replyTo = replyTo;
  }

  if (driver() === "console") {
    return writeEml(message);
  }

  if (!isConfigured()) {
    throw new Error("SMTP email configuration is incomplete");
  }

  const info = await smtpTransport().sendMail(message);

  return {
    messageId: info.messageId,
    accepted: info.accepted,
    driver: "smtp",
  };
}

// Verify the selected email transport.
async function verify() {
  if (driver() === "console") {
    return {
      ok: true,
      driver: "console",
    };
  }

  if (!isConfigured()) {
    throw new Error("SMTP email configuration is incomplete");
  }

  await smtpTransport().verify();

  return {
    ok: true,
    driver: "smtp",
  };
}

module.exports = {
  send,
  verify,
  status,
  isConfigured,
  driver,
  OUTBOX_DIR,
};

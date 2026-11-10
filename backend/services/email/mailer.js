const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const OUTBOX_DIR = path.join(__dirname, "..", "..", "storage", "outbox");

const driver = () => String(process.env.MAIL_DRIVER || "console").trim().toLowerCase();
const fromAddress = () => String(process.env.EMAIL_FROM || "").trim();

let _transport = null;

const smtpTransport = () => {
  if (_transport) return _transport;
  const host = String(process.env.EMAIL_HOST || "").trim();
  const port = Number(process.env.EMAIL_PORT) || 587;
  const user = String(process.env.EMAIL_USER || "").trim();
  const pass = String(process.env.EMAIL_PASS || "").trim();

  if (!host) throw new Error("EMAIL_HOST is not set");
  if (!user || !pass) throw new Error("EMAIL_USER / EMAIL_PASS are not set");

  _transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
  return _transport;
};

const safeName = (v) => String(v || "email").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 60);

const writeEml = async (message) => {
  if (!fs.existsSync(OUTBOX_DIR)) fs.mkdirSync(OUTBOX_DIR, { recursive: true });

  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
  const info = await composer.sendMail(message);
  const filename = `${Date.now()}-${safeName(message.subject)}.eml`;
  fs.writeFileSync(path.join(OUTBOX_DIR, filename), info.message);
  return { messageId: info.messageId, file: filename, driver: "console" };
};

const isConfigured = () => {
  if (driver() === "console") return true;
  return Boolean(
    String(process.env.EMAIL_HOST || "").trim() &&
    String(process.env.EMAIL_USER || "").trim() &&
    String(process.env.EMAIL_PASS || "").trim() &&
    fromAddress(),
  );
};

const status = () => ({
  driver: driver(),
  configured: isConfigured(),
  from: fromAddress() || null,
  host: String(process.env.EMAIL_HOST || "").trim() || null,
  outbox_dir: driver() === "console" ? OUTBOX_DIR : null,
});

async function send({ to, subject, html, attachments = [], replyTo }) {
  if (!to) throw new Error("Recipient address is required");
  if (!subject) throw new Error("Subject is required");

  const from = fromAddress() || "no-reply@localhost";
  const message = { from, to, subject, html, attachments };
  if (replyTo) message.replyTo = replyTo;

  if (driver() === "console") return writeEml(message);

  const info = await smtpTransport().sendMail(message);
  return { messageId: info.messageId, accepted: info.accepted, driver: "smtp" };
}

async function verify() {
  if (driver() === "console") return { ok: true, driver: "console" };
  await smtpTransport().verify();
  return { ok: true, driver: "smtp" };
}

module.exports = { send, verify, status, isConfigured, driver, OUTBOX_DIR };

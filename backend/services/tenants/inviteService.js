const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const pool = require("../../config/db");
const mailer = require("../email/mailer");
const { runWithTenant } = require("../../config/tenantContext");

const INVITE_TTL_DAYS = 7;

const hashToken = (token) =>
  crypto.createHash("sha256").update(String(token)).digest("hex");

// Base URL of the web app, used in invite links.
const appUrl = () => {
  const raw = process.env.APP_URL || process.env.CLIENT_ORIGIN || process.env.CLIENT_URL || "http://localhost:5173";
  return String(raw).split(",")[0].trim().replace(/\/+$/, "");
};

const inviteUrl = (token) => `${appUrl()}/accept-invite?token=${encodeURIComponent(token)}`;

// Create a fresh invite for a user, replacing any earlier unused ones.
// `db` must be a client inside the caller's transaction.
const createInvite = async (db, { tenantId, userId, email }) => {
  const token = crypto.randomBytes(32).toString("base64url");

  await db.query(
    `DELETE FROM tenant_invites
     WHERE invite_tenant_id = $1 AND user_id = $2 AND accepted_at IS NULL`,
    [tenantId, userId]
  );

  await db.query(
    `INSERT INTO tenant_invites (invite_tenant_id, user_id, email, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' days')::interval)`,
    [tenantId, userId, email, hashToken(token), String(INVITE_TTL_DAYS)]
  );

  return { token, url: inviteUrl(token), expiresInDays: INVITE_TTL_DAYS };
};

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Email the invite. Never throws: onboarding must not fail because mail did.
const sendInviteEmail = async ({ tenant, admin, url }) => {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#1f2937">
      <h2 style="margin-bottom:4px">Welcome to SogoDesk Books</h2>
      <p>Hi ${escapeHtml(admin.full_name)},</p>
      <p>An account has been created for <strong>${escapeHtml(tenant.tenant_name)}</strong>,
         and you are its administrator.</p>
      <p>Click the button below to set your password. The link expires in ${INVITE_TTL_DAYS} days.</p>
      <p style="margin:24px 0">
        <a href="${escapeHtml(url)}" style="background:#5b4de3;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Set your password</a>
      </p>
      <p>When signing in, use company code <strong>${escapeHtml(String(tenant.tenant_code).toLowerCase())}</strong>.</p>
      <p style="color:#6b7280;font-size:12px">If the button does not work, paste this link into your browser:<br>${escapeHtml(url)}</p>
    </div>`;

  try {
    // The console mail driver files messages per tenant, so run in its context.
    const result = await runWithTenant(null, tenant.id, () =>
      mailer.send({
        to: admin.email,
        subject: `You're invited to ${tenant.tenant_name} on SogoDesk Books`,
        html,
      })
    );
    return { sent: true, driver: result.driver };
  } catch (error) {
    console.error("[INVITE][EMAIL]", error);
    return { sent: false, driver: mailer.driver(), error: error.message };
  }
};

// Look up a usable invite by its raw token (public, pre-login).
const findInvite = async (token) => {
  const result = await pool.query(
    `SELECT i.id, i.user_id, i.email, i.expires_at, i.accepted_at,
            t.id AS tenant_id, t.tenant_name, t.tenant_code, t.status AS tenant_status
     FROM tenant_invites i
     JOIN tenants t ON t.id = i.invite_tenant_id
     WHERE i.token_hash = $1`,
    [hashToken(token)]
  );
  const invite = result.rows[0];
  if (!invite) return { error: "This invitation link is invalid." };
  if (invite.accepted_at) return { error: "This invitation has already been used. Please sign in." };
  if (new Date(invite.expires_at) < new Date()) return { error: "This invitation has expired. Ask for a new one." };
  if (invite.tenant_status !== "ACTIVE") return { error: "This company account is not active." };
  return { invite };
};

// Set the user's password and activate them. Returns the tenant code.
const acceptInvite = async (token, password) => {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");

    const locked = await db.query(
      `SELECT i.id, i.user_id, i.invite_tenant_id, i.expires_at, i.accepted_at,
              t.tenant_code, t.status AS tenant_status
       FROM tenant_invites i
       JOIN tenants t ON t.id = i.invite_tenant_id
       WHERE i.token_hash = $1
       FOR UPDATE OF i`,
      [hashToken(token)]
    );
    const invite = locked.rows[0];
    if (!invite || invite.accepted_at || new Date(invite.expires_at) < new Date() ||
        invite.tenant_status !== "ACTIVE") {
      throw Object.assign(new Error("This invitation is no longer valid."), { status: 410 });
    }

    await db.query("SELECT set_config('app.tenant_id', $1, true)", [String(invite.invite_tenant_id)]);

    const hash = await bcrypt.hash(password, 12);
    const updated = await db.query(
      `UPDATE users
       SET password_hash = $1, status = 'ACTIVE', updated_at = now()
       WHERE id = $2 AND tenant_id = $3`,
      [hash, invite.user_id, invite.invite_tenant_id]
    );
    if (updated.rowCount !== 1) {
      throw Object.assign(new Error("The invited user no longer exists."), { status: 410 });
    }

    await db.query("UPDATE tenant_invites SET accepted_at = now() WHERE id = $1", [invite.id]);
    await db.query("COMMIT");

    return { tenantCode: String(invite.tenant_code).toLowerCase() };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    db.release();
  }
};

module.exports = { createInvite, sendInviteEmail, findInvite, acceptInvite, INVITE_TTL_DAYS };

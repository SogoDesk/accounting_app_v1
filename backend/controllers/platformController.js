const pool = require("../config/db");
const { provisionTenant, TENANT_CODE_RE } = require("../services/tenants/provisionTenant");
const { createInvite, sendInviteEmail } = require("../services/tenants/inviteService");
const { ensurePlatformSchema } = require("../services/platform/ensurePlatformSchema");

const parseId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

// Run `fn(db)` in a transaction whose RLS context is the given tenant, so
// tenant-owned tables (users, roles, settings, ...) are visible.
const withTenantTx = async (tenantId, fn) => {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [String(tenantId)]);
    const result = await fn(db);
    await db.query("COMMIT");
    return result;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    db.release();
  }
};

// POST /api/platform/tenants — onboard a client and invite its admin
const createTenant = async (req, res) => {
  try {
    await ensurePlatformSchema();

    const {
      tenant_name,
      tenant_code,
      admin_name,
      admin_email,
      currency,
      fiscal_start_month,
    } = req.body;

    const result = await provisionTenant({
      tenantName: tenant_name,
      tenantCode: tenant_code,
      adminName: admin_name,
      adminEmail: admin_email,
      currency,
      fiscalStartMonth: fiscal_start_month ?? 1,
    });

    const email = await sendInviteEmail({
      tenant: result.tenant,
      admin: result.admin,
      url: result.invite.url,
    });

    return res.status(201).json({
      success: true,
      message: "Client onboarded successfully.",
      data: {
        tenant: result.tenant,
        admin: { id: result.admin.id, full_name: result.admin.full_name, email: result.admin.email },
        fiscal_year: result.fiscalYear,
        currency: result.currency,
        invite: {
          url: result.invite.url,
          expires_in_days: result.invite.expiresInDays,
          email_sent: email.sent,
          email_driver: email.driver,
          email_error: email.error || null,
        },
      },
    });
  } catch (error) {
    console.error("[PLATFORM][CREATE TENANT]", error);
    return res.status(400).json({
      success: false,
      message: error.message || "Unable to create client.",
    });
  }
};

// GET /api/platform/tenants
const getTenants = async (req, res) => {
  try {
    await ensurePlatformSchema();
    // Invite counts consider only each admin's most recent invitation.
    const result = await pool.query(
      `SELECT t.id, t.tenant_name, t.tenant_code, t.status, t.created_at,
              COALESCE(i.pending, 0)::int AS pending_invites,
              COALESCE(i.expired, 0)::int AS expired_invites
       FROM tenants t
       LEFT JOIN (
         SELECT invite_tenant_id,
                count(*) FILTER (WHERE accepted_at IS NULL AND expires_at >= now()) AS pending,
                count(*) FILTER (WHERE accepted_at IS NULL AND expires_at <  now()) AS expired
         FROM (
           SELECT DISTINCT ON (invite_tenant_id, user_id) *
           FROM tenant_invites
           ORDER BY invite_tenant_id, user_id, created_at DESC
         ) latest
         GROUP BY invite_tenant_id
       ) i ON i.invite_tenant_id = t.id
       ORDER BY t.id DESC`
    );
    return res.status(200).json({ success: true, data: result.rows });
  } catch (error) {
    console.error("[PLATFORM][GET TENANTS]", error);
    return res.status(500).json({ success: false, message: "Unable to fetch clients." });
  }
};

// GET /api/platform/tenants/check-code?code=XYZ
const checkTenantCode = async (req, res) => {
  const code = String(req.query.code || "").trim().toUpperCase();
  if (!TENANT_CODE_RE.test(code)) {
    return res.json({
      success: true,
      data: { code, valid: false, available: false },
    });
  }
  try {
    const result = await pool.query(
      "SELECT 1 FROM tenants WHERE upper(tenant_code) = $1",
      [code]
    );
    return res.json({
      success: true,
      data: { code, valid: true, available: result.rowCount === 0 },
    });
  } catch (error) {
    console.error("[PLATFORM][CHECK CODE]", error);
    return res.status(500).json({ success: false, message: "Unable to check code." });
  }
};

// GET /api/platform/tenants/:id — client detail
const getTenant = async (req, res) => {
  const tenantId = parseId(req.params.id);
  if (!tenantId) {
    return res.status(400).json({ success: false, message: "Invalid client ID." });
  }

  try {
    await ensurePlatformSchema();

    const tenantResult = await pool.query(
      "SELECT id, tenant_name, tenant_code, status, created_at FROM tenants WHERE id = $1",
      [tenantId]
    );
    const tenant = tenantResult.rows[0];
    if (!tenant) {
      return res.status(404).json({ success: false, message: "Client not found." });
    }

    const details = await withTenantTx(tenantId, async (db) => {
      const users = await db.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
                max(last_login_at) AS last_login_at
         FROM users WHERE tenant_id = $1`,
        [tenantId]
      );
      const admins = await db.query(
        `SELECT u.id, u.full_name, u.email, u.status, u.last_login_at, u.created_at
         FROM users u
         JOIN roles r ON r.id = u.role_id AND r.tenant_id = u.tenant_id
         WHERE u.tenant_id = $1 AND r.role_name = 'SUPER_ADMIN'
         ORDER BY u.id`,
        [tenantId]
      );
      const settings = await db.query(
        "SELECT group_currency FROM company_settings WHERE tenant_id = $1 LIMIT 1",
        [tenantId]
      );
      const fiscal = await db.query(
        `SELECT year_label, start_date, end_date, status
         FROM fiscal_years WHERE tenant_id = $1
         ORDER BY start_date DESC LIMIT 1`,
        [tenantId]
      );
      return {
        users: users.rows[0],
        admins: admins.rows,
        currency: settings.rows[0]?.group_currency || null,
        fiscal_year: fiscal.rows[0] || null,
      };
    });

    const invites = await pool.query(
      `SELECT user_id, email, expires_at, accepted_at, created_at
       FROM tenant_invites
       WHERE invite_tenant_id = $1
       ORDER BY created_at DESC`,
      [tenantId]
    );

    // Latest invite per admin, with a derived status.
    const latestInvite = new Map();
    for (const inv of invites.rows) {
      if (!latestInvite.has(inv.user_id)) latestInvite.set(inv.user_id, inv);
    }
    const admins = details.admins.map((a) => {
      const inv = latestInvite.get(a.id);
      let invite_status = "NONE";
      if (inv?.accepted_at) invite_status = "ACCEPTED";
      else if (inv && new Date(inv.expires_at) < new Date()) invite_status = "EXPIRED";
      else if (inv) invite_status = "PENDING";
      return {
        ...a,
        invite_status,
        invite_expires_at: inv && !inv.accepted_at ? inv.expires_at : null,
        invite_accepted_at: inv?.accepted_at || null,
      };
    });

    return res.json({
      success: true,
      data: { ...tenant, ...details, admins },
    });
  } catch (error) {
    console.error("[PLATFORM][GET TENANT]", error);
    return res.status(500).json({ success: false, message: "Unable to load client." });
  }
};

// POST /api/platform/tenants/:id/admins/:userId/resend-invite
const resendInvite = async (req, res) => {
  const tenantId = parseId(req.params.id);
  const userId = parseId(req.params.userId);
  if (!tenantId || !userId) {
    return res.status(400).json({ success: false, message: "Invalid request." });
  }

  try {
    await ensurePlatformSchema();

    const tenantResult = await pool.query(
      "SELECT id, tenant_name, tenant_code, status FROM tenants WHERE id = $1",
      [tenantId]
    );
    const tenant = tenantResult.rows[0];
    if (!tenant) {
      return res.status(404).json({ success: false, message: "Client not found." });
    }
    if (tenant.status !== "ACTIVE") {
      return res.status(400).json({ success: false, message: "Reactivate the client before sending an invite." });
    }

    const outcome = await withTenantTx(tenantId, async (db) => {
      const userResult = await db.query(
        "SELECT id, full_name, email, status FROM users WHERE id = $1 AND tenant_id = $2",
        [userId, tenantId]
      );
      const admin = userResult.rows[0];
      if (!admin) return { error: [404, "User not found."] };
      if (admin.status === "ACTIVE") {
        return { error: [400, "This user has already activated their account."] };
      }
      const invite = await createInvite(db, { tenantId, userId, email: admin.email });
      return { admin, invite };
    });

    if (outcome.error) {
      const [status, message] = outcome.error;
      return res.status(status).json({ success: false, message });
    }

    const email = await sendInviteEmail({ tenant, admin: outcome.admin, url: outcome.invite.url });

    return res.json({
      success: true,
      message: email.sent ? "Invitation sent." : "Invitation created, but the email could not be sent.",
      data: {
        url: outcome.invite.url,
        expires_in_days: outcome.invite.expiresInDays,
        email_sent: email.sent,
        email_driver: email.driver,
        email_error: email.error || null,
      },
    });
  } catch (error) {
    console.error("[PLATFORM][RESEND INVITE]", error);
    return res.status(500).json({ success: false, message: "Unable to resend invitation." });
  }
};

// PATCH /api/platform/tenants/:id — suspend or reactivate
const updateTenantStatus = async (req, res) => {
  try {
    const tenantId = parseId(req.params.id);
    const { status } = req.body;

    if (!tenantId) {
      return res.status(400).json({ success: false, message: "Invalid client ID." });
    }
    if (!["ACTIVE", "SUSPENDED"].includes(status)) {
      return res.status(400).json({ success: false, message: "Status must be ACTIVE or SUSPENDED." });
    }

    const result = await pool.query(
      `UPDATE tenants
       SET status = $1
       WHERE id = $2
       RETURNING id, tenant_name, tenant_code, status, created_at`,
      [status, tenantId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Client not found." });
    }

    return res.status(200).json({
      success: true,
      message: status === "ACTIVE" ? "Client reactivated." : "Client suspended.",
      data: result.rows[0],
    });
  } catch (error) {
    console.error("[PLATFORM][UPDATE TENANT]", error);
    return res.status(500).json({ success: false, message: "Unable to update client status." });
  }
};

module.exports = {
  createTenant,
  getTenants,
  checkTenantCode,
  getTenant,
  resendInvite,
  updateTenantStatus,
};

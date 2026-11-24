const { findInvite, acceptInvite } = require("../services/tenants/inviteService");
const { ensurePlatformSchema } = require("../services/platform/ensurePlatformSchema");

// GET /api/auth/invite/:token — show who the invite is for (public)
const getInvite = async (req, res) => {
  try {
    await ensurePlatformSchema();
    const { invite, error } = await findInvite(req.params.token);
    if (error) return res.status(410).json({ success: false, message: error });

    return res.json({
      success: true,
      data: {
        email: invite.email,
        company_name: invite.tenant_name,
        company_code: String(invite.tenant_code).toLowerCase(),
        expires_at: invite.expires_at,
      },
    });
  } catch (error) {
    console.error("[INVITE][GET]", error);
    return res.status(500).json({ success: false, message: "Unable to load invitation." });
  }
};

// POST /api/auth/invite/accept { token, password } (public)
const accept = async (req, res) => {
  const token = String(req.body?.token || "");
  const password = String(req.body?.password || "");

  if (!token) {
    return res.status(400).json({ success: false, message: "Invitation token is missing." });
  }
  if (password.length < 8) {
    return res.status(400).json({ success: false, message: "Password must be at least 8 characters." });
  }

  try {
    await ensurePlatformSchema();
    const { tenantCode } = await acceptInvite(token, password);
    return res.json({
      success: true,
      message: "Your password is set. You can now sign in.",
      data: { company_code: tenantCode },
    });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ success: false, message: error.message });
    }
    console.error("[INVITE][ACCEPT]", error);
    return res.status(500).json({ success: false, message: "Unable to accept invitation." });
  }
};

module.exports = { getInvite, accept };

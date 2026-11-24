const bcrypt = require("bcryptjs");
const pool = require("../config/db");
const { signPlatformToken } = require("../middleware/platformAuthMiddleware");

// Compared against when the email is unknown, so response time does not
// reveal whether the platform account's email is correct.
const DUMMY_HASH = bcrypt.hashSync("platform-dummy-password", 12);

const toPublic = (admin) => ({
  id: admin.id,
  fullName: admin.full_name,
  email: admin.email,
});

// POST /api/platform/auth/login  { email, password }
const login = async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required." });
    }

    const result = await pool.query(
      `SELECT id, full_name, email, password_hash, status
       FROM platform_admins
       WHERE lower(email) = $1`,
      [email]
    );
    const admin = result.rows[0];

    const ok = await bcrypt.compare(password, admin?.password_hash || DUMMY_HASH);

    if (!admin || !ok || admin.status !== "ACTIVE") {
      return res.status(401).json({ success: false, message: "Invalid email or password." });
    }

    const token = signPlatformToken(admin);

    await pool.query(
      "UPDATE platform_admins SET last_login_at = now() WHERE id = $1",
      [admin.id]
    );

    return res.json({ success: true, data: { token, admin: toPublic(admin) } });
  } catch (error) {
    console.error("[PLATFORM][LOGIN]", error);
    return res.status(500).json({ success: false, message: "Unable to sign in." });
  }
};

// GET /api/platform/auth/me
const me = (req, res) =>
  res.json({ success: true, data: { admin: toPublic(req.platformAdmin) } });

module.exports = { login, me };

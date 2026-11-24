const jwt = require("jsonwebtoken");
const pool = require("../config/db");

// Platform tokens are signed with their own secret and audience, so a tenant
// token can never pass here and a platform token can never pass the tenant
// `authenticate` middleware (different secret).
const PLATFORM_AUDIENCE = "platform";
const PLATFORM_TOKEN_TTL = "8h";

const getPlatformSecret = () => {
  const secret = process.env.PLATFORM_JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("PLATFORM_JWT_SECRET is missing or shorter than 32 characters.");
  }
  if (secret === process.env.JWT_SECRET) {
    throw new Error("PLATFORM_JWT_SECRET must differ from JWT_SECRET.");
  }
  return secret;
};

const signPlatformToken = (admin) =>
  jwt.sign(
    { sub: String(admin.id), email: admin.email, scope: "platform" },
    getPlatformSecret(),
    { audience: PLATFORM_AUDIENCE, expiresIn: PLATFORM_TOKEN_TTL }
  );

const authenticatePlatform = async (req, res, next) => {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";

  if (!token) {
    return res.status(401).json({ success: false, message: "Platform login required." });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, getPlatformSecret(), { audience: PLATFORM_AUDIENCE });
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ success: false, message: "Session expired. Please login again." });
    }
    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({ success: false, message: "Invalid platform token." });
    }
    console.error("[PLATFORM AUTH]", error);
    return res.status(500).json({ success: false, message: "Platform authentication is not configured." });
  }

  if (decoded.scope !== "platform" || !decoded.sub) {
    return res.status(401).json({ success: false, message: "Invalid platform token." });
  }

  try {
    const result = await pool.query(
      "SELECT id, full_name, email, status FROM platform_admins WHERE id = $1",
      [Number(decoded.sub)]
    );
    const admin = result.rows[0];

    if (!admin || admin.status !== "ACTIVE") {
      return res.status(401).json({ success: false, message: "Platform account is not active." });
    }

    req.platformAdmin = admin;
    next();
  } catch (error) {
    console.error("[PLATFORM AUTH][LOOKUP]", error);
    return res.status(500).json({ success: false, message: "Platform authentication failed." });
  }
};

module.exports = { authenticatePlatform, signPlatformToken };

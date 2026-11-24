
const jwt = require("jsonwebtoken");

// ---------------------------------------------------------------------------
// STEP 3.3: AUTHENTICATE USER
// ---------------------------------------------------------------------------

const authenticate = (req, res, next) => {
  try {
    // 1. Get token from request header
    const authHeader =
      req.headers.authorization || req.headers.Authorization;

    if (
      !authHeader ||
      !String(authHeader).startsWith("Bearer ")
    ) {
      return res.status(401).json({
        success: false,
        message: "Access denied. No token provided.",
      });
    }

    // 2. Extract token
    const token = String(authHeader).slice(7).trim();

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Access denied. Invalid token format.",
      });
    }

    // 3. Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // 4. Validate user ID and tenant ID
    if (
      !decoded.id ||
      !Number.isInteger(Number(decoded.tenant_id)) ||
      Number(decoded.tenant_id) <= 0
    ) {
      return res.status(401).json({
        success: false,
        message: "Invalid token. User or tenant information missing.",
      });
    }

    // 5. Store authenticated user information
    req.user = {
      id: decoded.id,
      email: decoded.email,
      role: decoded.role,
      tenant_id: Number(decoded.tenant_id),
    };

    // 6. Make tenant ID available to controllers
    req.tenantId = Number(decoded.tenant_id);

    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Session expired. Please login again.",
      });
    }

    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({
        success: false,
        message: "Invalid token.",
      });
    }

    console.error("[AUTH][MIDDLEWARE]", error);

    return res.status(401).json({
      success: false,
      message: "Unauthorized access.",
    });
  }
};

// ---------------------------------------------------------------------------
// STEP 3.4: CHECK USER ROLE
// ---------------------------------------------------------------------------

const authorize = (...allowedRoles) => {
  return (req, res, next) => {
    try {
      if (!req.user) {
        return res.status(401).json({
          success: false,
          message: "Unauthorized. User not authenticated.",
        });
      }

      const userRole = String(req.user.role || "").toUpperCase();

      const normalizedAllowedRoles = allowedRoles.map((role) =>
        String(role).toUpperCase()
      );

      if (!normalizedAllowedRoles.includes(userRole)) {
        return res.status(403).json({
          success: false,
          message:
            "Forbidden. You do not have permission to perform this action.",
        });
      }

      next();
    } catch (error) {
      console.error("[AUTH][AUTHORIZE]", error);

      return res.status(500).json({
        success: false,
        message: "Authorization error.",
      });
    }
  };
};

module.exports = {
  authenticate,
  authorize,
};

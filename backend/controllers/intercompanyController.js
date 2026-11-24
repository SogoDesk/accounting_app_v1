



const { getTenantClient } = require("../config/tenantContext");
const intercompany = require("../services/gl/intercompanyService");
const glPosting = require("../services/gl/postingService");
const { canPostToLocation } = require("../middleware/scopeMiddleware");
const { auditLog } = require("../middleware/auditMiddleware");

const getTenantDb = () => {
  const db = getTenantClient();
  if (!db) {
    throw new Error("Tenant database context is missing for this request");
  }
  return db;
};

const notReady = (res) =>
  res.json({
    success: true,
    glReady: false,
    data: null,
    message: "General ledger not enabled. Apply migrations 001–007, then restart the backend.",
  });

// POST /api/intercompany/transfers
const createTransfer = async (req, res) => {
  try {
    if (!(await glPosting.glAvailable())) return notReady(res);

    const {
      from_location_id,
      to_location_id,
      amount,
      currency,
      date,
      memo,
    } = req.body;

    if (!from_location_id || !to_location_id || !amount || !currency) {
      return res.status(400).json({
        success: false,
        message: "from_location_id, to_location_id, amount and currency are required",
      });
    }

    // The caller must be allowed to post to both locations.
    if (
      !canPostToLocation(req, from_location_id) ||
      !canPostToLocation(req, to_location_id)
    ) {
      return res.status(403).json({
        success: false,
        message: "Not authorized to post to one or both locations",
      });
    }

    // postTransfer uses the tenant context established by tenant middleware.
    getTenantDb();

    const result = await intercompany.postTransfer({
      fromLocationId: Number(from_location_id),
      toLocationId: Number(to_location_id),
      amount,
      currency,
      date,
      memo,
      userId: req.user?.id,
    });

    await auditLog({
      userId: req.user?.id,
      userEmail: req.user?.email,
      action: "CREATE",
      entityType: "intercompany_transfers",
      entityId: result.id,
      newValues: result,
      ipAddress: req.ip,
    });

    return res.status(201).json({ success: true, data: result });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/intercompany/transfers
const listTransfers = async (req, res) => {
  try {
    if (!(await glPosting.glAvailable())) return notReady(res);

    const db = getTenantDb();
    const allowedLocationIds =
      req.scopeEnforced && Array.isArray(req.allowedLocationIds)
        ? req.allowedLocationIds
        : undefined;

    const data = await intercompany.listTransfers(
      { allowedLocationIds },
      db,
    );

    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { createTransfer, listTransfers };





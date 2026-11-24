
const {
  getTenantClient,
  getTenantId,
} = require("../config/tenantContext");

const auditLog = async ({
  tenantId,
  userId,
  userEmail,
  action,
  entityType,
  entityId,
  oldValues,
  newValues,
  ipAddress,
}) => {
  try {
    // 1. Get current tenant database client
    const db = getTenantClient();

    if (!db) {
      console.error(
        "Audit log skipped: Tenant database connection not found."
      );
      return;
    }

    // 2. Get tenant ID from current context
    const contextTenantId = Number(getTenantId());
    const suppliedTenantId = Number(tenantId);

    if (
      !Number.isInteger(contextTenantId) ||
      contextTenantId <= 0
    ) {
      console.error(
        "Audit log skipped: Tenant context is invalid."
      );
      return;
    }

    // 3. Verify supplied tenant matches current tenant
    if (
      Number.isInteger(suppliedTenantId) &&
      suppliedTenantId > 0 &&
      suppliedTenantId !== contextTenantId
    ) {
      console.error(
        "Audit log skipped: Tenant ID mismatch."
      );
      return;
    }

    // 4. Insert audit record using current tenant
    await db.query(
      `INSERT INTO audit_logs
       (
         tenant_id,
         user_id,
         user_email,
         action,
         entity_type,
         entity_id,
         old_values,
         new_values,
         ip_address
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        contextTenantId,
        userId || null,
        userEmail || null,
        action,
        entityType,
        entityId || null,
        oldValues ? JSON.stringify(oldValues) : null,
        newValues ? JSON.stringify(newValues) : null,
        ipAddress || null,
      ]
    );
  } catch (err) {
    console.error("Audit log error:", err.message);
  }
};

module.exports = { auditLog };

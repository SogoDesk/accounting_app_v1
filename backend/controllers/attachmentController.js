


const fs = require("fs");
const path = require("path");
const { getTenantClient } = require("../config/tenantContext");
const { canActOnEntity } = require("../middleware/scopeMiddleware");
const { STORAGE_DIR } = require("../middleware/uploadDocument");

const getTenantDb = () => {
  const db = getTenantClient();
  if (!db) throw new Error("Tenant database connection not found.");
  return db;
};

// Supported parent records. Candidates are region-agnostic but still tenant-scoped.
const ENTITY_CONFIG = {
  invoice: { table: "invoices", scoped: true },
  bill: { table: "bills", scoped: true },
  placement: { table: "placements", scoped: true },
  candidate: { table: "candidates", scoped: false },
  timesheet: { table: "timesheets", scoped: true, regionVia: "placement" },
};

const loadParent = async (db, entityType, entityId) => {
  const cfg = ENTITY_CONFIG[entityType];
  if (!cfg) return { error: "Invalid attachment type", status: 400 };

  if (entityType === "bill") {
  }

  if (cfg.regionVia === "placement") {
    const { rows } = await db.query(
      `SELECT t.id, p.region_id
         FROM ${cfg.table} t JOIN placements p ON t.placement_id = p.id
        WHERE t.id = $1`,
      [Number(entityId)],
    );
    if (!rows.length) return { error: "Record not found", status: 404 };
    return { parent: rows[0] };
  }

  const cols = cfg.scoped === false ? "id" : "id, region_id";
  const { rows } = await db.query(
    `SELECT ${cols} FROM ${cfg.table} WHERE id = $1`,
    [Number(entityId)],
  );
  if (!rows.length) return { error: "Record not found", status: 404 };
  return { parent: rows[0] };
};

// Copies attachments inside the active tenant database context.
const copyAttachments = async (db, fromType, fromId, toType, toId) => {
  const { rows } = await db.query(
    `SELECT file_name, stored_name, mime_type, file_size, uploaded_by
       FROM attachments WHERE entity_type = $1 AND entity_id = $2`,
    [fromType, Number(fromId)],
  );
  let copied = 0;
  for (const a of rows) {
    let storedName = a.stored_name;
    const src = safeStoredPath(a.stored_name);
    if (src && fs.existsSync(src)) {
      const ext = path.extname(a.stored_name);
      const candidate = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
      const destPath = safeStoredPath(candidate);
      try {
        fs.copyFileSync(src, destPath);
        storedName = candidate;
      } catch (_e) {
        // Fall back to sharing the original file.
      }
    }
    await db.query(
      `INSERT INTO attachments
         (entity_type, entity_id, file_name, stored_name, mime_type, file_size, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [toType, Number(toId), a.file_name, storedName, a.mime_type, a.file_size, a.uploaded_by],
    );
    copied += 1;
  }
  return copied;
};

const allowedForCaller = (req, parent) => {
  if (parent.region_id == null) return true;
  return !req.scopeEnforced || canActOnEntity(req, parent.region_id);
};

const safeStoredPath = (storedName) => {
  const baseDir = path.resolve(STORAGE_DIR);
  const filePath = path.resolve(baseDir, path.basename(String(storedName || "")));
  return filePath.startsWith(`${baseDir}${path.sep}`) ? filePath : null;
};

// POST /api/attachments/:entityType/:entityId
const uploadAttachments = async (req, res) => {
  try {
    const db = getTenantDb();
    const { entityType, entityId } = req.params;
    const { parent, error, status } = await loadParent(db, entityType, entityId);
    if (error) return res.status(status).json({ success: false, message: error });
    if (!allowedForCaller(req, parent)) {
      return res.status(403).json({ success: false, message: "Not permitted for this record" });
    }

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ success: false, message: "No files uploaded" });

    const inserted = [];
    for (const f of files) {
      const { rows } = await db.query(
        `INSERT INTO attachments
           (entity_type, entity_id, file_name, stored_name, mime_type, file_size, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, entity_type, entity_id, file_name, mime_type, file_size, created_at`,
        [entityType, Number(entityId), f.originalname, f.filename, f.mimetype, f.size, req.user?.id || null],
      );
      inserted.push(rows[0]);
    }
    return res.status(201).json({ success: true, data: inserted });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/attachments/:entityType/:entityId
const listAttachments = async (req, res) => {
  try {
    const db = getTenantDb();
    const { entityType, entityId } = req.params;
    const { parent, error, status } = await loadParent(db, entityType, entityId);
    if (error) return res.status(status).json({ success: false, message: error });
    if (!allowedForCaller(req, parent)) {
      return res.status(403).json({ success: false, message: "Not permitted for this record" });
    }
    const { rows } = await db.query(
      `SELECT id, entity_type, entity_id, file_name, mime_type, file_size, created_at
         FROM attachments
        WHERE entity_type = $1 AND entity_id = $2
        ORDER BY created_at, id`,
      [entityType, Number(entityId)],
    );
    return res.json({ success: true, data: rows });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/attachments/file/:id
const downloadAttachment = async (req, res) => {
  try {
    const db = getTenantDb();
    const { rows } = await db.query(`SELECT * FROM attachments WHERE id = $1`, [Number(req.params.id)]);
    if (!rows.length) return res.status(404).json({ success: false, message: "Attachment not found" });
    const att = rows[0];

    const { parent, error, status } = await loadParent(db, att.entity_type, att.entity_id);
    if (error) return res.status(status || 404).json({ success: false, message: "Parent record not found" });
    if (!allowedForCaller(req, parent)) {
      return res.status(403).json({ success: false, message: "Not permitted for this record" });
    }

    const filePath = safeStoredPath(att.stored_name);
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: "File no longer available" });
    }
    res.setHeader("Content-Disposition", `attachment; filename="${String(att.file_name).replace(/"/g, "")}"`);
    if (att.mime_type) res.setHeader("Content-Type", att.mime_type);
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

// DELETE /api/attachments/:id
const deleteAttachment = async (req, res) => {
  try {
    const db = getTenantDb();
    const { rows } = await db.query(`SELECT * FROM attachments WHERE id = $1`, [Number(req.params.id)]);
    if (!rows.length) return res.status(404).json({ success: false, message: "Attachment not found" });
    const att = rows[0];

    const { parent, error } = await loadParent(db, att.entity_type, att.entity_id);
    // Fail closed: do not delete an attachment if its parent cannot be verified.
    if (error) return res.status(404).json({ success: false, message: "Parent record not found" });
    if (!allowedForCaller(req, parent)) {
      return res.status(403).json({ success: false, message: "Not permitted for this record" });
    }

    await db.query(`DELETE FROM attachments WHERE id = $1`, [att.id]);
    const filePath = safeStoredPath(att.stored_name);
    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (_e) { /* best effort */ }
    }
    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = { uploadAttachments, listAttachments, downloadAttachment, deleteAttachment, copyAttachments };





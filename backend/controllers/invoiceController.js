// HTTP layer for invoices: read the request, call the service, shape the
// response, map errors to status codes. The work lives in services/invoices/.

const { getTenantClient } = require("../config/tenantContext");
const { auditLog } = require("../middleware/auditMiddleware");
const { requestScope } = require("../middleware/scopeMiddleware");
const { generateInvoicePdf } = require("../utils/invoicePdfGenerator");
const { getBranding } = require("../services/branding/brandingService");
const { sendReport } = require("../services/reports/reportExport");
const { sendError } = require("../utils/httpErrors");
const { withTransaction } = require("../services/shared/transaction");
const invoiceService = require("../services/invoices/invoiceService");
const invoiceQueries = require("../services/invoices/invoiceQueries");
const numbering = require("../services/invoices/numberingService");
const { validateInvoiceLineItems, normalizeInvoiceType } = require("../services/invoices/lineItemService");
const { sanitizeInvoiceRecord } = require("../services/invoices/invoiceValues");

const INVALID_DATE_MESSAGE =
  "Invalid date value in invoice date, due date, billing period, or line item date";

// The request's tenant connection, or a 500 if tenantMiddleware did not run.
const tenantDb = (res) => {
  const db = getTenantClient();
  if (!db) {
    res.status(500).json({ success: false, message: "Tenant database connection not found." });
  }
  return db;
};

const audit = (req, entry) =>
  auditLog({ userId: req.user?.id, userEmail: req.user?.email, ipAddress: req.ip, entityType: "invoices", ...entry });

const notFound = (res) => res.status(404).json({ success: false, message: "Invoice not found" });

const getAllInvoices = async (req, res) => {
  try {
    const result = await invoiceQueries.listInvoices(getTenantClient(), req.query, requestScope(req));
    return res.status(200).json({
      success: true,
      message: "Invoices fetched successfully",
      data: result.data,
      total: result.total,
      page: result.page,
      limit: result.limit,
      reporting_currency: result.reportingCcy,
      totals: result.totals,
      tab_counts: result.tabCounts,
    });
  } catch (error) {
    return sendError(res, error, { message: "Server error while fetching invoices", log: "getAllInvoices" });
  }
};

const getInvoiceById = async (req, res) => {
  try {
    const invoice = await invoiceQueries.getInvoiceDetail(getTenantClient(), req.params.id, requestScope(req));
    if (!invoice) return notFound(res);
    return res.status(200).json({ success: true, message: "Invoice fetched successfully", data: invoice });
  } catch (error) {
    return sendError(res, error, { message: "Server error while fetching invoice", log: "getInvoiceById" });
  }
};

const getInvoicePrintData = async (req, res) => {
  try {
    const db = getTenantClient();
    const invoice = await invoiceQueries.getInvoiceDetail(db, req.params.id, requestScope(req));
    if (!invoice) return notFound(res);
    const payments = await invoiceQueries.listInvoicePayments(db, req.params.id);
    return res.status(200).json({
      success: true,
      message: "Invoice print data fetched successfully",
      data: { ...invoice, payments },
    });
  } catch (error) {
    return sendError(res, error, { message: "Server error while fetching invoice print data", log: "getInvoicePrintData" });
  }
};

const downloadInvoicePdf = async (req, res) => {
  try {
    const db = getTenantClient();
    const invoice = await invoiceQueries.getInvoiceDetail(db, req.params.id, requestScope(req));
    if (!invoice) return notFound(res);
    return await generateInvoicePdf(invoice, res, await getBranding(db, invoice.region_id));
  } catch (error) {
    return sendError(res, error, { message: "Server error while generating invoice PDF", log: "downloadInvoicePdf" });
  }
};

const getInvoicePlacementOptions = async (req, res) => {
  try {
    const data = await invoiceQueries.listPlacementOptions(getTenantClient());
    return res.status(200).json({ success: true, message: "Invoice placement options fetched successfully", data });
  } catch (error) {
    return sendError(res, error, { message: "Server error while fetching placement options", log: "getInvoicePlacementOptions" });
  }
};

// Draws (and so uses up) the next number in the requested series.
const getNextInvoiceNumberPreview = async (req, res) => {
  try {
    const invoiceNumber = await numbering.nextInvoiceNumber(getTenantClient(), {
      intercompany: numbering.isIntercompanyType(req.query.type),
    });
    return res.status(200).json({
      success: true,
      message: "Invoice number preview fetched successfully",
      data: { invoice_number: invoiceNumber },
    });
  } catch (error) {
    return sendError(res, error, { message: "Server error while generating invoice number preview", log: "getNextInvoiceNumberPreview" });
  }
};

const createInvoice = async (req, res) => {
  const db = tenantDb(res);
  if (!db) return undefined;
  try {
    const created = await withTransaction(db, () =>
      invoiceService.createInvoice(db, req.body, requestScope(req)),
    );
    await audit(req, {
      action: "CREATE",
      entityId: created.invoice.id,
      newValues: await invoiceQueries.getInvoiceRow(db, created.invoice.id),
    });
    return res.status(201).json({
      success: true,
      message: "Invoice created successfully",
      data: {
        ...sanitizeInvoiceRecord(created.invoice),
        line_items: created.lineItems,
        tax_lines: created.taxLines,
      },
    });
  } catch (error) {
    return sendError(res, error, {
      message: "Server error while creating invoice",
      log: "createInvoice",
      invalidDateMessage: INVALID_DATE_MESSAGE,
    });
  }
};

const updateInvoice = async (req, res) => {
  const db = tenantDb(res);
  if (!db) return undefined;
  try {
    const updated = await withTransaction(db, () =>
      invoiceService.updateInvoice(db, req.params.id, req.body, requestScope(req)),
    );
    await audit(req, {
      action: "UPDATE",
      entityId: Number(req.params.id),
      oldValues: updated.previous,
      newValues: updated.invoice,
    });
    return res.status(200).json({
      success: true,
      message: "Invoice updated successfully",
      data: {
        ...sanitizeInvoiceRecord(updated.invoice),
        line_items: updated.lineItems,
        tax_lines: updated.taxLines,
      },
    });
  } catch (error) {
    return sendError(res, error, {
      message: "Server error while updating invoice",
      log: "updateInvoice",
      invalidDateMessage: INVALID_DATE_MESSAGE,
    });
  }
};

const updateInvoiceStatus = async (req, res) => {
  const db = tenantDb(res);
  if (!db) return undefined;
  try {
    const changed = await withTransaction(db, () =>
      invoiceService.updateInvoiceStatus(db, req.params.id, req.body, requestScope(req)),
    );
    await audit(req, {
      action: "UPDATE_STATUS",
      entityId: Number(req.params.id),
      oldValues: changed.previous,
      newValues: changed.invoice,
    });
    return res.status(200).json({
      success: true,
      message: "Invoice status updated successfully",
      data: sanitizeInvoiceRecord(changed.invoice),
    });
  } catch (error) {
    return sendError(res, error, { message: "Server error while updating invoice status", log: "updateInvoiceStatus" });
  }
};

const deleteInvoice = async (req, res) => {
  const db = tenantDb(res);
  if (!db) return undefined;
  try {
    const deleted = await withTransaction(db, () =>
      invoiceService.deleteInvoice(db, req.params.id, requestScope(req)),
    );
    await audit(req, { action: "DELETE", entityId: Number(req.params.id), oldValues: deleted.previous });
    return res.status(200).json({ success: true, message: "Invoice deleted successfully" });
  } catch (error) {
    return sendError(res, error, { message: "Server error while deleting invoice", log: "deleteInvoice" });
  }
};

// GET /api/invoices/export?format=xlsx&from=&to=&status=&scope=&region_id=&search=
// status = derived display status; scope = outstanding|overdue|collected|sent.
const exportInvoices = async (req, res) => {
  try {
    const report = await invoiceQueries.buildInvoiceExport(getTenantClient(), req.query, requestScope(req));
    return await sendReport(res, report, req.query.format || "xlsx");
  } catch (error) {
    return sendError(res, error, { message: "Failed to export invoices" });
  }
};

module.exports = {
  getAllInvoices,
  exportInvoices,
  getInvoiceById,
  getInvoicePrintData,
  getInvoicePlacementOptions,
  getNextInvoiceNumberPreview,
  createInvoice,
  updateInvoice,
  updateInvoiceStatus,
  deleteInvoice,
  downloadInvoicePdf,
  // Not route handlers; kept on the controller for existing callers. New code
  // should import them from services/invoices/ directly.
  syncInvoiceGl: invoiceService.syncInvoiceGl,
  validateInvoiceLineItems,
  normalizeInvoiceType,
};

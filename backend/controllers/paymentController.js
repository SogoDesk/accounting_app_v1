// HTTP layer for customer payments: read the request, call the service, shape
// the response, map errors to status codes. The work lives in services/payments/.

const { getTenantClient } = require("../config/tenantContext");
const { auditLog } = require("../middleware/auditMiddleware");
const { requestScope } = require("../middleware/scopeMiddleware");
const { generatePaymentCode, generatePaymentReference } = require("../utils/codeGenerator");
const { sendReport } = require("../services/reports/reportExport");
const { sendError } = require("../utils/httpErrors");
const { withTransaction } = require("../services/shared/transaction");
const paymentService = require("../services/payments/paymentService");
const paymentQueries = require("../services/payments/paymentQueries");

// Every handler needs the request's tenant connection.
const withDb = (handler) => async (req, res) => {
  const db = getTenantClient();
  if (!db) return res.status(500).json({ success: false, message: "Tenant database connection not found." });
  return handler(req, res, db);
};

const audit = (req, entry) =>
  auditLog({ userId: req.user?.id, userEmail: req.user?.email, ipAddress: req.ip, entityType: "PAYMENT", ...entry });

const getAllPayments = withDb(async (req, res, db) => {
  try {
    const { rows, reportingCcy } = await paymentQueries.listPayments(db, req.query, requestScope(req));
    return res.json({ success: true, data: rows, reporting_currency: reportingCcy });
  } catch (error) {
    return sendError(res, error, { message: "Failed to fetch payments" });
  }
});

const getPaymentById = withDb(async (req, res, db) => {
  try {
    const payment = await paymentQueries.getPayment(db, req.params.id, requestScope(req));
    if (!payment) return res.status(404).json({ success: false, message: "Payment not found" });
    return res.json({ success: true, data: payment });
  } catch (error) {
    return sendError(res, error, { message: "Failed to fetch payment" });
  }
});

const getPaymentInvoiceOptions = withDb(async (req, res, db) => {
  try {
    return res.json({ success: true, data: await paymentQueries.listInvoiceOptions(db) });
  } catch (error) {
    return sendError(res, error, { message: "Failed to load invoice options" });
  }
});

// Draws (and so uses up) the next payment code and reference number.
const getNextPaymentCode = withDb(async (req, res, db) => {
  try {
    return res.json({
      success: true,
      data: { payment_code: await generatePaymentCode(db), reference_number: await generatePaymentReference(db) },
    });
  } catch (error) {
    return sendError(res, error, { message: "Failed to generate next payment code" });
  }
});

const createPayment = withDb(async (req, res, db) => {
  try {
    const created = await withTransaction(db, () =>
      paymentService.createPayment(db, req.body, requestScope(req)),
    );
    await audit(req, { action: "CREATE_PAYMENT", entityId: created.payment.id, newValues: created.payments });
    return res.status(201).json({
      success: true,
      message: "Payment created successfully",
      data: { payment: created.payment, payments: created.payments, invoices: created.invoices },
    });
  } catch (error) {
    return sendError(res, error, { message: "Failed to create payment" });
  }
});

const updatePayment = withDb(async (req, res, db) => {
  const paymentId = Number(req.params.id);
  try {
    const updated = await withTransaction(db, () =>
      paymentService.updatePayment(db, paymentId, req.body, requestScope(req)),
    );
    await audit(req, { action: "UPDATE_PAYMENT", entityId: paymentId, oldValues: updated.previous, newValues: updated.payment });
    return res.json({
      success: true,
      message: "Payment updated successfully",
      data: { payment: updated.payment, invoice: updated.invoice },
    });
  } catch (error) {
    return sendError(res, error, { message: "Failed to update payment" });
  }
});

const deletePayment = withDb(async (req, res, db) => {
  const paymentId = Number(req.params.id);
  try {
    const deleted = await withTransaction(db, () =>
      paymentService.deletePayment(db, paymentId, requestScope(req)),
    );
    await audit(req, { action: "DELETE_PAYMENT", entityId: paymentId, oldValues: deleted.previous, newValues: null });
    return res.json({ success: true, message: "Payment deleted successfully", data: { invoice: deleted.invoice } });
  } catch (error) {
    return sendError(res, error, { message: "Failed to delete payment" });
  }
});

const exportPayments = withDb(async (req, res, db) => {
  try {
    const report = await paymentQueries.buildPaymentExport(db, req.query, requestScope(req));
    return await sendReport(res, report, req.query.format || "xlsx");
  } catch (error) {
    return sendError(res, error, { message: "Failed to export payments" });
  }
});

const downloadReceiptPdf = withDb(async (req, res, db) => {
  try {
    const payment = await paymentQueries.getPayment(db, req.params.id, requestScope(req));
    if (!payment) return res.status(404).json({ success: false, message: "Payment not found" });
    const { generatePaymentReceiptPdf } = require("../utils/paymentReceiptPdf");
    return generatePaymentReceiptPdf(payment, res);
  } catch (error) {
    return sendError(res, error, { message: "Failed to generate receipt" });
  }
});

module.exports = {
  getAllPayments,
  exportPayments,
  getPaymentById,
  downloadReceiptPdf,
  getPaymentInvoiceOptions,
  getNextPaymentCode,
  createPayment,
  updatePayment,
  deletePayment,
};

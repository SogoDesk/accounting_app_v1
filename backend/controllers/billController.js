


const { getTenantClient } = require("../config/tenantContext");
const { auditLog } = require("../middleware/auditMiddleware");
const { generateBillNumber } = require("../utils/codeGenerator");
const glPosting = require("../services/gl/postingService");
const { canActOnEntity } = require("../middleware/scopeMiddleware");
const { sendReport } = require("../services/reports/reportExport");
const { convertToUsd } = require("../utils/fx");
const { groupCurrency, attachReportingFields } = require("../utils/reportingCurrency");

const getTenantDb = () => {
  const db = getTenantClient();
  if (!db) throw new Error("Tenant database connection not found.");
  return db;
};

const billPaymentStatus = (row) => {
  if (String(row?.bill_status || "").toUpperCase() === "CANCELLED") return "CANCELLED";
  const total = Number(row?.total_amount || 0);
  const outstanding = Number(row?.balance_outstanding || 0);
  const paid = Math.max(total - outstanding, 0);
  if (total > 0 && outstanding <= 0.005) return "PAID";
  if (paid > 0.005) return "PARTIALLY_PAID";
  return "UNPAID";
};

const ALLOWED_BILL_STATUSES = new Set(["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "PARTIALLY_PAID", "PAID", "OVERDUE", "CANCELLED"]);
const ALLOWED_APPROVAL_STATUSES = new Set(["NOT_SUBMITTED", "PENDING", "APPROVED", "REJECTED"]);
const toMoney = (value) => { const n = Number(value || 0); return Number.isNaN(n) ? 0 : n; };
const toNullable = (value) => value === undefined || value === null || value === "" ? null : value;
const sanitizeDate = (value) => {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
const sanitizeTaxLines = (taxLines = []) => !Array.isArray(taxLines) ? [] : taxLines
  .filter((line) => String(line?.tax_name || "").trim() || toMoney(line?.tax_percent) > 0)
  .map((line, i) => ({ id: i + 1, tax_name: String(line.tax_name || "Tax").trim(), tax_percent: toMoney(line.tax_percent), tax_amount: toMoney(line.tax_amount) }));

const normalizeLineItems = (lineItems = []) => {
  if (!Array.isArray(lineItems) || !lineItems.length) throw new Error("At least one bill line item is required");
  const normalized = lineItems.map((item) => {
    const description = String(item.description || "").trim();
    const quantity = toMoney(item.quantity || 1);
    const unitPrice = toMoney(item.unit_price ?? item.rate);
    if (!description) return null;
    const qty = quantity > 0 ? quantity : 1;
    return { description, quantity: qty, unit_price: unitPrice, line_total: Number((qty * unitPrice).toFixed(2)), expense_category: toNullable(item.expense_category), cost_center: toNullable(item.cost_center) };
  }).filter(Boolean);
  if (!normalized.length) throw new Error("At least one valid bill line item is required");
  return normalized;
};
const computeAmounts = (items, taxLines = []) => {
  const subtotal = items.reduce((s, x) => s + toMoney(x.line_total), 0);
  const computedTaxLines = sanitizeTaxLines(taxLines.map((x) => ({ ...x, tax_amount: Number(((subtotal * toMoney(x.tax_percent)) / 100).toFixed(2)) })));
  const taxAmount = computedTaxLines.reduce((s, x) => s + toMoney(x.tax_amount), 0);
  return { subtotal: Number(subtotal.toFixed(2)), taxAmount: Number(taxAmount.toFixed(2)), totalAmount: Number((subtotal + taxAmount).toFixed(2)), computedTaxLines };
};
const deriveBillStatus = ({ currentStatus, approvalStatus, totalAmount, paidAmount, dueDate }) => {
  const current = String(currentStatus || "").toUpperCase();
  if (current === "CANCELLED") return "CANCELLED";
  if (toMoney(totalAmount) > 0 && toMoney(paidAmount) >= toMoney(totalAmount)) return "PAID";
  if (toMoney(paidAmount) > 0 && toMoney(paidAmount) < toMoney(totalAmount)) return "PARTIALLY_PAID";
  const approval = String(approvalStatus || "").toUpperCase();
  if (approval === "REJECTED") return "REJECTED";
  if (approval === "PENDING") return "SUBMITTED";
  if (approval === "APPROVED") {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const due = dueDate ? new Date(dueDate) : null;
    if (due && !Number.isNaN(due.getTime())) { due.setHours(0, 0, 0, 0); if (due < today) return "OVERDUE"; }
    return "APPROVED";
  }
  return current || "DRAFT";
};
const getApprovalHistory = async (db, billId) => (await db.query(
  `SELECT ba.*, u.full_name AS acted_by_name FROM bill_approvals ba LEFT JOIN users u ON u.id = ba.acted_by WHERE ba.bill_id = $1 ORDER BY ba.id ASC`, [billId])).rows;
const getBillItems = async (db, billId) => (await db.query(`SELECT * FROM bill_items WHERE bill_id = $1 ORDER BY id ASC`, [billId])).rows;
const mapBill = async (db, row) => {
  const [items, approvals] = await Promise.all([getBillItems(db, row.id), getApprovalHistory(db, row.id)]);
  return { ...row, line_items: items, tax_lines: Array.isArray(row.tax_lines_json) ? row.tax_lines_json : [], approval_history: approvals };
};
const recalculateBillBalances = async (db, billId) => {
  const b = await db.query(`SELECT * FROM bills WHERE id = $1 LIMIT 1`, [billId]);
  if (!b.rows.length) throw new Error("Bill not found");
  const bill = b.rows[0];
  const p = await db.query(`SELECT COALESCE(SUM(amount_paid),0) AS paid_amount FROM vendor_payments WHERE bill_id = $1`, [billId]);
  const paid = toMoney(p.rows[0]?.paid_amount);
  const balance = Math.max(toMoney(bill.total_amount) - paid, 0);
  const status = deriveBillStatus({ currentStatus: bill.bill_status, approvalStatus: bill.approval_status, totalAmount: bill.total_amount, paidAmount: paid, dueDate: bill.due_date });
  return (await db.query(`UPDATE bills SET payment_paid_amount=$1,balance_outstanding=$2,bill_status=$3,updated_at=CURRENT_TIMESTAMP WHERE id=$4 RETURNING *`, [paid, balance, status, billId])).rows[0];
};

const getAllBills = async (req, res) => {
  try {
    const db = getTenantDb();
    const { status, approval_status, vendor_id, region_id, search } = req.query;
    const conditions = ["b.deleted_at IS NULL"], values = []; let idx = 1;
    if (status) { conditions.push(`b.bill_status=$${idx++}`); values.push(String(status).toUpperCase()); }
    if (approval_status) { conditions.push(`b.approval_status=$${idx++}`); values.push(String(approval_status).toUpperCase()); }
    if (vendor_id) { conditions.push(`b.vendor_id=$${idx++}`); values.push(Number(vendor_id)); }
    if (region_id) { conditions.push(`b.region_id=$${idx++}`); values.push(Number(region_id)); }
    if (req.scopeEnforced && Array.isArray(req.allowedEntityIds)) { conditions.push(`b.region_id=ANY($${idx++})`); values.push(req.allowedEntityIds); }
    if (search) { conditions.push(`(b.bill_number ILIKE $${idx} OR v.vendor_name ILIKE $${idx} OR COALESCE(b.external_reference,'') ILIKE $${idx})`); values.push(`%${search}%`); idx++; }
    const result = await db.query(`SELECT b.*,v.vendor_name,v.vendor_code,r.region_name,COUNT(bi.id)::int AS line_items_count
      FROM bills b JOIN vendors v ON v.id=b.vendor_id JOIN regions r ON r.id=b.region_id LEFT JOIN bill_items bi ON bi.bill_id=b.id
      WHERE ${conditions.join(" AND ")} GROUP BY b.id,v.vendor_name,v.vendor_code,r.region_name ORDER BY b.bill_date DESC,b.id DESC`, values);
    const reportingCcy = await groupCurrency(db);
    await attachReportingFields(result.rows, { total_amount: "total_amount_reporting", balance_outstanding: "balance_outstanding_reporting" }, { db, reportingCcy });
    return res.json({ success: true, data: result.rows, reporting_currency: reportingCcy });
  } catch (e) { return res.status(500).json({ success: false, message: "Failed to fetch bills", error: e.message }); }
};
const getBillById = async (req, res) => {
  try {
    const db = getTenantDb();
    const result = await db.query(`SELECT b.*,v.vendor_name,v.vendor_code,r.region_name FROM bills b JOIN vendors v ON v.id=b.vendor_id JOIN regions r ON r.id=b.region_id WHERE b.id=$1 AND b.deleted_at IS NULL LIMIT 1`, [req.params.id]);
    if (!result.rows.length || !canActOnEntity(req, result.rows[0].region_id)) return res.status(404).json({ success: false, message: "Bill not found" });
    return res.json({ success: true, data: await mapBill(db, result.rows[0]) });
  } catch (e) { return res.status(500).json({ success: false, message: "Failed to fetch bill", error: e.message }); }
};
const upsertBillItems = async (db, id, items) => {
  await db.query(`DELETE FROM bill_items WHERE bill_id=$1`, [id]);
  for (const x of items) await db.query(`INSERT INTO bill_items(bill_id,description,quantity,unit_price,line_total,expense_category,cost_center) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [id, x.description, x.quantity, x.unit_price, x.line_total, toNullable(x.expense_category), toNullable(x.cost_center)]);
};
const createBill = async (req, res) => {
  let db;
  try {
    db = getTenantDb();
    const { bill_number, vendor_id, region_id, bill_date, due_date, service_period_start, service_period_end, currency, invoice_reference, external_reference, notes, tax_lines = [], line_items = [] } = req.body;
    if (!vendor_id || !region_id || !bill_date || !due_date) return res.status(400).json({ success: false, message: "Vendor, region, bill date, and due date are required" });
    if (!canActOnEntity(req, region_id)) return res.status(403).json({ success: false, message: "Not authorized for this entity (region)" });
    const items = normalizeLineItems(line_items), amounts = computeAmounts(items, Array.isArray(tax_lines) ? tax_lines : []);
    const billNo = bill_number?.trim() ? bill_number.trim().toUpperCase() : await generateBillNumber(db);
    if ((await db.query(`SELECT id FROM bills WHERE bill_number=$1 LIMIT 1`, [billNo])).rows.length) return res.status(400).json({ success: false, message: "Bill number already exists" });
    await db.query("BEGIN");
    const header = (await db.query(`INSERT INTO bills(bill_number,vendor_id,region_id,bill_date,due_date,service_period_start,service_period_end,subtotal,tax_amount,total_amount,currency,bill_status,approval_status,payment_paid_amount,balance_outstanding,invoice_reference,external_reference,notes,tax_lines_json,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'DRAFT','NOT_SUBMITTED',0,$10,$12,$13,$14,$15,$16) RETURNING *`,
      [billNo, Number(vendor_id), Number(region_id), sanitizeDate(bill_date), sanitizeDate(due_date), sanitizeDate(service_period_start), sanitizeDate(service_period_end), amounts.subtotal, amounts.taxAmount, amounts.totalAmount, String(currency || "USD").toUpperCase(), toNullable(invoice_reference), toNullable(external_reference), toNullable(notes), JSON.stringify(amounts.computedTaxLines), req.user?.id || null])).rows[0];
    await upsertBillItems(db, header.id, items); await db.query("COMMIT");
    await auditLog({ userId:req.user?.id,userEmail:req.user?.email,action:"CREATE",entityType:"bills",entityId:header.id,newValues:header,ipAddress:req.ip });
    return res.status(201).json({ success:true,message:"Bill created",data:await mapBill(db,header) });
  } catch (e) { try { if (db) await db.query("ROLLBACK"); } catch (_) {} return res.status(500).json({ success:false,message:e.message || "Failed to create bill",error:e.message }); }
};
const syncBillGl = async (db, bill, userId, mode) => {
  if (!(await glPosting.glAvailable(db))) return;
  const posted = await glPosting.postedEntryIds("AP_BILL", bill.id, db), postable = String(bill.approval_status || "").toUpperCase() === "APPROVED";
  const reverse = async (reason) => { for (const entry of posted) await glPosting.reverseEntry(db, entry.id, reason, userId); };
  if (mode === "cancel") { await reverse("Bill deleted"); return; }
  if (mode === "repost") { await reverse("Bill edited"); if (postable) await glPosting.postBillEntered(db, bill); return; }
  if (!posted.length && postable) await glPosting.postBillEntered(db, bill);
};
const updateBill = async (req, res) => {
  let db;
  try {
    db = getTenantDb();
    const id = Number(req.params.id);
    const er = await db.query(`SELECT * FROM bills WHERE id=$1 AND deleted_at IS NULL LIMIT 1`, [id]);
    if (!er.rows.length || !canActOnEntity(req, er.rows[0].region_id)) return res.status(404).json({ success:false,message:"Bill not found" });
    const existing = er.rows[0];
    if (["PAID","CANCELLED"].includes(String(existing.bill_status || "").toUpperCase())) return res.status(400).json({ success:false,message:"Paid or cancelled bills cannot be edited" });
    const p=req.body;
    if (p.region_id != null && !canActOnEntity(req,p.region_id)) return res.status(403).json({ success:false,message:"Not authorized to assign bills to this region" });
    const items=normalizeLineItems(p.line_items || []), a=computeAmounts(items,Array.isArray(p.tax_lines)?p.tax_lines:[]);
    const billNo=p.bill_number?.trim()?p.bill_number.trim().toUpperCase():existing.bill_number;
    if ((await db.query(`SELECT id FROM bills WHERE bill_number=$1 AND id<>$2 LIMIT 1`,[billNo,id])).rows.length) return res.status(400).json({success:false,message:"Bill number already exists"});
    await db.query("BEGIN");
    await db.query(`UPDATE bills SET bill_number=$1,vendor_id=$2,region_id=$3,bill_date=$4,due_date=$5,service_period_start=$6,service_period_end=$7,subtotal=$8,tax_amount=$9,total_amount=$10,currency=$11,invoice_reference=$12,external_reference=$13,notes=$14,tax_lines_json=$15,balance_outstanding=GREATEST($10-COALESCE(payment_paid_amount,0),0),updated_at=CURRENT_TIMESTAMP WHERE id=$16 RETURNING *`,
      [billNo,Number(p.vendor_id),Number(p.region_id),sanitizeDate(p.bill_date),sanitizeDate(p.due_date),sanitizeDate(p.service_period_start),sanitizeDate(p.service_period_end),a.subtotal,a.taxAmount,a.totalAmount,String(p.currency||existing.currency||"USD").toUpperCase(),toNullable(p.invoice_reference),toNullable(p.external_reference),toNullable(p.notes),JSON.stringify(a.computedTaxLines),id]);
    await upsertBillItems(db,id,items); const updated=await recalculateBillBalances(db,id); await syncBillGl(db,updated,req.user?.id||null,"repost"); await db.query("COMMIT");
    await auditLog({userId:req.user?.id,userEmail:req.user?.email,action:"UPDATE",entityType:"bills",entityId:id,oldValues:existing,newValues:updated,ipAddress:req.ip});
    return res.json({success:true,message:"Bill updated",data:await mapBill(db,updated)});
  } catch(e) { try { if (db) await db.query("ROLLBACK"); } catch (_) {} return res.status(500).json({success:false,message:e.message||"Failed to update bill",error:e.message}); }
};
const updateBillStatus = async (req,res) => {
  try {
    const db=getTenantDb();
    const id=Number(req.params.id), requested=String(req.body.status||req.body.bill_status||"").toUpperCase(), comments=toNullable(req.body.comments);
    if(!ALLOWED_BILL_STATUSES.has(requested)) return res.status(400).json({success:false,message:"Invalid bill status"});
    const er=await db.query(`SELECT * FROM bills WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,[id]);
    if(!er.rows.length||!canActOnEntity(req,er.rows[0].region_id)) return res.status(404).json({success:false,message:"Bill not found"});
    const existing=er.rows[0]; let approval=existing.approval_status, approvedBy=existing.approved_by, approvedAt=existing.approved_at;
    if(requested==="SUBMITTED") approval="PENDING";
    if(requested==="APPROVED"){approval="APPROVED";approvedBy=req.user?.id||null;approvedAt=new Date();}
    if(requested==="REJECTED") approval="REJECTED";
    if(!ALLOWED_APPROVAL_STATUSES.has(String(approval).toUpperCase())) approval="NOT_SUBMITTED";
    await db.query("BEGIN");
    await db.query(`UPDATE bills SET bill_status=$1,approval_status=$2,approved_by=$3,approved_at=$4,updated_at=CURRENT_TIMESTAMP WHERE id=$5 RETURNING *`,[requested,approval,approvedBy,approvedAt,id]);
    const step=Number((await db.query(`SELECT COALESCE(MAX(step_no),0)+1 AS next_step FROM bill_approvals WHERE bill_id=$1`,[id])).rows[0]?.next_step||1);
    await db.query(`INSERT INTO bill_approvals(bill_id,step_no,action,comments,acted_by) VALUES($1,$2,$3,$4,$5)`,[id,step,requested,comments,req.user?.id||null]);
    const updated=await recalculateBillBalances(db,id); await syncBillGl(db,updated,req.user?.id||null,"repost"); await db.query("COMMIT");
    await auditLog({userId:req.user?.id,userEmail:req.user?.email,action:"UPDATE_STATUS",entityType:"bills",entityId:id,oldValues:existing,newValues:updated,ipAddress:req.ip});
    return res.json({success:true,message:"Bill status updated",data:await mapBill(db,updated)});
  } catch(e) {try { if (db) await db.query("ROLLBACK"); } catch (_) {} return res.status(500).json({success:false,message:"Failed to update bill status",error:e.message});}
};
const deleteBill = async (req,res) => {
  try {
    const db=getTenantDb();
    const id=Number(req.params.id);
    const er=await db.query(`SELECT * FROM bills WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,[id]);
    if(!er.rows.length||!canActOnEntity(req,er.rows[0].region_id)) return res.status(404).json({success:false,message:"Bill not found"});
    if(Number((await db.query(`SELECT COUNT(*)::int AS count FROM vendor_payments WHERE bill_id=$1`,[id])).rows[0]?.count||0)>0) return res.status(400).json({success:false,message:"Cannot delete bill with linked payments"});
    await db.query("BEGIN"); await syncBillGl(db,er.rows[0],req.user?.id||null,"cancel");
    const result=await db.query(`UPDATE bills SET deleted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=$1 AND deleted_at IS NULL RETURNING *`,[id]);
    if(!result.rows.length){await db.query("ROLLBACK");return res.status(404).json({success:false,message:"Bill not found"});}
    await db.query("COMMIT");
    await auditLog({userId:req.user?.id,userEmail:req.user?.email,action:"DELETE",entityType:"bills",entityId:id,oldValues:result.rows[0],ipAddress:req.ip});
    return res.json({success:true,message:"Bill deleted"});
  } catch(e){try { if (db) await db.query("ROLLBACK"); } catch (_) {} return res.status(500).json({success:false,message:"Failed to delete bill",error:e.message});}
};
const exportBills = async (req,res) => {
  try {
    const db=getTenantDb();
    const {status,approval_status,vendor_id,region_id,search,from,to}=req.query;
    const conditions=["b.deleted_at IS NULL"],values=[];let idx=1;
    if(approval_status){conditions.push(`b.approval_status=$${idx++}`);values.push(String(approval_status).toUpperCase());}
    if(vendor_id){conditions.push(`b.vendor_id=$${idx++}`);values.push(Number(vendor_id));}
    if(region_id){conditions.push(`b.region_id=$${idx++}`);values.push(Number(region_id));}
    if(from){conditions.push(`b.bill_date>=$${idx++}`);values.push(from);}
    if(to){conditions.push(`b.bill_date<=$${idx++}`);values.push(to);}
    if(req.scopeEnforced&&Array.isArray(req.allowedEntityIds)){conditions.push(`b.region_id=ANY($${idx++})`);values.push(req.allowedEntityIds);}
    if(search){conditions.push(`(b.bill_number ILIKE $${idx} OR v.vendor_name ILIKE $${idx} OR COALESCE(b.external_reference,'') ILIKE $${idx})`);values.push(`%${search}%`);idx++;}
    const result=await db.query(`SELECT b.*,v.vendor_name,r.region_name FROM bills b JOIN vendors v ON v.id=b.vendor_id JOIN regions r ON r.id=b.region_id WHERE ${conditions.join(" AND ")} ORDER BY b.bill_date DESC,b.id DESC`,values);
    const wanted=status?String(status).toUpperCase():"",cache=new Map();let totalUsd=0;const rows=[];
    for(const r of result.rows){const ps=billPaymentStatus(r);if(wanted&&ps!==wanted)continue;const usd=await convertToUsd(r.total_amount,r.currency,cache);totalUsd+=usd;rows.push({bill_date:String(r.bill_date).slice(0,10),bill_number:r.bill_number,vendor_name:r.vendor_name,region_name:r.region_name,due_date:r.due_date?String(r.due_date).slice(0,10):"",currency:r.currency,total_amount:Number(r.total_amount||0),balance_outstanding:Number(r.balance_outstanding||0),total_usd:usd,payment_status:ps,approval_status:r.approval_status});}
    const range=(from||to)?`${from||"…"} to ${to||"…"}`:"All dates";
    return await sendReport(res,{title:"Bills",subtitle:`${range} · ${rows.length} bill(s) · total in USD (consolidated)`,columns:[
      {key:"bill_date",label:"Date",type:"text"},{key:"bill_number",label:"Bill #",type:"text"},{key:"vendor_name",label:"Vendor",type:"text"},{key:"region_name",label:"Location",type:"text"},{key:"due_date",label:"Due",type:"text"},{key:"currency",label:"Currency",type:"text"},{key:"total_amount",label:"Total",type:"money"},{key:"balance_outstanding",label:"Outstanding",type:"money"},{key:"total_usd",label:"Total (USD)",type:"money"},{key:"payment_status",label:"Payment",type:"text"},{key:"approval_status",label:"Approval",type:"text"}],rows,totals:{total_usd:Math.round(totalUsd*100)/100}},req.query.format||"xlsx");
  } catch(e){return res.status(500).json({success:false,message:"Failed to export bills",error:e.message});}
};
const downloadBillPdf = async (req,res) => {
  try {
    const db=getTenantDb();
    const result=await db.query(`SELECT b.*,v.vendor_name,v.vendor_code,r.region_name FROM bills b JOIN vendors v ON v.id=b.vendor_id JOIN regions r ON r.id=b.region_id WHERE b.id=$1 AND b.deleted_at IS NULL LIMIT 1`,[req.params.id]);
    if(!result.rows.length||!canActOnEntity(req,result.rows[0].region_id)) return res.status(404).json({success:false,message:"Bill not found"});
    const bill=await mapBill(db,result.rows[0]);const {generateBillPdf}=require("../utils/billPdf");return generateBillPdf(bill,res);
  } catch(e){return res.status(500).json({success:false,message:"Failed to generate bill PDF",error:e.message});}
};
module.exports={getAllBills,exportBills,getBillById,downloadBillPdf,createBill,updateBill,updateBillStatus,deleteBill,recalculateBillBalances};





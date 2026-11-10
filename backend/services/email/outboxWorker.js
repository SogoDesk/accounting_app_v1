const pool = require("../../config/db");
const mailer = require("./mailer");
const invoiceQuery = require("./invoiceQuery");
const { renderInvoicePdfBuffer, invoicePdfFileName } = require("../../utils/invoicePdfGenerator");
const { ensureEmailSchema } = require("../../modules/email/ensureEmailSchema");

const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 20;

async function claimBatch(limit) {
  const { rows } = await pool.query(
    `UPDATE email_outbox
        SET status = 'SENDING'
      WHERE id IN (
        SELECT id FROM email_outbox
         WHERE status = 'QUEUED' AND attempts < $1
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT $2
      )
      RETURNING *`,
    [MAX_ATTEMPTS, limit],
  );
  return rows;
}

async function attachmentsFor(row) {
  if (!row.attach_pdf || !row.invoice_id) return [];
  const invoice = await invoiceQuery.byId(row.invoice_id);
  if (!invoice) return [];
  return [{
    filename: invoicePdfFileName(invoice),
    content: await renderInvoicePdfBuffer(invoice),
    contentType: "application/pdf",
  }];
}

async function deliver(row) {
  try {
    const result = await mailer.send({
      to: row.to_email,
      subject: row.subject,
      html: row.body_html,
      attachments: await attachmentsFor(row),
    });
    await pool.query(
      `UPDATE email_outbox
          SET status='SENT', sent_at=now(), attempts=attempts+1, last_error=NULL
        WHERE id=$1`,
      [row.id],
    );
    return { id: row.id, sent: true, ...result };
  } catch (err) {
    const attempts = Number(row.attempts) + 1;
    const dead = attempts >= MAX_ATTEMPTS;
    await pool.query(
      `UPDATE email_outbox
          SET status=$1, attempts=$2, last_error=$3
        WHERE id=$4`,
      [dead ? "FAILED" : "QUEUED", attempts, String(err.message).slice(0, 500), row.id],
    );
    return { id: row.id, sent: false, error: err.message, dead };
  }
}

async function runOnce({ limit = BATCH_SIZE } = {}) {
  await ensureEmailSchema();
  const batch = await claimBatch(limit);
  if (!batch.length) return { claimed: 0, sent: 0, failed: 0, results: [] };

  const results = [];
  for (const row of batch) results.push(await deliver(row));

  return {
    claimed: batch.length,
    sent: results.filter((r) => r.sent).length,
    failed: results.filter((r) => !r.sent).length,
    results,
  };
}

let timer = null;

function start() {
  if (String(process.env.EMAIL_WORKER || "").toLowerCase() !== "on") return;
  const everyMs = Math.max(15, Number(process.env.EMAIL_WORKER_INTERVAL_SEC) || 60) * 1000;

  const tick = async () => {
    try {
      const out = await runOnce();
      if (out.claimed) {
        console.log(`[outboxWorker] sent ${out.sent}/${out.claimed} (${out.failed} failed)`);
      }
    } catch (err) {
      console.error("[outboxWorker] run failed:", err.message);
    }
  };

  timer = setInterval(tick, everyMs);
  if (timer.unref) timer.unref();
  console.log(`[outboxWorker] enabled (every ${everyMs / 1000}s, driver=${mailer.driver()})`);
}

function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { runOnce, start, stop, MAX_ATTEMPTS };

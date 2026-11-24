
const pool = require("../../config/db");
const { runWithTenant } = require("../../config/tenantContext");
const mailer = require("./mailer");
const invoiceQuery = require("./invoiceQuery");
const { renderInvoicePdfBuffer, invoicePdfFileName } = require("../../utils/invoicePdfGenerator");
const { ensureEmailSchema } = require("../../modules/email/ensureEmailSchema");

const MAX_ATTEMPTS = 3;
const BATCH_SIZE = 20;

async function claimBatch(limit, db = pool, tenantId) {
  const { rows } = await db.query(
    `UPDATE email_outbox
        SET status = 'SENDING'
      WHERE tenant_id = $3
        AND id IN (
          SELECT id
            FROM email_outbox
           WHERE tenant_id = $3
             AND status = 'QUEUED'
             AND attempts < $1
           ORDER BY id
           FOR UPDATE SKIP LOCKED
           LIMIT $2
      )
      RETURNING *`,
    [MAX_ATTEMPTS, limit, tenantId],
  );

  return rows;
}

async function attachmentsFor(row, db = pool) {
  if (!row.attach_pdf || !row.invoice_id) return [];

  const invoice = await invoiceQuery.byId(row.invoice_id, {}, db);
  if (!invoice) return [];

  return [{
    filename: invoicePdfFileName(invoice),
    content: await renderInvoicePdfBuffer(invoice),
    contentType: "application/pdf",
  }];
}

async function deliver(row, db = pool, tenantId) {
  try {
    const result = await mailer.send({
      to: row.to_email,
      subject: row.subject,
      html: row.body_html,
      attachments: await attachmentsFor(row, db),
    });

    await db.query(
      `UPDATE email_outbox
          SET status = 'SENT',
              sent_at = now(),
              attempts = attempts + 1,
              last_error = NULL
        WHERE id = $1 AND tenant_id = $2`,
      [row.id, tenantId],
    );

    return { id: row.id, sent: true, ...result };
  } catch (err) {
    const attempts = Number(row.attempts) + 1;
    const dead = attempts >= MAX_ATTEMPTS;

    await db.query(
      `UPDATE email_outbox
          SET status = $1,
              attempts = $2,
              last_error = $3
        WHERE id = $4 AND tenant_id = $5`,
      [
        dead ? "FAILED" : "QUEUED",
        attempts,
        String(err.message).slice(0, 500),
        row.id,
        tenantId,
      ],
    );

    return { id: row.id, sent: false, error: err.message, dead };
  }
}

async function runOnceForTenant(tenantId, { limit = BATCH_SIZE } = {}) {
  const client = await pool.connect();

  try {
    await client.query(
      `SELECT set_config('app.tenant_id', $1, false)`,
      [String(tenantId)],
    );

    return await runWithTenant(client, tenantId, async () => {
      await ensureEmailSchema(client, tenantId);

      const batch = await claimBatch(limit, client, tenantId);

      if (!batch.length) {
        return {
          tenantId,
          claimed: 0,
          sent: 0,
          failed: 0,
          results: [],
        };
      }

      const results = [];

      for (const row of batch) {
        results.push(await deliver(row, client, tenantId));
      }

      return {
        tenantId,
        claimed: batch.length,
        sent: results.filter((r) => r.sent).length,
        failed: results.filter((r) => !r.sent).length,
        results,
      };
    });
  } finally {
    try {
      await client.query(`SELECT set_config('app.tenant_id', '', false)`);
    } catch (err) {
      console.error(
        `[outboxWorker] tenant ${tenantId} context reset failed:`,
        err.message,
      );
    }

    client.release();
  }
}

async function runOnce({ limit = BATCH_SIZE } = {}) {
  const { rows: tenants } = await pool.query(
    `SELECT id
       FROM tenants
      WHERE UPPER(COALESCE(status, 'ACTIVE')) = 'ACTIVE'
      ORDER BY id`,
  );

  const results = [];

  for (const tenant of tenants) {
    try {
      const result = await runOnceForTenant(tenant.id, { limit });
      results.push(result);
    } catch (err) {
      console.error(
        `[outboxWorker] tenant ${tenant.id} failed:`,
        err.message,
      );

      results.push({
        tenantId: tenant.id,
        claimed: 0,
        sent: 0,
        failed: 0,
        error: err.message,
        results: [],
      });
    }
  }

  return {
    tenantsProcessed: results.length,
    claimed: results.reduce((total, r) => total + (r.claimed || 0), 0),
    sent: results.reduce((total, r) => total + (r.sent || 0), 0),
    failed: results.reduce((total, r) => total + (r.failed || 0), 0),
    results,
  };
}

let timer = null;

function start() {
  if (String(process.env.EMAIL_WORKER || "").toLowerCase() !== "on") {
    return;
  }

  const everyMs =
    Math.max(15, Number(process.env.EMAIL_WORKER_INTERVAL_SEC) || 60) * 1000;

  const tick = async () => {
    try {
      const out = await runOnce();

      if (out.claimed) {
        console.log(
          `[outboxWorker] processed ${out.claimed}: sent ${out.sent}, failed ${out.failed}`,
        );
      }
    } catch (err) {
      console.error("[outboxWorker] run failed:", err.message);
    }
  };

  timer = setInterval(tick, everyMs);

  if (timer.unref) timer.unref();

  tick();

  console.log(
    `[outboxWorker] enabled (every ${everyMs / 1000}s, driver=${mailer.driver()})`,
  );
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  runOnce,
  runOnceForTenant,
  start,
  stop,
  MAX_ATTEMPTS,
};

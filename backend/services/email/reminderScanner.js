
const pool = require("../../config/db");
const { runWithTenant } = require("../../config/tenantContext");
const dispatcher = require("./dispatcher");
const invoiceQuery = require("./invoiceQuery");

const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const shiftDays = (isoDate, days) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};


function buildTargets(settings, today) {
  const targets = [];

  // Support multiple days before the invoice due date.
  // Keep compatibility with the older single-day setting.
  const beforeDays = Array.isArray(settings.before_due_days)
    ? settings.before_due_days
    : [settings.days_before_due];

  for (const n of [...new Set(beforeDays.map(Number))]) {
    if (Number.isInteger(n) && n > 0 && n <= 365) {
      targets.push({
        dueDate: shiftDays(today, n),
        templateKey: "REMINDER",
        reminderKey: `before-${n}`,
      });
    }
  }

  // Reminder on the actual due date.
  if (settings.send_on_due) {
    targets.push({
      dueDate: today,
      templateKey: "REMINDER",
      reminderKey: "on-due",
    });
  }

  // Reminders after the due date.
  for (const n of settings.overdue_days || []) {
    if (Number.isInteger(Number(n)) && Number(n) > 0 && Number(n) <= 365) {
      const days = Number(n);

      targets.push({
        dueDate: shiftDays(today, -days),
        templateKey: "REMINDER",
        reminderKey: `after-${days}`,
      });
    }
  }

  return targets;
}


async function sentKeys(invoiceIds, tenantId, db) {
  if (!invoiceIds.length) return new Set();

  const { rows } = await db.query(
    `SELECT invoice_id, reminder_key
       FROM invoice_reminder_logs
      WHERE tenant_id = $1
        AND invoice_id = ANY($2)
        AND channel = 'EMAIL'`,
    [tenantId, invoiceIds],
  );

  return new Set(rows.map((r) => `${r.invoice_id}:${r.reminder_key}`));
}

async function scanForTenant(
  tenantId,
  { today, dryRun },
  db,
) {

  const { rows: settingsRows } = await db.query(
    `SELECT *
       FROM invoice_reminder_settings
      WHERE tenant_id = $1`,
    [tenantId],
  );

  const settings = settingsRows[0];

  if (!settings) {
    return { tenantId, today, skipped: "no_settings", queued: 0, matches: [] };
  }

  if (!settings.enabled) {
    return { tenantId, today, skipped: "reminders_disabled", queued: 0, matches: [] };
  }

  if (!settings.channels_json?.email) {
    return { tenantId, today, skipped: "email_channel_off", queued: 0, matches: [] };
  }

  const targets = buildTargets(settings, today);

  if (!targets.length) {
    return { tenantId, today, queued: 0, matches: [] };
  }

  const dueDates = [...new Set(targets.map((t) => t.dueDate))];

  const invoices = await invoiceQuery.openWithDueDates(dueDates, db);

  if (!invoices.length) {
    return { tenantId, today, queued: 0, matches: [], dryRun };
  }

  const byDueDate = new Map();

  for (const inv of invoices) {
    const key = String(inv.due_date).slice(0, 10);

    if (!byDueDate.has(key)) {
      byDueDate.set(key, []);
    }

    byDueDate.get(key).push(inv);
  }

  const seen = await sentKeys(
    invoices.map((i) => i.id),
    tenantId,
    db,
  );

  const matches = [];

  for (const target of targets) {
    for (const inv of byDueDate.get(target.dueDate) || []) {
      if (seen.has(`${inv.id}:${target.reminderKey}`)) continue;

      matches.push({
        invoice_id: inv.id,
        invoice_number: inv.invoice_number,
        template: target.templateKey,
        reminder: target.reminderKey,
        to: inv.primary_contact_email,
      });
    }
  }

  if (dryRun) {
    return { tenantId, today, queued: 0, matches, dryRun: true };
  }

  let queued = 0;

  for (const m of matches) {
    const out = await dispatcher.queueReminder(
      m.invoice_id,
      m.template,
      m.reminder,
      db,
    );

    if (!out.queued) continue;

    await db.query(
      `INSERT INTO invoice_reminder_logs
         (tenant_id, invoice_id, reminder_key, sent_on, channel)
       VALUES ($1, $2, $3, $4, 'EMAIL')
       ON CONFLICT DO NOTHING`,
      [tenantId, m.invoice_id, m.reminder, today],
    );

    queued += 1;
  }

  return { tenantId, today, queued, matches };
}

async function scan({ today = iso(new Date()), dryRun = false } = {}) {
  const { rows: tenants } = await pool.query(
    `SELECT id
       FROM tenants
      WHERE UPPER(COALESCE(status, 'ACTIVE')) = 'ACTIVE'
      ORDER BY id`,
  );

  const results = [];

  for (const tenant of tenants) {
    const tenantId = Number(tenant.id);
    const client = await pool.connect();

    try {
      await client.query(
        `SELECT set_config('app.tenant_id', $1, false)`,
        [String(tenantId)],
      );

      const result = await runWithTenant(
        client,
        tenantId,
        () => scanForTenant(tenantId, { today, dryRun }, client),
      );

      results.push(result);
    } catch (err) {
      console.error(
        `[reminderScanner] tenant ${tenantId} failed:`,
        err.message,
      );

      results.push({
        tenantId,
        today,
        queued: 0,
        matches: [],
        error: err.message,
      });
    } finally {
      try {
        await client.query(
          `SELECT set_config('app.tenant_id', '', false)`,
        );
      } catch (err) {
        console.error(
          `[reminderScanner] tenant ${tenantId} context reset failed:`,
          err.message,
        );
      }

      client.release();
    }
  }

  return {
    today,
    tenantsProcessed: results.length,
    queued: results.reduce((total, r) => total + (r.queued || 0), 0),
    matches: results.flatMap((r) => r.matches || []),
    results,
  };
}

let timer = null;

function start() {
  if (String(process.env.EMAIL_REMINDERS || "").toLowerCase() !== "on") {
    return;
  }

  let lastRunDay = null;

  const tick = async () => {
    const today = iso(new Date());

    if (lastRunDay === today) return;

    lastRunDay = today;

    try {
      const out = await scan({ today });

      console.log(
        `[reminderScanner] ${today}: processed ${out.tenantsProcessed} tenant(s), queued ${out.queued} reminder(s)`,
      );
    } catch (err) {
      console.error("[reminderScanner] scan failed:", err.message);
    }
  };

  const everyMin = Math.max(
    5,
    Number(process.env.EMAIL_REMINDERS_INTERVAL_MIN) || 60,
  );

  timer = setInterval(tick, everyMin * 60 * 1000);

  if (timer.unref) timer.unref();

  tick();

  console.log(
    `[reminderScanner] enabled (checks every ${everyMin}m)`,
  );
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { scan, buildTargets, start, stop };

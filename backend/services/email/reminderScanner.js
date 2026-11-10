const pool = require("../../config/db");
const dispatcher = require("./dispatcher");
const invoiceQuery = require("./invoiceQuery");
const { ensureEmailSchema } = require("../../modules/email/ensureEmailSchema");

const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const shiftDays = (isoDate, days) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return iso(d);
};

function buildTargets(settings, today) {
  const targets = [];
  for (const n of settings.before_due_days || []) {
    targets.push({ dueDate: shiftDays(today, n), templateKey: "REMINDER", reminderKey: `before-${n}` });
  }
  if (settings.send_on_due) {
    targets.push({ dueDate: today, templateKey: "REMINDER", reminderKey: "on-due" });
  }
  for (const n of settings.overdue_days || []) {
    targets.push({ dueDate: shiftDays(today, -n), templateKey: "REMINDER", reminderKey: `after-${n}` });
  }
  return targets;
}

async function sentKeys(invoiceIds, db = pool) {
  if (!invoiceIds.length) return new Set();
  const { rows } = await db.query(
    `SELECT invoice_id, reminder_key FROM invoice_reminder_logs
      WHERE invoice_id = ANY($1) AND channel = 'EMAIL'`,
    [invoiceIds],
  );
  return new Set(rows.map((r) => `${r.invoice_id}:${r.reminder_key}`));
}

async function scan({ today = iso(new Date()), dryRun = false } = {}, db = pool) {
  await ensureEmailSchema(db);

  const { rows: settingsRows } = await db.query(`SELECT * FROM invoice_reminder_settings WHERE id = 1`);
  const settings = settingsRows[0];
  if (!settings) return { today, skipped: "no_settings", queued: 0, matches: [] };
  if (!settings.enabled) return { today, skipped: "reminders_disabled", queued: 0, matches: [] };
  if (!settings.channels_json?.email) return { today, skipped: "email_channel_off", queued: 0, matches: [] };

  const targets = buildTargets(settings, today);
  if (!targets.length) return { today, queued: 0, matches: [] };

  const invoices = await invoiceQuery.openWithDueDates([...new Set(targets.map((t) => t.dueDate))], db);
  if (!invoices.length) return { today, queued: 0, matches: [], dryRun };

  const byDueDate = new Map();
  for (const inv of invoices) {
    const key = String(inv.due_date).slice(0, 10);
    if (!byDueDate.has(key)) byDueDate.set(key, []);
    byDueDate.get(key).push(inv);
  }

  const seen = await sentKeys(invoices.map((i) => i.id), db);

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

  if (dryRun) return { today, queued: 0, matches, dryRun: true };

  let queued = 0;
  for (const m of matches) {
    const out = await dispatcher.queueReminder(m.invoice_id, m.template, m.reminder, db);
    if (!out.queued) continue;
    await db.query(
      `INSERT INTO invoice_reminder_logs (invoice_id, reminder_key, sent_on, channel)
       VALUES ($1,$2,$3,'EMAIL') ON CONFLICT DO NOTHING`,
      [m.invoice_id, m.reminder, today],
    );
    queued += 1;
  }

  return { today, queued, matches };
}

let timer = null;

function start() {
  if (String(process.env.EMAIL_REMINDERS || "").toLowerCase() !== "on") return;
  let lastRunDay = null;

  const tick = async () => {
    const today = iso(new Date());
    if (lastRunDay === today) return;
    lastRunDay = today;
    try {
      const out = await scan({ today });
      console.log(`[reminderScanner] ${today}: queued ${out.queued} reminder(s)`);
    } catch (err) {
      console.error("[reminderScanner] scan failed:", err.message);
    }
  };

  const everyMin = Math.max(5, Number(process.env.EMAIL_REMINDERS_INTERVAL_MIN) || 60);
  timer = setInterval(tick, everyMin * 60 * 1000);
  if (timer.unref) timer.unref();
  tick();
  console.log(`[reminderScanner] enabled (checks every ${everyMin}m)`);
}

function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { scan, buildTargets, start, stop };

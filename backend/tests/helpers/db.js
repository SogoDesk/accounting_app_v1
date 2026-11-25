// Run test code the way a request runs: on one pooled connection with
// app.tenant_id set, inside the tenant context, optionally in a transaction.

const pool = require("../../config/db");
const { runWithTenant } = require("../../config/tenantContext");

async function withTenant(tenantId, fn, { transaction = true } = {}) {
  const client = await pool.connect();
  try {
    await client.query("SELECT set_config('app.tenant_id', $1, false)", [String(tenantId)]);
    return await runWithTenant(client, tenantId, async () => {
      if (!transaction) return fn(client);
      await client.query("BEGIN");
      try {
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    });
  } finally {
    await client.query("SELECT set_config('app.tenant_id', '', false)").catch(() => {});
    client.release();
  }
}

// Lines of one journal entry with their account codes, in insert order.
async function entryLines(db, entryId) {
  const { rows } = await db.query(
    `SELECT a.account_code, jl.currency,
            jl.debit::float8 AS debit, jl.credit::float8 AS credit,
            jl.debit_base::float8 AS debit_base, jl.credit_base::float8 AS credit_base,
            jl.exchange_rate::float8 AS exchange_rate
       FROM journal_lines jl
       JOIN chart_of_accounts a ON a.id = jl.account_id
      WHERE jl.entry_id = $1
      ORDER BY jl.id`,
    [entryId],
  );
  return rows;
}

// Compact form for assertions: [account, debit, credit, debitBase, creditBase].
const lineSummary = (lines) =>
  lines.map((l) => [l.account_code, l.debit, l.credit, l.debit_base, l.credit_base]);

function totals(lines) {
  const sum = (key) => Math.round(lines.reduce((s, l) => s + l[key], 0) * 100) / 100;
  return {
    debitBase: sum("debit_base"),
    creditBase: sum("credit_base"),
  };
}

// Net functional-currency balance (debit - credit) of an account in an entity.
async function accountBalance(db, entityId, accountCode) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(jl.debit_base - jl.credit_base), 0)::float8 AS balance
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id AND je.status = 'POSTED'
       JOIN chart_of_accounts a ON a.id = jl.account_id
      WHERE jl.entity_id = $1 AND a.account_code = $2`,
    [entityId, accountCode],
  );
  return rows[0].balance;
}

module.exports = { pool, withTenant, entryLines, lineSummary, totals, accountBalance };

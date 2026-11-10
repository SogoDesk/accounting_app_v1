export default function GlNotReady({ message }) {
  return (
    <div className="table-card glass-card" style={{ padding: 24 }}>
      <h3 style={{ marginTop: 0 }}>General ledger not enabled yet</h3>
      <p className="text-muted">
        {message || 'Apply database migrations 001 and 002, then restart the backend.'}
      </p>
      <p className="text-muted text-sm" style={{ marginBottom: 0 }}>
        Run the SQL in <code>database/migrations/001_currency_engine.sql</code> then{' '}
        <code>002_general_ledger.sql</code>, then restart the backend.
      </p>
    </div>
  )
}

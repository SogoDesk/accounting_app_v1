import { useEffect, useState } from 'react'
import api from '../../services/api'
import { useDefaultEntityId } from '../../context/EntityContext'
import GlNotReady from './GlNotReady'
import { PageGuide } from './AccountingGuide'
import { fmtDate } from '../../components/ui'
import { formatMoney, todayISO } from './glHelpers'

export default function PeriodClosePage() {
  const [entities, setEntities] = useState([])
  const [accounts, setAccounts] = useState([])
  const [glReady, setGlReady] = useState(true)
  const [message, setMessage] = useState('')

  const [entityId, setEntityId] = useState(useDefaultEntityId())
  const [asOf, setAsOf] = useState(todayISO())

  const [busy, setBusy] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  const [schedules, setSchedules] = useState([])

  useEffect(() => {
    api.get('/regions').then((res) => setEntities(res.data.data || [])).catch(() => {})
    api
      .get('/gl/chart-of-accounts')
      .then((res) => {
        setGlReady(res.data.glReady !== false)
        setMessage(res.data.message || '')
        setAccounts(res.data.data || [])
      })
      .catch((err) => setError(err.response?.data?.message || err.message))
    loadSchedules()
  }, [])

  const loadSchedules = () => {
    api.get('/gl/recognition/schedules').then((res) => setSchedules(res.data.data || [])).catch(() => {})
  }

  const run = async (kind) => {
    setError('')
    setResult(null)
    if (kind === 'fx' && !entityId) {
      setError('Select an entity for FX revaluation.')
      return
    }
    setBusy(kind)
    try {
      let res
      if (kind === 'fx') res = await api.post('/gl/fx-revalue', { entityId: Number(entityId), asOfDate: asOf })
      else if (kind === 'recognition') res = await api.post('/gl/recognition/run', { asOfDate: asOf })
      else res = await api.post('/gl/period-close/run', { asOfDate: asOf })
      setResult({ kind, data: res.data.data })
      loadSchedules()
    } catch (err) {
      setError(err.response?.data?.message || err.message)
    } finally {
      setBusy('')
    }
  }

  const reopen = async () => {
    setError('')
    setResult(null)
    setBusy('reopen')
    try {
      const res = await api.post('/gl/period-close/reopen', { asOfDate: asOf })
      setResult({ kind: 'reopen', data: res.data.data })
    } catch (err) {
      setError(err.response?.data?.message || err.message)
    } finally {
      setBusy('')
    }
  }

  if (!glReady) {
    return (
      <div className="dashboard-page">
        <div className="page-header">
          <div>
            <h1 className="page-title">Period Close</h1>
          </div>
        </div>
        <GlNotReady message={message} />
      </div>
    )
  }

  return (
    <div className="dashboard-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Period Close</h1>
          <p className="page-subtitle">
            Run FX revaluation and accrual/deferral recognition, or the full monthly close. All entries
            post through the immutable ledger.
          </p>
        </div>
      </div>

      <PageGuide
        id="period-close"
        title="What is Period Close, and do I need it?"
        lead={'Period close is end-of-month housekeeping so the numbers settle and stop changing. If you only work in one currency and have no prepaid/deferred items, you may rarely touch this. It is here for accountants who do a formal monthly close.'}
        points={[
          { term: 'FX revaluation', text: 'Foreign-currency balances are worth more or less as exchange rates move. This records that unrealised gain or loss so your balances stay honest.' },
          { term: 'Recognition', text: 'Spreads a prepaid cost (e.g. annual insurance) or deferred income evenly over the months it actually covers, instead of all at once.' },
          { term: 'Run monthly close', text: 'Does both of the above across every entity, then you can lock the period so no one changes last month’s books.' },
        ]}
      />

      <div className="table-card glass-card" style={{ marginBottom: 16, padding: 16 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
            Entity (for FX revaluation)
            <select className="filter-select" value={entityId} onChange={(e) => setEntityId(e.target.value)}>
              <option value="">Select entity…</option>
              {entities.map((r) => (
                <option key={r.id} value={r.id}>{r.region_name}</option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
            As of date
            <input type="date" className="filter-select" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </label>
          <div style={{ flex: 1 }} />
          <button className="secondary-btn" onClick={() => run('fx')} disabled={!!busy}>
            {busy === 'fx' ? 'Running…' : 'Run FX revaluation'}
          </button>
          <button className="secondary-btn" onClick={() => run('recognition')} disabled={!!busy}>
            {busy === 'recognition' ? 'Running…' : 'Run recognition'}
          </button>
          <button className="primary-btn" onClick={() => run('close')} disabled={!!busy}>
            {busy === 'close' ? 'Running…' : 'Run monthly close'}
          </button>
          <button className="secondary-btn" onClick={reopen} disabled={!!busy} title="Reopen the period covering the as-of date so entries can be posted again">
            {busy === 'reopen' ? 'Reopening…' : 'Reopen period'}
          </button>
        </div>
        {error && <p className="text-muted" style={{ color: 'var(--danger-text)', marginTop: 8 }}>{error}</p>}
        {result && <RunResult result={result} />}
      </div>

      <RecognitionScheduleForm
        entities={entities}
        accounts={accounts}
        onCreated={loadSchedules}
      />

      <SchedulesTable schedules={schedules} entities={entities} />
    </div>
  )
}

function RunResult({ result }) {
  const { kind, data } = result
  if (kind === 'fx') {
    const revals = (data && data.revaluations) || []
    return (
      <div style={{ marginTop: 12 }}>
        <span style={{ color: 'var(--success-text)', fontWeight: 600 }}>
          FX revaluation for entity {data.entityId} @ {data.asOfDate}: {data.count} posting(s).
        </span>
        {revals.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table className="saas-table">
              <thead>
                <tr><th>Account</th><th>Ccy</th><th style={{ textAlign: 'right' }}>Book</th>
                  <th style={{ textAlign: 'right' }}>Revalued</th><th style={{ textAlign: 'right' }}>Gain/Loss</th></tr>
              </thead>
              <tbody>
                {revals.map((r, i) => (
                  <tr key={i}>
                    <td className="td-mono">{r.account_code}</td>
                    <td>{r.currency}</td>
                    <td className="td-mono" style={{ textAlign: 'right' }}>{r.skipped ? '—' : formatMoney(r.book_base, r.currency)}</td>
                    <td className="td-mono" style={{ textAlign: 'right' }}>{r.skipped ? '—' : formatMoney(r.revalued_base, r.currency)}</td>
                    <td className="td-mono" style={{ textAlign: 'right', color: (r.gain_loss || 0) >= 0 ? 'var(--success-text)' : 'var(--danger-text)' }}>
                      {r.skipped ? 'already revalued' : formatMoney(r.gain_loss, r.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    )
  }
  if (kind === 'recognition') {
    return (
      <p style={{ color: 'var(--success-text)', fontWeight: 600, marginTop: 12 }}>
        Recognition run @ {data.asOfDate}: {data.count} entry(ies) posted.
      </p>
    )
  }
  if (kind === 'reopen') {
    return (
      <p style={{ color: 'var(--success-text)', fontWeight: 600, marginTop: 12 }}>
        {data.period?.period_label || 'Period'} reopened — entries can be posted again.
      </p>
    )
  }
  // monthly close
  return (
    <p style={{ color: 'var(--success-text)', fontWeight: 600, marginTop: 12 }}>
      Monthly close @ {data.asOfDate}: revalued {data.entities?.length || 0} entit(ies);
      recognition posted {data.recognition?.count ?? 0} entry(ies)
      {data.period?.status === 'CLOSED' ? ` — ${data.period.period_label} is now locked (CLOSED).` : '.'}
    </p>
  )
}

function RecognitionScheduleForm({ entities, accounts, onCreated }) {
  const [entityId, setEntityId] = useState('')
  const [kind, setKind] = useState('PREPAID_EXPENSE')
  const [totalAmount, setTotalAmount] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [pnlAccountCode, setPnlAccountCode] = useState('')
  const [balanceAccountCode, setBalanceAccountCode] = useState('')
  const [startDate, setStartDate] = useState(todayISO())
  const [periods, setPeriods] = useState('12')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const pnlType = kind === 'PREPAID_EXPENSE' ? 'EXPENSE' : 'INCOME'
  const balanceHint = kind === 'PREPAID_EXPENSE' ? '1300 Prepaid (default)' : '2700 Deferred Revenue (default)'
  const pnlAccounts = accounts.filter((a) => a.account_type === pnlType)

  const submit = async (e) => {
    e.preventDefault()
    setErr('')
    setMsg('')
    if (!entityId || !totalAmount || !pnlAccountCode || !startDate || !periods) {
      setErr('Entity, amount, P&L account, start date and periods are required.')
      return
    }
    setBusy(true)
    try {
      const payload = {
        entityId: Number(entityId),
        kind,
        totalAmount: Number(totalAmount),
        currency,
        pnlAccountCode,
        startDate,
        periods: Number(periods),
      }
      if (balanceAccountCode) payload.balanceAccountCode = balanceAccountCode
      const res = await api.post('/gl/recognition/schedules', payload)
      setMsg(`✓ Schedule #${res.data.data.id} created (${kind}).`)
      setTotalAmount('')
      onCreated && onCreated()
    } catch (e2) {
      setErr(e2.response?.data?.message || e2.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="table-card glass-card" style={{ marginBottom: 16, padding: 16 }}>
      <strong>New recognition schedule</strong>
      <p className="text-muted text-sm">
        Straight-line recognition of prepaid expense (Dr expense / Cr prepaid) or deferred revenue
        (Dr deferred / Cr revenue) over N periods.
      </p>
      <form onSubmit={submit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          Entity
          <select className="filter-select" value={entityId} onChange={(e) => setEntityId(e.target.value)}>
            <option value="">Select…</option>
            {entities.map((r) => (
              <option key={r.id} value={r.id}>{r.region_name}</option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          Kind
          <select className="filter-select" value={kind} onChange={(e) => { setKind(e.target.value); setPnlAccountCode('') }}>
            <option value="PREPAID_EXPENSE">Prepaid expense</option>
            <option value="DEFERRED_REVENUE">Deferred revenue</option>
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          Total amount
          <input type="number" step="0.01" min="0" className="filter-select" value={totalAmount}
            onChange={(e) => setTotalAmount(e.target.value)} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          Currency
          <input className="filter-select" style={{ width: 90 }} value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          P&amp;L account ({pnlType})
          <select className="filter-select" value={pnlAccountCode} onChange={(e) => setPnlAccountCode(e.target.value)}>
            <option value="">Select…</option>
            {pnlAccounts.map((a) => (
              <option key={a.id} value={a.account_code}>{a.account_code} — {a.account_name}</option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          Balance account
          <select className="filter-select" value={balanceAccountCode} onChange={(e) => setBalanceAccountCode(e.target.value)}>
            <option value="">{balanceHint}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.account_code}>{a.account_code} — {a.account_name}</option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          Start date
          <input type="date" className="filter-select" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          Periods
          <input type="number" min="1" className="filter-select" style={{ width: 90 }} value={periods}
            onChange={(e) => setPeriods(e.target.value)} />
        </label>
        <button className="primary-btn" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create schedule'}
        </button>
      </form>
      {err && <p className="text-muted" style={{ color: 'var(--danger-text)' }}>{err}</p>}
      {msg && <p style={{ color: 'var(--success-text)', fontWeight: 600 }}>{msg}</p>}
    </div>
  )
}

function SchedulesTable({ schedules, entities = [] }) {
  const entityName = (id) => entities.find((e) => String(e.id) === String(id))?.region_name || `Entity ${id}`
  return (
    <div className="table-card glass-card">
      <div className="table-toolbar"><strong>Recognition schedules</strong></div>
      <div className="table-wrap">
        <table className="saas-table">
          <thead>
            <tr>
              <th>#</th><th>Entity</th><th>Kind</th>
              <th style={{ textAlign: 'right' }}>Total</th>
              <th>Balance → P&amp;L</th><th>Start</th><th>Periods</th>
              <th style={{ textAlign: 'right' }}>Runs</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {schedules.length === 0 ? (
              <tr><td colSpan={9} className="empty-row">No schedules yet.</td></tr>
            ) : (
              schedules.map((s) => (
                <tr key={s.id}>
                  <td className="td-mono">{s.id}</td>
                  <td>{entityName(s.entity_id)}</td>
                  <td>{s.kind === 'PREPAID_EXPENSE' ? 'Prepaid' : 'Deferred rev.'}</td>
                  <td className="td-mono" style={{ textAlign: 'right' }}>{formatMoney(s.total_amount, s.currency)}</td>
                  <td className="td-mono">{s.balance_account_code} → {s.pnl_account_code}</td>
                  <td>{fmtDate(s.start_date)}</td>
                  <td>{s.periods}</td>
                  <td className="td-mono" style={{ textAlign: 'right' }}>{s.runs_count}/{s.periods}</td>
                  <td>
                    <span className="badge badge-gray" style={{ color: s.status === 'COMPLETED' ? 'var(--success-text)' : 'var(--accent-text)' }}>
                      {s.status}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

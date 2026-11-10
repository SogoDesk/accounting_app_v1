import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import api from '../../services/api'
import { useDefaultEntityId } from '../../context/EntityContext'
import GlNotReady from './GlNotReady'
import { fmtDate } from '../../components/ui'
import { SOURCE_LABELS, formatMoney, todayISO, yearStartISO } from './glHelpers'

// Running-transaction history for a single account (the "account register").
// Requires an entity so the running balance is in one currency.
export default function AccountRegisterPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [entities, setEntities] = useState([])
  const [entityId, setEntityId] = useState(useDefaultEntityId())
  const [from, setFrom] = useState(yearStartISO())
  const [to, setTo] = useState(todayISO())
  const [data, setData] = useState(null)
  const [glReady, setGlReady] = useState(true)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // entity list; default to the first one for a single-currency running balance
  useEffect(() => {
    api.get('/regions').then((res) => {
      const rows = res.data.data || []
      setEntities(rows)
      if (rows.length) setEntityId(String(rows[0].id))
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!entityId) return
    let active = true
    setLoading(true)
    setError('')
    const params = { entityId, from, to }
    api
      .get(`/gl/accounts/${id}/register`, { params })
      .then((res) => {
        if (!active) return
        setGlReady(res.data.glReady !== false)
        setMessage(res.data.message || '')
        setData(res.data.data || null)
      })
      .catch((err) => active && setError(err.response?.data?.message || err.message))
      .finally(() => active && setLoading(false))
    return () => { active = false }
  }, [id, entityId, from, to])

  const ccy = data?.currency || ''
  const acct = data?.account

  return (
    <div className="dashboard-page">
      <div className="page-header">
        <div>
          <button className="linklike text-sm" onClick={() => navigate('/accounting/chart-of-accounts')}>
            ← Chart of Accounts
          </button>
          <h1 className="page-title" style={{ marginTop: 4 }}>
            {acct ? `${acct.account_code} · ${acct.account_name}` : 'Account register'}
          </h1>
          <p className="page-subtitle">
            Every transaction that touched this account, with a running balance.
          </p>
        </div>
      </div>

      {!glReady && !loading ? (
        <GlNotReady message={message} />
      ) : (
        <>
          <div className="table-card glass-card" style={{ marginBottom: 16 }}>
            <div className="table-toolbar" style={{ gap: 8, flexWrap: 'wrap' }}>
              <select className="filter-select" value={entityId} onChange={(e) => setEntityId(e.target.value)}>
                {entities.map((r) => (
                  <option key={r.id} value={r.id}>{r.region_name}</option>
                ))}
              </select>
              <span className="db-range">
                <span className="db-range-label">From</span>
                <input type="date" className="filter-select" value={from} onChange={(e) => setFrom(e.target.value)} />
                <span className="db-range-label">To</span>
                <input type="date" className="filter-select" value={to} onChange={(e) => setTo(e.target.value)} />
              </span>
            </div>

            {/* KPI strip */}
            {data && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, padding: '10px 16px', borderTop: '1px solid var(--border)' }}>
                <Kpi label="Opening balance" value={formatMoney(data.opening, ccy)} />
                <Kpi label="Total debits" value={formatMoney(data.totals.debit, ccy)} />
                <Kpi label="Total credits" value={formatMoney(data.totals.credit, ccy)} />
                <Kpi label="Closing balance" value={formatMoney(data.closing, ccy)} strong />
              </div>
            )}

            <div className="table-wrap">
              <table className="saas-table">
                <thead>
                  <tr>
                    <th style={{ width: 110 }}>Date</th>
                    <th style={{ width: 140 }}>Entry #</th>
                    <th>Source</th>
                    <th>Description</th>
                    <th style={{ textAlign: 'right', width: 120 }}>Debit</th>
                    <th style={{ textAlign: 'right', width: 120 }}>Credit</th>
                    <th style={{ textAlign: 'right', width: 140 }}>Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={7} className="empty-row">Loading…</td></tr>
                  ) : error ? (
                    <tr><td colSpan={7} className="empty-row">{error}</td></tr>
                  ) : !data || data.rows.length === 0 ? (
                    <tr><td colSpan={7} className="empty-row">No transactions in this range.</td></tr>
                  ) : (
                    <>
                      <tr className="je-opening-row">
                        <td colSpan={6} className="text-muted">Opening balance</td>
                        <td className="td-mono" style={{ textAlign: 'right' }}>{formatMoney(data.opening, ccy)}</td>
                      </tr>
                      {data.rows.map((r, i) => (
                        <tr
                          key={`${r.entry_id}-${i}`}
                          style={{ cursor: 'pointer' }}
                          onClick={() => navigate(r.entry_id ? `/accounting/journal-entries?view=${r.entry_id}` : '/accounting/journal-entries')}
                          title="Open this journal entry"
                        >
                          <td>{fmtDate(r.entry_date)}</td>
                          <td className="td-mono">{r.entry_no}</td>
                          <td>{SOURCE_LABELS[r.source] || r.source}</td>
                          <td className="text-muted text-sm">{r.description}{r.memo ? ` — ${r.memo}` : ''}</td>
                          <td className="td-mono" style={{ textAlign: 'right' }}>{r.debit > 0 ? formatMoney(r.debit, ccy) : ''}</td>
                          <td className="td-mono" style={{ textAlign: 'right' }}>{r.credit > 0 ? formatMoney(r.credit, ccy) : ''}</td>
                          <td className="td-mono" style={{ textAlign: 'right' }}>{formatMoney(r.balance, ccy)}</td>
                        </tr>
                      ))}
                      <tr className="je-closing-row">
                        <td colSpan={4} className="fw-bold" style={{ textAlign: 'right' }}>Closing balance</td>
                        <td className="td-mono fw-bold" style={{ textAlign: 'right' }}>{formatMoney(data.totals.debit, ccy)}</td>
                        <td className="td-mono fw-bold" style={{ textAlign: 'right' }}>{formatMoney(data.totals.credit, ccy)}</td>
                        <td className="td-mono fw-bold" style={{ textAlign: 'right' }}>{formatMoney(data.closing, ccy)}</td>
                      </tr>
                    </>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function Kpi({ label, value, strong }) {
  return (
    <div>
      <div className="text-muted text-sm">{label}</div>
      <div className="td-mono" style={{ fontSize: strong ? 18 : 15, fontWeight: strong ? 700 : 600 }}>{value}</div>
    </div>
  )
}

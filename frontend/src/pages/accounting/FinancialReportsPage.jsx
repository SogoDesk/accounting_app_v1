import { Fragment, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts'
import api from '../../services/api'
import { useDefaultEntityId } from '../../context/EntityContext'
import { useTheme } from '../../context/ThemeContext'
import { Card, DataTable, StatCard, StatusChip, chartColors, fmtDate } from '../../components/ui'
import GlNotReady from './GlNotReady'
import { PageGuide } from './AccountingGuide'
import { formatMoney, todayISO, yearStartISO } from './glHelpers'
import './FinancialReportsPage.css'

// The five statutory statements plus the consolidated roll-up. `key` maps to
// the existing `tab` state and drives the same API calls as before.
const REPORTS = [
  { key: 'pl', title: 'Profit & loss', sub: 'Income statement' },
  { key: 'bs', title: 'Balance sheet', sub: 'Position at date' },
  { key: 'tb', title: 'Trial balance', sub: 'All accounts, Dr / Cr' },
  { key: 'gl', title: 'General ledger', sub: 'Transaction detail' },
  { key: 'cf', title: 'Cash flow', sub: 'Operating, investing' },
  { key: 'cons', title: 'Consolidated', sub: 'Group eliminations' },
]

// Tabs that report over a date range (From/To) rather than a single "as of" date.
const RANGE_TABS = new Set(['pl', 'gl', 'cf'])

// --- small inline icons (stroked 24x24, currentColor) ----------------
const I = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' }
const ReportIcon = ({ k }) => {
  const p = { width: 22, height: 22, viewBox: '0 0 24 24', ...I }
  switch (k) {
    case 'pl': return <svg {...p}><path d="M4 19V5" /><path d="M4 19h16" /><path d="M8 15l3-4 3 2 4-6" /></svg>
    case 'bs': return <svg {...p}><path d="M3 21h18" /><path d="M5 21V9l7-5 7 5v12" /><path d="M9 21v-6h6v6" /></svg>
    case 'tb': return <svg {...p}><path d="M9 6h11" /><path d="M9 12h11" /><path d="M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></svg>
    case 'gl': return <svg {...p}><path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z" /><path d="M8 7h7M8 11h7" /></svg>
    case 'cf': return <svg {...p}><path d="M7 7h11l-3-3M17 17H6l3 3" /></svg>
    case 'cons': return <svg {...p}><path d="M12 3l8 4-8 4-8-4z" /><path d="M4 12l8 4 8-4" /><path d="M4 17l8 4 8-4" /></svg>
    default: return null
  }
}
const BackIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" {...I}><path d="M15 18l-6-6 6-6" /></svg>
const CalIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" {...I}><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /></svg>
const DownIcon = () => <svg width="15" height="15" viewBox="0 0 24 24" {...I}><path d="M12 4v11M7 11l5 4 5-4M5 20h14" /></svg>

const pctOf = (v, denom) => (denom ? `${((Number(v || 0) / denom) * 100).toFixed(1)}%` : '—')

export default function FinancialReportsPage() {
  const navigate = useNavigate()
  const { accent, dark } = useTheme()
  const [tab, setTab] = useState('tb')
  const [entities, setEntities] = useState([])
  const [orgUnits, setOrgUnits] = useState([])
  const [entityId, setEntityId] = useState(useDefaultEntityId()) // '' = consolidated USD
  const [rootLocationId, setRootLocationId] = useState('') // '' = GRP root
  const [asOf, setAsOf] = useState(todayISO())
  const [from, setFrom] = useState(yearStartISO())
  const [to, setTo] = useState(todayISO())

  const [report, setReport] = useState(null)
  const [reportTab, setReportTab] = useState(null) // which tab `report` was loaded for
  const [reloadKey, setReloadKey] = useState(0) // bump to refetch the current report
  const [fiscal, setFiscal] = useState(null) // real fiscal-year/period status
  const [glReady, setGlReady] = useState(true)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // intercompany transfer panel
  const [showXfer, setShowXfer] = useState(false)
  const [downloading, setDownloading] = useState('')

  // Download the current statement as Excel / PDF / CSV.
  const TYPE_BY_TAB = { tb: 'trial-balance', pl: 'profit-and-loss', bs: 'balance-sheet', gl: 'general-ledger', cf: 'cash-flow' }
  const downloadReport = async (format) => {
    const type = TYPE_BY_TAB[tab]
    if (!type) return // consolidated export not wired
    setDownloading(format)
    try {
      const params = new URLSearchParams({ format })
      if (entityId) params.set('entityId', entityId)
      if (RANGE_TABS.has(tab)) { params.set('from', from); params.set('to', to) }
      else params.set('asOf', asOf)
      const res = await api.get(`/gl/reports/${type}/export?${params.toString()}`, { responseType: 'blob' })
      const ext = format === 'excel' ? 'xlsx' : format
      const a = document.createElement('a')
      a.href = URL.createObjectURL(res.data)
      a.download = `${type}.${ext}`
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href)
    } catch (e) {
      setError(e.response?.data?.message || e.message || 'Download failed')
    } finally {
      setDownloading('')
    }
  }

  useEffect(() => {
    api.get('/regions').then((res) => setEntities(res.data.data || [])).catch(() => {})
    api.get('/org-units').then((res) => setOrgUnits(res.data.data || [])).catch(() => {})
    // Real fiscal-year/period status (best-effort; drives the period chip + card).
    api.get('/settings/fiscal').then((res) => setFiscal(res.data.data || null)).catch(() => {})
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    const params = {}
    let url
    if (tab === 'pl') {
      url = '/gl/reports/profit-and-loss'
      if (entityId) params.entityId = entityId
      params.from = from
      params.to = to
    } else if (tab === 'gl' || tab === 'cf') {
      url = tab === 'gl' ? '/gl/reports/general-ledger' : '/gl/reports/cash-flow'
      if (entityId) params.entityId = entityId
      params.from = from
      params.to = to
    } else if (tab === 'cons') {
      url = '/gl/reports/consolidated'
      if (rootLocationId) params.rootLocationId = rootLocationId
      params.asOf = asOf
    } else {
      url = tab === 'tb' ? '/gl/reports/trial-balance' : '/gl/reports/balance-sheet'
      if (entityId) params.entityId = entityId
      params.asOf = asOf
    }
    api
      .get(url, { params })
      .then((res) => {
        if (!active) return
        setGlReady(res.data.glReady !== false)
        setMessage(res.data.message || '')
        setReport(res.data.data || null)
        setReportTab(tab) // tag the data with the tab it belongs to
      })
      .catch((err) => active && setError(err.response?.data?.message || err.message))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [tab, entityId, rootLocationId, asOf, from, to, reloadKey])

  const ccy = report?.currency || 'USD'

  // Status of the accounting period covering a given date, from the real
  // fiscal overview. Returns 'OPEN' | 'CLOSED' | null (unknown → render nothing).
  const periodStatusFor = (iso) => {
    if (!fiscal?.periods?.length || !iso) return null
    const day = fmtDate(iso)
    const p = fiscal.periods.find((x) => fmtDate(x.start_date) <= day && day <= fmtDate(x.end_date))
    return p ? String(p.status).toUpperCase() : null
  }
  const plPeriodStatus = periodStatusFor(RANGE_TABS.has(tab) ? to : asOf)

  const scopeLabel =
    tab === 'cons'
      ? `Consolidated subtree (${
          rootLocationId
            ? orgUnits.find((o) => String(o.id) === String(rootLocationId))?.name || 'Root'
            : 'Group / GRP'
        })`
      : entityId
        ? entities.find((e) => String(e.id) === String(entityId))?.region_name || 'Entity'
        : 'Consolidated (USD)'

  const periodLabel = useMemo(() => {
    const iso = RANGE_TABS.has(tab) ? to : asOf
    const d = new Date(`${iso}T00:00:00`)
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
  }, [tab, to, asOf])

  return (
    <div className="dashboard-page fr-page">
      {/* Header ------------------------------------------------------ */}
      <div className="fr-head">
        <button type="button" className="fr-back" onClick={() => navigate(-1)} aria-label="Back">
          <BackIcon />
        </button>
        <div className="fr-head-titles">
          <h1 className="fr-title">Financial reports</h1>
          <p className="fr-sub">
            Trial balance, P&amp;L, balance sheet, general ledger and cash flow. Cross-entity figures
            convert to the group currency.
          </p>
        </div>
        <div className="fr-head-actions">
          <span className="fr-period"><CalIcon /> <span className="fr-period-val">{periodLabel}</span></span>
          <button
            className="secondary-btn"
            onClick={() => downloadReport('pdf')}
            disabled={!TYPE_BY_TAB[tab] || !!downloading}
          >
            {downloading === 'pdf' ? '…' : 'Export PDF'}
          </button>
          <button className="primary-btn" onClick={() => setShowXfer((v) => !v)}>
            {showXfer ? 'Close transfer' : '⇄ Intercompany transfer'}
          </button>
        </div>
      </div>

      {/* Report selector cards -------------------------------------- */}
      <div className="fr-reports">
        {REPORTS.map((r) => {
          const on = tab === r.key
          return (
            <Card
              key={r.key}
              accent={on}
              hover
              role="button"
              tabIndex={0}
              onClick={() => setTab(r.key)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTab(r.key) } }}
              className={`fr-report${on ? ' is-active' : ''}`}
            >
              <span className="fr-report-tile"><ReportIcon k={r.key} /></span>
              <span>
                <div className="fr-report-name">{r.title}</div>
                <div className="fr-report-sub">{r.sub}</div>
              </span>
            </Card>
          )
        })}
      </div>

      {/* Filters ----------------------------------------------------- */}
      <div className="fr-filters">
        {tab === 'cons' ? (
          <select className="fr-select" value={rootLocationId} onChange={(e) => setRootLocationId(e.target.value)}>
            <option value="">Group / GRP (all)</option>
            {orgUnits
              .filter((o) => o.unit_type !== 'GROUP')
              .map((o) => (
                <option key={o.id} value={o.id}>
                  {' '.repeat((o.depth || 0) * 2)}{o.name} ({o.unit_type})
                </option>
              ))}
          </select>
        ) : (
          <select className="fr-select" value={entityId} onChange={(e) => setEntityId(e.target.value)}>
            <option value="">Consolidated — all regions</option>
            {entities.map((r) => (
              <option key={r.id} value={r.id}>{r.region_name}</option>
            ))}
          </select>
        )}

        {RANGE_TABS.has(tab) ? (
          <>
            <label className="fr-field">From
              <input type="date" className="fr-date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="fr-field">To
              <input type="date" className="fr-date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </>
        ) : (
          <label className="fr-field">As of
            <input type="date" className="fr-date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </label>
        )}

        <span className="fr-spring" />

        {TYPE_BY_TAB[tab] && (
          <>
            <button className="fr-ghostbtn" disabled={!!downloading} onClick={() => downloadReport('excel')}>
              <DownIcon /> {downloading === 'excel' ? '…' : 'Excel'}
            </button>
            <button className="fr-ghostbtn" disabled={!!downloading} onClick={() => downloadReport('csv')}>
              <DownIcon /> {downloading === 'csv' ? '…' : 'CSV'}
            </button>
          </>
        )}
      </div>

      <PageGuide
        id="financial-reports"
        title="Which report answers what?"
        lead={'These are the standard statements every business runs. Pick a card above. Leave the entity on “Consolidated” to see all locations combined in one currency, or choose a single location.'}
        points={[
          { term: 'Trial Balance', text: 'A checklist that every account balances. Mostly an accountant’s sanity check — if debits ≠ credits, something is wrong.' },
          { term: 'Profit & Loss', text: '“Am I making money?” Income minus expenses over a date range = net profit.' },
          { term: 'Balance Sheet', text: '“What do I own and owe?” A snapshot of assets, liabilities, and equity on a chosen date.' },
          { term: 'General Ledger', text: 'Every account’s opening balance, movement, and closing balance for the period — the accountant’s master view.' },
          { term: 'Cash Flow', text: '“Where did the cash actually go?” Splits cash movement into Operating, Investing, and Financing.' },
          { term: 'Consolidated', text: 'All locations rolled into one, with money moved between your own branches cancelled out so nothing is double-counted.' },
        ]}
      />

      {showXfer && (
        <IntercompanyTransfer orgUnits={orgUnits} onPosted={() => setReloadKey((k) => k + 1)} />
      )}

      <p className="fr-scope">Scope: <b>{scopeLabel}</b></p>

      {!glReady && !loading ? (
        <GlNotReady message={message} />
      ) : loading ? (
        <Card><span className="text-muted">Loading…</span></Card>
      ) : error ? (
        <Card><span className="text-muted">{error}</span></Card>
      ) : reportTab === tab && report ? (
        <>
          {tab === 'tb' && <TrialBalance report={report} ccy={ccy} />}
          {tab === 'pl' && (
            <ProfitAndLoss report={report} ccy={ccy} periodLabel={periodLabel} periodStatus={plPeriodStatus} accent={accent} dark={dark} />
          )}
          {tab === 'bs' && <BalanceSheet report={report} ccy={ccy} />}
          {tab === 'gl' && <GeneralLedger report={report} ccy={ccy} />}
          {tab === 'cf' && <CashFlow report={report} ccy={ccy} />}
          {tab === 'cons' && <Consolidated report={report} ccy={ccy} />}
        </>
      ) : null}
    </div>
  )
}

/* ---- shared statement rendering ------------------------------------ */
function Statement({ groups, netRow, ccy, denom, showPct }) {
  return (
    <table className="fr-stmt">
      <thead>
        <tr>
          <th className="fr-stmt-h">Account</th>
          <th className="fr-stmt-h fr-num">Amount</th>
          {showPct && <th className="fr-stmt-h fr-num">% rev</th>}
        </tr>
      </thead>
      <tbody>
        {groups.map((g) => (
          <Fragment key={g.label}>
            <tr className="fr-sec">
              <td>{g.label}</td>
              <td className="fr-num" />
              {showPct && <td className="fr-num" />}
            </tr>
            {(g.rows || []).map((r, i) => (
              <tr className="fr-row" key={r.account_code ?? i}>
                <td className="fr-acct">
                  {r.account_code ? <span className="fr-code">{r.account_code}</span> : null}
                  {r.account_name}
                </td>
                <td className="fr-num fr-mono">{formatMoney(r.amount, ccy)}</td>
                {showPct && <td className="fr-num fr-mono">{pctOf(r.amount, denom)}</td>}
              </tr>
            ))}
            {(g.rows || []).length === 0 && (
              <tr className="fr-row"><td className="fr-acct text-muted">None</td><td className="fr-num" />{showPct && <td />}</tr>
            )}
            <tr className="fr-total">
              <td>{g.totalLabel}</td>
              <td className="fr-num fr-mono">{formatMoney(g.total, ccy)}</td>
              {showPct && <td className="fr-num fr-mono">{pctOf(g.total, denom)}</td>}
            </tr>
          </Fragment>
        ))}
        {netRow && (
          <tr className="fr-net">
            <td>{netRow.label}</td>
            <td className="fr-num fr-mono">{formatMoney(netRow.amount, ccy)}</td>
            {showPct && <td className="fr-num fr-mono">{pctOf(netRow.amount, denom)}</td>}
          </tr>
        )}
      </tbody>
    </table>
  )
}

/* ---- Profit & Loss (full designed layout) -------------------------- */
function ProfitAndLoss({ report, ccy, periodLabel, periodStatus, accent, dark }) {
  const income = report.income || []
  const expense = report.expense || []
  const totInc = report.totals?.income || 0
  const totExp = report.totals?.expense || 0
  const net = report.totals?.netProfit ?? (totInc - totExp)
  const colors = chartColors(accent, dark)

  const donut = income
    .map((r) => ({ name: r.account_name, value: Math.abs(Number(r.amount || 0)) }))
    .filter((d) => d.value > 0)

  const netMargin = totInc ? (net / totInc) * 100 : 0
  const expenseRatio = totInc ? (totExp / totInc) * 100 : 0

  return (
    <div className="fr-content">
      {/* LEFT — the statement */}
      <Card>
        <div className="fr-panel-head">
          <span className="fr-panel-title">Profit &amp; loss</span>
          {periodStatus ? (
            <StatusChip tone={periodStatus === 'OPEN' ? 'success' : 'neutral'}>
              {periodStatus === 'OPEN' ? 'PERIOD OPEN' : 'PERIOD CLOSED'}
            </StatusChip>
          ) : null}
        </div>
        <div className="fr-panel-sub">
          {report.from || '—'} → {report.to || '—'} · {ccy}
        </div>
        <Statement
          showPct
          denom={totInc}
          ccy={ccy}
          groups={[
            { label: 'Revenue', rows: income, total: totInc, totalLabel: 'Total revenue' },
            { label: 'Expenses', rows: expense, total: totExp, totalLabel: 'Total expenses' },
          ]}
          netRow={{ label: 'Net profit', amount: net }}
        />
      </Card>

      {/* RIGHT — rail */}
      <div className="fr-rail">
        <Card>
          <div className="fr-panel-head">
            <span className="fr-panel-title">Revenue mix</span>
            <span className="fr-panel-meta">{periodLabel}</span>
          </div>
          <div className="fr-donut-wrap">
            <div className="fr-donut">
              {donut.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={donut} dataKey="value" innerRadius={40} outerRadius={62} paddingAngle={2} stroke="none">
                      {donut.map((d, i) => <Cell key={i} fill={colors.series[i % colors.series.length]} />)}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="text-muted text-sm" style={{ padding: 12 }}>No revenue</div>
              )}
            </div>
            <div className="fr-legend">
              {donut.slice(0, 4).map((d, i) => (
                <div className="fr-leg-row" key={i}>
                  <span className="fr-swatch" style={{ background: colors.series[i % colors.series.length] }} />
                  <span className="fr-leg-name">{d.name}</span>
                  <span className="fr-leg-val">{formatMoney(d.value, ccy)}</span>
                </div>
              ))}
              <div className="fr-leg-row">
                <span className="fr-swatch" style={{ background: colors.series[4] }} />
                <span className="fr-leg-name">Net margin</span>
                <span className="fr-leg-val">{netMargin.toFixed(1)}%</span>
              </div>
              <div className="fr-leg-row">
                <span className="fr-swatch" style={{ background: colors.series[5] }} />
                <span className="fr-leg-name">Expense ratio</span>
                <span className="fr-leg-val">{expenseRatio.toFixed(1)}%</span>
              </div>
            </div>
          </div>
        </Card>

        {periodStatus ? (
          <Card>
            <div className="fr-panel-head"><span className="fr-panel-title">Period close</span></div>
            <div className="fr-close">
              <div className="fr-close-row">
                <span className={`fr-dot${periodStatus === 'OPEN' ? ' fr-dot-open' : ''}`} />
                <span className="fr-close-label">{periodLabel}</span>
                <span className="fr-close-state">{periodStatus === 'OPEN' ? 'Open — accepting postings' : 'Closed'}</span>
              </div>
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  )
}

/* ---- Trial balance ------------------------------------------------- */
function TrialBalance({ report, ccy }) {
  const rows = report.rows || []
  const t = report.totals || {}
  return (
    <Card pad={false}>
      <DataTable
        columns={[
          { key: 'account_code', header: 'Code', mono: true, width: 120 },
          { key: 'account_name', header: 'Account', primary: true },
          { key: 'tb_debit', header: 'Debit', align: 'right', mono: true, render: (r) => (r.tb_debit ? formatMoney(r.tb_debit, ccy) : '') },
          { key: 'tb_credit', header: 'Credit', align: 'right', mono: true, render: (r) => (r.tb_credit ? formatMoney(r.tb_credit, ccy) : '') },
        ]}
        rows={rows}
        getRowId={(r) => r.account_code}
        empty="No postings yet."
        footer={[
          { colSpan: 2, align: 'right', render: () => (
            <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
              Totals <StatusChip tone={t.balanced ? 'success' : 'danger'}>{t.balanced ? 'BALANCED' : 'OUT OF BALANCE'}</StatusChip>
            </span>
          ) },
          { align: 'right', mono: true, render: () => formatMoney(t.debit, ccy) },
          { align: 'right', mono: true, render: () => formatMoney(t.credit, ccy) },
        ]}
      />
    </Card>
  )
}

/* ---- Balance sheet ------------------------------------------------- */
function BalanceSheet({ report, ccy }) {
  const t = report.totals || {}
  return (
    <div className="fr-stack">
      <Card>
        <div className="fr-panel-head"><span className="fr-panel-title">Balance sheet</span></div>
        <Statement
          ccy={ccy}
          groups={[
            { label: 'Assets', rows: report.assets, total: t.assets, totalLabel: 'Total assets' },
            { label: 'Liabilities', rows: report.liabilities, total: t.liabilities, totalLabel: 'Total liabilities' },
            { label: 'Equity', rows: report.equity, total: t.equity, totalLabel: 'Total equity' },
          ]}
          netRow={{ label: 'Liabilities + Equity', amount: (t.liabilities || 0) + (t.equity || 0) }}
        />
      </Card>
      <Card>
        <div className="fr-note">
          <StatusChip tone={t.balanced ? 'success' : 'danger'}>{t.balanced ? 'BALANCED' : 'OUT OF BALANCE'}</StatusChip>
          <p>
            Assets {formatMoney(t.assets, ccy)} vs Liabilities + Equity{' '}
            {formatMoney((t.liabilities || 0) + (t.equity || 0), ccy)}.
          </p>
        </div>
      </Card>
    </div>
  )
}

/* ---- General ledger ------------------------------------------------ */
function GeneralLedger({ report, ccy }) {
  const rows = report.rows || []
  return (
    <Card pad={false}>
      <div style={{ padding: '16px 16px 0' }} className="fr-panel-head">
        <span className="fr-panel-title">General ledger</span>
        <span className="fr-panel-meta">{report.from ? `${report.from} → ${report.to}` : `through ${report.to}`}</span>
      </div>
      <DataTable
        columns={[
          { key: 'account_code', header: 'Code', mono: true, width: 100 },
          { key: 'account_name', header: 'Account', primary: true, render: (r) => (
            <span>{r.account_name} <span className="text-muted text-sm">({r.account_type})</span></span>
          ) },
          { key: 'opening', header: 'Opening', align: 'right', mono: true, render: (r) => formatMoney(r.opening, ccy) },
          { key: 'debit', header: 'Debit', align: 'right', mono: true, render: (r) => (r.debit ? formatMoney(r.debit, ccy) : '') },
          { key: 'credit', header: 'Credit', align: 'right', mono: true, render: (r) => (r.credit ? formatMoney(r.credit, ccy) : '') },
          { key: 'closing', header: 'Closing', align: 'right', mono: true, primary: true, render: (r) => formatMoney(r.closing, ccy) },
        ]}
        rows={rows}
        getRowId={(r) => r.account_code}
        empty="No activity in this range."
      />
    </Card>
  )
}

/* ---- Cash flow ----------------------------------------------------- */
function CashFlow({ report, ccy }) {
  const sec = report.sections || { operating: [], investing: [], financing: [] }
  const block = (label, rows, total, totalLabel) => ({
    label,
    rows: (rows || []).map((r) => ({ ...r })),
    total,
    totalLabel,
  })
  return (
    <div className="fr-stack">
      <div className="fr-tiles">
        <StatCard label="Opening cash" value={formatMoney(report.opening, ccy)} />
        <StatCard label="Net change" value={formatMoney(report.netChange, ccy)}
          sub={report.netChange < 0 ? 'Cash decreased' : 'Cash increased'} />
        <StatCard label="Closing cash" value={formatMoney(report.closing, ccy)} accent />
        <StatCard label="Reconciles" value={report.reconciles ? 'Yes' : 'No'}
          sub={report.reconciles ? 'Ties to ledger' : 'Check postings'} />
      </div>
      <Card>
        <div className="fr-panel-head"><span className="fr-panel-title">Cash flow statement</span></div>
        <Statement
          ccy={ccy}
          groups={[
            block('Operating', sec.operating, report.operating, 'Net cash from operating'),
            block('Investing', sec.investing, report.investing, 'Net cash from investing'),
            block('Financing', sec.financing, report.financing, 'Net cash from financing'),
          ]}
          netRow={{ label: 'Net change in cash', amount: report.netChange }}
        />
      </Card>
    </div>
  )
}

/* ---- Consolidated -------------------------------------------------- */
function Consolidated({ report, ccy }) {
  const pl = report?.profitAndLoss || {}
  const bs = report?.balanceSheet || {}
  const elim = report?.eliminations || {}
  const plT = pl.totals || {}
  const bsT = bs.totals || {}
  return (
    <div className="fr-stack">
      <Card>
        <div className="fr-note">
          <div className="fr-panel-head"><span className="fr-panel-title">Inter-company eliminations</span>
            <span style={{ marginLeft: 'auto' }}>
              <StatusChip tone={elim.balanced ? 'success' : 'danger'}>
                {elim.balanced ? 'RECONCILED' : 'DOES NOT TIE OUT'}
              </StatusChip>
            </span>
          </div>
          <p>
            Reciprocal control accounts 1600 (Due From) / 2600 (Due To) are excluded from the
            consolidated statements; net {formatMoney(elim.intercompanyNet, ccy)}.
          </p>
        </div>
      </Card>
      <Card>
        <div className="fr-panel-head"><span className="fr-panel-title">Consolidated profit &amp; loss</span></div>
        <Statement
          ccy={ccy}
          groups={[
            { label: 'Income', rows: pl.income, total: plT.income, totalLabel: 'Total income' },
            { label: 'Expenses', rows: pl.expense, total: plT.expense, totalLabel: 'Total expenses' },
          ]}
          netRow={{ label: 'Net profit', amount: plT.netProfit ?? ((plT.income || 0) - (plT.expense || 0)) }}
        />
      </Card>
      <Card>
        <div className="fr-panel-head"><span className="fr-panel-title">Consolidated balance sheet</span></div>
        <Statement
          ccy={ccy}
          groups={[
            { label: 'Assets', rows: bs.assets, total: bsT.assets, totalLabel: 'Total assets' },
            { label: 'Liabilities', rows: bs.liabilities, total: bsT.liabilities, totalLabel: 'Total liabilities' },
            { label: 'Equity', rows: bs.equity, total: bsT.equity, totalLabel: 'Total equity' },
          ]}
          netRow={{ label: 'Liabilities + Equity', amount: (bsT.liabilities || 0) + (bsT.equity || 0) }}
        />
      </Card>
    </div>
  )
}

/* ---- Intercompany transfer (unchanged behaviour) ------------------- */
function IntercompanyTransfer({ orgUnits, onPosted }) {
  const locations = orgUnits.filter((o) => o.unit_type !== 'GROUP')
  const [fromLoc, setFromLoc] = useState('')
  const [toLoc, setToLoc] = useState('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [date, setDate] = useState(todayISO())
  const [memo, setMemo] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [err, setErr] = useState('')
  const [transfers, setTransfers] = useState([])

  const loadTransfers = () => {
    api.get('/intercompany/transfers').then((res) => setTransfers(res.data.data || [])).catch(() => {})
  }
  useEffect(loadTransfers, [])

  const submit = async (e) => {
    e.preventDefault()
    setErr('')
    setResult(null)
    if (!fromLoc || !toLoc || !amount || !currency) {
      setErr('From, To, amount and currency are required.')
      return
    }
    setBusy(true)
    try {
      const res = await api.post('/intercompany/transfers', {
        from_location_id: Number(fromLoc),
        to_location_id: Number(toLoc),
        amount: Number(amount),
        currency,
        date,
        memo,
      })
      setResult(res.data.data)
      setAmount('')
      setMemo('')
      loadTransfers()
      onPosted && onPosted()
    } catch (e2) {
      setErr(e2.response?.data?.message || e2.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card style={{ marginBottom: 16 }}>
      <strong>Intercompany transfer</strong>
      <p className="text-muted text-sm">
        Posts two balanced, hash-chained entries (Dr 1600 / Cr Bank on the source; Dr Bank / Cr 2600 on
        the destination) linked by one transfer number. These net to zero on consolidation.
      </p>
      <form onSubmit={submit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          From location
          <select className="filter-select" value={fromLoc} onChange={(e) => setFromLoc(e.target.value)}>
            <option value="">Select…</option>
            {locations.map((o) => (
              <option key={o.id} value={o.id}>{o.name} ({o.unit_type})</option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          To location
          <select className="filter-select" value={toLoc} onChange={(e) => setToLoc(e.target.value)}>
            <option value="">Select…</option>
            {locations.map((o) => (
              <option key={o.id} value={o.id}>{o.name} ({o.unit_type})</option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          Amount
          <input type="number" step="0.01" min="0" className="filter-select" value={amount}
            onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          Currency
          <input className="filter-select" style={{ width: 90 }} value={currency}
            onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
          Date
          <input type="date" className="filter-select" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12, flex: 1, minWidth: 160 }}>
          Memo
          <input className="filter-select" value={memo} onChange={(e) => setMemo(e.target.value)} />
        </label>
        <button className="primary-btn" type="submit" disabled={busy}>
          {busy ? 'Posting…' : 'Post transfer'}
        </button>
      </form>
      {err && <p className="text-muted" style={{ color: 'var(--danger-text)' }}>{err}</p>}
      {result && (
        <p style={{ color: 'var(--success-text)', fontWeight: 600 }}>
          ✓ Posted {result.transferNo} — entries #{result.fromEntryId} (out) / #{result.toEntryId} (in).
        </p>
      )}
      {transfers.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="saas-table">
            <thead>
              <tr>
                <th>Transfer #</th><th>From</th><th>To</th>
                <th style={{ textAlign: 'right' }}>Amount</th><th>Date</th>
              </tr>
            </thead>
            <tbody>
              {transfers.slice(0, 8).map((t) => (
                <tr key={t.id}>
                  <td className="td-mono">{t.transfer_no}</td>
                  <td>{t.from_location_name}</td>
                  <td>{t.to_location_name}</td>
                  <td className="td-mono" style={{ textAlign: 'right' }}>{formatMoney(t.amount, t.currency)}</td>
                  <td>{fmtDate(t.transfer_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

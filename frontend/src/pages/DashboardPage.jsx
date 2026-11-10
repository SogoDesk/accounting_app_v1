import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, XAxis, Tooltip, CartesianGrid,
} from 'recharts'
import api from '../services/api'
import { useToast } from '../context/ToastContext'
import { useEntity } from '../context/EntityContext'
import { useTheme } from '../context/ThemeContext'
import { useAuth } from '../context/AuthContext'
import { Card, StatCard, PanelHeader, StatusChip, chartColors, currencySymbol } from '../components/ui'
import './DashboardPage.css'

// "USD per 1 unit of currency" — a fallback used only when live rates aren't in
// the data. GBP ~1.334 tracks the ~0.75 USD->GBP seeded rate.
const USD_FALLBACK_RATE = { USD: 1, INR: 0.012, EUR: 1.08, GBP: 1.334, AED: 0.272, SGD: 0.74, JPY: 0.0067, HKD: 0.128, CAD: 0.73, AUD: 0.66 }
const toNum = (v) => { const n = Number(v || 0); return Number.isNaN(n) ? 0 : n }
const monthKey = (v) => String(v || '').slice(0, 7)
const compact = (n) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(toNum(n))
const numFmt = (n) => Math.round(toNum(n)).toLocaleString('en-US')
const money = (n, ccy = 'USD') => { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(toNum(n)) } catch { return `${ccy} ${Math.round(toNum(n)).toLocaleString()}` } }
const daysOverdue = (due) => { if (!due) return 0; const d = new Date(due), t = new Date(); d.setHours(0, 0, 0, 0); t.setHours(0, 0, 0, 0); return Math.max(0, Math.floor((t - d) / 86400000)) }
const cssVar = (name) => { try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888' } catch { return '#888' } }
const CHART6 = '#f0a05a'
const initialsOf = (name) => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '—'

const PERIODS = [
  { value: 'all', label: 'All time' }, { value: 'month', label: 'This month' },
  { value: 'quarter', label: 'This quarter' }, { value: 'year', label: 'This year' },
]
const getRange = (p) => {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth(), iso = (d) => d.toISOString().slice(0, 10)
  if (p === 'month') return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) }
  if (p === 'quarter') { const q = Math.floor(m / 3) * 3; return { from: iso(new Date(y, q, 1)), to: iso(new Date(y, q + 3, 0)) } }
  if (p === 'year') return { from: iso(new Date(y, 0, 1)), to: iso(new Date(y, 11, 31)) }
  return { from: '', to: '' }
}
const inRange = (v, from, to) => { const k = String(v || '').slice(0, 10); if (!k) return false; if (from && k < from) return false; if (to && k > to) return false; return true }

const ACTIONS = [
  { label: 'Create invoice', to: '/invoices?action=create', icon: 'plus', filled: true },
  { label: 'Record payment', to: '/payments?action=create', icon: 'card' },
  { label: 'New bill', to: '/bills?action=create', icon: 'doc' },
  { label: 'Add expense', to: '/expenses', icon: 'card' },
  { label: 'New placement', to: '/placements?action=create', icon: 'user' },
  { label: 'Log timesheet', to: '/timesheets', icon: 'clock' },
]

// Inline stroked icons (24×24, currentColor) — no icon dependency.
const Ico = ({ d, size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
)
const ICONS = {
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  card: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18" /></>,
  doc: <><path d="M14 3v5h5" /><path d="M8 3h6l5 5v11a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 20a8 8 0 0 1 16 0" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  alert: <><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9 2.4 18a1.9 1.9 0 0 0 1.7 2.9h15.8a1.9 1.9 0 0 0 1.7-2.9L13.7 3.9a1.9 1.9 0 0 0-3.4 0Z" /></>,
  check: <><path d="M20 6 9 17l-5-5" /></>,
  bolt: <><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" /></>,
  download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>,
  chevron: <><path d="m6 9 6 6 6-6" /></>,
  arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
}

export default function DashboardPage() {
  const toast = useToast()
  const { user } = useAuth()
  const { accent, dark } = useTheme()
  // The dashboard switcher IS the app-wide entity default — every other page
  // seeds its own filter from this.
  const { entityId: regionId, setEntityId: setRegionId } = useEntity()
  const [period, setPeriod] = useState('all')
  const [quickOpen, setQuickOpen] = useState(false)
  const [regions, setRegions] = useState([])
  const [invoices, setInvoices] = useState([])
  const [payments, setPayments] = useState([])
  const [bills, setBills] = useState([])
  const [vendorPayments, setVendorPayments] = useState([])
  // Company group currency the backend consolidated the *_reporting fields into.
  const [reportingCurrency, setReportingCurrency] = useState('USD')
  const [expSummary, setExpSummary] = useState(null)
  const [expByCat, setExpByCat] = useState([])

  useEffect(() => {
    // The dashboard KPIs sum rows client-side, so load the full sets — invoices
    // is the only paginated list (default 100), which silently undercut the KPIs.
    Promise.all([api.get('/regions'), api.get('/invoices', { params: { limit: 2000 } }), api.get('/payments'), api.get('/bills'), api.get('/vendor-payments')])
      .then(([r, i, p, b, v]) => {
        const regionRows = r.data?.data || []
        setRegions(regionRows)
        if (regionId && !regionRows.some((row) => String(row.id) === String(regionId))) setRegionId('')
        setInvoices(i.data?.data || []); setPayments(p.data?.data || []); setBills(b.data?.data || []); setVendorPayments(v.data?.data || [])
        setReportingCurrency(i.data?.reporting_currency || b.data?.reporting_currency || 'USD')
      })
      .catch((e) => toast.error(e.response?.data?.message || 'Failed to load dashboard'))
  }, [])

  useEffect(() => {
    const params = regionId ? { entityId: regionId } : {}
    api.get('/expenses/reports/summary', { params }).then((r) => setExpSummary(r.data.data || null)).catch(() => {})
    api.get('/expenses/reports/by-category', { params: { ...params, year: new Date().getFullYear() } }).then((r) => setExpByCat(r.data.data || [])).catch(() => {})
  }, [regionId])

  const activeRegion = useMemo(() => regions.find((r) => String(r.id) === String(regionId)) || null, [regions, regionId])
  const isAll = !regionId
  // Display currency: consolidated view = the company group (reporting) currency;
  // a single entity = its book (functional) currency.
  const ccy = isAll ? reportingCurrency : (activeRegion?.functional_currency || activeRegion?.default_currency || 'USD')

  const rateMap = useMemo(() => {
    const map = { ...USD_FALLBACK_RATE }
    ;[...payments].sort((a, b) => new Date(b.payment_date || 0) - new Date(a.payment_date || 0)).forEach((row) => {
      const code = String(row.currency || '').toUpperCase(), rate = toNum(row.exchange_rate)
      if (code && code !== 'USD' && rate > 0 && !map[code]) map[code] = rate
    })
    return map
  }, [payments])
  // Convert a record's amount from its transaction currency into the display currency.
  const conv = (amt, currency) => {
    const from = String(currency || 'USD').toUpperCase()
    if (from === ccy) return toNum(amt)
    const usdPerFrom = rateMap[from] || 1
    const usdPerCcy = rateMap[ccy] || 1
    return toNum(amt) * usdPerFrom / usdPerCcy
  }
  // Consolidated (All regions) → the backend's group-currency *_reporting field
  // (rates from the exchange_rates table, so mixed £/₹/$ are never summed raw).
  // A single region → its native amount converted to the region's book currency.
  const convRow = (row, nativeField, reportingField) => (
    isAll ? toNum(row[reportingField]) : conv(row[nativeField], row.currency)
  )

  const range = useMemo(() => getRange(period), [period])
  const fInv = useMemo(() => invoices.filter((r) => isAll || String(r.region_id) === String(regionId)).filter((r) => (!range.from && !range.to) || inRange(r.invoice_date, range.from, range.to)), [invoices, regionId, isAll, range])
  const fPay = useMemo(() => payments.filter((r) => isAll || r.region_name === activeRegion?.region_name).filter((r) => (!range.from && !range.to) || inRange(r.payment_date, range.from, range.to)), [payments, regionId, isAll, activeRegion, range])
  const fBill = useMemo(() => bills.filter((r) => isAll || String(r.region_id) === String(regionId)).filter((r) => (!range.from && !range.to) || inRange(r.bill_date, range.from, range.to)), [bills, regionId, isAll, range])
  const fVpay = useMemo(() => vendorPayments.filter((r) => isAll || String(r.region_id) === String(regionId)).filter((r) => (!range.from && !range.to) || inRange(r.payment_date, range.from, range.to)), [vendorPayments, regionId, isAll, range])

  const m = useMemo(() => {
    const invoiced = fInv.reduce((s, r) => s + convRow(r, 'total_amount', 'total_amount_reporting'), 0)
    const receivables = fInv.reduce((s, r) => s + convRow(r, 'balance_outstanding', 'balance_outstanding_reporting'), 0)
    const collected = fPay.reduce((s, r) => s + convRow(r, 'amount_received', 'amount_received_reporting'), 0)
    const payables = fBill.reduce((s, r) => s + convRow(r, 'balance_outstanding', 'balance_outstanding_reporting'), 0)
    const billsTotal = fBill.reduce((s, r) => s + convRow(r, 'total_amount', 'total_amount_reporting'), 0)
    const cashOut = fVpay.reduce((s, r) => s + convRow(r, 'amount_paid', 'amount_paid_reporting'), 0)
    const overdueAr = fInv.filter((r) => daysOverdue(r.due_date) > 0 && toNum(r.balance_outstanding) > 0).reduce((s, r) => s + convRow(r, 'balance_outstanding', 'balance_outstanding_reporting'), 0)
    const notDueAr = Math.max(0, receivables - overdueAr)
    return { invoiced, receivables, collected, payables, billsTotal, cashOut, overdueAr, notDueAr }
  }, [fInv, fPay, fBill, fVpay, isAll, rateMap])

  const expensesTotal = toNum(expSummary?.total)
  const pnl = useMemo(() => {
    const income = m.invoiced
    const expenses = expensesTotal + m.billsTotal
    return { income, expenses, net: income - expenses }
  }, [m, expensesTotal])
  const grossMargin = pnl.income > 0 ? (pnl.net / pnl.income * 100) : 0

  // AR ageing (5 raw buckets → donut merges the two oldest into "60+").
  const arAging = useMemo(() => {
    const b = [0, 0, 0, 0, 0]
    fInv.forEach((r) => { const bal = convRow(r, 'balance_outstanding', 'balance_outstanding_reporting'); if (bal <= 0) return; const d = daysOverdue(r.due_date); b[d <= 0 ? 0 : d <= 30 ? 1 : d <= 60 ? 2 : d <= 90 ? 3 : 4] += bal })
    return b
  }, [fInv, isAll, rateMap])

  const cc = useMemo(() => chartColors(accent, dark), [accent, dark])
  const ageDonut = useMemo(() => ([
    { name: 'Current', value: arAging[0], color: cc.series[0] },
    { name: '1–30', value: arAging[1], color: cc.series[1] },
    { name: '31–60', value: arAging[2], color: CHART6 },
    { name: '60+', value: arAging[3] + arAging[4], color: cssVar('--danger') },
  ]), [arAging, cc, dark, accent])

  // Trailing 12-month revenue vs. expense series (+ monthly cash-in for deltas/forecast).
  const chart = useMemo(() => {
    const map = new Map(), keys = []
    for (let i = 11; i >= 0; i--) { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i); const k = d.toISOString().slice(0, 7); keys.push(k); map.set(k, { k, revenue: 0, expense: 0, cashIn: 0 }) }
    fInv.forEach((r) => { const k = monthKey(r.invoice_date); if (map.has(k)) map.get(k).revenue += convRow(r, 'total_amount', 'total_amount_reporting') })
    fBill.forEach((r) => { const k = monthKey(r.bill_date); if (map.has(k)) map.get(k).expense += convRow(r, 'total_amount', 'total_amount_reporting') })
    fPay.forEach((r) => { const k = monthKey(r.payment_date); if (map.has(k)) map.get(k).cashIn += convRow(r, 'amount_received', 'amount_received_reporting') })
    return keys.map((k) => { const row = map.get(k); const [y, mo] = k.split('-'); return { label: new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'short' }), revenue: Math.round(row.revenue), expense: Math.round(row.expense), cashIn: Math.round(row.cashIn) } })
  }, [fInv, fBill, fPay, isAll, rateMap])

  const revYtd = useMemo(() => chart.reduce((s, r) => s + r.revenue, 0), [chart])
  const expYtd = useMemo(() => chart.reduce((s, r) => s + r.expense, 0), [chart])
  const mom = (key) => { const n = chart.length; if (n < 2) return undefined; const cur = chart[n - 1][key], prev = chart[n - 2][key]; if (!prev) return undefined; const pct = (cur - prev) / prev * 100; return { dir: pct >= 0 ? 'up' : 'down', value: `${Math.abs(pct).toFixed(1)}%`, text: 'vs last month' } }
  const forecast = useMemo(() => { const nz = chart.slice(-3).map((r) => r.cashIn).filter((v) => v > 0); return nz.length ? nz.reduce((a, b) => a + b, 0) / nz.length : m.collected }, [chart, m])

  const dso = m.invoiced > 0 ? Math.round(m.receivables / m.invoiced * 365) : 0
  const collRate = m.invoiced > 0 ? (m.collected / m.invoiced * 100) : 0
  const badDebt = m.receivables > 0 ? ((arAging[3] + arAging[4]) / m.receivables * 100) : 0

  // Top clients by open (converted) balance.
  const topClients = useMemo(() => {
    const map = new Map()
    fInv.forEach((r) => {
      const bal = convRow(r, 'balance_outstanding', 'balance_outstanding_reporting'); if (bal <= 0) return
      const name = r.client_name || r.client || '—'
      const cur = map.get(name) || { name, bal: 0, region: r.region_name || '', n: 0 }
      cur.bal += bal; cur.n += 1; if (!cur.region && r.region_name) cur.region = r.region_name; map.set(name, cur)
    })
    return [...map.values()].sort((a, b) => b.bal - a.bal).slice(0, 4)
  }, [fInv, isAll, rateMap])

  // Needs attention — aggregate rows built from live AR/AP data.
  const attention = useMemo(() => {
    const overdue = fInv.filter((r) => daysOverdue(r.due_date) > 0 && toNum(r.balance_outstanding) > 0)
    const overdueSum = overdue.reduce((s, r) => s + convRow(r, 'balance_outstanding', 'balance_outstanding_reporting'), 0)
    const overdueClients = new Set(overdue.map((r) => r.client_name || r.client)).size
    const pendingBills = bills.filter((b) => (isAll || String(b.region_id) === String(regionId)) && String(b.approval_status || '').toUpperCase() === 'PENDING')
    const pendingSum = pendingBills.reduce((s, b) => s + convRow(b, 'total_amount', 'total_amount_reporting'), 0)
    const dueSoon = fInv.filter((r) => { const bal = toNum(r.balance_outstanding); if (bal <= 0 || !r.due_date) return false; const di = Math.ceil((new Date(r.due_date) - new Date()) / 86400000); return di >= 0 && di <= 7 })
    const dueSum = dueSoon.reduce((s, r) => s + convRow(r, 'balance_outstanding', 'balance_outstanding_reporting'), 0)
    const out = []
    if (overdue.length) out.push({ id: 'ov', icon: 'alert', tone: 'danger', title: `${overdue.length} invoices overdue`, sub: `${money(overdueSum, ccy)} across ${overdueClients} client${overdueClients === 1 ? '' : 's'}`, to: '/invoices?scope=overdue' })
    if (pendingBills.length) out.push({ id: 'ap', icon: 'check', tone: 'warn', title: `${pendingBills.length} bills awaiting approval`, sub: `${money(pendingSum, ccy)} · FINANCE_ADMIN`, to: '/approvals' })
    if (dueSoon.length) out.push({ id: 'du', icon: 'clock', tone: 'accent', title: `${dueSoon.length} invoices due within 7 days`, sub: `${money(dueSum, ccy)} not yet due`, to: '/invoices?scope=outstanding' })
    out.push({ id: 'pl', icon: 'doc', tone: 'neutral', title: `${money(m.payables, ccy)} payables open`, sub: `${fBill.length} bills in ${PERIODS.find((p) => p.value === period)?.label.toLowerCase()}`, to: '/bills' })
    return out.slice(0, 4)
  }, [fInv, fBill, bills, regionId, isAll, rateMap, ccy, m, period])

  const range12Ok = chart.length > 0
  const hour = new Date().getHours()
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const fullName = user?.fullName || user?.full_name || ''
  const firstName = (fullName || 'there').trim().split(/\s+/)[0]
  const regionNames = isAll ? regions.map((r) => r.region_name).filter(Boolean) : [activeRegion?.region_name].filter(Boolean)
  const regionText = regionNames.length ? regionNames.slice(0, 4).join(', ') : 'all entities'
  const periodLabel = PERIODS.find((p) => p.value === period)?.label
  const sym = currencySymbol(ccy)
  const tip = { borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12, fontFamily: 'var(--font-mono)' }

  return (
    <div className="dash">
      {/* Page header */}
      <header className="dash-head">
        <div className="dash-head-l">
          <h1 className="dash-title">{greet}, {firstName}</h1>
          <p className="dash-sub">Group position across {regionText}{isAll ? ' · consolidated USD' : ''} · {periodLabel} period is open.</p>
        </div>
        <div className="dash-head-r">
          {/* Region/entity is now driven app-wide by the top-bar region pill
              (EntityContext). This page reads that selection via `regionId`. */}
          <label className="dash-picker">
            <span className="dash-picker-ico"><Ico d={ICONS.chevron} size={15} /></span>
            <select className="dash-picker-sel" value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Period">
              {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>
          <button type="button" className="dash-btn dash-btn-ghost" onClick={() => toast.info?.('Export queued')}>
            <Ico d={ICONS.download} size={15} /> Export
          </button>
          <div className="dash-quick">
            <button
              type="button"
              className="dash-btn dash-btn-primary"
              aria-haspopup="menu"
              aria-expanded={quickOpen}
              onClick={() => setQuickOpen((v) => !v)}
            >
              <Ico d={ICONS.plus} size={15} /> Quick create
              <Ico d={ICONS.chevron} size={14} />
            </button>
            {quickOpen ? (
              <>
                <div className="dash-quick-backdrop" onClick={() => setQuickOpen(false)} />
                <div className="dash-quick-menu" role="menu">
                  <Link to="/invoices?action=create" className="dash-quick-item" role="menuitem" onClick={() => setQuickOpen(false)}>
                    <span className="dash-quick-ico"><Ico d={ICONS.plus} size={15} /></span>
                    Create invoice
                  </Link>
                  <Link to="/bills?action=create" className="dash-quick-item" role="menuitem" onClick={() => setQuickOpen(false)}>
                    <span className="dash-quick-ico"><Ico d={ICONS.doc} size={15} /></span>
                    Create bill
                  </Link>
                  <Link to="/expenses?action=create" className="dash-quick-item" role="menuitem" onClick={() => setQuickOpen(false)}>
                    <span className="dash-quick-ico"><Ico d={ICONS.card} size={15} /></span>
                    Add expense
                  </Link>
                </div>
              </>
            ) : null}
          </div>
        </div>
      </header>

      {/* KPI row */}
      <section className="dash-kpis">
        <StatCard label="Invoiced" prefix={sym} value={numFmt(m.invoiced)} delta={mom('revenue')} />
        <StatCard label="Receivables" prefix={sym} value={numFmt(m.receivables)} sub={`${money(m.overdueAr, ccy)} overdue`} />
        <StatCard label="Collected" prefix={sym} value={numFmt(m.collected)} delta={mom('cashIn')} />
        <StatCard label="Payables" prefix={sym} value={numFmt(m.payables)} sub={`${fBill.length} open bills`} />
        <StatCard label="Gross margin" value={grossMargin.toFixed(1)} unit="%" sub={`${money(pnl.net, ccy)} net`} />
      </section>

      {/* Row 2 — Revenue vs expense + AR ageing */}
      <section className="dash-r2">
        <Card className="dash-card">
          <PanelHeader title="Revenue vs. expense" actions={<span className="dash-meta">Last 12 months · {isAll ? 'USD' : ccy}</span>} />
          <div className="dash-legend">
            <span className="dash-sw" style={{ background: cc.gradientTo }} />Revenue
            <span className="dash-sw" style={{ background: cc.series[2], marginLeft: 16 }} />Expense
          </div>
          <div className="dash-chart" style={{ height: 150 }}>
            {range12Ok && (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chart} barGap={3} barCategoryGap="24%" margin={{ top: 6, right: 4, left: 4, bottom: 0 }}>
                  <defs>
                    <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={cc.gradientFrom} />
                      <stop offset="100%" stopColor={cc.gradientTo} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={cc.grid} vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: cc.axis, fontFamily: 'var(--font-mono)' }} axisLine={false} tickLine={false} interval={0} />
                  <Tooltip cursor={{ fill: 'var(--surface-sunken)' }} formatter={(v, n) => [money(v, ccy), n === 'revenue' ? 'Revenue' : 'Expense']} contentStyle={tip} />
                  <Bar dataKey="revenue" fill="url(#revGrad)" radius={[5, 5, 2, 2]} maxBarSize={13} />
                  <Bar dataKey="expense" fill={cc.series[2]} radius={[5, 5, 2, 2]} maxBarSize={13} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
          <div className="dash-sumrow">
            <div className="dash-sum"><span className="dash-sum-k">Revenue YTD</span><span className="dash-sum-v">{sym}{compact(revYtd)}</span></div>
            <div className="dash-sum"><span className="dash-sum-k">Expense YTD</span><span className="dash-sum-v">{sym}{compact(expYtd)}</span></div>
            <div className="dash-sum"><span className="dash-sum-k">Net</span><span className="dash-sum-v" style={{ color: (revYtd - expYtd) >= 0 ? 'var(--success-text)' : 'var(--danger-text)' }}>{sym}{compact(revYtd - expYtd)}</span></div>
          </div>
        </Card>

        <Card className="dash-card">
          <PanelHeader title="AR ageing" actions={<Link to="/invoices" className="dash-meta dash-link">View all</Link>} />
          <div className="dash-donut-wrap">
            <div className="dash-donut">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={ageDonut.filter((d) => d.value > 0)} dataKey="value" nameKey="name" innerRadius={48} outerRadius={70} paddingAngle={2} stroke="none">
                    {ageDonut.filter((d) => d.value > 0).map((d) => <Cell key={d.name} fill={d.color} />)}
                  </Pie>
                  <Tooltip formatter={(v) => money(v, ccy)} contentStyle={tip} />
                </PieChart>
              </ResponsiveContainer>
              <div className="dash-donut-center"><span className="dash-donut-total">{sym}{compact(m.receivables)}</span><span className="dash-donut-cap">Open AR</span></div>
            </div>
            <div className="dash-donut-legend">
              {ageDonut.map((d) => (
                <div key={d.name} className="dash-lg-row">
                  <span className="dash-lg-dot" style={{ background: d.color }} />
                  <span className="dash-lg-k">{d.name}</span>
                  <span className="dash-lg-v">{money(d.value, ccy)}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="dash-stat3">
            <div><span className="dash-s3-k">DSO</span><span className="dash-s3-v">{dso}<em> d</em></span></div>
            <div><span className="dash-s3-k">Collection rate</span><span className="dash-s3-v">{collRate.toFixed(1)}%</span></div>
            <div><span className="dash-s3-k">Bad debt</span><span className="dash-s3-v">{badDebt.toFixed(1)}%</span></div>
          </div>
          <div className="dash-forecast">
            <span className="dash-fc-ico"><Ico d={ICONS.arrow} size={16} /></span>
            <span className="dash-fc-main"><span className="dash-fc-t">Forecast collections</span><span className="dash-fc-s">Next 30 days, at current pace</span></span>
            <span className="dash-fc-amt">{money(forecast, ccy)}</span>
          </div>
        </Card>
      </section>

      {/* Row 3 — Top clients · Needs attention · Quick actions */}
      <section className="dash-r3">
        <Card className="dash-card">
          <PanelHeader title="Top clients by open balance" actions={<Link to="/invoices" className="dash-meta dash-link">View all</Link>} />
          <div className="dash-clients">
            {topClients.length === 0 ? <div className="dash-empty">No open balances.</div> : topClients.map((c) => (
              <div key={c.name} className="dash-client">
                <span className="dash-avatar">{initialsOf(c.name)}</span>
                <span className="dash-client-main"><span className="dash-client-name">{c.name}</span><span className="dash-client-sub">{c.region || `${c.n} invoice${c.n === 1 ? '' : 's'}`}</span></span>
                <span className="dash-client-amt">{money(c.bal, ccy)}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card className="dash-card">
          <PanelHeader title="Needs attention" />
          <div className="dash-attn">
            {attention.map((a) => (
              <Link key={a.id} to={a.to} className="dash-attn-row">
                <span className={`dash-attn-ico tone-${a.tone}`}><Ico d={ICONS[a.icon]} size={16} /></span>
                <span className="dash-attn-main"><span className="dash-attn-t">{a.title}</span><span className="dash-attn-s">{a.sub}</span></span>
                <span className="dash-attn-chev"><Ico d={ICONS.chevron} size={16} /></span>
              </Link>
            ))}
          </div>
        </Card>

        <Card className="dash-card">
          <PanelHeader title="Quick actions" />
          <div className="dash-qa">
            {ACTIONS.map((a) => (
              <Link key={a.label} to={a.to} className={`dash-qa-tile${a.filled ? ' is-filled' : ''}`}>
                <span className="dash-qa-ico"><Ico d={ICONS[a.icon]} size={16} /></span>
                <span className="dash-qa-label">{a.label}</span>
              </Link>
            ))}
          </div>
          <div className="dash-qa-foot">
            <span className="dash-qa-foot-l">Signed in as <strong>{fullName || '—'}</strong></span>
            {user?.roleName ? <StatusChip tone="accent">{user.roleName}</StatusChip> : null}
          </div>
        </Card>
      </section>
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { PieChart, Pie, Cell, ResponsiveContainer, BarChart, Bar, XAxis, Tooltip } from 'recharts'
import api, { downloadFile } from '../services/api'
import { useToast } from '../context/ToastContext'
import { useEntity } from '../context/EntityContext'
import { useTheme } from '../context/ThemeContext'
import {
  Modal, Input, SearchableSelect,
  Card, StatCard, DataTable, StatusChip, PanelHeader, chartColors,
  Pagination, fmt, fmtDate, currencySymbol,
} from '../components/ui'
import QuickAddDrawer from '../components/expenses/QuickAddDrawer'
import ExpenseViewModal from '../components/ExpenseViewModal'
import './ExpensesPage.css'

const money = (n, ccy = 'USD') => {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(Number(n || 0)) }
  catch { return `${ccy} ${Math.round(Number(n || 0)).toLocaleString()}` }
}
const num0 = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })
const today = () => new Date().toISOString().slice(0, 10)
const pad2 = (n) => String(n).padStart(2, '0')
// Current month's first/last day (local, TZ-safe) — the default KPI window.
const monthStartISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-01` }
const monthEndISO = () => { const d = new Date(); const e = new Date(d.getFullYear(), d.getMonth() + 1, 0); return `${e.getFullYear()}-${pad2(e.getMonth() + 1)}-${pad2(e.getDate())}` }
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const emptyForm = {
  entity_id: '', expense_date: today(), category_id: '', description: '',
  amount: '', gst_amount: '0', tds_amount: '0', payment_method_id: '',
  is_reimbursable: false, paid_by: '', expense_type: 'VARIABLE', currency: 'INR',
}

// Small inline icons (stroked 24×24, currentColor) ------------------
const BackIcon = () => (<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>)
const PlusIcon = () => (<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>)
const ReportIcon = () => (<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>)
const DownloadIcon = () => (<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 21h16" /></svg>)
const KebabIcon = () => (<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><circle cx="12" cy="5" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="12" cy="19" r="1.7" /></svg>)
const WarnIcon = () => (<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></svg>)
const SearchIcon = () => (<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>)
const EyeIcon = () => (<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>)
const EditIcon = () => (<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>)
const TrashIcon = () => (<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M10 11v6M14 11v6" /></svg>)

export default function ExpensesPage() {
  const toast = useToast()
  const navigate = useNavigate()
  const { accent, dark } = useTheme()
  const [ready, setReady] = useState(true)
  const [message, setMessage] = useState('')
  const [rows, setRows] = useState([])
  const [meta, setMeta] = useState({ total: 0, grandTotal: 0, currency: 'USD' })
  const [summary, setSummary] = useState(null)
  const [regions, setRegions] = useState([])
  const [categories, setCategories] = useState([])
  const [methods, setMethods] = useState([])
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [searchParams, setSearchParams] = useSearchParams()
  // A category drill-down from Monthly Summary passes `type=` (empty) to mean
  // "all types". Only default to VARIABLE when the param is absent entirely.
  const initialType = searchParams.has('type') ? searchParams.get('type') : 'VARIABLE'
  // Entity is driven by the global top-nav switcher (no per-page dropdown).
  const { entityId } = useEntity()
  const [filters, setFilters] = useState({ categoryId: searchParams.get('categoryId') || '', status: '', type: initialType, from: '', to: '' })
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [exporting, setExporting] = useState(false)
  const [viewExpense, setViewExpense] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting, setDeleting] = useState(false)

  // Open the create form when arrived via `?action=create` (e.g. the dashboard
  // Quick-create menu), then strip the param so a re-render doesn't reopen it.
  useEffect(() => {
    if (searchParams.get('action') !== 'create') return
    setEditId(null)
    setForm(emptyForm)
    setError('')
    setShowForm(true)
    const next = new URLSearchParams(searchParams)
    next.delete('action')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  // Inline "type-to-create" side drawers (mirror the invoice form pattern).
  const [catDrawer, setCatDrawer] = useState({ open: false, name: '' })
  const [pmDrawer, setPmDrawer] = useState({ open: false, name: '' })

  useEffect(() => {
    api.get('/regions').then((r) => setRegions(r.data.data || [])).catch(() => {})
    api.get('/expenses/categories').then((r) => { setReady(r.data.ready !== false); setMessage(r.data.message || ''); setCategories(r.data.data || []) }).catch(() => {})
    api.get('/expenses/payment-methods').then((r) => setMethods(r.data.data || [])).catch(() => {})
    api.get('/gl/chart-of-accounts').then((r) => setAccounts((r.data.data || []).filter((a) => ['EXPENSE', 'ASSET'].includes(a.account_type)))).catch(() => {})
  }, [])

  // Debounce the free-text search so we don't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1) }, 350)
    return () => clearTimeout(t)
  }, [searchInput])

  // The expenses list reacts to filters, search and page.
  useEffect(() => {
    setLoading(true)
    const params = { page, limit: pageSize }
    Object.entries(filters).forEach(([k, v]) => { if (v) params[k] = v })
    if (entityId) params.entityId = entityId
    if (search) params.search = search
    api.get('/expenses', { params })
      .then((r) => {
        setReady(r.data.ready !== false)
        setRows(r.data.data || [])
        setMeta({ total: r.data.pagination?.total || 0, grandTotal: r.data.grandTotal || 0, currency: r.data.currency || 'USD' })
      })
      .catch((e) => setError(e.response?.data?.message || e.message))
      .finally(() => setLoading(false))
  }, [filters, entityId, search, page, pageSize])

  // The KPI strip is month-scoped: it shows the CURRENT month by default (not an
  // all-time running total), and honours an explicit From/To range if the user
  // sets one. Tracks the selected entity too (not category/status/search).
  const kpiFrom = filters.from || monthStartISO()
  const kpiTo = filters.to || monthEndISO()
  const loadSummary = () => {
    const params = { from: kpiFrom, to: kpiTo }
    if (entityId) params.entityId = entityId
    return api.get('/expenses/reports/summary', { params }).then((r) => setSummary(r.data.data || null)).catch(() => {})
  }
  useEffect(() => { loadSummary() }, [entityId, kpiFrom, kpiTo])

  const set = (k) => (e) => { setFilters((f) => ({ ...f, [k]: e.target.value })); setPage(1) }
  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  // Month picker → scopes the whole page (KPIs, list, charts) to one month by
  // setting the From/To range. Empty clears back to the default view.
  const monthValue = (filters.from && filters.to && filters.from.slice(0, 7) === filters.to.slice(0, 7)) ? filters.from.slice(0, 7) : ''
  const pickMonth = (ym) => {
    if (!ym) { setFilters((f) => ({ ...f, from: '', to: '' })); setPage(1); return }
    const [y, mo] = ym.split('-').map(Number)
    const end = new Date(y, mo, 0)
    setFilters((f) => ({ ...f, from: `${ym}-01`, to: `${ym}-${pad2(end.getDate())}` }))
    setPage(1)
  }

  const reload = () => setFilters((f) => ({ ...f })) // re-trigger the list effect
  const totalPages = Math.max(1, Math.ceil(meta.total / pageSize))

  const regionOptions = useMemo(() => regions.map((r) => ({ value: String(r.id), label: r.region_name })), [regions])
  const categoryOptions = useMemo(() => categories.map((c) => ({ value: String(c.id), label: c.name })), [categories])
  const methodOptions = useMemo(() => methods.map((m) => ({ value: String(m.id), label: m.name })), [methods])
  // Categories map to expense/asset accounts; payment methods to asset (bank/cash).
  const categoryAccounts = useMemo(() => accounts, [accounts])
  const paymentAccounts = useMemo(() => accounts.filter((a) => a.account_type === 'ASSET'), [accounts])

  const openCreate = () => { setEditId(null); setForm(emptyForm); setError(''); setShowForm(true) }

  const openEdit = (r) => {
    setEditId(r.id)
    setForm({
      entity_id: r.entity_id != null ? String(r.entity_id) : '',
      expense_date: fmtDate(r.expense_date) || today(),
      category_id: r.category_id != null ? String(r.category_id) : '',
      description: r.description || '',
      amount: r.amount != null ? String(r.amount) : '',
      gst_amount: r.gst_amount != null ? String(r.gst_amount) : '0',
      tds_amount: r.tds_amount != null ? String(r.tds_amount) : '0',
      payment_method_id: r.payment_method_id != null ? String(r.payment_method_id) : '',
      is_reimbursable: !!r.is_reimbursable,
      paid_by: r.paid_by || '',
      expense_type: r.expense_type || 'VARIABLE',
      currency: r.currency || 'INR',
    })
    setError('')
    setShowForm(true)
  }

  const submit = async () => {
    if (!form.entity_id || !form.category_id || !form.amount) { setError('Entity, category and amount are required'); return }
    setSaving(true); setError('')
    try {
      if (editId) await api.put(`/expenses/${editId}`, form)
      else await api.post('/expenses', form)
      setShowForm(false); setEditId(null); setForm(emptyForm)
      setPage(1); reload(); loadSummary()
      toast.success(editId ? 'Expense updated' : 'Expense recorded')
    } catch (e) { setError(e.response?.data?.message || e.message) }
    finally { setSaving(false) }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api.delete(`/expenses/${deleteTarget.id}`)
      setDeleteTarget(null)
      reload(); loadSummary()
      toast.success('Expense deleted')
    } catch (e) { toast.error(e.response?.data?.message || e.message) }
    finally { setDeleting(false) }
  }

  const reimburse = async (id) => {
    try { await api.post(`/expenses/${id}/reimburse`, {}); reload() }
    catch (e) { setError(e.response?.data?.message || e.message) }
  }

  // Export the CURRENT filtered set (all pages) to Excel, server-side.
  const exportXlsx = async () => {
    setExporting(true)
    try {
      const params = new URLSearchParams()
      Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v) })
      if (search) params.set('search', search)
      params.set('format', 'xlsx')
      const range = (filters.from || filters.to) ? `_${filters.from || 'start'}_to_${filters.to || 'end'}` : ''
      await downloadFile(`/api/expenses/export?${params.toString()}`, `expenses${range}.xlsx`)
      toast.success('Expenses exported to Excel')
    } catch { toast.error('Export failed') }
    finally { setExporting(false) }
  }

  const sCcy = summary?.currency || meta.currency || 'USD'
  const sym = currencySymbol(sCcy)
  const cc = useMemo(() => chartColors(accent, dark), [accent, dark])

  // Month label for the KPI strip: the KPI window (current month, or the filter
  // range if one is set). Shows "Mon YYYY" so a non-current month is unambiguous.
  const monthLabel = useMemo(() => {
    const dt = new Date(`${kpiTo}T00:00:00`)
    if (Number.isNaN(dt.getTime())) return ''
    const sameYear = dt.getFullYear() === new Date().getFullYear()
    return dt.toLocaleString('en-US', sameYear ? { month: 'long' } : { month: 'long', year: 'numeric' })
  }, [kpiTo])

  // ----- Derived aggregates from the loaded (filtered) rows -----------
  // Consolidated (All regions) → the per-row reporting-currency amount so mixed
  // currencies aren't raw-summed; single region → native (one currency).
  const expAmt = (r) => Number((!entityId ? r.total_amount_reporting : r.total_amount) ?? r.total_amount ?? 0)

  const catAgg = useMemo(() => {
    const m = new Map()
    for (const r of rows) {
      const k = r.category_name || 'Uncategorised'
      m.set(k, (m.get(k) || 0) + expAmt(r))
    }
    return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value)
  }, [rows, entityId])

  const regionAgg = useMemo(() => {
    const m = new Map()
    let tot = 0
    for (const r of rows) {
      const k = r.entity_name || 'Unassigned'
      const v = expAmt(r)
      m.set(k, (m.get(k) || 0) + v); tot += v
    }
    const list = [...m.entries()].map(([name, value]) => ({ name, value, pct: tot ? (value / tot) * 100 : 0 }))
    return list.sort((a, b) => b.value - a.value)
  }, [rows, entityId])

  // Monthly trend, split Fixed vs variable, derived from the loaded rows.
  const trendAgg = useMemo(() => {
    const m = new Map()
    for (const r of rows) {
      const key = String(r.expense_date || '').slice(0, 7) // YYYY-MM
      if (!/^\d{4}-\d{2}$/.test(key)) continue
      const cur = m.get(key) || { fixed: 0, variable: 0 }
      const v = expAmt(r)
      if (r.expense_type === 'FIXED') cur.fixed += v; else cur.variable += v
      m.set(key, cur)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-7).map(([key, v]) => ({
      label: MONTH_ABBR[Number(key.slice(5, 7)) - 1] || key,
      fixed: Math.round(v.fixed), variable: Math.round(v.variable), total: v.fixed + v.variable,
    }))
  }, [rows, entityId])

  const trendYtd = useMemo(() => trendAgg.reduce((s, r) => s + r.total, 0), [trendAgg])
  const trendAvg = trendAgg.length ? trendYtd / trendAgg.length : 0

  // Receipts are not a field in the expense model — derive a deterministic
  // "attached" flag from the presence of a vendor bill (see summary note).
  const hasReceipt = (r) => Boolean(r.vendor_name)
  const missingReceipts = useMemo(() => rows.filter((r) => !hasReceipt(r)).length, [rows])

  const fixedPct = summary && summary.total ? Math.round((summary.fixed / summary.total) * 100) : null

  // List-panel segmented tabs drive the expense_type filter.
  const activeTab = filters.type === 'FIXED' ? 'fixed' : (filters.type === 'VARIABLE' ? 'variable' : 'all')
  const onTab = (key) => {
    const type = key === 'fixed' ? 'FIXED' : (key === 'variable' ? 'VARIABLE' : '')
    setFilters((f) => ({ ...f, type })); setPage(1)
  }

  // ----- DataTable column definitions --------------------------------
  const columns = [
    { key: 'expense_date', header: 'Date', mono: true, width: 96, render: (r) => fmtDate(r.expense_date) },
    {
      key: 'category_name', header: 'Category', width: 150, render: (r) => (
        r.category_id
          ? <Link to={`/expenses/categories/${r.category_id}`} state={{ from: '/expenses', label: 'Expenses' }} style={{ textDecoration: 'none' }}>
              <StatusChip tone={r.expense_type === 'FIXED' ? 'neutral' : 'accent'}>{r.category_name || '—'}</StatusChip>
            </Link>
          : <StatusChip tone={r.expense_type === 'FIXED' ? 'neutral' : 'accent'}>{r.category_name || '—'}</StatusChip>
      ),
    },
    { key: 'description', header: 'Description', primary: true, render: (r) => r.description || '—' },
    { key: 'entity_name', header: 'Region', render: (r) => r.entity_name || '—' },
    { key: 'method', header: 'Method', render: (r) => (r.is_reimbursable ? `${r.paid_by || 'Staff'} (reimb.)` : (r.payment_method_name || r.vendor_name || '—')) },
    {
      key: 'receipt', header: 'Receipt', width: 100, sortAccessor: (r) => (hasReceipt(r) ? 'ATTACHED' : 'MISSING'), render: (r) => (
        hasReceipt(r) ? <StatusChip tone="success">ATTACHED</StatusChip> : <StatusChip tone="danger">MISSING</StatusChip>
      ),
    },
    { key: 'total_amount', header: 'Amount', align: 'right', mono: true, render: (r) => fmt(r.total_amount, r.currency) },
    {
      key: '_act', header: 'Actions', align: 'right', width: 156, render: (r) => (
        <div className="sg-rowacts" onClick={(e) => e.stopPropagation()}>
          {r.is_reimbursable && r.status === 'RECORDED' ? (
            <button className="sg-pager-btn" style={{ height: 30, padding: '0 10px' }} onClick={() => reimburse(r.id)}>Reimburse</button>
          ) : null}
          <button className="sg-iconbtn" title="View" aria-label="View expense" onClick={() => setViewExpense(r)}><EyeIcon /></button>
          <button className="sg-iconbtn" title="Edit" aria-label="Edit expense" onClick={() => openEdit(r)}><EditIcon /></button>
          <button className="sg-iconbtn sg-iconbtn-danger" title="Delete" aria-label="Delete expense" onClick={() => setDeleteTarget(r)}><TrashIcon /></button>
        </div>
      ),
    },
  ]

  const tableFooter = rows.length > 0 ? [
    { colSpan: 6, align: 'left', render: () => `${rows.length} of ${meta.total.toLocaleString()} ${activeTab === 'all' ? '' : activeTab + ' '}entries · ${monthLabel}` },
    { colSpan: 1, align: 'right', mono: true, render: () => money(meta.grandTotal, meta.currency) },
    { colSpan: 1 },
  ] : null

  return (
    <div className="sg-expenses">
      {/* Page header --------------------------------------------------- */}
      <div className="sg-pagehead">
        <div className="sg-pagehead-main">
          <button className="sg-back" onClick={() => navigate(-1)} aria-label="Back"><BackIcon /></button>
          <div>
            <h1 className="sg-title">Expenses</h1>
            <p className="sg-subtitle">Variable and fixed operating expenses by category and region. Recurring runs post automatically each month.</p>
          </div>
        </div>
        {ready && (
          <div className="sg-pagehead-actions">
            <Link to="/expenses/summary" className="sg-btn"><ReportIcon /> Monthly summary</Link>
            <button className="sg-btn sg-btn-primary" onClick={openCreate}><PlusIcon /> Add expense</button>
          </div>
        )}
      </div>

      {!ready ? (
        <Card>
          <div className="sg-notready">
            <h3>Expenses not enabled yet</h3>
            <p>{message || 'Apply migration 003 and restart the backend.'}</p>
          </div>
        </Card>
      ) : (
        <>
          {/* KPI row ---------------------------------------------------- */}
          <div className="sg-kpigrid">
            <StatCard
              label={`Spend — ${monthLabel}`} prefix={sym} value={num0(summary?.total)}
              sub={`${(((summary?.fixedCount || 0) + (summary?.variableCount || 0))).toLocaleString()} entries this month`}
            />
            <StatCard
              label="Fixed / recurring" prefix={sym} value={num0(summary?.fixed)}
              sub={`${fixedPct != null ? fixedPct + '% of total · ' : ''}${summary?.fixedCount || 0} schedules`}
            />
            <StatCard
              label="Variable" prefix={sym} value={num0(summary?.variable)}
              sub={`${summary?.variableCount || 0} entries this month`}
            />
            <StatCard
              label="Vs. budget" value="—"
              sub="Budget not configured"
            />
          </div>

          {/* Analysis row: category / trend / region ------------------- */}
          <div className="sg-cardrow">
            {/* By category donut */}
            <Card>
              <div className="sg-cardtitle-row">
                <span className="sg-cardtitle">By category · {monthLabel}</span>
              </div>
              {catAgg.length === 0 ? (
                <div style={{ color: 'var(--muted)', fontSize: 12 }}>No spend to chart yet.</div>
              ) : (
                <div className="sg-donutwrap">
                  <div className="sg-donut">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={catAgg} dataKey="value" nameKey="name" innerRadius={48} outerRadius={70} paddingAngle={2} stroke="none">
                          {catAgg.map((_, i) => <Cell key={i} fill={cc.series[i % cc.series.length]} />)}
                        </Pie>
                        <Tooltip
                          formatter={(v) => fmt(v, sCcy)}
                          contentStyle={{ background: 'var(--surface)', border: '1px solid var(--surface-border)', borderRadius: 12, fontSize: 12, color: 'var(--ink)' }}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="sg-legend">
                    {catAgg.slice(0, 6).map((c, i) => (
                      <div className="sg-legend-item" key={c.name}>
                        <span className="sg-legend-dot" style={{ background: cc.series[i % cc.series.length] }} />
                        <span className="sg-legend-name">{c.name}</span>
                        <span className="sg-legend-val">{num0(c.value)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            {/* Monthly trend */}
            <Card>
              <div className="sg-cardtitle-row">
                <span className="sg-cardtitle">Monthly trend</span>
                <span className="sg-cardtitle-meta">Fixed vs variable</span>
              </div>
              {trendAgg.length === 0 ? (
                <div style={{ color: 'var(--muted)', fontSize: 12 }}>No trend data.</div>
              ) : (
                <div style={{ width: '100%', height: 150 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={trendAgg} barCategoryGap="28%" margin={{ top: 6, right: 4, left: 4, bottom: 0 }}>
                      <defs>
                        <linearGradient id="sgExpBar" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor={cc.gradientFrom} />
                          <stop offset="100%" stopColor={cc.gradientTo} />
                        </linearGradient>
                      </defs>
                      <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fill: cc.axis, fontSize: 10 }} />
                      <Tooltip
                        cursor={{ fill: 'var(--surface-sunken)' }}
                        formatter={(v) => [fmt(v, sCcy), 'Total']}
                        contentStyle={{ background: 'var(--surface)', border: '1px solid var(--surface-border)', borderRadius: 12, fontSize: 12, color: 'var(--ink)' }}
                      />
                      <Bar dataKey="total" radius={[5, 5, 2, 2]}>
                        {trendAgg.map((_, i) => (
                          <Cell key={i} fill={i === trendAgg.length - 1 ? 'url(#sgExpBar)' : cc.series[2]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              <div className="sg-trend-foot">
                <div>
                  <div className="sg-metric-label">Avg. monthly</div>
                  <div className="sg-metric-val">{sym}{num0(trendAvg)}</div>
                </div>
                <div>
                  <div className="sg-metric-label">YTD</div>
                  <div className="sg-metric-val">{sym}{num0(trendYtd)}</div>
                </div>
              </div>
            </Card>

            {/* By region */}
            <Card>
              <div className="sg-cardtitle-row">
                <span className="sg-cardtitle">By region</span>
              </div>
              {regionAgg.length === 0 ? (
                <div style={{ color: 'var(--muted)', fontSize: 12 }}>No regional spend.</div>
              ) : (
                <div className="sg-region-list">
                  {regionAgg.slice(0, 4).map((r) => (
                    <div key={r.name}>
                      <div className="sg-region-head">
                        <span className="sg-region-name">{r.name}</span>
                        <span className="sg-region-amt">{num0(r.value)}</span>
                        <span className="sg-region-pct">{Math.round(r.pct)}%</span>
                      </div>
                      <div className="sg-region-track"><div className="sg-region-fill" style={{ width: `${Math.max(2, Math.round(r.pct))}%` }} /></div>
                    </div>
                  ))}
                </div>
              )}
              {missingReceipts > 0 && (
                <div className="sg-warn"><WarnIcon /> {missingReceipts} expense{missingReceipts === 1 ? '' : 's'} missing receipts</div>
              )}
            </Card>
          </div>

          {/* Filter row ------------------------------------------------- */}
          <div className="sg-filterrow">
            <select className="sg-fpill" value={filters.categoryId} onChange={set('categoryId')}>
              <option value="">All categories</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select className="sg-fpill" value={filters.status} onChange={set('status')}>
              <option value="">All statuses</option>
              <option value="RECORDED">Recorded</option>
              <option value="REIMBURSED">Reimbursed</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
            <input type="month" className="sg-fpill sg-fpill-date" value={monthValue} onChange={(e) => pickMonth(e.target.value)} aria-label="Month" title="Pick a month" />
            <input type="date" className="sg-fpill sg-fpill-date" value={filters.from} max={filters.to || undefined} onChange={set('from')} aria-label="From date" />
            <input type="date" className="sg-fpill sg-fpill-date" value={filters.to} min={filters.from || undefined} onChange={set('to')} aria-label="To date" />
            <input
              className="sg-fpill sg-fpill-search"
              placeholder="Vendor, memo or reference"
              value={searchInput} onChange={(e) => setSearchInput(e.target.value)}
            />
            <button className="sg-fpill" onClick={() => { setFilters({ categoryId: '', status: '', type: 'VARIABLE', from: '', to: '' }); setSearchInput(''); setPage(1) }}>Reset</button>
          </div>

          {/* List panel ------------------------------------------------- */}
          <Card>
            <div className="sg-panel">
              <PanelHeader
                title="Expenses"
                tabs={[
                  { key: 'variable', label: 'Variable', count: summary?.variableCount ?? undefined },
                  { key: 'fixed', label: 'Fixed & recurring', count: summary?.fixedCount ?? undefined },
                  { key: 'all', label: 'Categories', count: categories.length || undefined },
                ]}
                activeTab={activeTab}
                onTab={onTab}
                actions={(
                  <div className="sg-panel-actions">
                    <button className="sg-panel-iconbtn" onClick={exportXlsx} disabled={exporting || meta.total === 0} title="Export to Excel" aria-label="Export to Excel"><DownloadIcon /></button>
                    <button className="sg-panel-iconbtn" title="More" aria-label="More"><KebabIcon /></button>
                  </div>
                )}
              />

              <DataTable
                columns={columns}
                rows={rows}
                getRowId={(r) => r.id}
                onRowSelect={(r) => setViewExpense(r)}
                loading={loading}
                empty="No expenses match these filters."
                footer={tableFooter}
              />

              {meta.total > 0 && (
                <Pagination
                  page={page}
                  pageSize={pageSize}
                  total={meta.total}
                  onPageChange={setPage}
                  onPageSizeChange={(size) => { setPageSize(size); setPage(1) }}
                  label="expenses"
                />
              )}
            </div>
          </Card>
        </>
      )}

      <ExpenseViewModal
        expense={viewExpense}
        onClose={() => setViewExpense(null)}
        onEdit={(e) => { setViewExpense(null); openEdit(e) }}
        onDelete={(e) => { setViewExpense(null); setDeleteTarget(e) }}
      />

      <Modal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete expense"
        maxWidth={440}
        footer={(
          <>
            <button className="btn btn-secondary" onClick={() => setDeleteTarget(null)}>Cancel</button>
            <button className="btn btn-danger" onClick={confirmDelete} disabled={deleting}>{deleting ? 'Deleting…' : 'Delete expense'}</button>
          </>
        )}
      >
        {deleteTarget ? (
          <div style={{ fontSize: 14, lineHeight: 1.5 }}>
            Delete <strong>{deleteTarget.description || deleteTarget.category_name || 'this expense'}</strong>
            {' '}for <strong>{fmt(deleteTarget.total_amount, deleteTarget.currency)}</strong>?
            {deleteTarget.gl_entry_id ? <div style={{ marginTop: 8, color: 'var(--muted)' }}>Its journal entry will be reversed to keep the ledger balanced.</div> : null}
            <div style={{ marginTop: 8, color: 'var(--muted)' }}>This can’t be undone.</div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={showForm}
        onClose={() => { setShowForm(false); setEditId(null) }}
        title={editId ? 'Edit expense' : 'Add expense'}
        maxWidth={640}
        footer={(
          <>
            <button className="btn btn-secondary" onClick={() => { setShowForm(false); setEditId(null) }}>Cancel</button>
            <button className="btn btn-primary" onClick={submit} disabled={saving}>{saving ? 'Saving…' : (editId ? 'Update expense' : 'Save expense')}</button>
          </>
        )}
      >
        {error && <div className="error-box" style={{ marginBottom: 12 }}>{error}</div>}
        <div className="form-grid cols-2">
          <SearchableSelect
            label="Entity" required
            value={form.entity_id}
            options={regionOptions}
            placeholder="Search entity..."
            emptyMessage="No entities found"
            onChange={setF('entity_id')}
          />
          <Input label="Date" type="date" value={form.expense_date} onChange={setF('expense_date')} />
          <SearchableSelect
            label="Category" required
            value={form.category_id}
            options={categoryOptions}
            placeholder="Type to search or add a category..."
            emptyMessage="No matching category"
            createLabel="+ Add category"
            onChange={setF('category_id')}
            onCreate={(query) => setCatDrawer({ open: true, name: query })}
          />
          <SearchableSelect
            label="Payment method"
            value={form.payment_method_id}
            options={methodOptions}
            placeholder="Type to search or add a payment method..."
            emptyMessage="No matching payment method"
            createLabel="+ Add payment method"
            onChange={setF('payment_method_id')}
            onCreate={(query) => setPmDrawer({ open: true, name: query })}
          />
          <div className="span-2"><Input label="Description" value={form.description} onChange={setF('description')} placeholder="What was this for?" /></div>
          <Input label="Amount (pre-tax)" required type="number" value={form.amount} onChange={setF('amount')} />
          <Input label="Currency" value={form.currency} onChange={setF('currency')} />
          <Input label="GST amount" type="number" value={form.gst_amount} onChange={setF('gst_amount')} />
          <Input label="TDS amount" type="number" value={form.tds_amount} onChange={setF('tds_amount')} />
          <div className="form-group" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'end' }}>
            <input id="exp-reimbursable" type="checkbox" checked={form.is_reimbursable} onChange={setF('is_reimbursable')} />
            <label htmlFor="exp-reimbursable" className="form-label" style={{ margin: 0 }}>Reimbursable</label>
          </div>
          {form.is_reimbursable && <Input label="Paid by" value={form.paid_by} onChange={setF('paid_by')} placeholder="Person to reimburse" />}
        </div>
      </Modal>

      <QuickAddDrawer
        open={catDrawer.open}
        title="Quick Add Category"
        endpoint="/expenses/categories"
        initialName={catDrawer.name}
        accounts={categoryAccounts}
        accountHint="Spend in this category posts to this P&L / asset account."
        namePlaceholder="e.g. Office Supplies"
        saveLabel="Save Category"
        onClose={() => setCatDrawer({ open: false, name: '' })}
        onCreated={(created) => {
          setCategories((prev) => [created, ...prev.filter((c) => c.id !== created.id)])
          setForm((f) => ({ ...f, category_id: String(created.id) }))
        }}
      />

      <QuickAddDrawer
        open={pmDrawer.open}
        title="Quick Add Payment Method"
        endpoint="/expenses/payment-methods"
        initialName={pmDrawer.name}
        accounts={paymentAccounts}
        accountHint="Payments via this method credit this bank / cash account."
        namePlaceholder="e.g. HDFC Current A/C"
        saveLabel="Save Payment Method"
        onClose={() => setPmDrawer({ open: false, name: '' })}
        onCreated={(created) => {
          setMethods((prev) => [created, ...prev.filter((m) => m.id !== created.id)])
          setForm((f) => ({ ...f, payment_method_id: String(created.id) }))
        }}
      />
    </div>
  )
}

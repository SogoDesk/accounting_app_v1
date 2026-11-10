import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../../services/api'
import { useToast } from '../../context/ToastContext'
import { Modal, Input, SearchableSelect } from '../../components/ui'
import QuickAddDrawer from '../../components/expenses/QuickAddDrawer'

const money = (n, ccy = 'INR') => {
  try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: ccy, maximumFractionDigits: 0 }).format(Number(n || 0)) }
  catch { return `${ccy} ${Math.round(Number(n || 0)).toLocaleString()}` }
}
const monthStart = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01` }

const emptyForm = {
  entity_id: '', name: '', category_id: '', vendor_name: '', payment_method_id: '', currency: 'INR',
  actual_cost: '', gst_percent: '0', tds_percent: '0', period_months: '1',
  start_month: monthStart(), end_month: '', is_active: true, notes: '',
}

export default function FixedExpensesPage() {
  const toast = useToast()
  const [ready, setReady] = useState(true)
  const [message, setMessage] = useState('')
  const [rows, setRows] = useState([])
  const [regions, setRegions] = useState([])
  const [categories, setCategories] = useState([])
  const [methods, setMethods] = useState([])
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [catDrawer, setCatDrawer] = useState({ open: false, name: '' })
  const [pmDrawer, setPmDrawer] = useState({ open: false, name: '' })
  const [genMonth, setGenMonth] = useState(monthStart())
  const [genMsg, setGenMsg] = useState('')
  const [genStatus, setGenStatus] = useState(null)

  // Has the selected month already been generated into the expenses register?
  useEffect(() => {
    api.get('/expenses/recurring/status', { params: { month: genMonth } })
      .then((r) => setGenStatus(r.data.data || null)).catch(() => setGenStatus(null))
  }, [genMonth])

  const load = () => {
    setLoading(true)
    api.get('/expenses/recurring')
      .then((r) => { setReady(r.data.ready !== false); setMessage(r.data.message || ''); setRows(r.data.data || []) })
      .catch((e) => setError(e.response?.data?.message || e.message))
      .finally(() => setLoading(false))
  }
  useEffect(() => {
    load()
    api.get('/regions').then((r) => setRegions(r.data.data || [])).catch(() => {})
    api.get('/expenses/categories').then((r) => setCategories(r.data.data || [])).catch(() => {})
    api.get('/expenses/payment-methods').then((r) => setMethods(r.data.data || [])).catch(() => {})
    api.get('/gl/chart-of-accounts').then((r) => setAccounts((r.data.data || []).filter((a) => ['EXPENSE', 'ASSET'].includes(a.account_type)))).catch(() => {})
  }, [])

  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  const regionOptions = useMemo(() => regions.map((r) => ({ value: String(r.id), label: r.region_name })), [regions])
  const categoryOptions = useMemo(() => categories.map((c) => ({ value: String(c.id), label: c.name })), [categories])
  const methodOptions = useMemo(() => methods.map((m) => ({ value: String(m.id), label: m.name })), [methods])
  const paymentAccounts = useMemo(() => accounts.filter((a) => a.account_type === 'ASSET'), [accounts])

  const submit = async () => {
    if (!form.entity_id || !form.name || !form.actual_cost) { setError('Entity, name and actual cost are required'); return }
    setSaving(true); setError('')
    try { await api.post('/expenses/recurring', form); setShowForm(false); setForm(emptyForm); load(); toast.success('Fixed expense template saved') }
    catch (e) { setError(e.response?.data?.message || e.message) }
    finally { setSaving(false) }
  }
  const generate = async () => {
    setGenMsg('Generating…')
    try {
      const r = await api.post('/expenses/recurring/run', { month: genMonth })
      setGenMsg(r.data.message || 'Done')
      const s = await api.get('/expenses/recurring/status', { params: { month: genMonth } })
      setGenStatus(s.data.data || null)
    } catch (e) { setGenMsg(e.response?.data?.message || e.message) }
  }

  return (
    <div className="dashboard-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Fixed Expenses</h1>
          <p className="page-subtitle">Recurring monthly costs — rent, EMIs, maintenance. Generate each month's entries from these templates.</p>
        </div>
        {ready && <button className="primary-btn" onClick={() => { setForm(emptyForm); setShowForm(true) }}>Add fixed expense</button>}
      </div>

      {!ready ? (
        <div className="table-card glass-card" style={{ padding: 24 }}>
          <h3 style={{ marginTop: 0 }}>Expenses not enabled yet</h3>
          <p className="text-muted">{message || 'Apply migration 003 and restart the backend.'}</p>
        </div>
      ) : (
        <div className="table-card glass-card">
          <div className="table-toolbar" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="text-muted text-sm">Generate this month's expenses:</span>
            <input type="date" className="filter-select" value={genMonth} onChange={(e) => setGenMonth(e.target.value)} />
            <button className="secondary-btn" onClick={generate}>Generate</button>
            {genStatus && (
              genStatus.due === 0
                ? <span className="badge badge-gray">No templates due this month</span>
                : genStatus.pending === 0
                  ? <span className="badge badge-green">✓ All {genStatus.due} generated for {String(genMonth).slice(0, 7)}</span>
                  : genStatus.generated === 0
                    ? <span className="badge badge-yellow">Not generated yet · {genStatus.due} pending</span>
                    : <span className="badge badge-yellow">{genStatus.generated}/{genStatus.due} generated · {genStatus.pending} pending</span>
            )}
            {genMsg && <span className="text-muted text-sm">{genMsg}</span>}
          </div>
          <p className="text-muted text-sm" style={{ margin: '0 4px 8px' }}>
            These are recurring <strong>templates</strong>. Fixed expenses only post to the ledger and show up in Monthly Summary, the KPIs and the dashboard <strong>after you generate the month</strong>.
          </p>

          <div className="table-wrap">
            <table className="saas-table">
              <thead>
                <tr>
                  <th>Name</th><th>Category</th><th>Vendor</th><th>Entity</th>
                  <th style={{ textAlign: 'right' }}>Actual</th><th style={{ textAlign: 'right' }}>GST%</th><th style={{ textAlign: 'right' }}>TDS%</th>
                  <th style={{ textAlign: 'right' }}>Monthly</th><th>Period</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {loading ? <tr><td colSpan={10} className="empty-row">Loading…</td></tr>
                : rows.length === 0 ? <tr><td colSpan={10} className="empty-row">No recurring expenses yet.</td></tr>
                : rows.map((r) => (
                  <tr key={r.id}>
                    <td className="fw-bold">{r.name}</td>
                    <td className="text-muted text-sm">{r.category_id ? <Link to={`/expenses/categories/${r.category_id}`} state={{ from: '/expenses/fixed', label: 'Fixed Expenses' }} style={{ color: 'var(--primary)', textDecoration: 'none' }}>{r.category_name}</Link> : r.category_name}</td>
                    <td className="text-muted text-sm">{r.vendor_name}</td>
                    <td>{r.entity_name}</td>
                    <td className="td-mono" style={{ textAlign: 'right' }}>{money(r.actual_cost, r.currency)}</td>
                    <td className="td-mono" style={{ textAlign: 'right' }}>{Number(r.gst_percent)}%</td>
                    <td className="td-mono" style={{ textAlign: 'right' }}>{Number(r.tds_percent)}%</td>
                    <td className="td-mono fw-bold" style={{ textAlign: 'right' }}>{money(r.monthly_equiv, r.currency)}</td>
                    <td>{String(r.start_month).slice(0, 7)}{r.end_month ? ` → ${String(r.end_month).slice(0, 7)}` : ' → open'}</td>
                    <td><span className="badge badge-gray">{r.is_active ? 'active' : 'inactive'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title="Add fixed expense"
        maxWidth={640}
        footer={(
          <>
            <button className="btn btn-secondary" onClick={() => setShowForm(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </>
        )}
      >
        {error && <div className="error-box" style={{ marginBottom: 12 }}>{error}</div>}
        <div className="form-grid cols-2">
          <SearchableSelect label="Entity" required value={form.entity_id} options={regionOptions} placeholder="Search entity..." emptyMessage="No entities found" onChange={setF('entity_id')} />
          <Input label="Name" required value={form.name} onChange={setF('name')} placeholder="e.g. Office Rent" />
          <SearchableSelect
            label="Category" value={form.category_id} options={categoryOptions}
            placeholder="Type to search or add a category..." emptyMessage="No matching category"
            createLabel="+ Add category" onChange={setF('category_id')}
            onCreate={(q) => setCatDrawer({ open: true, name: q })}
          />
          <Input label="Vendor" value={form.vendor_name} onChange={setF('vendor_name')} />
          <SearchableSelect
            label="Payment method" value={form.payment_method_id} options={methodOptions}
            placeholder="Type to search or add a payment method..." emptyMessage="No matching payment method"
            createLabel="+ Add payment method" onChange={setF('payment_method_id')}
            onCreate={(q) => setPmDrawer({ open: true, name: q })}
          />
          <Input label="Actual cost" required type="number" value={form.actual_cost} onChange={setF('actual_cost')} />
          <Input label="GST %" type="number" value={form.gst_percent} onChange={setF('gst_percent')} />
          <Input label="TDS %" type="number" value={form.tds_percent} onChange={setF('tds_percent')} />
          <Input label="Period (months)" type="number" value={form.period_months} onChange={setF('period_months')} />
          <Input label="Currency" value={form.currency} onChange={setF('currency')} />
          <Input label="Start month" type="date" value={form.start_month} onChange={setF('start_month')} />
          <Input label="End month (optional)" type="date" value={form.end_month} onChange={setF('end_month')} />
          <div className="form-group" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'end' }}>
            <input id="fx-active" type="checkbox" checked={form.is_active} onChange={setF('is_active')} />
            <label htmlFor="fx-active" className="form-label" style={{ margin: 0 }}>Active</label>
          </div>
        </div>
      </Modal>

      <QuickAddDrawer
        open={catDrawer.open}
        title="Quick Add Category"
        endpoint="/expenses/categories"
        initialName={catDrawer.name}
        accounts={accounts}
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

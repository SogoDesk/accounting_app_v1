import { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useNavigate } from 'react-router-dom'
import api from '../services/api'
import {
  PanelHeader,
  DataTable,
  StatusChip,
  Select,
  Input,
  Textarea,
  Modal,
  SkeletonRows,
  fmt,
  fmtDateDisplay,
} from '../components/ui/index.jsx'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import { ACTION_ACCESS, hasAnyRole } from '../utils/acl'
import BillViewModal from '../components/BillViewModal'
import VendorPaymentViewModal from '../components/VendorPaymentViewModal'
import './DetailPage.css'

const toNum = (v) => { const n = Number(v || 0); return Number.isNaN(n) ? 0 : n }
const DUE_SOON_WINDOW_DAYS = 15

const initialsOf = (name = '') => String(name).trim().split(/\s+/).slice(0, 2)
  .map((w) => w[0]).join('').toUpperCase() || '?'

const daysBetween = (dateStr) => {
  const d = new Date(String(dateStr).slice(0, 10))
  if (Number.isNaN(d.getTime())) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((d - today) / 86400000)
}

// Derived display status for a bill: open + dated → Overdue / Due; else stored.
const billStatusMeta = (bill) => {
  const stored = String(bill.bill_status || '').toUpperCase()
  const open = toNum(bill.balance_outstanding) > 0 && !['PAID', 'CANCELLED'].includes(stored)
  if (open && bill.due_date) {
    const diff = daysBetween(bill.due_date)
    if (diff != null && diff < 0) return { label: `Overdue ${Math.abs(diff)} days`, tone: 'danger' }
    if (diff != null && diff <= DUE_SOON_WINDOW_DAYS) return { label: `Due in ${diff} days`, tone: 'warn' }
  }
  if (stored === 'PAID') return { label: 'Paid', tone: 'success' }
  if (stored === 'CANCELLED') return { label: 'Cancelled', tone: 'neutral' }
  if (stored === 'PARTIALLY_PAID') return { label: 'Partially paid', tone: 'warn' }
  if (!stored) return { label: 'Draft', tone: 'neutral' }
  return { label: stored.replace(/_/g, ' ').toLowerCase(), tone: 'accent' }
}

const MoneyBagIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 3h6l-1.5 3h-3L9 3Z" />
    <path d="M12 6c-3.5 3-6 5.5-6 9a6 6 0 0 0 12 0c0-3.5-2.5-6-6-9Z" />
    <path d="M12 12v4M10.5 13.5h3" />
  </svg>
)

const EMPTY_FORM = {
  vendor_name: '', vendor_code: '', region_id: '', currency: 'USD',
  billing_address: '', tax_identifier: '', default_payment_terms: 'NET_30',
  primary_contact_name: '', primary_contact_email: '', primary_contact_phone: '',
  bank_name: '', bank_account_name: '', bank_account_number: '', bank_routing_number: '', bank_swift_ifsc: '',
  status: 'ACTIVE',
}

export default function VendorDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const { user } = useAuth()
  const canManageBills = hasAnyRole(user?.roleName, ACTION_ACCESS.bills.manage)
  const [viewBillId, setViewBillId] = useState(null)
  const [viewPaymentId, setViewPaymentId] = useState(null)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('transactions')
  const [typeFilter, setTypeFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [regions, setRegions] = useState([])
  const [editOpen, setEditOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const loadOverview = () => {
    setLoading(true)
    setError('')
    return api.get(`/vendors/${id}/overview`)
      .then((r) => setData(r.data.data))
      .catch((e) => setError(e.response?.data?.message || e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { loadOverview() }, [id])
  useEffect(() => { api.get('/regions').then((r) => setRegions(r.data?.data || r.data || [])).catch(() => {}) }, [])

  const regionById = useMemo(() => {
    const map = {}
    regions.forEach((r) => { map[String(r.id)] = r })
    return map
  }, [regions])

  const setField = (key, value) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'region_id') {
        const region = regionById[String(value)]
        if (region?.default_currency) next.currency = region.default_currency
      }
      return next
    })
  }

  const openEdit = () => {
    const v = data.vendor
    setForm({
      ...EMPTY_FORM,
      ...v,
      region_id: v.region_id ? String(v.region_id) : '',
      currency: v.currency || 'USD',
    })
    setEditOpen(true)
  }

  const saveEdit = async () => {
    if (!form.vendor_name || !form.region_id || !form.currency) {
      toast.error('Name, region and currency are required')
      return
    }
    setSaving(true)
    try {
      await api.put(`/vendors/${id}`, form)
      toast.success('Vendor updated')
      setEditOpen(false)
      await loadOverview()
    } catch (e) {
      toast.error(e.response?.data?.message || 'Update failed')
    } finally {
      setSaving(false)
    }
  }

  const ccy = data?.vendor?.currency || 'USD'

  const txns = useMemo(() => {
    if (!data) return []
    const billRows = (data.bills || []).map((b) => {
      const meta = billStatusMeta(b)
      return {
        key: `bill-${b.id}`,
        id: b.id,
        kind: 'bill',
        dateRaw: String(b.bill_date || '').slice(0, 10),
        type: 'Bill',
        no: b.bill_number,
        memo: b.due_date ? `Due ${fmtDateDisplay(b.due_date)}` : '—',
        amount: toNum(b.total_amount),
        currency: b.currency || ccy,
        statusLabel: meta.label,
        statusTone: meta.tone,
        open: toNum(b.balance_outstanding) > 0,
      }
    })
    const paymentRows = (data.payments || []).map((p) => ({
      key: `pay-${p.id}`,
      id: p.id,
      kind: 'payment',
      dateRaw: String(p.payment_date || '').slice(0, 10),
      type: 'Payment',
      no: p.reference_number || p.bill_number || '—',
      memo: `Payment sent${p.payment_method ? ` · ${String(p.payment_method).replace(/_/g, ' ')}` : ''}${p.bill_number ? ` · ${p.bill_number}` : ''}`,
      amount: toNum(p.amount_paid),
      currency: p.currency || ccy,
      statusLabel: 'Paid',
      statusTone: 'success',
      open: false,
    }))
    return [...billRows, ...paymentRows].sort((a, b) => (a.dateRaw < b.dateRaw ? 1 : a.dateRaw > b.dateRaw ? -1 : 0))
  }, [data, ccy])

  const filteredTxns = useMemo(() => txns.filter((t) => {
    if (typeFilter === 'bills' && t.kind !== 'bill') return false
    if (typeFilter === 'payments' && t.kind !== 'payment') return false
    if (statusFilter === 'open' && !t.open) return false
    if (statusFilter === 'paid' && !(t.kind === 'bill' && !t.open)) return false
    if (statusFilter === 'overdue' && t.statusTone !== 'danger') return false
    return true
  }), [txns, typeFilter, statusFilter])

  const txnTotal = useMemo(() => filteredTxns.reduce((sum, t) => sum + t.amount, 0), [filteredTxns])

  const aging = useMemo(() => {
    const s = data?.summary || {}
    const rows = [
      { label: 'Current', value: toNum(s.current_bucket), color: 'var(--success)' },
      { label: '1–30', value: toNum(s.d30), color: '#2bb0a6' },
      { label: '31–60', value: toNum(s.d60), color: '#d99a1c' },
      { label: '61–90', value: toNum(s.d90), color: '#e0679b' },
      { label: '90+', value: toNum(s.d90p), color: 'var(--danger)' },
    ]
    const max = Math.max(...rows.map((r) => r.value), 1)
    return { rows, max }
  }, [data])

  if (loading) {
    return (
      <div className="dashboard-page client-detail">
        <div className="cd-header sg-card is-skeleton" />
        <div className="cd-panel sg-card"><table className="sg-skel-table"><tbody><SkeletonRows cols={6} rows={5} /></tbody></table></div>
      </div>
    )
  }
  if (error || !data) {
    return (
      <div className="dashboard-page client-detail">
        <div className="cd-back"><Link to="/vendors" className="cd-backlink">← Back to vendors</Link></div>
        <div className="cd-panel sg-card" style={{ padding: 28, textAlign: 'center', color: 'var(--muted)' }}>{error || 'Not found'}</div>
      </div>
    )
  }

  const v = data.vendor
  const s = data.summary
  const overdue = toNum(s.overdue)

  const txnColumns = [
    { key: 'date', header: 'Date', width: 108, render: (r) => fmtDateDisplay(r.dateRaw), sortAccessor: (r) => r.dateRaw },
    { key: 'type', header: 'Type', width: 108, render: (r) => <StatusChip tone={r.kind === 'payment' ? 'success' : 'accent'}>{r.type}</StatusChip>, sortAccessor: (r) => r.type },
    { key: 'no', header: 'No.', width: 120, mono: true, render: (r) => {
      if (r.kind === 'bill' && r.id) return <button type="button" className="cd-linkbtn" title="View bill details" onClick={() => setViewBillId(r.id)}>{r.no}</button>
      if (r.kind === 'payment' && r.id) return <button type="button" className="cd-linkbtn" title="View payment details" onClick={() => setViewPaymentId(r.id)}>{r.no}</button>
      return r.no
    } },
    { key: 'memo', header: 'Memo', render: (r) => <span className="cd-memo">{r.memo}</span> },
    { key: 'amount', header: 'Amount', align: 'right', mono: true, render: (r) => fmt(r.amount, r.currency), sortAccessor: (r) => r.amount },
    { key: 'status', header: 'Status', width: 148, render: (r) => <StatusChip tone={r.statusTone}>{r.statusLabel}</StatusChip>, sortAccessor: (r) => r.statusLabel },
  ]

  const detailFields = [
    { label: 'Vendor code', value: v.vendor_code },
    { label: 'Region', value: v.region_name },
    { label: 'Currency', value: ccy },
    { label: 'Payment terms', value: String(v.default_payment_terms || '—').replace(/_/g, ' ') },
    { label: 'Tax identifier', value: v.tax_identifier || '—' },
    { label: 'Primary contact', value: v.primary_contact_name || '—' },
    { label: 'Contact email', value: v.primary_contact_email || '—' },
    { label: 'Contact phone', value: v.primary_contact_phone || '—' },
    { label: 'Bank name', value: v.bank_name || '—' },
    { label: 'Account name', value: v.bank_account_name || '—' },
    { label: 'Account number', value: v.bank_account_number || '—' },
    { label: 'Routing number', value: v.bank_routing_number || '—' },
    { label: 'SWIFT / IFSC', value: v.bank_swift_ifsc || '—' },
  ]

  return (
    <div className="dashboard-page client-detail">
      <div className="cd-back"><Link to="/vendors" className="cd-backlink">← Back to vendors</Link></div>

      <div className="cd-header sg-card">
        <div className="cd-identity">
          <div className="cd-avatar">{initialsOf(v.vendor_name)}</div>
          <div className="cd-identity-body">
            <h1 className="cd-name">{v.vendor_name}</h1>
            <div className="cd-sub">{[v.vendor_code, v.region_name].filter(Boolean).join(' · ')}</div>
            <StatusChip tone={String(v.status).toUpperCase() === 'ACTIVE' ? 'success' : 'neutral'}>{v.status}</StatusChip>
            <div className="cd-quick">
              <button type="button" className="cd-editbtn" onClick={openEdit} title="Edit details">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
                Edit
              </button>
              <button type="button" className="cd-quickbtn" onClick={() => navigate('/bills')} title="New bill">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3v4h4" /><path d="M6 3h8l4 4v14H6z" /><path d="M12 11v6M9 14h6" /></svg>
              </button>
              <button type="button" className="cd-quickbtn" onClick={() => navigate('/vendor-payments')} title="Record payment">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18M7 15h3" /></svg>
              </button>
            </div>
          </div>
        </div>

        <div className="cd-contact">
          <div className="cd-field">
            <span className="cd-flabel">Email</span>
            <span className="cd-fvalue">{v.primary_contact_email || <span className="cd-empty">No email on file</span>}</span>
          </div>
          <div className="cd-field">
            <span className="cd-flabel">Phone</span>
            <span className="cd-fvalue">{v.primary_contact_phone || <span className="cd-empty">No phone on file</span>}</span>
          </div>
          <div className="cd-field">
            <span className="cd-flabel">Billing address</span>
            <span className="cd-fvalue">{v.billing_address || <span className="cd-empty">No address on file</span>}</span>
          </div>
          <div className="cd-field">
            <span className="cd-flabel">Terms</span>
            <span className="cd-fvalue">{String(v.default_payment_terms || '—').replace(/_/g, ' ')}</span>
          </div>
        </div>

        <div className="cd-summary">
          <div className="cd-summary-head"><MoneyBagIcon /> Financial summary</div>
          <div className="cd-summary-item">
            <div className="cd-summary-row"><span className="cd-dot cd-dot-amber" /> Open balance</div>
            <div className="cd-summary-val">{fmt(s.outstanding, ccy)}</div>
          </div>
          <div className="cd-summary-item">
            <div className="cd-summary-row"><span className="cd-dot cd-dot-red" /> Overdue payment</div>
            <div className={`cd-summary-val${overdue > 0 ? ' is-danger' : ''}`}>{fmt(overdue, ccy)}</div>
          </div>
        </div>
      </div>

      <div className="cd-panel sg-card">
        <PanelHeader
          title={v.vendor_name}
          tabs={[
            { key: 'transactions', label: 'Transaction List', count: txns.length },
            { key: 'details', label: 'Vendor Details' },
          ]}
          activeTab={tab}
          onTab={setTab}
        />

        {tab === 'transactions' && (
          <>
            <div className="cd-filters">
              <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                <option value="all">All transactions</option>
                <option value="bills">Bills only</option>
                <option value="payments">Payments only</option>
              </Select>
              <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="all">All statuses</option>
                <option value="open">Open</option>
                <option value="paid">Paid</option>
                <option value="overdue">Overdue</option>
              </Select>
            </div>
            <DataTable
              columns={txnColumns}
              rows={filteredTxns}
              getRowId={(r) => r.key}
              paginate
              pageLabel="transactions"
              defaultSort={{ key: 'date', dir: 'desc' }}
              empty="No transactions for this vendor"
              footer={[
                { colSpan: 4, align: 'left', render: () => `Total · ${filteredTxns.length} transaction${filteredTxns.length === 1 ? '' : 's'}` },
                { colSpan: 1, align: 'right', mono: true, render: () => fmt(txnTotal, ccy) },
                { colSpan: 1, render: () => null },
              ]}
            />
          </>
        )}

        {tab === 'details' && (
          <div className="cd-details">
            <div className="cd-details-grid">
              {detailFields.map((f) => (
                <div key={f.label} className="cd-field">
                  <span className="cd-flabel">{f.label}</span>
                  <span className="cd-fvalue">{f.value}</span>
                </div>
              ))}
            </div>
            <div className="cd-aging">
              <div className="cd-aging-head">Payables aging</div>
              {aging.rows.map((r) => (
                <div key={r.label} className="cd-age-row">
                  <span className="cd-age-label">{r.label}</span>
                  <span className="cd-age-track"><span className="cd-age-fill" style={{ width: `${Math.max(2, Math.round((r.value / aging.max) * 100))}%`, background: r.color }} /></span>
                  <span className="cd-age-val">{fmt(r.value, ccy)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <BillViewModal
        billId={viewBillId}
        onClose={() => setViewBillId(null)}
        canEdit={canManageBills}
        onEdit={(bill) => { setViewBillId(null); navigate(`/bills?edit=${bill.id}`) }}
      />

      <VendorPaymentViewModal
        paymentId={viewPaymentId}
        onClose={() => setViewPaymentId(null)}
      />

      <Modal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        title="Edit vendor details"
        maxWidth={720}
        footer={(
          <div className="cd-modal-actions">
            <button type="button" className="secondary-btn" onClick={() => setEditOpen(false)}>Cancel</button>
            <button type="button" className="primary-btn" onClick={saveEdit} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>
          </div>
        )}
      >
        <div className="cd-form-grid">
          <Input label="Vendor name" required value={form.vendor_name} onChange={(e) => setField('vendor_name', e.target.value)} />
          <Select label="Region" required value={form.region_id} onChange={(e) => setField('region_id', e.target.value)}>
            <option value="">Select region</option>
            {regions.map((r) => <option key={r.id} value={String(r.id)}>{r.region_name}</option>)}
          </Select>
          <Input label="Currency" value={form.currency} readOnly hint="Set by the region" />
          <Select label="Status" value={form.status} onChange={(e) => setField('status', e.target.value)}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </Select>
          <Input label="Primary contact" value={form.primary_contact_name || ''} onChange={(e) => setField('primary_contact_name', e.target.value)} />
          <Input label="Contact email" type="email" value={form.primary_contact_email || ''} onChange={(e) => setField('primary_contact_email', e.target.value)} />
          <Input label="Phone" value={form.primary_contact_phone || ''} onChange={(e) => setField('primary_contact_phone', e.target.value)} />
          <Input label="Tax identifier" value={form.tax_identifier || ''} onChange={(e) => setField('tax_identifier', e.target.value)} />
          <Select label="Payment terms" value={form.default_payment_terms} onChange={(e) => setField('default_payment_terms', e.target.value)}>
            <option value="NET_15">Net 15</option>
            <option value="NET_30">Net 30</option>
            <option value="NET_45">Net 45</option>
          </Select>
          <Input label="Bank name" value={form.bank_name || ''} onChange={(e) => setField('bank_name', e.target.value)} />
          <Input label="Account name" value={form.bank_account_name || ''} onChange={(e) => setField('bank_account_name', e.target.value)} />
          <Input label="Account number" value={form.bank_account_number || ''} onChange={(e) => setField('bank_account_number', e.target.value)} />
          <Input label="Routing number" value={form.bank_routing_number || ''} onChange={(e) => setField('bank_routing_number', e.target.value)} />
          <Input label="SWIFT / IFSC" value={form.bank_swift_ifsc || ''} onChange={(e) => setField('bank_swift_ifsc', e.target.value)} />
          <div className="cd-form-full">
            <Textarea label="Billing address" rows={2} value={form.billing_address || ''} onChange={(e) => setField('billing_address', e.target.value)} />
          </div>
        </div>
      </Modal>
    </div>
  )
}

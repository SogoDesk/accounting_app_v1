import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams, Link, useNavigate } from 'react-router-dom'
import api from '../services/api'
import {
  Modal,
  Drawer,
  Badge,
  SkeletonRows,
  Input,
  Select,
  SearchableSelect,
  Textarea,
  ConfirmDialog,
  Pagination,
  usePagination,
  fmt,
  fmtDate,
  fmtDateDisplay,
  currencySymbol,
} from '../components/ui/index.jsx'
import StatCard from '../components/common/StatCard'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import { useEntity } from '../context/EntityContext'
import { ACTION_ACCESS, hasAnyRole } from '../utils/acl'
import { useRegionCurrencyFilter } from '../utils/useRegionCurrencyFilter'
import { useResizableColumns } from '../utils/useResizableColumns'
import VendorPaymentViewModal from '../components/VendorPaymentViewModal'

const BLANK = {
  payment_code: '',
  bill_id: '',
  bill_ids: [],
  payment_date: '',
  amount_paid: '',
  payment_method: 'BANK_TRANSFER',
  reference_number: '',
  notes: '',
}

const createBillLine = () => ({
  description: '',
  quantity: '1',
  unit_price: '0',
  expense_category: '',
  cost_center: '',
})

const createBillTax = () => ({
  tax_name: '',
  tax_percent: '0',
})

const BLANK_BILL_FORM = {
  bill_number: '',
  vendor_id: '',
  region_id: '',
  bill_date: '',
  due_date: '',
  service_period_start: '',
  service_period_end: '',
  currency: 'USD',
  invoice_reference: '',
  external_reference: '',
  notes: '',
  line_items: [createBillLine()],
  tax_lines: [createBillTax()],
}

const PAYMENT_METHODS = ['BANK_TRANSFER', 'WIRE_TRANSFER', 'ACH', 'CHECK', 'CASH', 'CARD', 'UPI', 'NEFT', 'RTGS', 'IMPS', 'OTHER']

const normalizeNumber = (value) => {
  const num = Number(value || 0)
  return Number.isNaN(num) ? 0 : num
}

const isDateInRange = (value, from, to) => {
  if (!value) return true
  const d = String(value).slice(0, 10)
  if (from && d < from) return false
  if (to && d > to) return false
  return true
}

export default function VendorPaymentsPage() {
  const toast = useToast()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { user } = useAuth()
  const roleName = user?.roleName
  const canManage = hasAnyRole(roleName, ACTION_ACCESS.vendorPayments.manage)
  const canDelete = hasAnyRole(roleName, ACTION_ACCESS.vendorPayments.delete)

  const [rows, setRows] = useState([])
  const [reportingCurrency, setReportingCurrency] = useState('USD')
  const [billOptions, setBillOptions] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [methodFilter, setMethodFilter] = useState('')
  const [vendorFilter, setVendorFilter] = useState('')
  // Region is driven by the global top-nav switcher (no per-page dropdown).
  const { entityId: regionFilter } = useEntity()
  const [currencyFilter, setCurrencyFilter] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [modal, setModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [viewPaymentId, setViewPaymentId] = useState(null)
  const [form, setForm] = useState(BLANK)
  const [nextCode, setNextCode] = useState({ payment_code: '', reference_number: '' })
  const [billPickerSearch, setBillPickerSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [actionMenu, setActionMenu] = useState({ open: false, x: 0, y: 0, row: null })
  const [billDrawerOpen, setBillDrawerOpen] = useState(false)
  const [billDraft, setBillDraft] = useState(BLANK_BILL_FORM)
  const [billSaving, setBillSaving] = useState(false)
  const [vendors, setVendors] = useState([])
  const [regions, setRegions] = useState([])

  const load = async () => {
    try {
      setLoading(true)
      const [paymentRes, billRes] = await Promise.all([
        api.get('/vendor-payments'),
        api.get('/vendor-payments/bill-options'),
      ])
      setRows(paymentRes.data?.data || [])
      setReportingCurrency(paymentRes.data?.reporting_currency || 'USD')
      setBillOptions(billRes.data?.data || [])
    } catch (error) {
      toast.error(error.response?.data?.message || 'Failed to load vendor payments')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  useEffect(() => {
    const close = () => setActionMenu({ open: false, x: 0, y: 0, row: null })
    window.addEventListener('click', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [])

  const billById = useMemo(() => {
    const map = {}
    billOptions.forEach((bill) => { map[String(bill.id)] = bill })
    return map
  }, [billOptions])

  const regionById = useMemo(() => {
    const map = {}
    regions.forEach((region) => { map[String(region.id)] = region })
    return map
  }, [regions])

  const vendorById = useMemo(() => {
    const map = {}
    vendors.forEach((vendor) => { map[String(vendor.id)] = vendor })
    return map
  }, [vendors])

  const vendorOptions = useMemo(() => (
    vendors.map((vendor) => ({
      value: String(vendor.id),
      label: vendor.vendor_name,
      meta: [vendor.vendor_code, vendor.region_name].filter(Boolean).join(' • '),
      searchText: `${vendor.primary_contact_name || ''} ${vendor.primary_contact_email || ''}`.trim(),
    }))
  ), [vendors])

  const regionOptions = useMemo(() => (
    regions.map((region) => ({
      value: String(region.id),
      label: region.region_name,
      meta: [region.country_name, region.default_currency].filter(Boolean).join(' • '),
      searchText: `${region.region_code || ''} ${region.company_name || ''}`.trim(),
    }))
  ), [regions])

  // ---- Bill selection (multi-bill allocation, mirrors AR multi-invoice receipts) ----
  const availableBills = useMemo(() => (
    billOptions.filter((bill) => {
      if (String(bill.approval_status || '').toUpperCase() !== 'APPROVED') {
        return editing && String(bill.id) === String(form.bill_id)
      }
      const balance = normalizeNumber(bill.balance_outstanding)
      if (balance > 0) return true
      return !!editing && String(bill.id) === String(form.bill_id)
    })
  ), [billOptions, editing, form.bill_id])

  const selectedBills = useMemo(() => {
    const ids = editing ? [String(form.bill_id)] : form.bill_ids.map(String)
    return billOptions.filter((b) => ids.includes(String(b.id)))
  }, [editing, form.bill_id, form.bill_ids, billOptions])

  const lockedCurrency = selectedBills[0] ? String(selectedBills[0].currency || '').toUpperCase() : null

  const pickerBills = useMemo(() => {
    const needle = billPickerSearch.trim().toLowerCase()
    if (!needle) return availableBills
    return availableBills.filter((b) => `${b.bill_number} ${b.vendor_name} ${b.reference_number || ''}`.toLowerCase().includes(needle))
  }, [availableBills, billPickerSearch])

  const billSummary = useMemo(() => ({
    count: selectedBills.length,
    total: selectedBills.reduce((s, b) => s + normalizeNumber(b.total_amount), 0),
    balance: selectedBills.reduce((s, b) => s + normalizeNumber(b.balance_outstanding), 0),
    currency: selectedBills[0]?.currency || '',
  }), [selectedBills])

  const toggleBill = (bill) => {
    setForm((prev) => {
      const id = String(bill.id)
      const has = prev.bill_ids.map(String).includes(id)
      const nextIds = has ? prev.bill_ids.filter((x) => String(x) !== id) : [...prev.bill_ids, id]
      const selected = billOptions.filter((b) => nextIds.map(String).includes(String(b.id)))
      const suggested = selected.reduce((s, b) => s + normalizeNumber(b.balance_outstanding), 0)
      return { ...prev, bill_ids: nextIds, amount_paid: suggested ? String(Number(suggested.toFixed(2))) : '' }
    })
  }

  const loadNextCode = async () => {
    try {
      const res = await api.get('/vendor-payments/next-code')
      return res.data?.data || null
    } catch {
      return null
    }
  }

  const openCreate = async () => {
    const today = new Date().toISOString().slice(0, 10)
    setEditing(null)
    setViewPaymentId(null)
    setBillPickerSearch('')
    setForm({ ...BLANK, bill_ids: [], payment_date: today })
    setModal(true)
    const codes = await loadNextCode()
    if (codes) {
      setNextCode(codes)
      setForm((prev) => ({
        ...prev,
        payment_code: codes.payment_code || '',
        reference_number: codes.reference_number || '',
      }))
    }
  }

  useEffect(() => {
    if (searchParams.get('action') !== 'create' || !canManage) return
    openCreate()
    setSearchParams({}, { replace: true })
  }, [searchParams, setSearchParams, canManage])

  const openEdit = (row) => {
    setEditing(row)
    setViewPaymentId(null)
    setBillPickerSearch('')
    setForm({
      ...BLANK,
      ...row,
      bill_id: row.bill_id ? String(row.bill_id) : '',
      bill_ids: row.bill_id ? [String(row.bill_id)] : [],
      payment_date: fmtDate(row.payment_date),
      amount_paid: row.amount_paid != null ? String(row.amount_paid) : '',
      payment_method: row.payment_method || 'BANK_TRANSFER',
    })
    setModal(true)
    setActionMenu({ open: false, x: 0, y: 0, row: null })
  }

  const openView = (row) => {
    setViewPaymentId(row?.id ?? null)
    setActionMenu({ open: false, x: 0, y: 0, row: null })
  }

  const openActionMenu = (event, row) => {
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    setActionMenu({ open: true, x: rect.right - 180, y: rect.bottom + 8, row })
  }

  const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))

  const setBillDraftValue = (key, value) => {
    setBillDraft((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'vendor_id') {
        const vendor = vendorById[String(value)]
        if (vendor?.region_id) next.region_id = String(vendor.region_id)
        if (vendor?.currency) next.currency = vendor.currency
      }
      if (key === 'region_id') {
        const region = regionById[String(value)]
        if (region?.default_currency) next.currency = region.default_currency
      }
      return next
    })
  }

  const updateBillLine = (index, patch) => {
    setBillDraft((prev) => ({
      ...prev,
      line_items: prev.line_items.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
    }))
  }

  const addBillLine = () => setBillDraft((prev) => ({ ...prev, line_items: [...prev.line_items, createBillLine()] }))

  const removeBillLine = (index) => setBillDraft((prev) => ({
    ...prev,
    line_items: prev.line_items.length > 1 ? prev.line_items.filter((_, itemIndex) => itemIndex !== index) : prev.line_items,
  }))

  const updateBillTax = (index, patch) => {
    setBillDraft((prev) => ({
      ...prev,
      tax_lines: prev.tax_lines.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
    }))
  }

  const addBillTax = () => setBillDraft((prev) => ({ ...prev, tax_lines: [...prev.tax_lines, createBillTax()] }))

  const removeBillTax = (index) => setBillDraft((prev) => ({
    ...prev,
    tax_lines: prev.tax_lines.length > 1 ? prev.tax_lines.filter((_, itemIndex) => itemIndex !== index) : prev.tax_lines,
  }))

  const openBillDrawer = async () => {
    const today = new Date().toISOString().slice(0, 10)
    setBillDraft({
      ...BLANK_BILL_FORM,
      bill_date: today,
      due_date: today,
      line_items: [createBillLine()],
      tax_lines: [createBillTax()],
    })
    setBillSaving(false)
    setBillDrawerOpen(true)
    try {
      const [vendorRes, regionRes] = await Promise.all([api.get('/vendors'), api.get('/regions')])
      setVendors(vendorRes.data?.data || [])
      setRegions(regionRes.data?.data || [])
    } catch (error) {
      toast.error(error.response?.data?.message || 'Failed to load vendor/region options')
    }
  }

  const saveBillQuickCreate = async () => {
    if (!billDraft.vendor_id || !billDraft.region_id || !billDraft.bill_date || !billDraft.due_date) {
      toast.error('Vendor, region, bill date, and due date are required')
      return
    }
    setBillSaving(true)
    try {
      const response = await api.post('/bills', {
        ...billDraft,
        vendor_id: Number(billDraft.vendor_id),
        region_id: Number(billDraft.region_id),
        line_items: billDraft.line_items,
        tax_lines: billDraft.tax_lines,
      })
      const created = response.data?.data
      const billOptionsRes = await api.get('/vendor-payments/bill-options')
      setBillOptions(billOptionsRes.data?.data || [])
      if (created?.id && !editing) {
        setForm((prev) => ({ ...prev, bill_ids: Array.from(new Set([...prev.bill_ids.map(String), String(created.id)])) }))
      }
      setBillDrawerOpen(false)
      toast.success('Bill created. Submit it for approval before it can be paid.')
    } catch (error) {
      toast.error(error.response?.data?.message || 'Failed to create bill')
    } finally {
      setBillSaving(false)
    }
  }

  const save = async () => {
    const billIds = editing ? [String(form.bill_id)].filter(Boolean) : form.bill_ids.map(String)
    if (!billIds.length || !form.payment_date) {
      toast.error('Select at least one bill and a payment date')
      return
    }
    if (normalizeNumber(form.amount_paid) <= 0) {
      toast.error('Amount paid must be greater than zero')
      return
    }

    const base = {
      payment_code: form.payment_code,
      payment_date: form.payment_date,
      amount_paid: normalizeNumber(form.amount_paid),
      payment_method: form.payment_method,
      reference_number: form.reference_number,
      notes: form.notes,
    }
    const payload = editing
      ? { ...base, bill_id: Number(form.bill_id) }
      : { ...base, bill_ids: billIds.map(Number) }

    setSaving(true)
    try {
      if (editing) {
        await api.put(`/vendor-payments/${editing.id}`, payload)
      } else {
        await api.post('/vendor-payments', payload)
      }
      toast.success(`Vendor payment ${editing ? 'updated' : 'recorded'} successfully`)
      setModal(false)
      setEditing(null)
      setForm(BLANK)
      load()
    } catch (error) {
      toast.error(error.response?.data?.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    setDeleteLoading(true)
    try {
      await api.delete(`/vendor-payments/${deleting.id}`)
      toast.success('Vendor payment deleted successfully')
      setDeleting(null)
      load()
    } catch (error) {
      toast.error(error.response?.data?.message || 'Delete failed')
    } finally {
      setDeleteLoading(false)
    }
  }

  const vendorFilterOptions = useMemo(() => (
    Array.from(new Set(rows.map((r) => r.vendor_name).filter(Boolean))).sort()
  ), [rows])
  // Keyed by region_id, not name: the filter has to accept the app-wide entity
  // default (an id), and two entities can share a display name.
  const { visibleCurrencies, selectCurrency } = useRegionCurrencyFilter({
    regions,
    currencies: rows.map((r) => r.currency),
    regionFilter,
    currencyFilter,
    setRegionFilter: () => {},
    setCurrencyFilter,
  })

  const filtered = rows.filter((row) => {
    const needle = search.trim().toLowerCase()
    const matchSearch = !needle || [row.payment_code, row.bill_number, row.vendor_name, row.reference_number]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle))
    const matchMethod = !methodFilter || String(row.payment_method || '').toUpperCase() === methodFilter
    const matchVendor = !vendorFilter || row.vendor_name === vendorFilter
    const matchRegion = !regionFilter || String(row.region_id || '') === String(regionFilter)
    const matchCurrency = !currencyFilter || String(row.currency || '').toUpperCase() === currencyFilter
    const matchDate = isDateInRange(row.payment_date, dateFrom, dateTo)
    return matchSearch && matchMethod && matchVendor && matchRegion && matchCurrency && matchDate
  })

  const { pageRows, paginationProps } = usePagination(filtered, {
    resetKey: `${search}|${methodFilter}|${vendorFilter}|${regionFilter}|${currencyFilter}|${dateFrom}|${dateTo}`,
  })
  const rz = useResizableColumns(9, 'rz:vendor-payments')

  // Consolidate across regions: single region → native amount in that currency;
  // "All regions" → the backend's group-currency amount_paid_reporting.
  const consolidated = !regionFilter
  const kpiCcy = consolidated ? reportingCurrency : (filtered[0]?.currency || reportingCurrency)
  const pickAmt = (row, nativeField, reportingField) =>
    normalizeNumber(consolidated ? row[reportingField] : row[nativeField])

  const resetFilters = () => {
    setSearch('')
    setMethodFilter('')
    setVendorFilter('')
    setCurrencyFilter('')
    setDateFrom('')
    setDateTo('')
  }

  const stats = useMemo(() => {
    const totalAmount = filtered.reduce((sum, row) => sum + pickAmt(row, 'amount_paid', 'amount_paid_reporting'), 0)
    const vendorCount = new Set(filtered.map((row) => String(row.vendor_name || '').trim()).filter(Boolean)).size
    return { total: filtered.length, totalAmount, vendorCount }
  }, [filtered, consolidated])

  return (
    <div className="dashboard-page vendor-payments-page">
      <div className="page-header">
        <div className="page-head-left">
          <button type="button" className="page-back" onClick={() => navigate('/dashboard')} aria-label="Back to dashboard">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
          </button>
          <div>
            <div className="page-title">Vendor Payments</div>
            <div className="page-subtitle">Record disbursements against approved vendor bills</div>
          </div>
        </div>
        <div className="page-actions">
          {canManage ? <button className="primary-btn" onClick={openCreate}>+ Add Vendor Payment</button> : null}
        </div>
      </div>

      <div className="table-card glass-card">
        <div className="table-toolbar" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input className="search-input" placeholder="Search vendor payments..." value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="filter-select" value={methodFilter} onChange={(e) => setMethodFilter(e.target.value)}>
            <option value="">All Methods</option>
            {PAYMENT_METHODS.map((method) => <option key={method} value={method}>{method.replace(/_/g, ' ')}</option>)}
          </select>
          <select className="filter-select" value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)}>
            <option value="">All Vendors</option>
            {vendorFilterOptions.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <select className="filter-select" value={currencyFilter} onChange={(e) => selectCurrency(e.target.value)}>
            <option value="">All Currencies</option>
            {visibleCurrencies.map((code) => <option key={code} value={code}>{currencySymbol(code)} {code}</option>)}
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>From
            <input type="date" className="filter-select" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>To
            <input type="date" className="filter-select" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </label>
          <button type="button" className="secondary-btn" onClick={resetFilters}>Reset</button>
          <span className="text-muted text-sm" style={{ marginLeft: 'auto' }}>{filtered.length} payments · Paid out {fmt(stats.totalAmount, kpiCcy)}{consolidated ? ` (${kpiCcy})` : ''}</span>
        </div>

        <div className="stats-grid stats-grid-three">
          <StatCard label="Total Payments" value={stats.total.toLocaleString('en-US')} hint="All AP cash disbursements" />
          <StatCard label="Cash Outflow" value={fmt(stats.totalAmount, kpiCcy)} hint={`Total vendor payment amount${consolidated ? ` · ${kpiCcy}` : ''}`} tone="warning" />
          <StatCard label="Vendors Covered" value={stats.vendorCount.toLocaleString('en-US')} hint="Unique vendors paid" tone="info" />
        </div>

        <div className="table-wrap">
          <table className="saas-table" ref={rz.tableRef} style={rz.tableStyle}>
            {rz.colgroup}
            <thead>
              <tr>
                <th>Payment Code{rz.handle(0)}</th>
                <th>Date{rz.handle(1)}</th>
                <th>Bill #{rz.handle(2)}</th>
                <th>Vendor{rz.handle(3)}</th>
                <th>Method{rz.handle(4)}</th>
                <th>Reference{rz.handle(5)}</th>
                <th className="text-right">Amount{rz.handle(6)}</th>
                <th>Bill Status{rz.handle(7)}</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonRows cols={9} />
              ) : filtered.length === 0 ? (
                <tr className="empty-row"><td colSpan={9}>No vendor payments found</td></tr>
              ) : pageRows.map((row) => (
                <tr key={row.id}>
                  <td><button type="button" className="cd-linkbtn" title="View payment details" onClick={() => openView(row)}>{row.payment_code || '-'}</button></td>
                  <td>{fmtDateDisplay(row.payment_date)}</td>
                  <td>{row.bill_number}</td>
                  <td>{row.vendor_id ? <Link to={`/vendors/${row.vendor_id}`} style={{ color: 'var(--primary)', textDecoration: 'none' }}>{row.vendor_name}</Link> : row.vendor_name}</td>
                  <td>{String(row.payment_method || '-').replace(/_/g, ' ')}</td>
                  <td className="td-mono">{row.reference_number || '-'}</td>
                  <td className="text-right td-mono">{fmt(row.amount_paid, row.currency)}</td>
                  <td><Badge value={row.bill_status} /></td>
                  <td>
                    <div className="td-actions">
                      {canManage ? <button className="payments-kebab-btn" onClick={(e) => openActionMenu(e, row)}>...</button> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && filtered.length > 0 && (
            <Pagination {...paginationProps} label="vendor payments" />
          )}
        </div>
      </div>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title={editing ? `Edit Vendor Payment ${editing.payment_code || ''}` : 'Add Vendor Payment'}
        maxWidth={820}
        modalClassName="payments-modal-card"
        footer={<div className="payments-modal-actions"><button className="secondary-btn" onClick={() => setModal(false)}>Cancel</button><button className="primary-btn" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save Vendor Payment'}</button></div>}
      >
        <div className="form-grid cols-2">
          <Input label="Payment Code" value={form.payment_code} placeholder={nextCode.payment_code} onChange={(e) => set('payment_code', e.target.value.toUpperCase())} hint="Leave blank to auto-generate" />
          <Input label="Reference Number" value={form.reference_number} placeholder={nextCode.reference_number} onChange={(e) => set('reference_number', e.target.value.toUpperCase())} />

          {editing ? (
            <Input className="span-2" label="Bill" value={selectedBills[0] ? `${selectedBills[0].bill_number} • ${selectedBills[0].vendor_name}` : (form.bill_id || '')} readOnly hint="The bill cannot be changed while editing a payment" />
          ) : (
            <div className="span-2 payments-bill-picker">
              <label className="form-label">Bills <span style={{ color: 'var(--danger)' }}>*</span></label>
              <input className="form-control" placeholder="Search bill or vendor..." value={billPickerSearch} onChange={(e) => setBillPickerSearch(e.target.value)} />
              <div className="payments-bill-picker-list">
                {pickerBills.length === 0 ? (
                  <div className="text-muted text-sm" style={{ padding: 10 }}>No approved bills with an outstanding balance. Use “+ Add bill”, then submit &amp; approve it.</div>
                ) : pickerBills.map((bill) => {
                  const checked = form.bill_ids.map(String).includes(String(bill.id))
                  const offCurrency = lockedCurrency && String(bill.currency || '').toUpperCase() !== lockedCurrency
                  return (
                    <label key={bill.id} className={`payments-bill-picker-row${checked ? ' is-checked' : ''}${offCurrency && !checked ? ' is-disabled' : ''}`}>
                      <input type="checkbox" checked={checked} disabled={offCurrency && !checked} onChange={() => toggleBill(bill)} />
                      <span className="pbp-main">{bill.bill_number} · {bill.vendor_name}</span>
                      <span className="pbp-bal">{fmt(bill.balance_outstanding, bill.currency)}</span>
                    </label>
                  )
                })}
              </div>
              <button type="button" className="attachments-add-btn" onClick={() => { void openBillDrawer() }}>+ Add bill</button>
            </div>
          )}

          <Input label="Payment Date" required type="date" value={form.payment_date} onChange={(e) => set('payment_date', e.target.value)} />
          <Input label="Amount Paid" required type="number" min="0" step="0.01" value={form.amount_paid} onChange={(e) => set('amount_paid', e.target.value)} hint={!editing && billSummary.count > 1 ? 'Distributed across the selected bills, oldest balance first' : ''} />
          <Select label="Payment Method" value={form.payment_method} onChange={(e) => set('payment_method', e.target.value)}>
            {PAYMENT_METHODS.map((method) => <option key={method} value={method}>{method.replace(/_/g, ' ')}</option>)}
          </Select>
          <Input label="Currency" value={billSummary.currency || ''} readOnly hint="Follows the selected bill(s) currency" />

          <div className="span-2 payment-invoice-summary">
            <div className="payment-invoice-summary-head">
              <div className="fw-bold">{billSummary.count > 1 ? `Bills Summary (${billSummary.count})` : 'Bill Summary'}</div>
              {selectedBills.length === 1 ? <Badge value={selectedBills[0].bill_status} /> : null}
            </div>
            {selectedBills.length === 1 ? (
              <div className="payment-invoice-summary-grid">
                <div>
                  <div className="text-muted text-sm">Vendor</div>
                  <div className="fw-bold">{selectedBills[0].vendor_name}</div>
                  <div className="text-muted text-sm">{selectedBills[0].bill_number}</div>
                </div>
                <div>
                  <div className="text-muted text-sm">Amounts</div>
                  <div className="td-mono">Total: {fmt(selectedBills[0].total_amount, selectedBills[0].currency)}</div>
                  <div className="td-mono">Paid: {fmt(selectedBills[0].payment_paid_amount, selectedBills[0].currency)}</div>
                  <div className="td-mono" style={{ color: 'var(--danger)' }}>Balance: {fmt(selectedBills[0].balance_outstanding, selectedBills[0].currency)}</div>
                </div>
                <div>
                  <div className="text-muted text-sm">Approval</div>
                  <div>{String(selectedBills[0].approval_status || '').replace(/_/g, ' ')}</div>
                  <div className="text-muted text-sm">Due {fmtDateDisplay(selectedBills[0].due_date)}</div>
                </div>
              </div>
            ) : selectedBills.length > 1 ? (
              <div className="payment-invoice-summary-grid">
                <div>
                  <div className="text-muted text-sm">Bills selected</div>
                  <div className="fw-bold">{billSummary.count}</div>
                </div>
                <div>
                  <div className="text-muted text-sm">Combined total</div>
                  <div className="td-mono">{fmt(billSummary.total, billSummary.currency)}</div>
                </div>
                <div>
                  <div className="text-muted text-sm">Combined balance</div>
                  <div className="td-mono" style={{ color: 'var(--danger)' }}>{fmt(billSummary.balance, billSummary.currency)}</div>
                </div>
              </div>
            ) : (
              <div className="text-muted">Select one or more approved bills to disburse against.</div>
            )}
          </div>
          <div className="span-2"><Textarea label="Notes" rows={3} value={form.notes} onChange={(e) => set('notes', e.target.value)} /></div>
        </div>
      </Modal>

      <Drawer
        open={billDrawerOpen}
        onClose={() => setBillDrawerOpen(false)}
        title="Quick Add Bill"
        width={760}
        footer={(
          <>
            <button className="secondary-btn" onClick={() => setBillDrawerOpen(false)}>Cancel</button>
            <button className="primary-btn" onClick={saveBillQuickCreate} disabled={billSaving}>
              {billSaving ? 'Saving...' : 'Save Bill'}
            </button>
          </>
        )}
      >
        <div className="form-grid cols-2">
          <Input label="Bill Number" value={billDraft.bill_number} onChange={(e) => setBillDraftValue('bill_number', e.target.value.toUpperCase())} hint="Leave blank to auto-generate" />
          <SearchableSelect
            label="Vendor"
            required
            value={billDraft.vendor_id}
            options={vendorOptions}
            placeholder="Search vendor..."
            emptyMessage="No vendors found"
            onChange={(e) => setBillDraftValue('vendor_id', e.target.value)}
          />
          <SearchableSelect
            label="Region"
            required
            value={billDraft.region_id}
            options={regionOptions}
            placeholder="Search region..."
            emptyMessage="No regions found"
            onChange={(e) => setBillDraftValue('region_id', e.target.value)}
          />
          <Input label="Currency" value={billDraft.currency} readOnly hint="Auto selected from vendor/region" />
          <Input label="Bill Date" required type="date" value={billDraft.bill_date} onChange={(e) => setBillDraftValue('bill_date', e.target.value)} />
          <Input label="Due Date" required type="date" value={billDraft.due_date} onChange={(e) => setBillDraftValue('due_date', e.target.value)} />
          <Input label="Service Start" type="date" value={billDraft.service_period_start || ''} onChange={(e) => setBillDraftValue('service_period_start', e.target.value)} />
          <Input label="Service End" type="date" value={billDraft.service_period_end || ''} onChange={(e) => setBillDraftValue('service_period_end', e.target.value)} />
          <Input label="Invoice Reference" value={billDraft.invoice_reference || ''} onChange={(e) => setBillDraftValue('invoice_reference', e.target.value)} />
          <Input label="External Reference" value={billDraft.external_reference || ''} onChange={(e) => setBillDraftValue('external_reference', e.target.value)} />
          <div className="span-2 form-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontWeight: 800 }}>Line Items</div>
              <button className="btn btn-sm btn-primary" type="button" onClick={addBillLine}>+ Add Line</button>
            </div>
            <div style={{ display: 'grid', gap: 12 }}>
              {billDraft.line_items.map((item, index) => (
                <div key={`bill-line-${index}`} className="form-grid cols-2" style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, background: 'var(--surface)' }}>
                  <Input label="Description" value={item.description} onChange={(e) => updateBillLine(index, { description: e.target.value })} />
                  <Input label="Quantity" type="number" value={item.quantity} onChange={(e) => updateBillLine(index, { quantity: e.target.value })} />
                  <Input label="Unit Price" type="number" value={item.unit_price} onChange={(e) => updateBillLine(index, { unit_price: e.target.value })} />
                  <Input label="Expense Category" value={item.expense_category} onChange={(e) => updateBillLine(index, { expense_category: e.target.value })} />
                  <Input label="Cost Center" value={item.cost_center} onChange={(e) => updateBillLine(index, { cost_center: e.target.value })} />
                  <div style={{ display: 'flex', alignItems: 'end' }}>
                    {billDraft.line_items.length > 1 ? <button className="btn btn-sm btn-ghost" type="button" onClick={() => removeBillLine(index)}>Remove</button> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="span-2 form-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontWeight: 800 }}>Tax Lines</div>
              <button className="btn btn-sm btn-primary" type="button" onClick={addBillTax}>+ Add Tax</button>
            </div>
            <div style={{ display: 'grid', gap: 12 }}>
              {billDraft.tax_lines.map((item, index) => (
                <div key={`bill-tax-${index}`} className="form-grid cols-2" style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, background: 'var(--surface)' }}>
                  <Input label="Tax Name" value={item.tax_name} onChange={(e) => updateBillTax(index, { tax_name: e.target.value })} />
                  <Input label="Tax %" type="number" value={item.tax_percent} onChange={(e) => updateBillTax(index, { tax_percent: e.target.value })} />
                  <div style={{ display: 'flex', alignItems: 'end' }}>
                    {billDraft.tax_lines.length > 1 ? <button className="btn btn-sm btn-ghost" type="button" onClick={() => removeBillTax(index)}>Remove</button> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="span-2"><Textarea label="Notes" rows={3} value={billDraft.notes} onChange={(e) => setBillDraftValue('notes', e.target.value)} /></div>
        </div>
      </Drawer>

      <VendorPaymentViewModal
        paymentId={viewPaymentId}
        onClose={() => setViewPaymentId(null)}
        canEdit={canManage}
        onEdit={(p) => { setViewPaymentId(null); openEdit(p) }}
      />

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        title="Delete Vendor Payment"
        message={`Delete vendor payment ${deleting?.payment_code || ''}? Bill totals will be recalculated automatically.`}
        loading={deleteLoading}
      />

      {canManage && actionMenu.open && actionMenu.row && createPortal(
        <div className="floating-action-menu payments-action-menu" style={{ top: actionMenu.y, left: actionMenu.x }} onClick={(e) => e.stopPropagation()}>
          <button className="floating-action-item" onClick={() => openView(actionMenu.row)}>View</button>
          <button className="floating-action-item" onClick={() => openEdit(actionMenu.row)}>Edit</button>
          {canDelete ? <button className="floating-action-item danger" onClick={() => {
            setDeleting(actionMenu.row)
            setActionMenu({ open: false, x: 0, y: 0, row: null })
          }}>Delete</button> : null}
        </div>,
        document.body,
      )}
    </div>
  )
}

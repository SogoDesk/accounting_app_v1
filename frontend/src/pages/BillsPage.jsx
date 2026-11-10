import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams } from 'react-router-dom'
import api, { downloadFile } from '../services/api'
import {
  Modal,
  Drawer,
  Input,
  Select,
  SearchableSelect,
  Textarea,
  ConfirmDialog,
  fmt,
  fmtDate,
  fmtDateDisplay,
  currencySymbol,
  Card,
  StatCard,
  DataTable,
  StatusChip,
  PanelHeader,
} from '../components/ui/index.jsx'
import './BillsPage.css'
import AttachmentsField, { uploadPendingAttachments } from '../components/AttachmentsField'
import AttachmentsViewer from '../components/AttachmentsViewer'
import BillViewModal from '../components/BillViewModal'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import { useEntity } from '../context/EntityContext'
import { ACTION_ACCESS, hasAnyRole } from '../utils/acl'
import { useRegionCurrencyFilter } from '../utils/useRegionCurrencyFilter'
import { COUNTRIES, COUNTRY_BY_NAME } from '../data/countries'
import { buildRegionCode } from '../utils/regionHelpers'

const BILL_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED']

// Currencies to offer for a region: the entity's book (functional) currency, its
// suggested default, the region's country currency, any extras (e.g. the chosen
// vendor's currency), plus USD (group/reporting). For TetriQ-UK this is GBP + USD.
function regionCurrencyOptions(region, extras = []) {
  const list = []
  const add = (code) => {
    const c = String(code || '').toUpperCase().trim()
    if (c && !list.includes(c)) list.push(c)
  }
  if (region) {
    add(region.functional_currency)
    add(region.default_currency)
    add(COUNTRY_BY_NAME[region.country_name]?.currency)
  }
  extras.forEach(add)
  add('USD')
  return list
}

// The "Status" column is a PAYMENT status (approval lives in its own column).
// Derived from amounts so it is always Unpaid / Partially Paid / Paid regardless
// of where the bill is in its approval lifecycle.
const PAYMENT_STATUSES = ['UNPAID', 'PARTIALLY_PAID', 'PAID']

const paymentStatusOf = (row) => {
  if (String(row?.bill_status || '').toUpperCase() === 'CANCELLED') return 'CANCELLED'
  const total = Number(row?.total_amount || 0)
  const outstanding = Number(row?.balance_outstanding || 0)
  const paid = Math.max(total - outstanding, 0)
  if (total > 0 && outstanding <= 0.005) return 'PAID'
  if (paid > 0.005) return 'PARTIALLY_PAID'
  return 'UNPAID'
}

const PAY_METHODS = ['BANK_TRANSFER', 'WIRE_TRANSFER', 'ACH', 'CHECK', 'CASH', 'CARD', 'UPI', 'NEFT', 'RTGS', 'IMPS', 'OTHER']

const createBlankLine = () => ({
  description: '',
  quantity: '1',
  unit_price: '0',
  expense_category: '',
  cost_center: '',
})

const createBlankTax = () => ({
  tax_name: '',
  tax_percent: '0',
})

const BLANK = {
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
  line_items: [createBlankLine()],
  tax_lines: [createBlankTax()],
}

const BLANK_VENDOR_FORM = {
  vendor_name: '',
  vendor_code: '',
  region_id: '',
  billing_address: '',
  tax_identifier: '',
  currency: 'USD',
  default_payment_terms: 'NET_30',
  primary_contact_name: '',
  primary_contact_email: '',
  primary_contact_phone: '',
  bank_name: '',
  bank_account_name: '',
  bank_account_number: '',
  bank_routing_number: '',
  bank_swift_ifsc: '',
  status: 'ACTIVE',
}

const BLANK_REGION_FORM = {
  region_name: '',
  region_code: '',
  country_name: '',
  country_code: '',
  default_currency: 'USD',
  status: 'ACTIVE',
  company_name: '',
  company_address: '',
}

const normalizeNumber = (value) => {
  const num = Number(value || 0)
  return Number.isNaN(num) ? 0 : num
}

// Due Status is derived, never stored — the same "Due in 2 days / Overdue 3 days"
// countdown the InvoicesPage renders, keyed here on bill_status so a bill reads
// the same way an invoice does.
const getDateKey = (value) => String(value || '').slice(0, 10)

const toDateKey = (date) => {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

const isRealDateKey = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

// Whole days from today to the due date; negative once the date has passed.
const daysUntilDue = (value) => {
  const key = getDateKey(value)
  if (!isRealDateKey(key)) return null
  const dueMs = Date.parse(`${key}T00:00:00Z`)
  const todayMs = Date.parse(`${toDateKey(new Date())}T00:00:00Z`)
  return Math.round((dueMs - todayMs) / 86400000)
}

const pluralDays = (count) => `${count} ${count === 1 ? 'day' : 'days'}`

const DUE_SORT_CLOSED = Number.MAX_SAFE_INTEGER

// A countdown for bills that still owe money, and a plain state for the ones that
// can't come due (a cancelled, rejected or paid bill showing "Due in 12 days"
// would be a lie).
const getDueStatus = (row) => {
  const status = String(row?.bill_status || '').toUpperCase()
  const outstanding = normalizeNumber(row?.balance_outstanding) > 0

  if (status === 'CANCELLED') return { label: 'Cancelled', tone: 'closed', sort: DUE_SORT_CLOSED }
  if (status === 'REJECTED') return { label: 'Rejected', tone: 'closed', sort: DUE_SORT_CLOSED }
  if (status === 'DRAFT') return { label: 'Draft', tone: 'closed', sort: DUE_SORT_CLOSED }
  if (status === 'PAID' || !outstanding) return { label: 'Paid', tone: 'paid', sort: DUE_SORT_CLOSED }

  const days = daysUntilDue(row?.due_date)
  if (days === null) return { label: 'No due date', tone: 'closed', sort: DUE_SORT_CLOSED }
  if (days < 0) return { label: `Overdue ${pluralDays(Math.abs(days))}`, tone: 'overdue', sort: days }
  if (days === 0) return { label: 'Due today', tone: 'due-soon', sort: days }
  if (days === 1) return { label: 'Due tomorrow', tone: 'due-soon', sort: days }
  return { label: `Due in ${pluralDays(days)}`, tone: days <= 7 ? 'due-soon' : 'upcoming', sort: days }
}

// Two-letter vendor monogram for the list avatar.
const initialsOf = (name) => String(name || '?')
  .trim()
  .split(/\s+/)
  .map((word) => word[0])
  .filter(Boolean)
  .slice(0, 2)
  .join('')
  .toUpperCase() || '?'

// "Submitted N days ago" for the approval queue, from whatever timestamp exists.
const submittedAgo = (row) => {
  const src = row?.submitted_at || row?.created_at || row?.bill_date
  const days = daysUntilDue(src)
  if (days === null) return 'Submitted recently'
  const ago = Math.abs(days)
  if (ago === 0) return 'Submitted today'
  if (ago === 1) return 'Submitted 1 day ago'
  return `Submitted ${ago} days ago`
}

// The list "Status" column blends approval + payment lifecycle into one chip.
// Once a bill is payable and still owes money it mirrors the InvoicesPage
// countdown — "Overdue N days" / "Due today" / "Due in N days" — so a bill reads
// the same way an invoice does; the bill-only gates (Pending approval, Rejected,
// Draft) that have no invoice equivalent still take precedence.
const billStatusChip = (row) => {
  const approval = String(row?.approval_status || '').toUpperCase()
  const payment = paymentStatusOf(row)
  if (payment === 'CANCELLED') return { tone: 'neutral', label: 'Cancelled' }
  if (approval === 'PENDING') return { tone: 'warn', label: 'Pending' }
  if (approval === 'REJECTED') return { tone: 'danger', label: 'Rejected' }
  if (payment === 'PAID') return { tone: 'success', label: 'Paid' }
  // Approved or partially-paid bills that still owe money show the countdown.
  if (approval === 'APPROVED' || payment === 'PARTIALLY_PAID') {
    const days = daysUntilDue(row?.due_date)
    if (days !== null) {
      if (days < 0) return { tone: 'danger', label: `Overdue ${pluralDays(Math.abs(days))}` }
      if (days === 0) return { tone: 'warn', label: 'Due today' }
      if (days === 1) return { tone: 'warn', label: 'Due tomorrow' }
      return { tone: days <= 7 ? 'warn' : 'accent', label: `Due in ${pluralDays(days)}` }
    }
    if (payment === 'PARTIALLY_PAID') return { tone: 'accent', label: 'Part paid' }
    return { tone: 'success', label: 'Approved' }
  }
  if (approval === 'NOT_SUBMITTED') return { tone: 'neutral', label: 'Draft' }
  return { tone: 'neutral', label: (approval || 'Open').replace(/_/g, ' ') }
}

// Statuses a user may set by hand. OVERDUE is intentionally omitted — the
// backend deriveBillStatus computes it from the due date, so it is never
// offered as a manual choice here.
const STATUS_MENU_OPTIONS = ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PARTIALLY_PAID', 'PAID', 'CANCELLED']

const statusMenuTone = (status) => {
  switch (String(status || '').toUpperCase()) {
    case 'PAID':
    case 'APPROVED':
      return 'success'
    case 'REJECTED':
      return 'danger'
    case 'SUBMITTED':
      return 'warn'
    case 'PARTIALLY_PAID':
      return 'accent'
    default:
      return 'neutral'
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export default function BillsPage() {
  const toast = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const { user } = useAuth()
  const roleName = user?.roleName
  const canManage = hasAnyRole(roleName, ACTION_ACCESS.bills.manage)
  const canDelete = hasAnyRole(roleName, ACTION_ACCESS.bills.delete)

  const [rows, setRows] = useState([])
  const [vendors, setVendors] = useState([])
  const [regions, setRegions] = useState([])
  const [payments, setPayments] = useState([])
  // Company group currency the backend consolidated the *_reporting fields into.
  const [reportingCurrency, setReportingCurrency] = useState('USD')
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [vendorFilter, setVendorFilter] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [statusFilter, setStatusFilter] = useState('')
  const [approvalFilter, setApprovalFilter] = useState('')
  // Region is driven by the global top-nav switcher (no per-page dropdown).
  const { entityId: regionFilter } = useEntity()
  const [currencyFilter, setCurrencyFilter] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [exporting, setExporting] = useState(false)
  const [modal, setModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [viewBillId, setViewBillId] = useState(null)
  const [form, setForm] = useState(BLANK)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [actionMenu, setActionMenu] = useState({ open: false, x: 0, y: 0, row: null })
  // Click-to-change status dropdown on the Status column.
  const [statusMenu, setStatusMenu] = useState({ open: false, x: 0, y: 0, row: null })
  // Quick-pay dropdown on the Payment Status column (records a vendor payment).
  const [payStatusMenu, setPayStatusMenu] = useState({ open: false, x: 0, y: 0, row: null })
  const [payModal, setPayModal] = useState({ open: false, row: null, mode: 'PAID' })
  const [payForm, setPayForm] = useState({ amount_paid: '', payment_date: '', payment_method: 'BANK_TRANSFER', reference_number: '' })
  const [payLoading, setPayLoading] = useState(false)
  const [drawer, setDrawer] = useState({ type: null, returnTo: null })
  const [vendorDraft, setVendorDraft] = useState(BLANK_VENDOR_FORM)
  const [regionDraft, setRegionDraft] = useState(BLANK_REGION_FORM)
  const [drawerSaving, setDrawerSaving] = useState(false)

  const load = async () => {
    try {
      setLoading(true)
      const [billRes, vendorRes, regionRes, paymentRes] = await Promise.all([
        api.get('/bills'),
        api.get('/vendors'),
        api.get('/regions'),
        // Real vendor-payments feed powers the "Recent vendor payments" rail and
        // the "Paid — {month}" KPI. Endpoint has no region_id param, so we fetch
        // all (RBAC-scoped server-side) and filter by the current region below.
        api.get('/vendor-payments'),
      ])
      setRows(billRes.data?.data || [])
      setReportingCurrency(billRes.data?.reporting_currency || 'USD')
      setVendors(vendorRes.data?.data || [])
      setRegions(regionRes.data?.data || [])
      setPayments(paymentRes.data?.data || [])
    } catch (error) {
      toast.error(error.response?.data?.message || 'Failed to load bills')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  useEffect(() => {
    const close = () => {
      setActionMenu({ open: false, x: 0, y: 0, row: null })
      setPayStatusMenu({ open: false, x: 0, y: 0, row: null })
      setStatusMenu({ open: false, x: 0, y: 0, row: null })
    }
    const onKey = (event) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [])

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

  const regionOptions = useMemo(() => (
    regions.map((region) => ({
      value: String(region.id),
      label: region.region_name,
      meta: [region.country_name, region.default_currency].filter(Boolean).join(' • '),
      searchText: `${region.region_code || ''} ${region.company_name || ''}`.trim(),
    }))
  ), [regions])

  // Bill currency options: scoped to the bill's region, plus the selected
  // vendor's currency and the current value so nothing is ever dropped.
  const currencyOptions = useMemo(() => (
    regionCurrencyOptions(regionById[String(form.region_id)], [
      vendorById[String(form.vendor_id)]?.currency,
      form.currency,
    ])
  ), [regionById, vendorById, form.region_id, form.vendor_id, form.currency])

  const vendorOptions = useMemo(() => {
    const scope = form.region_id
      ? vendors.filter((vendor) => String(vendor.region_id) === String(form.region_id))
      : vendors
    return scope.map((vendor) => ({
      value: String(vendor.id),
      label: vendor.vendor_name,
      meta: [vendor.vendor_code, vendor.region_name].filter(Boolean).join(' • '),
      searchText: `${vendor.primary_contact_name || ''} ${vendor.primary_contact_email || ''}`.trim(),
    }))
  }, [vendors, form.region_id])

  const countryOptions = useMemo(() => (
    COUNTRIES.map((country) => ({
      value: country.iso2,
      label: country.name,
      meta: `${country.currency} • ${country.symbol}`,
      searchText: `${country.iso2} ${country.currency}`.trim(),
    }))
  ), [])

  // Vendor-invoice attachments selected in the create/edit modal (uploaded on save).
  const [billFiles, setBillFiles] = useState([])

  const openCreate = () => {
    const today = new Date().toISOString().slice(0, 10)
    setEditing(null)
    setBillFiles([])
    setViewBillId(null)
    setForm({ ...BLANK, bill_date: today, due_date: today })
    setModal(true)
  }

  useEffect(() => {
    if (searchParams.get('action') !== 'create' || !canManage) return
    openCreate()
    setSearchParams({}, { replace: true })
  }, [searchParams, setSearchParams, canManage])

  // Deep-link to edit a specific bill (e.g. Edit from a vendor's bill modal:
  // /bills?edit=<id>). Opens the full edit form on this page.
  useEffect(() => {
    const editId = searchParams.get('edit')
    if (!editId) return
    const next = new URLSearchParams(searchParams)
    next.delete('edit')
    setSearchParams(next, { replace: true })
    if (canManage) void openEdit({ id: editId })
  }, [searchParams, setSearchParams, canManage])

  const openEdit = async (row) => {
    try {
      const res = await api.get(`/bills/${row.id}`)
      const bill = res.data?.data
      setEditing(row)
      setBillFiles([])
      setViewBillId(null)
      setForm({
        ...BLANK,
        ...bill,
        vendor_id: bill.vendor_id ? String(bill.vendor_id) : '',
        region_id: bill.region_id ? String(bill.region_id) : '',
        bill_date: fmtDate(bill.bill_date),
        due_date: fmtDate(bill.due_date),
        service_period_start: fmtDate(bill.service_period_start),
        service_period_end: fmtDate(bill.service_period_end),
        line_items: (bill.line_items || []).map((item) => ({
          description: item.description || '',
          quantity: String(item.quantity ?? '1'),
          unit_price: String(item.unit_price ?? '0'),
          expense_category: item.expense_category || '',
          cost_center: item.cost_center || '',
        })),
        tax_lines: (bill.tax_lines || []).length
          ? bill.tax_lines.map((tax) => ({ tax_name: tax.tax_name || '', tax_percent: String(tax.tax_percent ?? '0') }))
          : [createBlankTax()],
      })
      setModal(true)
    } catch (error) {
      toast.error(error.response?.data?.message || 'Failed to load bill details')
    } finally {
      setActionMenu({ open: false, x: 0, y: 0, row: null })
    }
  }

  const openView = (row) => {
    setViewBillId(row?.id ?? null)
    setActionMenu({ open: false, x: 0, y: 0, row: null })
  }

  const openActionMenu = (event, row) => {
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    setActionMenu({ open: true, x: rect.right - 210, y: rect.bottom + 8, row })
  }

  const openStatusMenu = (event, row) => {
    event.stopPropagation()
    if (!canManage) return
    if (statusMenu.open && String(statusMenu.row?.id) === String(row.id)) {
      setStatusMenu({ open: false, x: 0, y: 0, row: null })
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    const menuWidth = 190
    const menuHeight = STATUS_MENU_OPTIONS.length * 36 + 12
    const pad = 12
    const left = Math.min(
      Math.max(rect.left, pad),
      window.innerWidth - menuWidth - pad,
    )
    const top = rect.bottom + menuHeight + pad > window.innerHeight
      ? Math.max(rect.top - menuHeight - 6, pad)
      : rect.bottom + 6
    setActionMenu({ open: false, x: 0, y: 0, row: null })
    setPayStatusMenu({ open: false, x: 0, y: 0, row: null })
    setStatusMenu({ open: true, x: left, y: top, row })
  }

  // A bill's payment status can only change by recording a real vendor payment,
  // and only an approved bill with a balance is payable.
  const canQuickPay = (row) => (
    canManage
    && String(row.approval_status || '').toUpperCase() === 'APPROVED'
    && normalizeNumber(row.balance_outstanding) > 0.005
  )

  const openPayStatusMenu = (event, row) => {
    event.stopPropagation()
    if (!canQuickPay(row)) return
    const rect = event.currentTarget.getBoundingClientRect()
    setActionMenu({ open: false, x: 0, y: 0, row: null })
    setPayStatusMenu({ open: true, x: Math.max(rect.left, 12), y: rect.bottom + 8, row })
  }

  const pickPayStatus = (row, mode) => {
    const balance = normalizeNumber(row.balance_outstanding)
    setPayStatusMenu({ open: false, x: 0, y: 0, row: null })
    setPayForm({
      amount_paid: mode === 'PAID' ? String(Number(balance.toFixed(2))) : '',
      payment_date: new Date().toISOString().slice(0, 10),
      payment_method: 'BANK_TRANSFER',
      reference_number: '',
    })
    setPayModal({ open: true, row, mode })
  }

  const recordVendorPayment = async () => {
    const row = payModal.row
    if (!row) return
    const amount = normalizeNumber(payForm.amount_paid)
    const balance = normalizeNumber(row.balance_outstanding)
    if (amount <= 0) { toast.error('Amount must be greater than zero'); return }
    if (amount > balance + 0.005) { toast.error(`Amount cannot exceed the outstanding balance of ${fmt(balance, row.currency)}`); return }
    if (!payForm.payment_date) { toast.error('Payment date is required'); return }

    setPayLoading(true)
    try {
      await api.post('/vendor-payments', {
        bill_id: Number(row.id),
        amount_paid: amount,
        payment_date: payForm.payment_date,
        payment_method: payForm.payment_method,
        reference_number: payForm.reference_number || '',
      })
      toast.success('Vendor payment recorded')
      setPayModal({ open: false, row: null, mode: 'PAID' })
      load()
    } catch (error) {
      toast.error(error.response?.data?.message || 'Failed to record payment')
    } finally {
      setPayLoading(false)
    }
  }

  const applyRegionToBill = (nextRegionId) => {
    const region = regionById[String(nextRegionId)]
    setForm((prev) => {
      const selectedVendor = vendorById[String(prev.vendor_id)]
      const keepVendor = selectedVendor && String(selectedVendor.region_id) === String(nextRegionId)
      return {
        ...prev,
        region_id: nextRegionId,
        vendor_id: keepVendor ? prev.vendor_id : '',
        // Bills (AP) default to the entity's book currency — GBP for TetriQ-UK.
        currency: region?.functional_currency || region?.default_currency || prev.currency,
      }
    })
  }

  const applyVendorToBill = (nextVendorId) => {
    const vendor = vendorById[String(nextVendorId)]
    setForm((prev) => ({
      ...prev,
      vendor_id: nextVendorId,
      region_id: vendor?.region_id ? String(vendor.region_id) : prev.region_id,
      currency: vendor?.currency || prev.currency,
    }))
  }

  const openVendorDrawer = (initialName = '') => {
    const selectedRegion = regionById[String(form.region_id)]
    setDrawerSaving(false)
    setVendorDraft({
      ...BLANK_VENDOR_FORM,
      vendor_name: String(initialName || '').trim(),
      region_id: form.region_id || '',
      currency: selectedRegion?.functional_currency || selectedRegion?.default_currency || form.currency || 'USD',
    })
    setDrawer({ type: 'vendor', returnTo: null })
  }

  const openRegionDrawer = (initialName = '', returnTo = null) => {
    setDrawerSaving(false)
    setRegionDraft({
      ...BLANK_REGION_FORM,
      region_name: String(initialName || '').trim(),
      region_code: buildRegionCode(initialName),
      default_currency: form.currency || 'USD',
    })
    setDrawer({ type: 'region', returnTo })
  }

  const closeDrawer = () => {
    setDrawer({ type: null, returnTo: null })
    setDrawerSaving(false)
  }

  const setFormValue = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))

  const setVendorDraftValue = (key, value) => {
    setVendorDraft((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'region_id') {
        const region = regionById[String(value)]
        const preferred = region?.functional_currency || region?.default_currency
        if (preferred) next.currency = preferred
      }
      return next
    })
  }

  const setRegionDraftValue = (key, value) => {
    setRegionDraft((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'region_name') next.region_code = buildRegionCode(value)
      if (key === 'country_code') {
        const country = COUNTRIES.find((entry) => entry.iso2 === value)
        next.country_name = country?.name || ''
        next.default_currency = country?.currency || prev.default_currency
      }
      return next
    })
  }

  const updateLineItem = (index, patch) => {
    setForm((prev) => ({
      ...prev,
      line_items: (prev.line_items || []).map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item),
    }))
  }

  const addLineItem = () => setForm((prev) => ({ ...prev, line_items: [...(prev.line_items || []), createBlankLine()] }))
  const removeLineItem = (index) => setForm((prev) => ({
    ...prev,
    line_items: (prev.line_items || []).filter((_, itemIndex) => itemIndex !== index),
  }))

  const updateTax = (index, patch) => {
    setForm((prev) => ({
      ...prev,
      tax_lines: (prev.tax_lines || []).map((tax, taxIndex) => taxIndex === index ? { ...tax, ...patch } : tax),
    }))
  }

  const addTax = () => setForm((prev) => ({ ...prev, tax_lines: [...(prev.tax_lines || []), createBlankTax()] }))
  const removeTax = (index) => setForm((prev) => ({
    ...prev,
    tax_lines: (prev.tax_lines || []).filter((_, taxIndex) => taxIndex !== index),
  }))

  const amounts = useMemo(() => {
    const subtotal = (form.line_items || []).reduce((sum, item) => {
      return sum + normalizeNumber(item.quantity) * normalizeNumber(item.unit_price)
    }, 0)
    const taxAmount = (form.tax_lines || []).reduce((sum, line) => sum + ((subtotal * normalizeNumber(line.tax_percent)) / 100), 0)
    return {
      subtotal,
      taxAmount,
      total: subtotal + taxAmount,
    }
  }, [form.line_items, form.tax_lines])

  const save = async () => {
    if (!form.vendor_id || !form.region_id || !form.bill_date || !form.due_date) {
      toast.error('Vendor, region, bill date, and due date are required')
      return
    }

    if (!editing && billFiles.length === 0) {
      toast.error('Please attach the vendor invoice (at least one document)')
      return
    }

    const payload = {
      ...form,
      vendor_id: Number(form.vendor_id),
      region_id: Number(form.region_id),
      line_items: (form.line_items || []).map((item) => ({
        ...item,
        quantity: normalizeNumber(item.quantity),
        unit_price: normalizeNumber(item.unit_price),
      })),
      tax_lines: (form.tax_lines || []).map((line) => ({
        tax_name: line.tax_name,
        tax_percent: normalizeNumber(line.tax_percent),
      })),
    }

    setSaving(true)
    try {
      let response
      if (editing) {
        response = await api.put(`/bills/${editing.id}`, payload)
      } else {
        response = await api.post('/bills', payload)
      }
      const savedId = response?.data?.data?.id || editing?.id

      // Upload any newly-attached vendor invoices to the saved bill.
      if (savedId && billFiles.length) {
        try {
          await uploadPendingAttachments('bill', savedId, billFiles)
        } catch (uploadError) {
          toast.error('Bill saved, but document upload failed. Open the bill to retry.')
        }
      }
      setBillFiles([])

      toast.success(`Bill ${editing ? 'updated' : 'created'} successfully`)
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

  const saveRegionQuickCreate = async () => {
    if (!regionDraft.region_name || !regionDraft.country_name || !regionDraft.default_currency) {
      toast.error('Region name, country, and currency are required')
      return
    }

    const payload = new FormData()
    payload.append('region_name', regionDraft.region_name)
    payload.append('region_code', regionDraft.region_code || buildRegionCode(regionDraft.region_name))
    payload.append('country_name', regionDraft.country_name)
    payload.append('country_code', regionDraft.country_code || '')
    payload.append('default_currency', regionDraft.default_currency)
    payload.append('status', regionDraft.status || 'ACTIVE')
    payload.append('company_name', regionDraft.company_name || '')
    payload.append('company_address', regionDraft.company_address || '')

    setDrawerSaving(true)
    try {
      const response = await api.post('/regions', payload, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      const created = response.data?.data
      if (!created) throw new Error('Region create response missing data')
      setRegions((prev) => [created, ...prev])

      if (drawer.returnTo === 'vendor') {
        setVendorDraft((prev) => ({
          ...prev,
          region_id: String(created.id),
          currency: created.default_currency || prev.currency,
        }))
        setDrawer({ type: 'vendor', returnTo: null })
      } else {
        setForm((prev) => ({
          ...prev,
          region_id: String(created.id),
          vendor_id: '',
          currency: created.default_currency || prev.currency,
        }))
        closeDrawer()
      }

      toast.success('Region created successfully')
    } catch (error) {
      toast.error(error.response?.data?.message || error.message || 'Failed to create region')
    } finally {
      setDrawerSaving(false)
    }
  }

  const saveVendorQuickCreate = async () => {
    if (!vendorDraft.vendor_name || !vendorDraft.region_id) {
      toast.error('Vendor name and region are required')
      return
    }

    setDrawerSaving(true)
    try {
      const response = await api.post('/vendors', vendorDraft)
      const created = response.data?.data
      if (!created) throw new Error('Vendor create response missing data')

      const region = regionById[String(created.region_id)]
      const createdWithRegion = region ? { ...created, region_name: region.region_name } : created
      setVendors((prev) => [createdWithRegion, ...prev])
      setForm((prev) => ({
        ...prev,
        vendor_id: String(created.id),
        region_id: created.region_id ? String(created.region_id) : prev.region_id,
        currency: created.currency || prev.currency,
      }))
      closeDrawer()
      toast.success('Vendor created successfully')
    } catch (error) {
      toast.error(error.response?.data?.message || error.message || 'Failed to create vendor')
    } finally {
      setDrawerSaving(false)
    }
  }

  const changeStatus = async (row, status) => {
    let comments = ''
    if (status === 'REJECTED') {
      comments = window.prompt('Rejection comment', '') || ''
    }
    try {
      await api.patch(`/bills/${row.id}/status`, { status, comments })
      toast.success(`Bill marked ${status.replace(/_/g, ' ').toLowerCase()}`)
      load()
    } catch (error) {
      toast.error(error.response?.data?.message || 'Status update failed')
    } finally {
      setActionMenu({ open: false, x: 0, y: 0, row: null })
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    setDeleteLoading(true)
    try {
      await api.delete(`/bills/${deleting.id}`)
      toast.success('Bill deleted successfully')
      setDeleting(null)
      load()
    } catch (error) {
      toast.error(error.response?.data?.message || 'Delete failed')
    } finally {
      setDeleteLoading(false)
    }
  }

  // Base set: every filter EXCEPT the approval tab. KPIs, the approval queue and
  // the recent-payments rail all read this so switching the list tab never moves
  // the top-line numbers.
  const { visibleCurrencies, selectCurrency } = useRegionCurrencyFilter({
    regions,
    currencies: rows.map((r) => r.currency),
    regionFilter,
    currencyFilter,
    setRegionFilter: () => {},
    setCurrencyFilter,
  })

  const kpiBase = rows.filter((row) => {
    const needle = search.trim().toLowerCase()
    const matchSearch = !needle || [row.bill_number, row.vendor_name, row.external_reference]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle))
    const matchStatus = !statusFilter || paymentStatusOf(row) === statusFilter
    const matchVendor = !vendorFilter || String(row.vendor_id || '') === String(vendorFilter)
    const matchRegion = !regionFilter || String(row.region_id || '') === String(regionFilter)
    const matchCurrency = !currencyFilter || String(row.currency || '').toUpperCase() === currencyFilter
    const day = String(row.bill_date || '').slice(0, 10)
    const matchDate = (!fromDate || day >= fromDate) && (!toDate || day <= toDate)
    return matchSearch && matchStatus && matchVendor && matchRegion && matchCurrency && matchDate
  })

  // The visible list rows additionally honour the approval tab.
  const filtered = kpiBase.filter((row) => (
    !approvalFilter || String(row.approval_status || '').toUpperCase() === approvalFilter
  ))

  // Multi-currency KPI consolidation. When a single region is in scope every row
  // shares one currency, so KPIs sum the native amounts and display that currency.
  // Across "All regions" we sum the backend's group-currency (*_reporting) copies
  // so mixed £/₹/$ are converted before adding — never summed raw.
  const consolidated = !regionFilter
  const kpiCcy = consolidated ? reportingCurrency : (kpiBase[0]?.currency || reportingCurrency)
  const pickAmt = (row, nativeField, reportingField) =>
    normalizeNumber(consolidated ? row[reportingField] : row[nativeField])

  const exportXlsx = async () => {
    setExporting(true)
    try {
      const params = new URLSearchParams()
      if (search.trim()) params.set('search', search.trim())
      if (statusFilter) params.set('status', statusFilter)
      if (approvalFilter) params.set('approval_status', approvalFilter)
      if (regionFilter) params.set('region_id', regionFilter)
      if (fromDate) params.set('from', fromDate)
      if (toDate) params.set('to', toDate)
      params.set('format', 'xlsx')
      const range = (fromDate || toDate) ? `_${fromDate || 'start'}_to_${toDate || 'end'}` : ''
      await downloadFile(`/api/bills/export?${params.toString()}`, `bills${range}.xlsx`)
      toast.success('Bills exported to Excel')
    } catch { toast.error('Export failed') }
    finally { setExporting(false) }
  }

  // KPI + rail figures, all derived from kpiBase so the list tab never moves them.
  const stats = useMemo(() => {
    const outstanding = kpiBase.reduce((sum, row) => sum + pickAmt(row, 'balance_outstanding', 'balance_outstanding_reporting'), 0)

    const dueWeek = kpiBase.filter((row) => {
      const days = daysUntilDue(row.due_date)
      return days !== null && days >= 0 && days <= 7 && normalizeNumber(row.balance_outstanding) > 0.005
    })
    const dueWeekAmount = dueWeek.reduce((sum, row) => sum + pickAmt(row, 'balance_outstanding', 'balance_outstanding_reporting'), 0)
    const dueWeekVendors = new Set(dueWeek.map((row) => row.vendor_id)).size

    const pendingRows = kpiBase.filter((row) => String(row.approval_status || '').toUpperCase() === 'PENDING')
    const pendingAmount = pendingRows.reduce((sum, row) => (
      sum + (pickAmt(row, 'balance_outstanding', 'balance_outstanding_reporting') || pickAmt(row, 'total_amount', 'total_amount_reporting'))
    ), 0)

    return {
      total: kpiBase.length,
      outstanding,
      dueWeekAmount,
      dueWeekCount: dueWeek.length,
      dueWeekVendors,
      pendingCount: pendingRows.length,
      pendingAmount,
    }
  }, [kpiBase, consolidated])

  // Vendor payments scoped to the current region filter (the endpoint carries no
  // region_id param, so the widgets honour the filter here). Empty when the feed
  // hasn't loaded — the rail and KPI render graceful zero/empty states.
  const scopedPayments = useMemo(() => (
    payments.filter((p) => !regionFilter || String(p.region_id || '') === String(regionFilter))
  ), [payments, regionFilter])

  // "Paid — {month}" KPI: real vendor payments disbursed in the current month.
  const paidStats = useMemo(() => {
    const now = new Date()
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const monthPayments = scopedPayments.filter((p) => String(p.payment_date || '').slice(0, 7) === ym)
    return {
      amount: monthPayments.reduce((sum, p) => sum + pickAmt(p, 'amount_paid', 'amount_paid_reporting'), 0),
      count: monthPayments.length,
    }
  }, [scopedPayments, consolidated])

  // Approval queue: pending bills, newest-submitted first, with a real amount.
  const approvalQueue = useMemo(() => (
    kpiBase
      .filter((row) => String(row.approval_status || '').toUpperCase() === 'PENDING')
      .sort((a, b) => String(b.submitted_at || b.created_at || b.bill_date || '').localeCompare(String(a.submitted_at || a.created_at || a.bill_date || '')))
  ), [kpiBase])

  // Recent vendor payments, straight from the vendor-payments feed
  // (newest disbursement first), scoped to the current region filter.
  const recentPayments = useMemo(() => (
    [...scopedPayments]
      .sort((a, b) => String(b.payment_date || '').localeCompare(String(a.payment_date || '')))
      .slice(0, 5)
  ), [scopedPayments])

  // Segmented tab counts for the list panel.
  const tabCounts = useMemo(() => ({
    all: kpiBase.length,
    approved: kpiBase.filter((row) => String(row.approval_status || '').toUpperCase() === 'APPROVED').length,
    pending: kpiBase.filter((row) => String(row.approval_status || '').toUpperCase() === 'PENDING').length,
  }), [kpiBase])

  // Footer column totals for the visible list.
  const listTotals = useMemo(() => ({
    total: filtered.reduce((sum, row) => sum + pickAmt(row, 'total_amount', 'total_amount_reporting'), 0),
    balance: filtered.reduce((sum, row) => sum + pickAmt(row, 'balance_outstanding', 'balance_outstanding_reporting'), 0),
  }), [filtered, consolidated])

  const monthLabel = MONTHS[new Date().getMonth()]

  return (
    <div className="dashboard-page bills-page bills-v2">
      <div className="bills-head">
        <div className="bills-head-main">
          <button type="button" className="bills-back" onClick={() => window.history.back()} aria-label="Back">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <div>
            <div className="bills-title">Bills &amp; vendor payments</div>
            <div className="bills-sub">Accounts payable: vendor bills, the approval queue and disbursements. Bills post to the GL on approval.</div>
          </div>
        </div>
        <div className="bills-head-actions">
          <button
            type="button"
            className="bills-btn bills-btn-secondary"
            title="Clear all filters"
            onClick={() => { setSearch(''); setVendorFilter(''); setStatusFilter(''); setApprovalFilter(''); setFromDate(''); setToDate('') }}
          >
            Reset
          </button>
          <button type="button" className="bills-btn bills-btn-secondary" onClick={exportXlsx} disabled={exporting || filtered.length === 0} title="Download the filtered bills as Excel">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
            {exporting ? 'Exporting…' : 'Export'}
          </button>
          {canManage ? (
            <button type="button" className="bills-btn bills-btn-primary" onClick={openCreate}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
              New bill
            </button>
          ) : null}
        </div>
      </div>

      <div className="bills-kpis">
        <StatCard
          label="Open payables"
          prefix={currencySymbol(kpiCcy)}
          value={Math.round(stats.outstanding).toLocaleString('en-US')}
          sub={`${stats.total} open ${stats.total === 1 ? 'bill' : 'bills'}`}
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="3" /><path d="M2 10h20M16 15h2" /></svg>}
        />
        <StatCard
          label="Due this week"
          prefix={currencySymbol(kpiCcy)}
          value={Math.round(stats.dueWeekAmount).toLocaleString('en-US')}
          sub={`${stats.dueWeekCount} ${stats.dueWeekCount === 1 ? 'bill' : 'bills'} · ${stats.dueWeekVendors} ${stats.dueWeekVendors === 1 ? 'vendor' : 'vendors'}`}
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>}
        />
        <StatCard
          label="Awaiting approval"
          value={String(stats.pendingCount)}
          sub={`${fmt(stats.pendingAmount, kpiCcy)} to review`}
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" /><path d="M9.5 12l1.8 1.8L15 10.2" /></svg>}
        />
        <StatCard
          label={`Paid — ${monthLabel}`}
          prefix={currencySymbol(kpiCcy)}
          value={Math.round(paidStats.amount).toLocaleString('en-US')}
          sub={`${paidStats.count} vendor ${paidStats.count === 1 ? 'payment' : 'payments'}`}
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M8.5 12.2l2.4 2.3 4.6-4.8" /></svg>}
        />
      </div>

      <div className="bills-filters">
        <span className={`bills-pill${vendorFilter ? ' is-active' : ''}`}>
          <select value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)} aria-label="Filter by vendor">
            <option value="">All vendors</option>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.vendor_name}</option>)}
          </select>
          <span className="bills-pill-chev"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg></span>
        </span>
        <span className={`bills-pill${statusFilter ? ' is-active' : ''}`}>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by payment status">
            <option value="">Status: All</option>
            {PAYMENT_STATUSES.map((status) => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}
          </select>
          <span className="bills-pill-chev"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg></span>
        </span>
        <span className={`bills-pill${currencyFilter ? ' is-active' : ''}`}>
          <select value={currencyFilter} onChange={(e) => selectCurrency(e.target.value)} aria-label="Filter by currency">
            <option value="">All currencies</option>
            {visibleCurrencies.map((code) => <option key={code} value={code}>{currencySymbol(code)} {code}</option>)}
          </select>
          <span className="bills-pill-chev"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg></span>
        </span>
        <span className="bills-pill bills-pill-search">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Bill # or vendor" aria-label="Search bills" />
          <span className="bills-pill-ico"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg></span>
        </span>
      </div>

      <div className="bills-content">
        <div className="bills-panel">
          <PanelHeader
            title="Open bills"
            tabs={[
              { key: '', label: 'All', count: tabCounts.all },
              { key: 'APPROVED', label: 'Approved', count: tabCounts.approved },
              { key: 'PENDING', label: 'Pending', count: tabCounts.pending },
            ]}
            activeTab={approvalFilter}
            onTab={setApprovalFilter}
            actions={(
              <span className="bills-panel-icons">
                <button type="button" className="bills-mini-btn" title="Export" onClick={exportXlsx} disabled={exporting || filtered.length === 0}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" /></svg>
                </button>
              </span>
            )}
          />
          <DataTable
            loading={loading}
            rows={filtered}
            paginate
            pageLabel="bills"
            getRowId={(row) => row.id}
            selectedId={selectedId}
            onRowSelect={(row) => { setSelectedId(row.id); openView(row) }}
            empty="No bills found"
            columns={[
              {
                key: 'bill_number', header: 'Bill #', mono: true, primary: true, width: 118,
                render: (row) => (
                  <button
                    type="button"
                    className="bills-number-btn"
                    onClick={(e) => { e.stopPropagation(); openView(row) }}
                    title={`View bill ${row.bill_number}`}
                  >
                    {row.bill_number}
                  </button>
                ),
              },
              {
                key: 'vendor',
                header: 'Vendor',
                sortAccessor: (row) => String(row.vendor_name || '').toLowerCase(),
                render: (row) => (
                  <div className="bills-vend">
                    <span className="bills-avatar">{initialsOf(row.vendor_name)}</span>
                    <span className="bills-vend-txt">
                      <span className="bills-vend-name">{row.vendor_name || '—'}</span>
                      <span className="bills-vend-sub">{row.notes || row.external_reference || row.region_name || '—'}</span>
                    </span>
                  </div>
                ),
              },
              { key: 'bill_date', header: 'Bill date', mono: true, width: 104, render: (row) => fmtDateDisplay(row.bill_date) },
              {
                key: 'due_date',
                header: 'Due',
                mono: true,
                width: 104,
                render: (row) => {
                  const ds = getDueStatus(row)
                  return <span className={ds.tone === 'overdue' ? 'bills-due-over' : undefined} title={ds.label}>{fmtDateDisplay(row.due_date)}</span>
                },
              },
              { key: 'total_amount', header: 'Total', align: 'right', mono: true, width: 112, render: (row) => fmt(row.total_amount, row.currency) },
              { key: 'balance_outstanding', header: 'Balance', align: 'right', mono: true, width: 112, render: (row) => fmt(row.balance_outstanding, row.currency) },
              {
                key: 'status',
                header: 'Status',
                width: 108,
                // Sort by urgency (signed days-to-due): most overdue first, then
                // soonest due, then later; closed/paid/no-due-date rows sort last.
                sortAccessor: (row) => getDueStatus(row).sort,
                render: (row) => {
                  const chip = billStatusChip(row)
                  if (canQuickPay(row)) {
                    return (
                      <button type="button" className="bills-chip-btn" title="Record a payment to update status" onClick={(e) => openPayStatusMenu(e, row)}>
                        <StatusChip tone={chip.tone}>{chip.label}</StatusChip>
                      </button>
                    )
                  }
                  if (!canManage) return <StatusChip tone={chip.tone}>{chip.label}</StatusChip>
                  const isOpen = statusMenu.open && String(statusMenu.row?.id) === String(row.id)
                  return (
                    <button
                      type="button"
                      className={`bills-status-btn${isOpen ? ' is-open' : ''}`}
                      onClick={(e) => openStatusMenu(e, row)}
                      title="Change status"
                    >
                      <StatusChip tone={chip.tone}>{chip.label}</StatusChip>
                      <span className="bills-status-caret" aria-hidden="true">
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
                      </span>
                    </button>
                  )
                },
              },
              {
                key: 'act',
                header: '',
                width: 44,
                align: 'right',
                sortable: false,
                render: (row) => (canManage ? (
                  <button type="button" className="bills-kebab" onClick={(e) => openActionMenu(e, row)} aria-label="Row actions">⋯</button>
                ) : null),
              },
            ]}
            footer={[
              { colSpan: 4, render: () => `${filtered.length} of ${rows.length} open bills${consolidated ? ` · converted to ${kpiCcy}` : ''}` },
              { align: 'right', mono: true, render: () => fmt(listTotals.total, kpiCcy) },
              { align: 'right', mono: true, render: () => fmt(listTotals.balance, kpiCcy) },
              { colSpan: 2, render: () => null },
            ]}
          />
        </div>

        <div className="bills-rail">
          <Card>
            <div className="bills-card-head">
              <span className="bills-card-title">Approval queue</span>
              <StatusChip tone={approvalQueue.length ? 'accent' : 'neutral'}>{approvalQueue.length} PENDING</StatusChip>
            </div>
            <div className="bills-appr-list">
              {approvalQueue.length === 0 ? (
                <div className="bills-appr-empty">No bills awaiting approval.</div>
              ) : approvalQueue.slice(0, 6).map((row, i) => (
                <div key={row.id} className={`bills-appr${i === 0 ? ' is-top' : ''}`}>
                  <div className="bills-appr-row">
                    <span className="bills-appr-num">{row.bill_number}</span>
                    <span className="bills-appr-amt">{fmt(row.balance_outstanding || row.total_amount, row.currency)}</span>
                  </div>
                  <span className="bills-appr-vendor">{row.vendor_name}</span>
                  <span className="bills-appr-when">{submittedAgo(row)}</span>
                  {canManage ? (
                    <div className="bills-appr-actions">
                      <button type="button" className="bills-appr-pill is-approve" onClick={() => changeStatus(row, 'APPROVED')}>Approve</button>
                      <button type="button" className="bills-appr-pill is-reject" onClick={() => changeStatus(row, 'REJECTED')}>Reject</button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <div className="bills-card-head">
              <span className="bills-card-title">Recent vendor payments</span>
              <button type="button" className="bills-card-link" onClick={() => setStatusFilter('PAID')}>View all</button>
            </div>
            <div className="bills-pay-list">
              {loading ? (
                <div className="bills-appr-empty">Loading vendor payments…</div>
              ) : recentPayments.length === 0 ? (
                <div className="bills-appr-empty">No vendor payments recorded yet.</div>
              ) : recentPayments.map((pay) => (
                <div key={pay.id} className="bills-pay">
                  <div className="bills-pay-main">
                    <span className="bills-pay-name">{pay.vendor_name || '—'}</span>
                    <span className="bills-pay-ref">{pay.payment_code || pay.reference_number || pay.bill_number} · {fmtDateDisplay(pay.payment_date)}</span>
                  </div>
                  <span className="bills-pay-amt">{fmt(pay.amount_paid, pay.currency)}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title={editing ? 'Edit Bill' : 'New Bill'}
        maxWidth={980}
        modalClassName="invoices-modal-card"
        footer={<div className="invoices-modal-actions"><button className="secondary-btn" onClick={() => setModal(false)}>Cancel</button><button className="primary-btn" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save Bill'}</button></div>}
      >
        <div className="form-grid cols-3">
          <Input label="Bill Number" value={form.bill_number} onChange={(e) => setFormValue('bill_number', e.target.value.toUpperCase())} hint="Leave blank to auto-generate" />
          <SearchableSelect
            label="Vendor"
            required
            value={form.vendor_id}
            options={vendorOptions}
            placeholder={form.region_id ? 'Search vendor in selected region...' : 'Search vendor...'}
            emptyMessage={form.region_id ? 'No vendors found in this region' : 'No vendors found'}
            createLabel="+ Add vendor"
            onChange={(e) => applyVendorToBill(e.target.value)}
            onCreate={(query) => openVendorDrawer(query)}
          />
          <SearchableSelect
            label="Region"
            required
            value={form.region_id}
            options={regionOptions}
            placeholder="Search region..."
            emptyMessage="No regions found"
            createLabel="+ Add region"
            onChange={(e) => applyRegionToBill(e.target.value)}
            onCreate={(query) => openRegionDrawer(query)}
          />
          <Input label="Bill Date" required type="date" value={form.bill_date} onChange={(e) => setFormValue('bill_date', e.target.value)} />
          <Input label="Due Date" required type="date" value={form.due_date} onChange={(e) => setFormValue('due_date', e.target.value)} />
          <Select
            label="Currency"
            required
            value={form.currency}
            onChange={(e) => setFormValue('currency', e.target.value)}
            disabled={!form.region_id}
            hint={form.region_id ? 'Defaults to the entity book currency' : 'Select a region first'}
          >
            {currencyOptions.map((code) => (
              <option key={code} value={code}>{currencySymbol(code)} {code}</option>
            ))}
          </Select>
          <div className="span-3 quick-create-note">
            Search existing vendors and regions first. If nothing matches, use the add action in the search panel to create it without leaving this bill.
          </div>
          <Input label="Service Start" type="date" value={form.service_period_start || ''} onChange={(e) => setFormValue('service_period_start', e.target.value)} />
          <Input label="Service End" type="date" value={form.service_period_end || ''} onChange={(e) => setFormValue('service_period_end', e.target.value)} />
          <Input label="Invoice Reference" value={form.invoice_reference || ''} onChange={(e) => setFormValue('invoice_reference', e.target.value)} />
          <div className="span-3"><Input label="External Reference" value={form.external_reference || ''} onChange={(e) => setFormValue('external_reference', e.target.value)} /></div>

          <div className="span-3" style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 16, background: 'var(--surface2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontWeight: 800, color: 'var(--text)' }}>Line Items</div>
              <button className="btn btn-sm btn-primary" type="button" onClick={addLineItem}>+ Add Line</button>
            </div>
            <div style={{ display: 'grid', gap: 12 }}>
              {(form.line_items || []).map((item, index) => (
                <div key={`line-${index}`} className="form-grid cols-3" style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, background: 'var(--surface)' }}>
                  <Input label="Description" value={item.description} onChange={(e) => updateLineItem(index, { description: e.target.value })} />
                  <Input label="Quantity" type="number" value={item.quantity} onChange={(e) => updateLineItem(index, { quantity: e.target.value })} />
                  <Input label="Unit Price" type="number" value={item.unit_price} onChange={(e) => updateLineItem(index, { unit_price: e.target.value })} />
                  <Input label="Expense Category" value={item.expense_category} onChange={(e) => updateLineItem(index, { expense_category: e.target.value })} />
                  <Input label="Cost Center" value={item.cost_center} onChange={(e) => updateLineItem(index, { cost_center: e.target.value })} />
                  <div>
                    <Input label="Line Total" value={fmt(normalizeNumber(item.quantity) * normalizeNumber(item.unit_price), form.currency)} readOnly />
                    {(form.line_items || []).length > 1 ? <div style={{ marginTop: 8 }}><button className="btn btn-sm btn-ghost" type="button" onClick={() => removeLineItem(index)}>Remove Line</button></div> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="span-3" style={{ border: '1px solid var(--border)', borderRadius: 12, padding: 16, background: 'var(--surface2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontWeight: 800, color: 'var(--text)' }}>Tax Lines</div>
              <button className="btn btn-sm btn-primary" type="button" onClick={addTax}>+ Add Tax</button>
            </div>
            <div style={{ display: 'grid', gap: 12 }}>
              {(form.tax_lines || []).map((tax, index) => (
                <div key={`tax-${index}`} className="form-grid cols-3" style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, background: 'var(--surface)' }}>
                  <Input label="Tax Name" value={tax.tax_name} onChange={(e) => updateTax(index, { tax_name: e.target.value })} />
                  <Input label="Tax %" type="number" value={tax.tax_percent} onChange={(e) => updateTax(index, { tax_percent: e.target.value })} />
                  <div>
                    <Input label="Tax Amount" value={fmt((amounts.subtotal * normalizeNumber(tax.tax_percent)) / 100, form.currency)} readOnly />
                    {(form.tax_lines || []).length > 1 ? <div style={{ marginTop: 8 }}><button className="btn btn-sm btn-ghost" type="button" onClick={() => removeTax(index)}>Remove Tax</button></div> : null}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="span-3" style={{ background: 'var(--surface2)', borderRadius: 12, padding: 16, border: '1px solid var(--border)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, textAlign: 'center' }}>
              <div><div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Subtotal</div><div style={{ fontSize: 18, fontWeight: 800, marginTop: 4 }}>{fmt(amounts.subtotal, form.currency)}</div></div>
              <div><div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Tax</div><div style={{ fontSize: 18, fontWeight: 800, marginTop: 4 }}>{fmt(amounts.taxAmount, form.currency)}</div></div>
              <div><div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Total</div><div style={{ fontSize: 18, fontWeight: 800, color: 'var(--primary)', marginTop: 4 }}>{fmt(amounts.total, form.currency)}</div></div>
            </div>
          </div>

          <div className="span-3"><Textarea label="Notes" value={form.notes} onChange={(e) => setFormValue('notes', e.target.value)} rows={3} /></div>

          <div className="span-3">
            <AttachmentsField
              entityType="bill"
              entityId={editing?.id || null}
              pendingFiles={billFiles}
              onPendingChange={setBillFiles}
              label="Vendor invoice"
              hint="Attach the invoice received from the vendor — PDF, image, Excel or Word. Required."
              required
            />
          </div>
        </div>
      </Modal>


      <BillViewModal
        billId={viewBillId}
        onClose={() => setViewBillId(null)}
        canEdit={canManage}
        onEdit={(bill) => { setViewBillId(null); openEdit(bill) }}
      />

      <Drawer
        open={drawer.type === 'vendor'}
        onClose={closeDrawer}
        title="Quick Add Vendor"
        width={560}
        footer={(
          <>
            <button className="secondary-btn" onClick={closeDrawer}>Cancel</button>
            <button className="primary-btn" onClick={saveVendorQuickCreate} disabled={drawerSaving}>
              {drawerSaving ? 'Saving...' : 'Save Vendor'}
            </button>
          </>
        )}
      >
        <div className="form-grid cols-2">
          <Input label="Vendor Name" required value={vendorDraft.vendor_name} onChange={(e) => setVendorDraftValue('vendor_name', e.target.value)} />
          <Input label="Vendor Code" value={vendorDraft.vendor_code} onChange={(e) => setVendorDraftValue('vendor_code', e.target.value.toUpperCase())} hint="Leave blank to auto-generate" />
          <SearchableSelect
            label="Region"
            required
            value={vendorDraft.region_id}
            options={regionOptions}
            placeholder="Search region..."
            emptyMessage="No regions found"
            createLabel="+ Add region"
            onChange={(e) => setVendorDraftValue('region_id', e.target.value)}
            onCreate={(query) => openRegionDrawer(query, 'vendor')}
          />
          <Select
            label="Currency"
            required
            value={vendorDraft.currency}
            onChange={(e) => setVendorDraftValue('currency', e.target.value)}
            disabled={!vendorDraft.region_id}
            hint={vendorDraft.region_id ? 'Defaults to the entity book currency' : 'Select a region first'}
          >
            {regionCurrencyOptions(regionById[String(vendorDraft.region_id)], [vendorDraft.currency]).map((code) => (
              <option key={code} value={code}>{currencySymbol(code)} {code}</option>
            ))}
          </Select>
          <Select label="Payment Terms" value={vendorDraft.default_payment_terms} onChange={(e) => setVendorDraftValue('default_payment_terms', e.target.value)}>
            <option value="NET_15">Net 15</option>
            <option value="NET_30">Net 30</option>
            <option value="NET_45">Net 45</option>
          </Select>
          <Select label="Status" value={vendorDraft.status} onChange={(e) => setVendorDraftValue('status', e.target.value)}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </Select>
          <Input label="Primary Contact" value={vendorDraft.primary_contact_name} onChange={(e) => setVendorDraftValue('primary_contact_name', e.target.value)} />
          <Input label="Contact Email" type="email" value={vendorDraft.primary_contact_email} onChange={(e) => setVendorDraftValue('primary_contact_email', e.target.value)} />
          <Input label="Contact Phone" value={vendorDraft.primary_contact_phone} onChange={(e) => setVendorDraftValue('primary_contact_phone', e.target.value)} />
          <Input label="Tax Identifier" value={vendorDraft.tax_identifier} onChange={(e) => setVendorDraftValue('tax_identifier', e.target.value)} />
          <div className="span-2"><Textarea label="Billing Address" value={vendorDraft.billing_address} onChange={(e) => setVendorDraftValue('billing_address', e.target.value)} rows={2} /></div>
          <div className="span-2 form-card">
            <div style={{ fontWeight: 800, marginBottom: 12 }}>Bank Details</div>
            <div className="form-grid cols-2">
              <Input label="Bank Name" value={vendorDraft.bank_name} onChange={(e) => setVendorDraftValue('bank_name', e.target.value)} />
              <Input label="Account Name" value={vendorDraft.bank_account_name} onChange={(e) => setVendorDraftValue('bank_account_name', e.target.value)} />
              <Input label="Account Number" value={vendorDraft.bank_account_number} onChange={(e) => setVendorDraftValue('bank_account_number', e.target.value)} />
              <Input label="Routing Number" value={vendorDraft.bank_routing_number} onChange={(e) => setVendorDraftValue('bank_routing_number', e.target.value)} />
              <div className="span-2"><Input label="SWIFT / IFSC" value={vendorDraft.bank_swift_ifsc} onChange={(e) => setVendorDraftValue('bank_swift_ifsc', e.target.value)} /></div>
            </div>
          </div>
        </div>
      </Drawer>

      <Drawer
        open={drawer.type === 'region'}
        onClose={closeDrawer}
        title="Quick Add Region"
        width={520}
        footer={(
          <>
            <button className="secondary-btn" onClick={closeDrawer}>Cancel</button>
            <button className="primary-btn" onClick={saveRegionQuickCreate} disabled={drawerSaving}>
              {drawerSaving ? 'Saving...' : 'Save Region'}
            </button>
          </>
        )}
      >
        <div className="form-grid cols-2">
          <Input label="Region Name" required value={regionDraft.region_name} onChange={(e) => setRegionDraftValue('region_name', e.target.value)} />
          <Input label="Region Code" value={regionDraft.region_code} readOnly hint="Auto generated from region name" />
          <SearchableSelect
            label="Country"
            required
            value={regionDraft.country_code}
            options={countryOptions}
            placeholder="Search country..."
            emptyMessage="No countries found"
            onChange={(e) => setRegionDraftValue('country_code', e.target.value)}
          />
          <Input label="Default Currency" required value={regionDraft.default_currency} readOnly hint="Auto selected from country" />
          <Input label="Company Name" value={regionDraft.company_name} onChange={(e) => setRegionDraftValue('company_name', e.target.value)} />
          <Select label="Status" value={regionDraft.status} onChange={(e) => setRegionDraftValue('status', e.target.value)}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </Select>
          <div className="span-2"><Textarea label="Company Address" value={regionDraft.company_address} onChange={(e) => setRegionDraftValue('company_address', e.target.value)} rows={3} /></div>
        </div>
      </Drawer>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => !deleteLoading && setDeleting(null)}
        onConfirm={confirmDelete}
        loading={deleteLoading}
        title="Delete Bill"
        message={`Delete bill ${deleting?.bill_number || ''}? This cannot be undone. If it has linked payments, deletion will be blocked.`}
      />

      {canManage && actionMenu.open && actionMenu.row && createPortal(
        <div className="floating-action-menu invoices-action-menu" style={{ top: actionMenu.y, left: actionMenu.x }} onClick={(e) => e.stopPropagation()}>
          <button className="floating-action-item" onClick={() => openView(actionMenu.row)}>View</button>
          <button className="floating-action-item" onClick={() => openEdit(actionMenu.row)}>Edit</button>
          {String(actionMenu.row.approval_status || '').toUpperCase() === 'NOT_SUBMITTED' ? <button className="floating-action-item" onClick={() => changeStatus(actionMenu.row, 'SUBMITTED')}>Submit</button> : null}
          {String(actionMenu.row.approval_status || '').toUpperCase() === 'PENDING' ? <button className="floating-action-item" onClick={() => changeStatus(actionMenu.row, 'APPROVED')}>Approve</button> : null}
          {String(actionMenu.row.approval_status || '').toUpperCase() === 'PENDING' ? <button className="floating-action-item" onClick={() => changeStatus(actionMenu.row, 'REJECTED')}>Reject</button> : null}
          {canDelete ? <button className="floating-action-item danger" onClick={() => {
            setDeleting(actionMenu.row)
            setActionMenu({ open: false, x: 0, y: 0, row: null })
          }}>Delete</button> : null}
        </div>,
        document.body,
      )}

      {canManage && statusMenu.open && statusMenu.row && createPortal(
        <div
          className="floating-action-menu bills-status-menu"
          style={{ top: statusMenu.y, left: statusMenu.x }}
          onClick={(event) => event.stopPropagation()}
        >
          {STATUS_MENU_OPTIONS.map((status) => {
            const current = String(statusMenu.row.bill_status || '').toUpperCase() === status
            return (
              <button
                key={status}
                className={`floating-action-item bills-status-item${current ? ' is-current' : ''}`}
                disabled={current}
                onClick={() => {
                  const row = statusMenu.row
                  setStatusMenu({ open: false, x: 0, y: 0, row: null })
                  if (!current) changeStatus(row, status)
                }}
              >
                <StatusChip tone={statusMenuTone(status)}>{status.replace(/_/g, ' ')}</StatusChip>
                {current ? <span className="bills-status-check" aria-hidden="true">✓</span> : null}
              </button>
            )
          })}
        </div>,
        document.body,
      )}

      {payStatusMenu.open && payStatusMenu.row && createPortal(
        <div className="floating-action-menu invoices-action-menu" style={{ top: payStatusMenu.y, left: payStatusMenu.x, minWidth: 200 }} onClick={(e) => e.stopPropagation()}>
          <button className="floating-action-item" onClick={() => pickPayStatus(payStatusMenu.row, 'PAID')}>Mark Paid (full balance)</button>
          <button className="floating-action-item" onClick={() => pickPayStatus(payStatusMenu.row, 'PARTIAL')}>Record Partial Payment</button>
        </div>,
        document.body,
      )}

      <Modal
        open={payModal.open}
        onClose={() => !payLoading && setPayModal({ open: false, row: null, mode: 'PAID' })}
        title={payModal.mode === 'PAID' ? `Mark Bill ${payModal.row?.bill_number || ''} Paid` : `Record Partial Payment · ${payModal.row?.bill_number || ''}`}
        maxWidth={520}
        footer={(
          <div className="modal-actions">
            <button className="secondary-btn" onClick={() => setPayModal({ open: false, row: null, mode: 'PAID' })} disabled={payLoading}>Cancel</button>
            <button className="primary-btn" onClick={recordVendorPayment} disabled={payLoading}>{payLoading ? 'Recording…' : 'Record Payment'}</button>
          </div>
        )}
      >
        {payModal.row ? (
          <div className="form-grid cols-2">
            <div className="span-2" style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
              <span className="text-muted">{payModal.row.vendor_name}</span>
              <span className="td-mono">Outstanding: <strong style={{ color: 'var(--danger)' }}>{fmt(payModal.row.balance_outstanding, payModal.row.currency)}</strong></span>
            </div>
            <Input label="Amount Paid" required type="number" min="0" step="0.01" value={payForm.amount_paid} onChange={(e) => setPayForm((p) => ({ ...p, amount_paid: e.target.value }))} />
            <Input label="Payment Date" required type="date" value={payForm.payment_date} onChange={(e) => setPayForm((p) => ({ ...p, payment_date: e.target.value }))} />
            <Select label="Payment Method" value={payForm.payment_method} onChange={(e) => setPayForm((p) => ({ ...p, payment_method: e.target.value }))}>
              {PAY_METHODS.map((m) => <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>)}
            </Select>
            <Input label="Reference Number" value={payForm.reference_number} onChange={(e) => setPayForm((p) => ({ ...p, reference_number: e.target.value.toUpperCase() }))} />
          </div>
        ) : null}
      </Modal>
    </div>
  )
}

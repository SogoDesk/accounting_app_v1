import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams, Link } from 'react-router-dom'
import api, { downloadFile } from '../services/api'
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
  Card,
  StatCard,
  DataTable,
  StatusChip,
  FilterPill,
  PanelHeader,
  chartColors,
  fmt,
  fmtDate,
  fmtDateDisplay,
  customerLabel,
  currencySymbol,
} from '../components/ui/index.jsx'
import PaymentReceiptViewModal from '../components/PaymentReceiptViewModal'
import { useTheme } from '../context/ThemeContext'
import './PaymentsPage.css'
import { useToast } from '../context/ToastContext'
import { generateCandidateCode } from '../utils/candidateHelpers'
import { buildRegionCode } from '../utils/regionHelpers'
import { COUNTRIES, COUNTRY_NAME_OPTIONS } from '../data/countries'
import { useAuth } from '../context/AuthContext'
import { useEntity } from '../context/EntityContext'
import { ACTION_ACCESS, hasAnyRole } from '../utils/acl'

const BLANK = {
  payment_code: '',
  invoice_id: '',
  invoice_ids: [],
  payment_date: '',
  amount_received: '',
  payment_mode: 'BANK_TRANSFER',
  reference_number: '',
  tds_applicable: '',
  tds_percent: '',
  notes: '',
}

const createQuickInvoiceLine = () => ({
  placement_id: '',
  candidate_id: '',
  candidate_name: '',
  job_title: '',
  activity_label: '',
  description: '',
  quantity: '1',
  rate: '0',
  line_date: '',
})

const BLANK_INVOICE_FORM = {
  invoice_number: '',
  placement_id: '',
  client_id: '',
  region_id: '',
  client_name: '',
  region_name: '',
  currency: 'USD',
  invoice_date: '',
  due_date: '',
  invoice_terms_label: '',
  billing_period_start: '',
  billing_period_end: '',
  invoice_status: 'GENERATED',
  invoice_template: 'CLASSIC',
  notes: '',
  line_items: [createQuickInvoiceLine()],
}

const BLANK_QUICK_PLACEMENT = {
  placement_code: '',
  candidate_id: '',
  client_id: '',
  region_id: '',
  end_client_name: '',
  vendor_name: '',
  recruiter_id: '',
  account_manager_id: '',
  job_title: '',
  employment_type: 'CONTRACT',
  placement_status: 'ACTIVE',
  billing_type: 'HOURLY',
  bill_rate: '0',
  pay_rate: '0',
  currency: 'USD',
  expected_hours_per_month: '160',
  monthly_billing_amount: '0',
  one_time_fee_amount: '0',
  invoice_cycle: 'MONTHLY',
  payment_terms: 'NET_30',
  custom_payment_terms_days: '',
  po_number: '',
  sow_number: '',
  tax_applicable: false,
  tax_percent: '0',
  start_date: '',
  end_date: '',
  notes: '',
}

const BLANK_QUICK_CANDIDATE = {
  full_name: '',
  candidate_code: '',
  job_title: '',
  email: '',
  phone: '',
  country: '',
  skills: '',
  notes: '',
  status: 'ACTIVE',
}

const BLANK_QUICK_CLIENT = {
  client_name: '',
  client_code: '',
  region_id: '',
  billing_address: '',
  tax_identifier: '',
  currency: 'USD',
  default_payment_terms: 'NET_30',
  default_invoice_cycle: 'MONTHLY',
  primary_contact_name: '',
  primary_contact_email: '',
  primary_contact_phone: '',
  credit_limit: '0',
  status: 'ACTIVE',
}

const BLANK_QUICK_REGION = {
  region_name: '',
  region_code: '',
  country_name: '',
  country_code: '',
  default_currency: 'USD',
  status: 'ACTIVE',
  company_name: '',
  company_address: '',
}

const PAYMENT_MODES = [
  'BANK_TRANSFER',
  'WIRE_TRANSFER',
  'ACH',
  'CHECK',
  'CASH',
  'CARD',
  'UPI',
  'NEFT',
  'RTGS',
  'IMPS',
  'OTHER',
]

const formatCurrencyLabel = (currencyCode = '') => {
  const code = String(currencyCode || '').toUpperCase()
  if (!code) return 'Not available'
  return `${currencySymbol(code)} ${code}`
}

const getLocalDateInputValue = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

const normalizeDateForApi = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw

  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return raw
  return getLocalDateInputValue(parsed)
}

const getDateKey = (value) => normalizeDateForApi(value)

const isDateInRange = (value, from, to) => {
  const key = getDateKey(value)
  if (!key) return false
  if (from && key < from) return false
  if (to && key > to) return false
  return true
}

function isForbiddenError(error) {
  const status = error?.response?.status
  return status === 401 || status === 403
}

export default function PaymentsPage() {
  const toast = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const { user } = useAuth()
  const roleName = user?.roleName
  const canManagePayments = hasAnyRole(roleName, ACTION_ACCESS.payments.manage)
  const canDeletePayments = hasAnyRole(roleName, ACTION_ACCESS.payments.delete)

  const [rows, setRows] = useState([])
  const [reportingCurrency, setReportingCurrency] = useState('USD')
  const [invoiceOptions, setInvoiceOptions] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [invoiceFilter, setInvoiceFilter] = useState('')
  const [paymentModeFilter, setPaymentModeFilter] = useState('')
  // Region follows the global top-nav switcher (no per-page dropdown); a
  // drill-down ?region_id= link still overrides it (see effect below).
  const { entityId: defaultEntityId } = useEntity()
  const [regionFilter, setRegionFilter] = useState(defaultEntityId ? `id:${defaultEntityId}` : '')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [clientFilter, setClientFilter] = useState('')
  const [receiptTab, setReceiptTab] = useState('all')
  const [activePill, setActivePill] = useState(null)
  const [filtersOpen, setFiltersOpen] = useState(true)
  const { accent, dark } = useTheme()
  const [exporting, setExporting] = useState(false)
  const [modal, setModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [viewPaymentId, setViewPaymentId] = useState(null)
  const [form, setForm] = useState(BLANK)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [actionMenu, setActionMenu] = useState({ open: false, x: 0, y: 0, row: null })
  const [nextCode, setNextCode] = useState({ payment_code: '', reference_number: '' })
  const [invoiceDropdownOpen, setInvoiceDropdownOpen] = useState(false)
  const [invoicePickerSearch, setInvoicePickerSearch] = useState('')
  const invoiceDropdownRef = useRef(null)
  const [invoiceDrawerOpen, setInvoiceDrawerOpen] = useState(false)
  const [invoiceDraft, setInvoiceDraft] = useState(BLANK_INVOICE_FORM)
  const [invoiceDraftSaving, setInvoiceDraftSaving] = useState(false)
  const [placementOptions, setPlacementOptions] = useState([])
  const [placementDrawerOpen, setPlacementDrawerOpen] = useState(false)
  const [quickPlacementDraft, setQuickPlacementDraft] = useState(BLANK_QUICK_PLACEMENT)
  const [quickPlacementSaving, setQuickPlacementSaving] = useState(false)
  const [quickCandidates, setQuickCandidates] = useState([])
  const [quickClients, setQuickClients] = useState([])
  const [quickRegions, setQuickRegions] = useState([])
  const [quickUsers, setQuickUsers] = useState([])
  const [quickPlacementDrawer, setQuickPlacementDrawer] = useState({ type: null, returnTo: null })
  const [quickPlacementDrawerSaving, setQuickPlacementDrawerSaving] = useState(false)
  const [quickCandidateDraft, setQuickCandidateDraft] = useState(BLANK_QUICK_CANDIDATE)
  const [quickClientDraft, setQuickClientDraft] = useState(BLANK_QUICK_CLIENT)
  const [quickRegionDraft, setQuickRegionDraft] = useState(BLANK_QUICK_REGION)

  const load = async () => {
    try {
      setLoading(true)
      const [paymentsRes, invoicesRes] = await Promise.all([
        api.get('/payments'),
        api.get('/payments/invoice-options'),
      ])
      setRows(paymentsRes.data.data || [])
      setReportingCurrency(paymentsRes.data?.reporting_currency || 'USD')
      setInvoiceOptions(invoicesRes.data.data || [])
    } catch (e) {
      toast.error(e.response?.data?.message || 'Failed to load payments')
    } finally {
      setLoading(false)
    }
  }

  const loadNextCode = async () => {
    try {
      const res = await api.get('/payments/next-code')
      setNextCode(res.data.data || { payment_code: '', reference_number: '' })
      return res.data.data || { payment_code: '', reference_number: '' }
    } catch {
      return { payment_code: '', reference_number: '' }
    }
  }

  useEffect(() => {
    load()
  }, [])

  useEffect(() => {
    const closeAllFloating = () => {
      setActionMenu({ open: false, x: 0, y: 0, row: null })
      setInvoiceDropdownOpen(false)
    }
    const closeOnScroll = (event) => {
      setActionMenu({ open: false, x: 0, y: 0, row: null })
      if (invoiceDropdownRef.current?.contains(event.target)) return
      setInvoiceDropdownOpen(false)
    }
    window.addEventListener('click', closeAllFloating)
    window.addEventListener('resize', closeAllFloating)
    window.addEventListener('scroll', closeOnScroll, true)
    return () => {
      window.removeEventListener('click', closeAllFloating)
      window.removeEventListener('resize', closeAllFloating)
      window.removeEventListener('scroll', closeOnScroll, true)
    }
  }, [])

  useEffect(() => {
    if (!activePill) return undefined
    const close = () => setActivePill(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [activePill])

  const invoiceById = useMemo(() => {
    const map = {}
    invoiceOptions.forEach((invoice) => {
      map[String(invoice.id)] = invoice
    })
    return map
  }, [invoiceOptions])

  const placementById = useMemo(() => {
    const map = {}
    placementOptions.forEach((placement) => { map[String(placement.id)] = placement })
    return map
  }, [placementOptions])

  const quickCandidateOptions = useMemo(() => (
    quickCandidates.map((candidate) => ({
      value: String(candidate.id),
      label: candidate.full_name,
      meta: [candidate.candidate_code, candidate.job_title].filter(Boolean).join(' • '),
      searchText: `${candidate.email || ''} ${candidate.country || ''}`.trim(),
    }))
  ), [quickCandidates])

  const quickClientOptions = useMemo(() => (
    quickClients.map((client) => ({
      value: String(client.id),
      label: client.client_name,
      meta: [client.client_code, client.region_name].filter(Boolean).join(' • '),
      searchText: `${client.primary_contact_name || ''} ${client.primary_contact_email || ''}`.trim(),
    }))
  ), [quickClients])

  const quickRegionOptions = useMemo(() => (
    quickRegions.map((region) => ({
      value: String(region.id),
      label: region.region_name,
      meta: [region.country_name, region.default_currency].filter(Boolean).join(' • '),
      searchText: `${region.region_code || ''} ${region.company_name || ''}`.trim(),
    }))
  ), [quickRegions])

  const quickUserOptions = useMemo(() => (
    quickUsers.map((user) => ({
      value: String(user.id),
      label: user.full_name,
      meta: user.email || '',
      searchText: `${user.role_name || ''} ${user.phone || ''}`.trim(),
    }))
  ), [quickUsers])

  const quickRegionById = useMemo(() => {
    const map = new Map()
    quickRegions.forEach((region) => map.set(String(region.id), region))
    return map
  }, [quickRegions])

  const quickCountryOptions = useMemo(() => (
    COUNTRIES.map((country) => ({
      value: country.iso2,
      label: country.name,
      meta: [country.iso2, country.currency].filter(Boolean).join(' • '),
      searchText: `${country.iso3 || ''} ${country.phone_code || ''}`.trim(),
    }))
  ), [])

  const selectedInvoiceIds = (form.invoice_ids || []).length
    ? form.invoice_ids
    : form.invoice_id
      ? [String(form.invoice_id)]
      : []
  const availableInvoiceOptions = useMemo(() => (
    invoiceOptions.filter((invoice) => {
      const balance = Number(invoice.balance_outstanding || 0)
      if (balance > 0) return true
      return !!editing && selectedInvoiceIds.includes(String(invoice.id))
    })
  ), [editing, invoiceOptions, selectedInvoiceIds])
  const filteredInvoicePickerOptions = useMemo(() => {
    const needle = invoicePickerSearch.trim().toLowerCase()
    if (!needle) return availableInvoiceOptions
    return availableInvoiceOptions.filter((invoice) => (
      [
        invoice.invoice_number,
        invoice.client_name,
        invoice.candidate_name,
        invoice.placement_code,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle))
    ))
  }, [availableInvoiceOptions, invoicePickerSearch])
  const selectedInvoices = selectedInvoiceIds.map((id) => invoiceById[String(id)]).filter(Boolean)
  const currentInvoice = selectedInvoices[0] || null
  const selectedInvoiceCurrency = currentInvoice?.currency || selectedInvoices[0]?.currency || ''
  const invoiceDropdownLabel = selectedInvoices.length
    ? selectedInvoices.length <= 2
      ? selectedInvoices.map((invoice) => invoice.invoice_number).join(', ')
      : `${selectedInvoices.slice(0, 2).map((invoice) => invoice.invoice_number).join(', ')} +${selectedInvoices.length - 2} more`
    : 'Select invoices...'

  const openCreate = async () => {
    const today = getLocalDateInputValue()
    const codeData = await loadNextCode()
    setEditing(null)
    setViewPaymentId(null)
    setForm({
      ...BLANK,
      payment_date: today,
      payment_code: codeData.payment_code || '',
      reference_number: codeData.reference_number || '',
    })
    setInvoicePickerSearch('')
    setModal(true)
  }

  useEffect(() => {
    if (searchParams.get('action') !== 'create' || !canManagePayments) return
    void openCreate()
    setSearchParams({}, { replace: true })
  }, [searchParams, setSearchParams, canManagePayments])

  useEffect(() => {
    const regionId = String(searchParams.get('region_id') || '')
    const startDate = String(searchParams.get('start_date') || '')
    const endDate = String(searchParams.get('end_date') || '')

    // An explicit region_id (a drill-down link) wins; otherwise fall back to the
    // app-wide entity default rather than clobbering it with "all".
    const effective = regionId || defaultEntityId
    setRegionFilter(effective ? `id:${effective}` : '')
    setDateFrom(/^\d{4}-\d{2}-\d{2}$/.test(startDate) ? startDate : '')
    setDateTo(/^\d{4}-\d{2}-\d{2}$/.test(endDate) ? endDate : '')
  }, [searchParams, defaultEntityId])

  const openEdit = (row) => {
    setEditing(row)
    setViewPaymentId(null)
    setForm({
      ...BLANK,
      ...row,
      invoice_id: row.invoice_id ? String(row.invoice_id) : '',
      invoice_ids: row.invoice_id ? [String(row.invoice_id)] : [],
      payment_date: fmtDate(row.payment_date),
      amount_received: row.amount_received != null ? String(row.amount_received) : '',
      tds_applicable: !!row.tds_applicable,
      tds_percent: row.tds_percent != null ? String(row.tds_percent) : '',
      payment_code: row.payment_code || '',
      reference_number: row.reference_number || '',
      payment_mode: row.payment_mode || 'BANK_TRANSFER',
      notes: row.notes || '',
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
    setActionMenu({
      open: true,
      x: rect.right - 180,
      y: rect.bottom + 8,
      row,
    })
  }

  const getInvoiceTdsAmount = (invoice, percentValue = form.tds_percent, applicable = form.tds_applicable) => {
    if (applicable !== true) return 0
    const percent = Number(percentValue || 0)
    if (!percent || percent <= 0) return 0
    return (Number(invoice?.subtotal || 0) * percent) / 100
  }

  const getSuggestedAmountForInvoices = (invoices, percentValue = form.tds_percent, applicable = form.tds_applicable) => (
    invoices.reduce((sum, invoice) => {
      const balance = Number(invoice.balance_outstanding || 0)
      const tdsAmount = getInvoiceTdsAmount(invoice, percentValue, applicable)
      return sum + Math.max(balance - tdsAmount, 0)
    }, 0)
  )

  const set = (key, value) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value }

      if (key === 'tds_applicable' && value !== true) {
        next.tds_percent = ''
      }

      if (key === 'invoice_ids') {
        next.invoice_ids = value
        next.invoice_id = value[0] || ''
        const invoices = value.map((id) => invoiceById[String(id)]).filter(Boolean)

        // The region decides whether TDS is asked at all, so changing the
        // selection can strand an answer from a region that no longer applies —
        // switching an India invoice for a US one would otherwise keep deducting.
        // '' re-asks where TDS applies; false answers it where it doesn't.
        const regionTdsOf = (list) => list.some((invoice) => invoice?.region_tds_applicable === true)
        const prevInvoices = (prev.invoice_ids || []).map((id) => invoiceById[String(id)]).filter(Boolean)
        const nextRegionTds = regionTdsOf(invoices)
        if (nextRegionTds !== regionTdsOf(prevInvoices)) {
          next.tds_applicable = nextRegionTds ? '' : false
          next.tds_percent = ''
        }

        if (invoices.length && !editing) {
          const suggestedAmount = getSuggestedAmountForInvoices(invoices, next.tds_percent, next.tds_applicable)
          next.amount_received = suggestedAmount > 0 ? suggestedAmount.toFixed(2) : ''
        }
        if (!prev.reference_number && nextCode.reference_number) {
          next.reference_number = nextCode.reference_number
        }
      }

      if ((key === 'tds_applicable' || key === 'tds_percent') && !editing) {
        const invoices = (next.invoice_ids || []).map((id) => invoiceById[String(id)]).filter(Boolean)
        const suggestedAmount = getSuggestedAmountForInvoices(invoices, next.tds_percent, next.tds_applicable)
        next.amount_received = suggestedAmount > 0 ? suggestedAmount.toFixed(2) : ''
      }

      return next
    })
  }

  const toggleInvoiceSelection = (invoiceId) => {
    const id = String(invoiceId)
    const invoice = invoiceById[id]
    const invoiceCurrency = String(invoice?.currency || '').toUpperCase()
    const lockedCurrency = String(selectedInvoiceCurrency || '').toUpperCase()

    if (!selectedInvoiceIds.includes(id) && lockedCurrency && invoiceCurrency && invoiceCurrency !== lockedCurrency) {
      toast.error(`You can only combine invoices in ${lockedCurrency} within one payment`)
      return
    }

    set('invoice_ids', selectedInvoiceIds.includes(id)
      ? selectedInvoiceIds.filter((item) => item !== id)
      : [...selectedInvoiceIds, id])
  }

  const save = async () => {
    if (regionTdsApplicable && form.tds_applicable !== true && form.tds_applicable !== false) {
      toast.error('Select whether TDS is applicable')
      return
    }

    if (!selectedInvoiceIds.length || !form.payment_date) {
      toast.error('Select at least one invoice and payment date')
      return
    }

    if (!form.amount_received && !isTdsApplicable) {
      toast.error('Amount received is required unless TDS is applicable')
      return
    }

    if (isTdsApplicable && Number(form.tds_percent || 0) <= 0) {
      toast.error('Enter TDS percentage')
      return
    }

    const paymentCurrencies = Array.from(new Set(
      selectedInvoices.map((invoice) => String(invoice.currency || '').toUpperCase()).filter(Boolean),
    ))
    if (paymentCurrencies.length > 1) {
      toast.error('Selected invoices must have the same currency')
      return
    }

    const payload = {
      ...form,
      payment_date: normalizeDateForApi(form.payment_date),
      payment_code: form.payment_code?.trim() || '',
      reference_number: form.reference_number?.trim() || '',
      invoice_id: Number(selectedInvoiceIds[0]),
      invoice_ids: selectedInvoiceIds.map((id) => Number(id)),
      tds_applicable: isTdsApplicable,
      tds_percent: isTdsApplicable ? Number(form.tds_percent || 0) : null,
    }

    setSaving(true)
    try {
      if (editing) {
        await api.put(`/payments/${editing.id}`, payload)
      } else {
        await api.post('/payments', payload)
      }
      toast.success(`Payment ${editing ? 'updated' : 'created'} successfully`)
      setModal(false)
      setEditing(null)
      setForm(BLANK)
      load()
    } catch (e) {
      toast.error(e.response?.data?.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const confirmDelete = async () => {
    if (!deleting) return
    setDeleteLoading(true)
    try {
      await api.delete(`/payments/${deleting.id}`)
      toast.success('Payment deleted successfully')
      setDeleting(null)
      load()
    } catch (e) {
      toast.error(e.response?.data?.message || 'Delete failed')
    } finally {
      setDeleteLoading(false)
    }
  }

  const filtered = rows.filter((row) => {
    const q = search.toLowerCase()
    const searchMatch =
      !q ||
      String(row.payment_code || '').toLowerCase().includes(q) ||
      String(row.invoice_number || '').toLowerCase().includes(q) ||
      String(row.client_name || '').toLowerCase().includes(q) ||
      String(row.candidate_name || '').toLowerCase().includes(q) ||
      String(row.reference_number || '').toLowerCase().includes(q)

    const invoiceMatch = !invoiceFilter || String(row.invoice_id) === String(invoiceFilter)
    const paymentModeMatch = !paymentModeFilter || String(row.payment_mode || '') === paymentModeFilter
    const regionMatch =
      !regionFilter ||
      (regionFilter.startsWith('id:') && String(row.region_id || '') === regionFilter.slice(3)) ||
      (regionFilter.startsWith('name:') && String(row.region_name || '') === regionFilter.slice(5))
    const dateRangeMatch = (!dateFrom && !dateTo) || isDateInRange(row.payment_date, dateFrom, dateTo)
    const clientMatch = !clientFilter || String(row.client_name || '').trim() === clientFilter

    return searchMatch && invoiceMatch && paymentModeMatch && regionMatch && dateRangeMatch && clientMatch
  })

  const exportXlsx = async () => {
    setExporting(true)
    try {
      const params = new URLSearchParams()
      if (search.trim()) params.set('search', search.trim())
      if (invoiceFilter) params.set('invoice_id', invoiceFilter)
      if (paymentModeFilter) params.set('payment_mode', paymentModeFilter)
      if (regionFilter.startsWith('id:')) params.set('region_id', regionFilter.slice(3))
      if (dateFrom) params.set('from', dateFrom)
      if (dateTo) params.set('to', dateTo)
      params.set('format', 'xlsx')
      const range = (dateFrom || dateTo) ? `_${dateFrom || 'start'}_to_${dateTo || 'end'}` : ''
      await downloadFile(`/api/payments/export?${params.toString()}`, `payments${range}.xlsx`)
      toast.success('Payments exported to Excel')
    } catch { toast.error('Export failed') }
    finally { setExporting(false) }
  }

  const placementPickerOptions = useMemo(() => (
    placementOptions.map((placement) => ({
      value: String(placement.id),
      label: placement.placement_code || `#${placement.id}`,
      meta: `${placement.candidate_name || 'Candidate'} • ${placement.client_name || 'Client'}`,
      searchText: `${placement.job_title || ''} ${placement.region_name || ''}`.trim(),
    }))
  ), [placementOptions])

  // Multi-currency consolidation: region-scoped → native amount (all one
  // currency); "All regions" → the backend's group-currency amount_received_reporting
  // so mixed £/₹/$ are converted before summing, never added raw.
  const consolidated = !regionFilter
  const amountNum = (r) => Number((consolidated ? r.amount_received_reporting : r.amount_received) || 0)

  const summary = filtered.reduce(
    (acc, row) => {
      acc.total += amountNum(row)
      return acc
    },
    { total: 0 },
  )

  // ---- Restyle-only derived views (no new endpoints) --------------------
  const series = useMemo(() => chartColors(accent, dark).series, [accent, dark])
  const fmtInt = (v) => Math.round(Number(v || 0)).toLocaleString('en-US')
  const getFxRate = (r) => {
    const raw = r.exchange_rate
    const n = Number(raw)
    return raw != null && raw !== '' && !Number.isNaN(n) ? n.toFixed(4) : '—'
  }
  const initialsOf = (name = '') => String(name).trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '—'

  const monthLabel = useMemo(() => {
    const ref = filtered.find((r) => r.payment_date)?.payment_date || dateTo || dateFrom
    const d = ref ? new Date(ref) : new Date()
    return Number.isNaN(d.getTime()) ? new Date().toLocaleString('en-US', { month: 'long' }) : d.toLocaleString('en-US', { month: 'long' })
  }, [filtered, dateFrom, dateTo])

  const appliedRows = useMemo(() => filtered.filter((r) => r.invoice_id), [filtered])
  const unappliedRows = useMemo(() => filtered.filter((r) => !r.invoice_id), [filtered])
  const collectedTotal = summary.total
  const appliedTotal = useMemo(() => appliedRows.reduce((s, r) => s + amountNum(r), 0), [appliedRows])
  const unappliedTotal = useMemo(() => unappliedRows.reduce((s, r) => s + amountNum(r), 0), [unappliedRows])
  const appliedPct = collectedTotal > 0 ? ((appliedTotal / collectedTotal) * 100).toFixed(1) : '0.0'
  const fxGainLoss = useMemo(() => filtered.reduce((s, r) => s + Number(r.fx_gain_loss ?? 0), 0), [filtered])

  const baseCurrency = useMemo(() => {
    // Consolidated view reports in the company group currency; a single region
    // reports in its own (dominant) currency.
    if (consolidated) return reportingCurrency
    const counts = new Map()
    filtered.forEach((r) => { const c = String(r.currency || '').toUpperCase(); if (c) counts.set(c, (counts.get(c) || 0) + 1) })
    let best = reportingCurrency; let n = -1
    counts.forEach((v, k) => { if (v > n) { n = v; best = k } })
    return best
  }, [filtered, consolidated, reportingCurrency])
  const baseSymbol = currencySymbol(baseCurrency)

  const clientOptions = useMemo(() => (
    Array.from(new Set(rows.map((r) => String(r.client_name || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b))
  ), [rows])

  const methodBreakdown = useMemo(() => {
    const map = new Map()
    filtered.forEach((r) => {
      const k = String(r.payment_mode || 'OTHER').replace(/_/g, ' ')
      map.set(k, (map.get(k) || 0) + amountNum(r))
    })
    return Array.from(map.entries()).map(([label, amount]) => ({ label, amount })).sort((a, b) => b.amount - a.amount)
  }, [filtered])
  const methodTotal = methodBreakdown.reduce((s, m) => s + m.amount, 0)

  const unappliedByClient = useMemo(() => {
    const map = new Map()
    unappliedRows.forEach((r) => {
      const key = r.client_name || '—'
      const cur = map.get(key) || { client: key, amount: 0, currency: r.currency, region: r.region_name }
      cur.amount += amountNum(r)
      map.set(key, cur)
    })
    return Array.from(map.values()).sort((a, b) => b.amount - a.amount)
  }, [unappliedRows])

  const tabRows = receiptTab === 'applied' ? appliedRows : receiptTab === 'unapplied' ? unappliedRows : filtered

  const dateRangeLabel = (dateFrom || dateTo)
    ? `${dateFrom ? fmtDateDisplay(dateFrom) : 'Start'} — ${dateTo ? fmtDateDisplay(dateTo) : 'End'}`
    : 'All dates'

  const stopPill = (e) => e.stopPropagation()

  const invoiceInfo = selectedInvoices.length
    ? selectedInvoices.reduce((acc, invoice) => {
        acc.total += Number(invoice.total_amount || 0)
        acc.principal += Number(invoice.subtotal || 0)
        acc.received += Number(invoice.payment_received_amount || 0)
        acc.balance += Number(invoice.balance_outstanding || 0)
        acc.tds += getInvoiceTdsAmount(invoice)
        return acc
      }, { total: 0, principal: 0, received: 0, balance: 0, tds: 0 })
    : { total: 0, principal: 0, received: 0, balance: 0, tds: 0 }
  const summaryCurrency = currentInvoice?.currency || selectedInvoices[0]?.currency || ''
  // TDS is an Indian withholding regime configured per region. A payment can
  // span invoices, so the question appears if any of them withholds — though the
  // currency lock already stops an INR invoice joining a USD one.
  const regionTdsApplicable = selectedInvoices.some((invoice) => invoice?.region_tds_applicable === true)
  const isTdsApplicable = regionTdsApplicable && form.tds_applicable === true
  const hasTdsSelection = !regionTdsApplicable || form.tds_applicable === true || form.tds_applicable === false
  const disableSavePayment = saving || !hasTdsSelection

  const extractNetDays = (terms) => {
    const value = String(terms || '').trim().toUpperCase()
    if (!value) return 30
    if (value === 'DUE_ON_RECEIPT' || value === 'DUE ON RECEIPT') return 0
    const match = value.match(/(\d{1,3})/)
    return match ? Number(match[1]) : 30
  }

  const addDays = (dateValue, days) => {
    if (!dateValue) return ''
    const date = new Date(dateValue)
    if (Number.isNaN(date.getTime())) return ''
    date.setDate(date.getDate() + Number(days || 0))
    return date.toISOString().slice(0, 10)
  }

  const buildTermsFromPlacement = (placement) => {
    if (!placement) return 'Net 30'
    if (placement.payment_terms === 'CUSTOM' && placement.custom_payment_terms_days) {
      return `Net ${placement.custom_payment_terms_days}`
    }
    if (placement.payment_terms) return String(placement.payment_terms).replace('NET_', 'Net ').replace(/_/g, ' ')
    if (placement.default_payment_terms) return placement.default_payment_terms
    if (placement.invoice_terms_label) return placement.invoice_terms_label
    return 'Net 30'
  }

  const getPlacementBillRate = (placement) => {
    if (!placement) return 0
    if (placement.billing_type === 'MONTHLY') return Number(placement.monthly_billing_amount || 0)
    if (placement.billing_type === 'ONE_TIME') return Number(placement.one_time_fee_amount || 0)
    return Number(placement.bill_rate || 0)
  }

  const getPlacementDefaultQuantity = (placement) => {
    if (!placement) return 1
    if (placement.billing_type === 'MONTHLY' || placement.billing_type === 'ONE_TIME') return 1
    return Number(placement.expected_hours_per_month || 1) || 1
  }

  const buildInvoiceLineDescription = (placement) => {
    const activity = placement?.job_title || 'Professional Services'
    const candidate = placement?.candidate_name ? ` for ${placement.candidate_name}` : ''
    return `${activity}${candidate}`.trim()
  }

  const applyInvoicePlacementRecord = (placement) => {
    if (!placement) return
    const today = invoiceDraft.invoice_date || getLocalDateInputValue()
    const terms = buildTermsFromPlacement(placement)
    const quantity = getPlacementDefaultQuantity(placement)
    const rate = getPlacementBillRate(placement)
    setInvoiceDraft((prev) => ({
      ...prev,
      placement_id: String(placement.id),
      client_id: String(placement.client_id || ''),
      region_id: String(placement.region_id || ''),
      client_name: placement.client_name || '',
      region_name: placement.region_name || '',
      currency: String(placement.client_currency || placement.currency || placement.region_currency || prev.currency || 'USD').toUpperCase(),
      invoice_terms_label: terms,
      due_date: addDays(today, extractNetDays(terms)),
      billing_period_start: prev.billing_period_start || normalizeDateForApi(placement.start_date),
      billing_period_end: prev.billing_period_end || normalizeDateForApi(placement.end_date),
      line_items: [{
        placement_id: String(placement.id),
        candidate_id: String(placement.candidate_id || ''),
        candidate_name: placement.candidate_name || '',
        job_title: placement.job_title || '',
        activity_label: placement.job_title || placement.candidate_name || 'Professional Services',
        description: buildInvoiceLineDescription(placement),
        quantity: String(quantity),
        rate: String(rate),
        line_date: '',
      }],
    }))
  }

  const applyInvoicePlacement = (placementId) => {
    applyInvoicePlacementRecord(placementById[String(placementId)])
  }

  const loadQuickInvoiceSeed = async () => {
    const [placementRes, previewRes] = await Promise.all([
      api.get('/invoices/placement-options'),
      api.get('/invoices/next-number-preview'),
    ])
    setPlacementOptions(placementRes.data?.data || [])
    return previewRes.data?.data?.invoice_number || ''
  }

  const setQuickPlacementValue = (key, value) => {
    setQuickPlacementDraft((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'candidate_id') {
        const candidate = quickCandidates.find((entry) => String(entry.id) === String(value))
        if (candidate && (!prev.job_title || prev.job_title === quickCandidates.find((entry) => String(entry.id) === String(prev.candidate_id))?.job_title)) {
          next.job_title = candidate.job_title || ''
        }
      }
      if (key === 'client_id') {
        const client = quickClients.find((entry) => String(entry.id) === String(value))
        if (client) {
          next.region_id = client.region_id ? String(client.region_id) : ''
          next.currency = client.currency || prev.currency
        }
      }
      if (key === 'region_id') {
        const region = quickRegions.find((entry) => String(entry.id) === String(value))
        if (region?.default_currency && !next.client_id) next.currency = region.default_currency
      }
      return next
    })
  }

  const setQuickCandidateDraftValue = (key, value) => {
    setQuickCandidateDraft((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'full_name' && !prev.candidate_code) next.candidate_code = generateCandidateCode(value)
      return next
    })
  }

  const setQuickClientDraftValue = (key, value) => {
    setQuickClientDraft((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'region_id') {
        const region = quickRegionById.get(String(value))
        if (region?.default_currency) next.currency = region.default_currency
      }
      return next
    })
  }

  const setQuickRegionDraftValue = (key, value) => {
    setQuickRegionDraft((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'region_name') next.region_code = buildRegionCode(value)
      if (key === 'country_code') {
        const country = COUNTRIES.find((entry) => entry.iso2 === value)
        next.country_code = value
        next.country_name = country?.name || ''
        next.default_currency = country?.currency || prev.default_currency
      }
      return next
    })
  }

  const openQuickCandidateDrawer = (initialName = '') => {
    setQuickPlacementDrawerSaving(false)
    setQuickCandidateDraft({
      ...BLANK_QUICK_CANDIDATE,
      full_name: String(initialName || '').trim(),
      candidate_code: generateCandidateCode(initialName),
      job_title: quickPlacementDraft.job_title || '',
    })
    setQuickPlacementDrawer({ type: 'candidate', returnTo: null })
  }

  const openQuickClientDrawer = (initialName = '') => {
    const selectedRegion = quickRegionById.get(String(quickPlacementDraft.region_id))
    setQuickPlacementDrawerSaving(false)
    setQuickClientDraft({
      ...BLANK_QUICK_CLIENT,
      client_name: String(initialName || '').trim(),
      region_id: quickPlacementDraft.region_id || '',
      currency: selectedRegion?.default_currency || quickPlacementDraft.currency || 'USD',
    })
    setQuickPlacementDrawer({ type: 'client', returnTo: null })
  }

  const openQuickRegionDrawer = (initialName = '', returnTo = null) => {
    setQuickPlacementDrawerSaving(false)
    setQuickRegionDraft({
      ...BLANK_QUICK_REGION,
      region_name: String(initialName || '').trim(),
      region_code: buildRegionCode(initialName),
      default_currency: quickPlacementDraft.currency || 'USD',
    })
    setQuickPlacementDrawer({ type: 'region', returnTo })
  }

  const closeQuickPlacementDrawer = () => {
    setQuickPlacementDrawer({ type: null, returnTo: null })
    setQuickPlacementDrawerSaving(false)
  }

  const openPlacementDrawer = async (initialName = '') => {
    const today = getLocalDateInputValue()
    setQuickPlacementSaving(false)
    setQuickPlacementDraft({
      ...BLANK_QUICK_PLACEMENT,
      placement_code: String(initialName || '').trim(),
      job_title: invoiceDraft.line_items[0]?.job_title || '',
      start_date: today,
      currency: invoiceDraft.currency || 'USD',
    })
    setPlacementDrawerOpen(true)
    try {
      const [candidateRes, clientRes, regionRes] = await Promise.all([
        api.get('/candidates'),
        api.get('/clients'),
        api.get('/regions'),
      ])
      setQuickCandidates(candidateRes.data?.data || [])
      setQuickClients(clientRes.data?.data || [])
      setQuickRegions(regionRes.data?.data || [])

      try {
        const userRes = await api.get('/users')
        setQuickUsers(userRes.data?.data || [])
      } catch (userError) {
        if (isForbiddenError(userError)) setQuickUsers([])
        else throw userError
      }
    } catch (error) {
      toast.error(error.response?.data?.message || 'Failed to load placement setup')
    }
  }

  const saveQuickPlacement = async () => {
    if (
      !quickPlacementDraft.candidate_id ||
      !quickPlacementDraft.client_id ||
      !quickPlacementDraft.region_id ||
      !quickPlacementDraft.job_title ||
      !quickPlacementDraft.employment_type ||
      !quickPlacementDraft.billing_type ||
      !quickPlacementDraft.currency ||
      !quickPlacementDraft.start_date
    ) {
      toast.error('Candidate, client, region, job title, employment type, billing type, currency and start date are required')
      return
    }
    setQuickPlacementSaving(true)
    try {
      const createRes = await api.post('/placements', {
        ...quickPlacementDraft,
        tax_applicable: !!quickPlacementDraft.tax_applicable,
      })
      const createdId = createRes.data?.data?.id
      if (!createdId) throw new Error('Placement create response missing id')
      const [detailRes, placementRes] = await Promise.all([
        api.get(`/placements/${createdId}`),
        api.get('/invoices/placement-options'),
      ])
      const createdPlacement = detailRes.data?.data || createRes.data?.data
      const nextPlacements = placementRes.data?.data || []
      setPlacementOptions(nextPlacements)
      applyInvoicePlacementRecord(createdPlacement)
      setPlacementDrawerOpen(false)
      toast.success('Placement created successfully')
    } catch (error) {
      toast.error(error.response?.data?.message || error.message || 'Failed to create placement')
    } finally {
      setQuickPlacementSaving(false)
    }
  }

  const saveQuickCandidate = async () => {
    if (!quickCandidateDraft.full_name) {
      toast.error('Candidate name is required')
      return
    }
    setQuickPlacementDrawerSaving(true)
    try {
      const response = await api.post('/candidates', {
        ...quickCandidateDraft,
        candidate_code: quickCandidateDraft.candidate_code?.trim() || '',
      })
      const created = response.data?.data
      if (!created) throw new Error('Candidate create response missing data')
      setQuickCandidates((prev) => [created, ...prev])
      setQuickPlacementDraft((prev) => ({
        ...prev,
        candidate_id: String(created.id),
        job_title: created.job_title || prev.job_title,
      }))
      toast.success('Candidate created successfully')
      closeQuickPlacementDrawer()
    } catch (error) {
      toast.error(error.response?.data?.message || error.message || 'Failed to create candidate')
    } finally {
      setQuickPlacementDrawerSaving(false)
    }
  }

  const saveQuickClient = async () => {
    if (!quickClientDraft.client_name || !quickClientDraft.region_id || !quickClientDraft.currency) {
      toast.error('Client name, region, and currency are required')
      return
    }
    setQuickPlacementDrawerSaving(true)
    try {
      const response = await api.post('/clients', {
        ...quickClientDraft,
        client_code: '',
      })
      const created = response.data?.data
      if (!created) throw new Error('Client create response missing data')
      const region = quickRegionById.get(String(created.region_id))
      const createdWithRegion = region ? { ...created, region_name: region.region_name } : created
      setQuickClients((prev) => [createdWithRegion, ...prev])
      setQuickPlacementDraft((prev) => ({
        ...prev,
        client_id: String(created.id),
        region_id: created.region_id ? String(created.region_id) : prev.region_id,
        currency: created.currency || prev.currency,
      }))
      toast.success('Client created successfully')
      closeQuickPlacementDrawer()
    } catch (error) {
      toast.error(error.response?.data?.message || error.message || 'Failed to create client')
    } finally {
      setQuickPlacementDrawerSaving(false)
    }
  }

  const saveQuickRegion = async () => {
    if (!quickRegionDraft.region_name || !quickRegionDraft.country_name || !quickRegionDraft.default_currency) {
      toast.error('Region name, country, and currency are required')
      return
    }
    const payload = new FormData()
    payload.append('region_name', quickRegionDraft.region_name)
    payload.append('region_code', quickRegionDraft.region_code || buildRegionCode(quickRegionDraft.region_name))
    payload.append('country_name', quickRegionDraft.country_name)
    payload.append('country_code', quickRegionDraft.country_code || '')
    payload.append('default_currency', quickRegionDraft.default_currency)
    payload.append('status', quickRegionDraft.status || 'ACTIVE')
    payload.append('company_name', quickRegionDraft.company_name || '')
    payload.append('company_address', quickRegionDraft.company_address || '')

    setQuickPlacementDrawerSaving(true)
    try {
      const response = await api.post('/regions', payload, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      const created = response.data?.data
      if (!created) throw new Error('Region create response missing data')
      setQuickRegions((prev) => [created, ...prev])
      if (quickPlacementDrawer.returnTo === 'client') {
        setQuickClientDraft((prev) => ({
          ...prev,
          region_id: String(created.id),
          currency: created.default_currency || prev.currency,
        }))
        setQuickPlacementDrawer({ type: 'client', returnTo: null })
      } else {
        setQuickPlacementDraft((prev) => ({
          ...prev,
          region_id: String(created.id),
          currency: created.default_currency || prev.currency,
        }))
        closeQuickPlacementDrawer()
      }
      toast.success('Region created successfully')
    } catch (error) {
      toast.error(error.response?.data?.message || error.message || 'Failed to create region')
    } finally {
      setQuickPlacementDrawerSaving(false)
    }
  }

  const openInvoiceDrawer = async () => {
    const today = getLocalDateInputValue()
    setInvoiceDraftSaving(false)
    try {
      const previewNumber = await loadQuickInvoiceSeed()
      setInvoiceDraft({
        ...BLANK_INVOICE_FORM,
        invoice_number: previewNumber,
        invoice_date: today,
        line_items: [createQuickInvoiceLine()],
      })
      setInvoiceDrawerOpen(true)
    } catch (error) {
      toast.error(error.response?.data?.message || 'Failed to load invoice setup')
    }
  }

  const saveInvoiceQuickCreate = async () => {
    if (!invoiceDraft.invoice_number || !invoiceDraft.invoice_date || !invoiceDraft.due_date || !invoiceDraft.invoice_terms_label || !invoiceDraft.placement_id) {
      toast.error('Invoice number, dates, terms, and placement are required')
      return
    }
    const line = invoiceDraft.line_items[0]
    setInvoiceDraftSaving(true)
    try {
      const response = await api.post('/invoices', {
        invoice_number: invoiceDraft.invoice_number,
        placement_id: Number(invoiceDraft.placement_id),
        client_id: Number(invoiceDraft.client_id),
        region_id: Number(invoiceDraft.region_id),
        invoice_date: normalizeDateForApi(invoiceDraft.invoice_date),
        due_date: normalizeDateForApi(invoiceDraft.due_date),
        billing_period_start: normalizeDateForApi(invoiceDraft.billing_period_start) || null,
        billing_period_end: normalizeDateForApi(invoiceDraft.billing_period_end) || null,
        currency: invoiceDraft.currency,
        invoice_status: invoiceDraft.invoice_status,
        invoice_template: invoiceDraft.invoice_template,
        invoice_terms_label: invoiceDraft.invoice_terms_label,
        notes: invoiceDraft.notes || null,
        line_items: [{
          placement_id: Number(line.placement_id),
          candidate_id: line.candidate_id ? Number(line.candidate_id) : null,
          candidate_name: line.candidate_name || '',
          job_title: line.job_title || '',
          activity_label: line.activity_label || '',
          description: line.description || buildInvoiceLineDescription(placementById[String(line.placement_id)]),
          quantity: Number(line.quantity || 0),
          rate: Number(line.rate || 0),
          line_date: normalizeDateForApi(line.line_date) || null,
        }],
        tax_lines: [],
      })
      const created = response.data?.data
      const invoiceOptionsRes = await api.get('/payments/invoice-options')
      setInvoiceOptions(invoiceOptionsRes.data?.data || [])
      if (created?.id) set('invoice_ids', [...selectedInvoiceIds, String(created.id)])
      setInvoiceDrawerOpen(false)
      toast.success('Invoice created successfully')
    } catch (error) {
      toast.error(error.response?.data?.message || 'Failed to create invoice')
    } finally {
      setInvoiceDraftSaving(false)
    }
  }

  return (
    <div className="dashboard-page payments-page pay-page">
      <div className="pay-header">
        <Link to="/" className="pay-back" aria-label="Back">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
        </Link>
        <div className="pay-head-copy">
          <h1 className="pay-title">Payments</h1>
          <p className="pay-subtitle">Collections received and applied against invoices. Multi-currency, posted to the GL on save.</p>
        </div>
        <div className="pay-head-actions">
          <button type="button" className="pay-icon-btn" aria-label="Toggle filters" onClick={() => setFiltersOpen((v) => !v)}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h16M7 12h10M10 19h4" /></svg>
          </button>
          <button type="button" className="pay-btn pay-btn-secondary" onClick={exportXlsx} disabled={exporting || filtered.length === 0} title="Download the filtered payments as Excel">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" /></svg>
            {exporting ? 'Exporting…' : 'Export'}
          </button>
          {canManagePayments ? (
            <button type="button" className="pay-btn pay-btn-primary" onClick={openCreate}>+ Record payment</button>
          ) : null}
        </div>
      </div>

      <div className="pay-kpis">
        <StatCard
          label={`Collected — ${monthLabel}`}
          prefix={baseSymbol}
          value={fmtInt(collectedTotal)}
          sub={`${filtered.length} receipts`}
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>}
        />
        <StatCard
          label="Applied to invoices"
          prefix={baseSymbol}
          value={fmtInt(appliedTotal)}
          sub={`${appliedPct}% of receipts`}
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1M14 11a5 5 0 00-7 0l-2 2a5 5 0 007 7l1-1" /></svg>}
        />
        <StatCard
          label="Unapplied credit"
          prefix={baseSymbol}
          value={fmtInt(unappliedTotal)}
          sub={<span className={unappliedRows.length ? 'pay-sub-warn' : undefined}>{unappliedRows.length ? `${unappliedRows.length} receipts need matching` : 'All receipts applied'}</span>}
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--warn)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>}
        />
        <StatCard
          label="FX gain / loss"
          prefix={baseSymbol}
          value={<span style={{ color: fxGainLoss >= 0 ? 'var(--success-text)' : 'var(--danger-text)' }}>{fmtInt(fxGainLoss)}</span>}
          sub="Realised on collections"
          icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--icon)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" /></svg>}
        />
      </div>

      {filtersOpen ? (
        <div className="pay-filters">
          <div className="pay-pill-wrap" onClick={stopPill}>
            <FilterPill
              active={!!clientFilter}
              dropdown
              icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 20a8 8 0 0116 0" /></svg>}
              onClick={() => setActivePill((p) => (p === 'clients' ? null : 'clients'))}
            >
              {clientFilter || 'All clients'}
            </FilterPill>
            {activePill === 'clients' ? (
              <div className="pay-pop">
                <button type="button" className={`pay-pop-item${!clientFilter ? ' is-on' : ''}`} onClick={() => { setClientFilter(''); setActivePill(null) }}>All clients</button>
                {clientOptions.map((name) => (
                  <button key={name} type="button" className={`pay-pop-item${clientFilter === name ? ' is-on' : ''}`} onClick={() => { setClientFilter(name); setActivePill(null) }}>{name}</button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="pay-pill-wrap" onClick={stopPill}>
            <FilterPill
              active={!!paymentModeFilter}
              dropdown
              onClick={() => setActivePill((p) => (p === 'methods' ? null : 'methods'))}
            >
              {paymentModeFilter ? paymentModeFilter.replace(/_/g, ' ') : 'All methods'}
            </FilterPill>
            {activePill === 'methods' ? (
              <div className="pay-pop">
                <button type="button" className={`pay-pop-item${!paymentModeFilter ? ' is-on' : ''}`} onClick={() => { setPaymentModeFilter(''); setActivePill(null) }}>All methods</button>
                {PAYMENT_MODES.map((mode) => (
                  <button key={mode} type="button" className={`pay-pop-item${paymentModeFilter === mode ? ' is-on' : ''}`} onClick={() => { setPaymentModeFilter(mode); setActivePill(null) }}>{mode.replace(/_/g, ' ')}</button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="pay-pill-wrap" onClick={stopPill}>
            <FilterPill
              active={!!(dateFrom || dateTo)}
              dropdown
              icon={<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /></svg>}
              onClick={() => setActivePill((p) => (p === 'dates' ? null : 'dates'))}
            >
              {(dateFrom || dateTo) ? dateRangeLabel : 'Date range'}
            </FilterPill>
            {activePill === 'dates' ? (
              <div className="pay-pop pay-pop-dates">
                <label className="pay-pop-field"><span>From</span><input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} /></label>
                <label className="pay-pop-field"><span>To</span><input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} /></label>
                <button type="button" className="pay-pop-clear" onClick={() => { setDateFrom(''); setDateTo('') }}>Clear dates</button>
              </div>
            ) : null}
          </div>

          <label className="pay-search-pill">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
            <input
              value={search}
              placeholder="Reference or invoice #"
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>

          {(clientFilter || paymentModeFilter || dateFrom || dateTo || search) ? (
            <button
              type="button"
              className="pay-reset"
              onClick={() => {
                setSearch('')
                setInvoiceFilter('')
                setPaymentModeFilter('')
                setClientFilter('')
                setRegionFilter('')
                setDateFrom('')
                setDateTo('')
                setSearchParams({}, { replace: true })
              }}
            >
              Reset
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="pay-grid">
        <Card className="pay-list">
          <PanelHeader
            title={`Receipts — ${monthLabel}`}
            tabs={[
              { key: 'all', label: 'All', count: filtered.length },
              { key: 'applied', label: 'Applied', count: appliedRows.length },
              { key: 'unapplied', label: 'Unapplied', count: unappliedRows.length },
            ]}
            activeTab={receiptTab}
            onTab={setReceiptTab}
            actions={(
              <>
                <button type="button" className="pay-icon-btn sm" aria-label="Export" onClick={exportXlsx} disabled={exporting || filtered.length === 0}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" /></svg>
                </button>
                <button type="button" className="pay-icon-btn sm" aria-label="More">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg>
                </button>
              </>
            )}
          />
          <DataTable
            getRowId={(row) => row.id}
            loading={loading}
            empty="No receipts found"
            rows={tabRows}
            paginate
            pageLabel="receipts"
            columns={[
              {
                key: 'payment_code', header: 'Receipt', primary: true, mono: true,
                render: (row) => (row.payment_code ? (
                  <button
                    type="button"
                    className="pay-number-btn"
                    onClick={() => openView(row)}
                    title={`View payment ${row.payment_code}`}
                  >
                    {row.payment_code}
                  </button>
                ) : '—'),
              },
              {
                key: 'client',
                header: 'Client',
                sortAccessor: (row) => String(row.client_name || '').toLowerCase(),
                render: (row) => (
                  <div className="pay-client">
                    <span className="pay-avatar">{initialsOf(row.client_name)}</span>
                    <span className="pay-client-copy">
                      <span className="pay-client-name">
                        {row.client_id ? <Link to={`/clients/${row.client_id}`} onClick={stopPill}>{row.client_name}</Link> : (row.client_name || '—')}
                      </span>
                      <span className="pay-client-sub">
                        {String(row.payment_mode || '—').replace(/_/g, ' ')}{row.reference_number ? ` · ${row.reference_number}` : ''}
                      </span>
                    </span>
                  </div>
                ),
              },
              {
                key: 'applied',
                header: 'Applied to',
                mono: true,
                sortAccessor: (row) => (row.invoice_id ? String(row.invoice_number || '') : '￿'),
                render: (row) => (row.invoice_id
                  ? (row.invoice_number || '—')
                  : <span className="pay-unapplied-tag">Unapplied</span>),
              },
              { key: 'payment_mode', header: 'Method', render: (row) => String(row.payment_mode || '—').replace(/_/g, ' ') },
              { key: 'payment_date', header: 'Date', mono: true, render: (row) => fmtDateDisplay(row.payment_date) },
              { key: 'fx', header: 'FX rate', mono: true, sortAccessor: (row) => row.exchange_rate, render: (row) => getFxRate(row) },
              { key: 'amount', header: 'Amount', mono: true, align: 'right', sortAccessor: (row) => row.amount_received, render: (row) => fmt(row.amount_received, row.currency) },
              {
                key: 'actions',
                header: '',
                align: 'right',
                width: 44,
                render: (row) => (canManagePayments ? (
                  <button className="payments-kebab-btn" onClick={(e) => openActionMenu(e, row)} aria-label="Row actions">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></svg>
                  </button>
                ) : null),
              },
            ]}
            footer={[
              { colSpan: 6, render: () => <span className="pay-foot-label">{tabRows.length} of {filtered.length} receipts · {monthLabel}</span> },
              { align: 'right', mono: true, render: () => fmt(tabRows.reduce((s, r) => s + amountNum(r), 0), baseCurrency) },
              { render: () => null },
            ]}
          />
        </Card>

        <div className="pay-rail">
          <Card className="pay-rail-card">
            <div className="pay-rail-title">Unapplied credit</div>
            <div className="pay-rail-list">
              {unappliedByClient.length ? unappliedByClient.map((u) => (
                <div key={u.client} className="pay-rail-row">
                  <span className="pay-rail-copy">
                    <span className="pay-rail-name">{u.client}</span>
                    {u.region ? <span className="pay-rail-sub">{u.region}</span> : null}
                  </span>
                  <span className="pay-rail-amt">{fmt(u.amount, u.currency)}</span>
                </div>
              )) : (
                <div className="pay-rail-empty">No unapplied credit. Every receipt is matched to an invoice.</div>
              )}
            </div>
            {canManagePayments ? (
              <button type="button" className="pay-btn pay-btn-primary pay-rail-btn" onClick={openCreate}>Match to invoices</button>
            ) : null}
          </Card>

          <Card className="pay-rail-card">
            <div className="pay-rail-title">By method · {monthLabel}</div>
            <div className="pay-legend">
              {methodBreakdown.length ? methodBreakdown.map((m, i) => (
                <div key={m.label} className="pay-legend-row">
                  <span className="pay-legend-dot" style={{ background: series[i % series.length] }} />
                  <span className="pay-legend-label">{m.label}</span>
                  <span className="pay-legend-amt">{fmt(m.amount, baseCurrency)}</span>
                </div>
              )) : <div className="pay-rail-empty">No receipts in range.</div>}
            </div>
            {methodTotal > 0 ? (
              <div className="pay-bar">
                {methodBreakdown.map((m, i) => (
                  <span
                    key={m.label}
                    className="pay-bar-seg"
                    style={{ width: `${(m.amount / methodTotal) * 100}%`, background: series[i % series.length] }}
                    title={`${m.label} · ${fmt(m.amount, baseCurrency)}`}
                  />
                ))}
              </div>
            ) : null}
          </Card>
        </div>
      </div>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title={editing ? `Edit Payment ${editing.payment_code || editing.reference_number || ''}` : 'Add Payment'}
        maxWidth={880}
        modalClassName="payments-modal-card"
        footer={(
          <div className="payments-modal-actions">
            <button className="secondary-btn" onClick={() => setModal(false)} disabled={saving}>Cancel</button>
            <button className="primary-btn" onClick={save} disabled={disableSavePayment}>
              {saving ? 'Saving...' : 'Save Payment'}
            </button>
          </div>
        )}
      >
        <div className="form-grid cols-2">
          <Input
            label="Payment Code"
            value={form.payment_code}
            onChange={(e) => set('payment_code', e.target.value.toUpperCase())}
            placeholder={nextCode.payment_code || 'Auto generated from backend'}
            hint="You can override this manually. Backend still validates uniqueness."
          />

          <div className="form-group payments-invoice-picker">
            <label className="form-label required">Invoices</label>
            <div
              ref={invoiceDropdownRef}
              className={`payments-invoice-dropdown${invoiceDropdownOpen ? ' is-open' : ''}`}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className="payments-invoice-trigger"
                onClick={() => setInvoiceDropdownOpen((open) => !open)}
              >
                <span>{invoiceDropdownLabel}</span>
                <strong>{selectedInvoiceIds.length}</strong>
              </button>
              {invoiceDropdownOpen ? (
                <div className="payments-invoice-list">
                  <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
                    <input
                      className="form-control"
                      value={invoicePickerSearch}
                      placeholder="Search invoice, client, candidate..."
                      onChange={(e) => setInvoicePickerSearch(e.target.value)}
                    />
                  </div>
                  {filteredInvoicePickerOptions.map((invoice) => {
                    const checked = selectedInvoiceIds.includes(String(invoice.id))
                    const isCurrencyLocked =
                      !!selectedInvoiceCurrency &&
                      !checked &&
                      String(invoice.currency || '').toUpperCase() !== String(selectedInvoiceCurrency || '').toUpperCase()
                    return (
                      <label
                        key={invoice.id}
                        className={`payments-invoice-option${checked ? ' is-selected' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={(!!editing && !checked) || isCurrencyLocked}
                          onChange={() => toggleInvoiceSelection(invoice.id)}
                        />
                        <span className="payments-invoice-option-copy">
                          <strong>{invoice.invoice_number} - {invoice.client_name}</strong>
                          <small>
                            {formatCurrencyLabel(invoice.currency)} - Principal {fmt(invoice.subtotal, invoice.currency)} - Balance {fmt(invoice.balance_outstanding, invoice.currency)}
                          </small>
                        </span>
                      </label>
                    )
                  })}
                  {filteredInvoicePickerOptions.length === 0 ? (
                    <div style={{ padding: '12px 14px', display: 'grid', gap: 10 }}>
                      <div className="text-muted text-sm">
                        {availableInvoiceOptions.length === 0 ? 'No invoices with pending balance available.' : 'No invoices match your search.'}
                      </div>
                      <button
                        type="button"
                        className="secondary-btn"
                        onClick={() => { void openInvoiceDrawer() }}
                      >
                        + Add Invoice
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="form-hint">
              {editing
                ? 'Edit keeps the invoice tied to this payment.'
                : selectedInvoiceCurrency
                  ? `${selectedInvoiceIds.length} invoice(s) selected in ${selectedInvoiceCurrency}`
                  : `${selectedInvoiceIds.length} invoice(s) selected`}
            </div>
          </div>

          <Input
            label="Payment Date"
            required
            type="date"
            value={form.payment_date}
            onChange={(e) => set('payment_date', e.target.value)}
          />

          <Input
            label="Currency"
            value={formatCurrencyLabel(summaryCurrency)}
            readOnly
            hint="Read only. Payment currency always follows the selected invoice currency."
          />

          <Input
            label="Amount Received"
            required={!isTdsApplicable}
            type="number"
            min="0"
            step="0.01"
            value={form.amount_received}
            onChange={(e) => set('amount_received', e.target.value)}
          />

          <Select
            label="Payment Mode"
            value={form.payment_mode}
            onChange={(e) => set('payment_mode', e.target.value)}
          >
            {PAYMENT_MODES.map((mode) => (
              <option key={mode} value={mode}>{mode.replace(/_/g, ' ')}</option>
            ))}
          </Select>

          <Input
            label="Reference Number"
            value={form.reference_number}
            onChange={(e) => set('reference_number', e.target.value.toUpperCase())}
            placeholder={nextCode.reference_number || 'Auto generated if left blank'}
          />

          {regionTdsApplicable ? (
            <div className="payments-tds-panel">
              <div className="payments-toggle-row">
                <span>
                  <strong>TDS Applicable</strong>
                  <small>Choose Yes or No to enable saving.</small>
                </span>
                <div className="payments-tds-options" role="radiogroup" aria-label="TDS applicable">
                  <label>
                    <input
                      type="radio"
                      name="tds_applicable"
                      checked={form.tds_applicable === true}
                      onChange={() => set('tds_applicable', true)}
                    />
                    <span>Yes</span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="tds_applicable"
                      checked={form.tds_applicable === false}
                      onChange={() => set('tds_applicable', false)}
                    />
                    <span>No</span>
                  </label>
                </div>
              </div>
            </div>
          ) : null}

          {isTdsApplicable ? (
            <>
              <Input
                label="TDS Percentage"
                type="number"
                min="0"
                step="0.01"
                value={form.tds_percent}
                onChange={(e) => set('tds_percent', e.target.value)}
              />

              <Input
                label="TDS Amount"
                value={fmt(invoiceInfo.tds, summaryCurrency)}
                readOnly
                hint="Calculated from selected invoice principal before tax."
              />
            </>
          ) : null}

          <div className="span-2 payment-invoice-summary">
            <div className="payment-invoice-summary-head">
              <div className="fw-bold">Invoice Summary</div>
              {currentInvoice ? <Badge value={currentInvoice.invoice_status} /> : null}
            </div>

            {selectedInvoices.length ? (
              <div className="payment-invoice-summary-grid">
                <div>
                  <div className="text-muted text-sm">Invoices</div>
                  <div className="fw-bold">{selectedInvoices.length} selected</div>
                  <div className="text-muted text-sm">
                    {selectedInvoices.map((invoice) => invoice.invoice_number).join(', ')}
                  </div>
                </div>
                <div>
                  <div className="text-muted text-sm">Totals</div>
                  <div className="td-mono">Principal: {fmt(invoiceInfo.principal, summaryCurrency)}</div>
                  <div className="td-mono">Total: {fmt(invoiceInfo.total, summaryCurrency)}</div>
                  <div className="td-mono">Received: {fmt(invoiceInfo.received, summaryCurrency)}</div>
                  <div className="td-mono" style={{ color: invoiceInfo.balance > 0 ? 'var(--danger)' : 'var(--success)' }}>
                    Balance: {fmt(invoiceInfo.balance, summaryCurrency)}
                  </div>
                </div>
                {regionTdsApplicable ? (
                  <div>
                    <div className="text-muted text-sm">TDS</div>
                    <div>{hasTdsSelection ? (isTdsApplicable ? 'Applicable' : 'Not applicable') : 'Select Yes or No'}</div>
                    <div className="text-muted text-sm">
                      {hasTdsSelection
                        ? (isTdsApplicable ? `${Number(form.tds_percent || 0)}% of principal` : 'No deduction')
                        : 'Required before saving'}
                    </div>
                    <div className="td-mono">{fmt(invoiceInfo.tds, summaryCurrency)}</div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="text-muted">Select invoices to view totals and outstanding balance.</div>
            )}
          </div>

          <div className="span-2">
            <Textarea
              label="Notes"
              rows={3}
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
            />
          </div>
        </div>
      </Modal>

      <Drawer
        open={invoiceDrawerOpen}
        onClose={() => setInvoiceDrawerOpen(false)}
        title="Quick Add Invoice"
        width={720}
        footer={(
          <>
            <button className="secondary-btn" onClick={() => setInvoiceDrawerOpen(false)}>Cancel</button>
            <button className="primary-btn" onClick={saveInvoiceQuickCreate} disabled={invoiceDraftSaving}>
              {invoiceDraftSaving ? 'Saving...' : 'Save Invoice'}
            </button>
          </>
        )}
      >
        <div className="form-grid cols-2">
          <Input label="Invoice Number" required value={invoiceDraft.invoice_number} onChange={(e) => setInvoiceDraft((prev) => ({ ...prev, invoice_number: e.target.value.toUpperCase() }))} />
          <SearchableSelect
            label="Placement"
            required
            value={invoiceDraft.placement_id}
            options={placementPickerOptions}
            placeholder="Search placement..."
            emptyMessage="No placements found"
            createLabel="+ Add placement"
            onChange={(e) => applyInvoicePlacement(e.target.value)}
            onCreate={(query) => { void openPlacementDrawer(query) }}
          />
          <Input label={customerLabel()} value={invoiceDraft.client_name} readOnly />
          <Input label="Region" value={invoiceDraft.region_name} readOnly />
          <Input label="Invoice Date" required type="date" value={invoiceDraft.invoice_date} onChange={(e) => setInvoiceDraft((prev) => ({ ...prev, invoice_date: e.target.value, due_date: prev.invoice_terms_label ? addDays(e.target.value, extractNetDays(prev.invoice_terms_label)) : prev.due_date }))} />
          <Input label="Due Date" required type="date" value={invoiceDraft.due_date} onChange={(e) => setInvoiceDraft((prev) => ({ ...prev, due_date: e.target.value }))} />
          <Input label="Currency" value={invoiceDraft.currency} readOnly />
          <Input label="Net Terms" required value={invoiceDraft.invoice_terms_label} onChange={(e) => setInvoiceDraft((prev) => ({ ...prev, invoice_terms_label: e.target.value, due_date: prev.invoice_date ? addDays(prev.invoice_date, extractNetDays(e.target.value)) : prev.due_date }))} />
          <Input label="Billing Period Start" type="date" value={invoiceDraft.billing_period_start || ''} onChange={(e) => setInvoiceDraft((prev) => ({ ...prev, billing_period_start: e.target.value }))} />
          <Input label="Billing Period End" type="date" value={invoiceDraft.billing_period_end || ''} onChange={(e) => setInvoiceDraft((prev) => ({ ...prev, billing_period_end: e.target.value }))} />
          <div className="span-2 form-card">
            <div style={{ fontWeight: 800, marginBottom: 12 }}>Invoice Particular</div>
            <div className="form-grid cols-2">
              <Input label="Candidate" value={invoiceDraft.line_items[0]?.candidate_name || ''} readOnly />
              <Input label="Job Title" value={invoiceDraft.line_items[0]?.job_title || ''} readOnly />
              <Input label="Description" value={invoiceDraft.line_items[0]?.description || ''} onChange={(e) => setInvoiceDraft((prev) => ({ ...prev, line_items: [{ ...prev.line_items[0], description: e.target.value }] }))} />
              <Input label="Activity" value={invoiceDraft.line_items[0]?.activity_label || ''} onChange={(e) => setInvoiceDraft((prev) => ({ ...prev, line_items: [{ ...prev.line_items[0], activity_label: e.target.value }] }))} />
              <Input label="Quantity" type="number" value={invoiceDraft.line_items[0]?.quantity || ''} onChange={(e) => setInvoiceDraft((prev) => ({ ...prev, line_items: [{ ...prev.line_items[0], quantity: e.target.value }] }))} />
              <Input label="Rate" type="number" value={invoiceDraft.line_items[0]?.rate || ''} onChange={(e) => setInvoiceDraft((prev) => ({ ...prev, line_items: [{ ...prev.line_items[0], rate: e.target.value }] }))} />
            </div>
          </div>
          <div className="span-2"><Textarea label="Notes" rows={3} value={invoiceDraft.notes} onChange={(e) => setInvoiceDraft((prev) => ({ ...prev, notes: e.target.value }))} /></div>
        </div>
      </Drawer>

      <Drawer
        open={placementDrawerOpen}
        onClose={() => setPlacementDrawerOpen(false)}
        title="Quick Add Placement"
        width={760}
        footer={(
          <>
            <button className="secondary-btn" onClick={() => setPlacementDrawerOpen(false)}>Cancel</button>
            <button className="primary-btn" onClick={saveQuickPlacement} disabled={quickPlacementSaving}>
              {quickPlacementSaving ? 'Saving...' : 'Save Placement'}
            </button>
          </>
        )}
      >
        <div className="form-grid cols-2">
          <SearchableSelect
            label="Candidate"
            required
            value={quickPlacementDraft.candidate_id}
            options={quickCandidateOptions}
            placeholder="Search candidate..."
            emptyMessage="No candidates found"
            createLabel="+ Add candidate"
            onChange={(e) => setQuickPlacementValue('candidate_id', e.target.value)}
            onCreate={(query) => openQuickCandidateDrawer(query)}
          />
          <SearchableSelect
            label="Client"
            required
            value={quickPlacementDraft.client_id}
            options={quickClientOptions}
            placeholder="Search client..."
            emptyMessage="No clients found"
            createLabel="+ Add client"
            onChange={(e) => setQuickPlacementValue('client_id', e.target.value)}
            onCreate={(query) => openQuickClientDrawer(query)}
          />
          <SearchableSelect
            label="Region"
            required
            value={quickPlacementDraft.region_id}
            options={quickRegionOptions}
            placeholder="Search region..."
            emptyMessage="No regions found"
            createLabel="+ Add region"
            onChange={(e) => setQuickPlacementValue('region_id', e.target.value)}
            onCreate={(query) => openQuickRegionDrawer(query)}
          />
          <Input label="Currency" value={quickPlacementDraft.currency} readOnly hint="Auto selected from client/region" />
          <Input label="Job Title" required value={quickPlacementDraft.job_title} onChange={(e) => setQuickPlacementValue('job_title', e.target.value)} />
          <Input label="End Client Name" value={quickPlacementDraft.end_client_name} onChange={(e) => setQuickPlacementValue('end_client_name', e.target.value)} />
          <Input label="Vendor Name" value={quickPlacementDraft.vendor_name} onChange={(e) => setQuickPlacementValue('vendor_name', e.target.value)} />
          <Select label="Employment Type" value={quickPlacementDraft.employment_type} onChange={(e) => setQuickPlacementValue('employment_type', e.target.value)}>
            <option value="CONTRACT">Contract</option>
            <option value="C2C">C2C</option>
            <option value="W2">W2</option>
            <option value="FULL_TIME">Full Time</option>
            <option value="PERMANENT">Permanent</option>
          </Select>
          <SearchableSelect
            label="Recruiter"
            value={quickPlacementDraft.recruiter_id}
            options={quickUserOptions}
            placeholder="Search recruiter..."
            emptyMessage="No users found"
            onChange={(e) => setQuickPlacementValue('recruiter_id', e.target.value)}
          />
          <SearchableSelect
            label="Account Manager"
            value={quickPlacementDraft.account_manager_id}
            options={quickUserOptions}
            placeholder="Search account manager..."
            emptyMessage="No users found"
            onChange={(e) => setQuickPlacementValue('account_manager_id', e.target.value)}
          />
          <Select label="Status" value={quickPlacementDraft.placement_status} onChange={(e) => setQuickPlacementValue('placement_status', e.target.value)}>
            <option value="ACTIVE">Active</option>
            <option value="ON_HOLD">On Hold</option>
            <option value="ENDED">Ended</option>
            <option value="CANCELLED">Cancelled</option>
          </Select>
          <Select label="Billing Type" value={quickPlacementDraft.billing_type} onChange={(e) => setQuickPlacementValue('billing_type', e.target.value)}>
            <option value="HOURLY">Hourly</option>
            <option value="MONTHLY">Monthly</option>
            <option value="ONE_TIME">One Time</option>
          </Select>
          <Input label="Bill Rate" type="number" value={quickPlacementDraft.bill_rate} onChange={(e) => setQuickPlacementValue('bill_rate', e.target.value)} />
          <Input label="Pay Rate" type="number" value={quickPlacementDraft.pay_rate} onChange={(e) => setQuickPlacementValue('pay_rate', e.target.value)} />
          <Input label="Expected Hours / Month" type="number" value={quickPlacementDraft.expected_hours_per_month} onChange={(e) => setQuickPlacementValue('expected_hours_per_month', e.target.value)} />
          <Input label="Monthly Billing Amount" type="number" value={quickPlacementDraft.monthly_billing_amount} onChange={(e) => setQuickPlacementValue('monthly_billing_amount', e.target.value)} />
          <Input label="One Time Fee Amount" type="number" value={quickPlacementDraft.one_time_fee_amount} onChange={(e) => setQuickPlacementValue('one_time_fee_amount', e.target.value)} />
          <Select label="Invoice Cycle" value={quickPlacementDraft.invoice_cycle} onChange={(e) => setQuickPlacementValue('invoice_cycle', e.target.value)}>
            <option value="WEEKLY">Weekly</option>
            <option value="BIWEEKLY">Bi-Weekly</option>
            <option value="MONTHLY">Monthly</option>
          </Select>
          <Select label="Payment Terms" value={quickPlacementDraft.payment_terms} onChange={(e) => setQuickPlacementValue('payment_terms', e.target.value)}>
            <option value="NET_15">Net 15</option>
            <option value="NET_30">Net 30</option>
            <option value="NET_45">Net 45</option>
            <option value="CUSTOM">Custom</option>
          </Select>
          <Input label="Custom Terms Days" type="number" value={quickPlacementDraft.custom_payment_terms_days} onChange={(e) => setQuickPlacementValue('custom_payment_terms_days', e.target.value)} />
          <Input label="Start Date" required type="date" value={quickPlacementDraft.start_date} onChange={(e) => setQuickPlacementValue('start_date', e.target.value)} />
          <Input label="End Date" type="date" value={quickPlacementDraft.end_date} onChange={(e) => setQuickPlacementValue('end_date', e.target.value)} />
          <div className="span-2"><Textarea label="Notes" rows={3} value={quickPlacementDraft.notes} onChange={(e) => setQuickPlacementValue('notes', e.target.value)} /></div>
        </div>
      </Drawer>

      <Drawer
        open={quickPlacementDrawer.type === 'candidate'}
        onClose={closeQuickPlacementDrawer}
        title="Quick Add Candidate"
        width={560}
        footer={(
          <>
            <button className="secondary-btn" onClick={closeQuickPlacementDrawer}>Cancel</button>
            <button className="primary-btn" onClick={saveQuickCandidate} disabled={quickPlacementDrawerSaving}>
              {quickPlacementDrawerSaving ? 'Saving...' : 'Save Candidate'}
            </button>
          </>
        )}
      >
        <div className="form-grid cols-2">
          <Input label="Candidate Name" required value={quickCandidateDraft.full_name} onChange={(e) => setQuickCandidateDraftValue('full_name', e.target.value)} />
          <Input label="Candidate Code" value={quickCandidateDraft.candidate_code} onChange={(e) => setQuickCandidateDraftValue('candidate_code', e.target.value.toUpperCase())} />
          <Input label="Job Title" value={quickCandidateDraft.job_title} onChange={(e) => setQuickCandidateDraftValue('job_title', e.target.value)} />
          <Input label="Email" type="email" value={quickCandidateDraft.email} onChange={(e) => setQuickCandidateDraftValue('email', e.target.value)} />
          <Input label="Phone" value={quickCandidateDraft.phone} onChange={(e) => setQuickCandidateDraftValue('phone', e.target.value)} />
          <SearchableSelect label="Country" value={quickCandidateDraft.country} options={COUNTRY_NAME_OPTIONS} placeholder="Search country..." emptyMessage="No countries found" onChange={(e) => setQuickCandidateDraftValue('country', e.target.value)} />
          <div className="span-2"><Textarea label="Skills" value={quickCandidateDraft.skills} onChange={(e) => setQuickCandidateDraftValue('skills', e.target.value)} rows={2} /></div>
          <div className="span-2"><Textarea label="Notes" value={quickCandidateDraft.notes} onChange={(e) => setQuickCandidateDraftValue('notes', e.target.value)} rows={3} /></div>
          <Select label="Status" value={quickCandidateDraft.status} onChange={(e) => setQuickCandidateDraftValue('status', e.target.value)}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </Select>
        </div>
      </Drawer>

      <Drawer
        open={quickPlacementDrawer.type === 'client'}
        onClose={closeQuickPlacementDrawer}
        title="Quick Add Client"
        width={620}
        footer={(
          <>
            <button className="secondary-btn" onClick={closeQuickPlacementDrawer}>Cancel</button>
            <button className="primary-btn" onClick={saveQuickClient} disabled={quickPlacementDrawerSaving}>
              {quickPlacementDrawerSaving ? 'Saving...' : 'Save Client'}
            </button>
          </>
        )}
      >
        <div className="form-grid cols-2">
          <Input label="Client Name" required value={quickClientDraft.client_name} onChange={(e) => setQuickClientDraftValue('client_name', e.target.value)} />
          <Input label="Client Code" value={quickClientDraft.client_code} readOnly hint="Generated on save" />
          <SearchableSelect
            label="Region"
            required
            value={quickClientDraft.region_id}
            options={quickRegionOptions}
            placeholder="Search region..."
            emptyMessage="No regions found"
            createLabel="+ Add region"
            onChange={(e) => setQuickClientDraftValue('region_id', e.target.value)}
            onCreate={(query) => openQuickRegionDrawer(query, 'client')}
          />
          <Input label="Currency" required value={quickClientDraft.currency} readOnly hint="Auto selected from region" />
          <Select label="Payment Terms" value={quickClientDraft.default_payment_terms} onChange={(e) => setQuickClientDraftValue('default_payment_terms', e.target.value)}>
            <option value="NET_15">Net 15</option>
            <option value="NET_30">Net 30</option>
            <option value="NET_45">Net 45</option>
          </Select>
          <Select label="Invoice Cycle" value={quickClientDraft.default_invoice_cycle} onChange={(e) => setQuickClientDraftValue('default_invoice_cycle', e.target.value)}>
            <option value="WEEKLY">Weekly</option>
            <option value="BIWEEKLY">Bi-Weekly</option>
            <option value="MONTHLY">Monthly</option>
          </Select>
          <div className="span-2"><Textarea label="Billing Address" value={quickClientDraft.billing_address} onChange={(e) => setQuickClientDraftValue('billing_address', e.target.value)} rows={2} /></div>
          <Input label="Tax Identifier" value={quickClientDraft.tax_identifier} onChange={(e) => setQuickClientDraftValue('tax_identifier', e.target.value)} />
          <Input label="Credit Limit" type="number" value={quickClientDraft.credit_limit} onChange={(e) => setQuickClientDraftValue('credit_limit', e.target.value)} />
          <Input label="Contact Name" value={quickClientDraft.primary_contact_name} onChange={(e) => setQuickClientDraftValue('primary_contact_name', e.target.value)} />
          <Input label="Contact Email" type="email" value={quickClientDraft.primary_contact_email} onChange={(e) => setQuickClientDraftValue('primary_contact_email', e.target.value)} />
          <Input label="Contact Phone" value={quickClientDraft.primary_contact_phone} onChange={(e) => setQuickClientDraftValue('primary_contact_phone', e.target.value)} />
          <Select label="Status" value={quickClientDraft.status} onChange={(e) => setQuickClientDraftValue('status', e.target.value)}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </Select>
        </div>
      </Drawer>

      <Drawer
        open={quickPlacementDrawer.type === 'region'}
        onClose={closeQuickPlacementDrawer}
        title="Quick Add Region"
        width={520}
        footer={(
          <>
            <button className="secondary-btn" onClick={closeQuickPlacementDrawer}>Cancel</button>
            <button className="primary-btn" onClick={saveQuickRegion} disabled={quickPlacementDrawerSaving}>
              {quickPlacementDrawerSaving ? 'Saving...' : 'Save Region'}
            </button>
          </>
        )}
      >
        <div className="form-grid cols-2">
          <Input label="Region Name" required value={quickRegionDraft.region_name} onChange={(e) => setQuickRegionDraftValue('region_name', e.target.value)} />
          <Input label="Region Code" value={quickRegionDraft.region_code} readOnly hint="Auto generated from region name" />
          <SearchableSelect
            label="Country"
            required
            value={quickRegionDraft.country_code}
            options={quickCountryOptions}
            placeholder="Search country..."
            emptyMessage="No countries found"
            onChange={(e) => setQuickRegionDraftValue('country_code', e.target.value)}
          />
          <Input label="Default Currency" required value={quickRegionDraft.default_currency} readOnly hint="Auto selected from country" />
          <Input label="Company Name" value={quickRegionDraft.company_name} onChange={(e) => setQuickRegionDraftValue('company_name', e.target.value)} />
          <Select label="Status" value={quickRegionDraft.status} onChange={(e) => setQuickRegionDraftValue('status', e.target.value)}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </Select>
          <div className="span-2"><Textarea label="Company Address" value={quickRegionDraft.company_address} onChange={(e) => setQuickRegionDraftValue('company_address', e.target.value)} rows={3} /></div>
        </div>
      </Drawer>

      <PaymentReceiptViewModal
        paymentId={viewPaymentId}
        onClose={() => setViewPaymentId(null)}
        canEdit={canManagePayments}
        onEdit={(p) => { setViewPaymentId(null); openEdit(p) }}
      />

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        title="Delete Payment"
        message={`Are you sure you want to delete payment ${deleting?.payment_code || deleting?.reference_number || ''}? Invoice totals will be recalculated automatically.`}
        loading={deleteLoading}
      />

      {canManagePayments && actionMenu.open && actionMenu.row && createPortal(
        <div
          className="floating-action-menu payments-action-menu"
          style={{ top: actionMenu.y, left: actionMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button className="floating-action-item" onClick={() => openView(actionMenu.row)}>
            View
          </button>
          <button className="floating-action-item" onClick={() => openEdit(actionMenu.row)}>
            Edit
          </button>
          {canDeletePayments ? (
            <button
              className="floating-action-item danger"
              onClick={() => {
                setDeleting(actionMenu.row)
                setActionMenu({ open: false, x: 0, y: 0, row: null })
              }}
            >
              Delete
            </button>
          ) : null}
        </div>,
        document.body,
      )}
    </div>
  )
}

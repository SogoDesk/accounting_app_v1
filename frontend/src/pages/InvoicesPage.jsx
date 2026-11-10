import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate, useSearchParams, Link } from 'react-router-dom'
import api, { downloadFile } from '../services/api'
import {
  Modal,
  Drawer,
  ConfirmDialog,
  SkeletonRows,
  Input,
  Select,
  SearchableSelect,
  Textarea,
  fmt,
  fmtDate,
  fmtDateDisplay,
  customerLabel,
  StatCard,
  DataTable,
  StatusChip,
  FilterPill,
  PanelHeader,
  Pagination,
  currencySymbol,
} from '../components/ui/index.jsx'
import { useRegionCurrencyFilter } from '../utils/useRegionCurrencyFilter'
import './InvoicesPage.saas.css'
import SendInvoiceEmailModal from '../components/invoices/SendInvoiceEmailModal'
import AttachmentsField, { uploadPendingAttachments } from '../components/AttachmentsField'
import AttachmentsViewer from '../components/AttachmentsViewer'
import InvoiceViewModal from '../components/InvoiceViewModal'
import { useToast } from '../context/ToastContext'
import { getAppPreferences } from '../utils/appPreferences'
import { generateCandidateCode } from '../utils/candidateHelpers'
import { buildRegionCode } from '../utils/regionHelpers'
import { COUNTRIES, COUNTRY_NAME_OPTIONS } from '../data/countries'
import { BILLING_TYPES, billingFamily } from '../data/billingTypes'
import { useAuth } from '../context/AuthContext'
import { useEntity } from '../context/EntityContext'
import { ACTION_ACCESS, hasAnyRole } from '../utils/acl'

const STATUS_OPTIONS = ['DRAFT', 'GENERATED', 'SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'CANCELLED']
const STATUS_FILTER_OPTIONS = ['DUE', ...STATUS_OPTIONS]
// Manually selectable statuses from the status-chip dropdown. OVERDUE/DUE are
// intentionally omitted — they are derived automatically from the due date.
const STATUS_MENU_OPTIONS = ['DRAFT', 'GENERATED', 'SENT', 'PARTIALLY_PAID', 'PAID', 'CANCELLED']
const SUPPORTED_INVOICE_CURRENCIES = ['USD', 'GBP', 'INR']
const COUNTRY_TO_CURRENCY = {
  US: 'USD',
  GB: 'GBP',
  IN: 'INR',
}

const getDateKey = (value) => String(value || '').slice(0, 10)

const normalizeDateForApi = (value) => {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw

  const delimited = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (delimited) {
    const [, dd, mm, yyyy] = delimited
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`
  }

  return raw
}

const isDateInRange = (value, from, to) => {
  const key = getDateKey(value)
  if (!key) return false
  if (from && key < from) return false
  if (to && key > to) return false
  return true
}

const DATE_PRESETS = [
  { value: 'this_month', label: 'This Month' },
  { value: 'next_month', label: 'Next Month' },
  { value: 'last_month', label: 'Last Month' },
  { value: 'last_30_days', label: 'Last 30 Days' },
  { value: 'last_3_months', label: 'Last 3 Months' },
  { value: 'last_6_months', label: 'Last 6 Months' },
  { value: 'all', label: 'All Time' },
  { value: 'custom', label: 'Custom Date Range' },
]

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

// Rolling windows end today; calendar-month presets end on the month's last day
// so invoices dated later in the current month stay visible.
const getPresetRange = (preset) => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const monthsBack = (count) => {
    const start = new Date(today)
    start.setMonth(start.getMonth() - count)
    return { from: toDateKey(start), to: toDateKey(today) }
  }

  switch (preset) {
    case 'this_month':
      return {
        from: toDateKey(new Date(today.getFullYear(), today.getMonth(), 1)),
        to: toDateKey(new Date(today.getFullYear(), today.getMonth() + 1, 0)),
      }
    // Day 0 of the following month is the last day of the one before it, so the
    // window always lands on a real month end without any length arithmetic.
    case 'next_month':
      return {
        from: toDateKey(new Date(today.getFullYear(), today.getMonth() + 1, 1)),
        to: toDateKey(new Date(today.getFullYear(), today.getMonth() + 2, 0)),
      }
    case 'last_month':
      return {
        from: toDateKey(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
        to: toDateKey(new Date(today.getFullYear(), today.getMonth(), 0)),
      }
    case 'last_30_days': {
      const start = new Date(today)
      start.setDate(start.getDate() - 29)
      return { from: toDateKey(start), to: toDateKey(today) }
    }
    case 'last_3_months':
      return monthsBack(3)
    case 'last_6_months':
      return monthsBack(6)
    default:
      return { from: '', to: '' }
  }
}

const createBlankLine = () => ({
  placement_id: '',
  candidate_id: '',
  candidate_name: '',
  job_title: '',
  activity_label: '',
  description: '',
  quantity: '1',
  rate: '0',
  amount: 0,
  line_date: '',
})

const createBlankTax = () => ({
  tax_name: '',
  tax_percent: '0',
  tax_amount: 0,
})

const BLANK_FORM = {
  invoice_number: '',
  invoice_type: 'CLIENT',
  bill_to_region_id: '',
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
  customer_message: '',
  internal_notes: '',
  notes: '',
  line_items: [createBlankLine()],
  tax_lines: [createBlankTax()],
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

function isForbiddenError(error) {
  const status = error?.response?.status
  return status === 401 || status === 403
}

const normalizeNumber = (value) => {
  const num = Number(value || 0)
  return Number.isNaN(num) ? 0 : num
}

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

// The countdown ("Due in N days") shows on every unpaid invoice with a due date.
// This window only controls the DUE *category* (amber/soon tone + status filter):
// within it the invoice counts as DUE; further out it keeps its base status
// category but still reads "Due in N days". Past the due date it flips to an
// OVERDUE count-up ("Overdue N days") until it is paid.
const DUE_SOON_WINDOW_DAYS = 15

// Returns { key, label, days } where `key` is the status category used for
// filtering/tone/counts (OVERDUE | DUE | the base status), and `label` is the
// human countdown text shown on the chip.
const getInvoiceDueInfo = (row) => {
  const status = String(row?.invoice_status || '').toUpperCase()
  const base = status || 'DRAFT'
  const isClosed = ['PAID', 'CANCELLED'].includes(status)
  const outstanding = normalizeNumber(row?.balance_outstanding) > 0

  if (isClosed || !outstanding || !row?.due_date) {
    // `diffDays` null → these sort last on the status column (closed/no due date).
    return { key: base, label: base.replace(/_/g, ' '), days: null, diffDays: null }
  }

  const due = new Date(row.due_date)
  due.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  // Signed days-to-due: negative = overdue, 0 = today, positive = future.
  const diffDays = Math.round((due.getTime() - today.getTime()) / 86400000)

  if (diffDays < 0) {
    const n = -diffDays
    return { key: 'OVERDUE', label: `Overdue ${n} day${n === 1 ? '' : 's'}`, days: n, diffDays }
  }
  if (diffDays === 0) return { key: 'DUE', label: 'Due today', days: 0, diffDays }
  // Always show the countdown label. Within the window the invoice is also
  // categorized DUE (amber/soon tone + status filter); further out it keeps its
  // base status category but still reads "Due in N days".
  const label = `Due in ${diffDays} day${diffDays === 1 ? '' : 's'}`
  if (diffDays <= DUE_SOON_WINDOW_DAYS) {
    return { key: 'DUE', label, days: diffDays, diffDays }
  }
  return { key: base, label, days: diffDays, diffDays }
}

const getInvoiceDisplayStatus = (row) => getInvoiceDueInfo(row).key

// Whole days from today to the due date; negative once the date has passed.
// Both sides are read as the same date-key convention the Due Date column
// renders, so the countdown can never contradict the date beside it.
const daysUntilDue = (value) => {
  const key = getDateKey(value)
  if (!isRealDateKey(key)) return null
  const dueMs = Date.parse(`${key}T00:00:00Z`)
  const todayMs = Date.parse(`${toDateKey(new Date())}T00:00:00Z`)
  return Math.round((dueMs - todayMs) / 86400000)
}

const pluralDays = (count) => `${count} ${count === 1 ? 'day' : 'days'}`

// Due status is derived, never stored: a countdown for invoices that still owe
// money, and a plain state for the ones that can't come due (a cancelled or
// settled invoice showing "Due in 12 days" would be a lie).
const DUE_SORT_CLOSED = Number.MAX_SAFE_INTEGER

const getDueStatus = (row) => {
  const status = String(row?.invoice_status || '').toUpperCase()
  const outstanding = normalizeNumber(row?.balance_outstanding) > 0

  if (status === 'CANCELLED') return { label: 'Cancelled', tone: 'closed', sort: DUE_SORT_CLOSED }
  if (status === 'DRAFT') return { label: 'Draft', tone: 'closed', sort: DUE_SORT_CLOSED }
  if (status === 'PAID' || !outstanding) return { label: 'Paid', tone: 'paid', sort: DUE_SORT_CLOSED }

  const days = daysUntilDue(row?.due_date)
  if (days === null) return { label: 'No due date', tone: 'closed', sort: DUE_SORT_CLOSED }
  if (days < 0) return { label: `Overdue ${pluralDays(Math.abs(days))}`, tone: 'overdue', sort: days }
  if (days === 0) return { label: 'Due today', tone: 'due-soon', sort: days }
  if (days === 1) return { label: 'Due tomorrow', tone: 'due-soon', sort: days }
  return { label: `Due in ${pluralDays(days)}`, tone: days <= 7 ? 'due-soon' : 'upcoming', sort: days }
}

// Nothing left to collect (or nothing collectable) means no payment to receive.
const canReceivePaymentFor = (row) =>
  normalizeNumber(row?.balance_outstanding) > 0 &&
  !['CANCELLED', 'PAID'].includes(String(row?.invoice_status || '').toUpperCase())

// TDS is an Indian withholding regime; regions configured without it (US, UK)
// never see the question. The flag rides along on the invoice row from its region.
const tdsAppliesTo = (row) => row?.region_tds_applicable === true

const buildTermsFromPlacement = (placement) => {
  if (!placement) return 'Net 30'
  if (placement.payment_terms === 'CUSTOM' && placement.custom_payment_terms_days) {
    return `Net ${placement.custom_payment_terms_days}`
  }
  if (placement.payment_terms) {
    return String(placement.payment_terms)
      .replace('NET_', 'Net ')
      .replace(/_/g, ' ')
  }
  if (placement.default_payment_terms) return placement.default_payment_terms
  if (placement.invoice_terms_label) return placement.invoice_terms_label
  return 'Net 30'
}

const getPlacementBillRate = (placement) => {
  if (!placement) return 0
  const fam = billingFamily(placement.billing_type)
  if (fam === 'FLAT') return normalizeNumber(placement.monthly_billing_amount)
  if (fam === 'ANNUAL') return normalizeNumber(placement.monthly_billing_amount) / 12
  if (fam === 'FEE') return normalizeNumber(placement.one_time_fee_amount)
  return normalizeNumber(placement.bill_rate) // RATE: HOURLY/DAILY/WEEKLY
}

const getPlacementDefaultQuantity = (placement) => {
  if (!placement) return 1
  if (billingFamily(placement.billing_type) === 'RATE') {
    return normalizeNumber(placement.expected_hours_per_month) || 1
  }
  return 1
}

const buildLineDescription = (line) => {
  if (String(line.description || '').trim()) return String(line.description).trim()
  const parts = []
  if (line.activity_label) parts.push(String(line.activity_label).trim())
  if (line.candidate_name) parts.push(`for ${String(line.candidate_name).trim()}`)
  if (line.job_title) parts.push(`(${String(line.job_title).trim()})`)
  if (line.line_date) parts.push(`dated ${String(line.line_date).trim()}`)
  return parts.join(' ').trim() || 'Invoice line item'
}

const resolveInvoiceCurrency = (placement, fallback = 'USD') => {
  const countryCurrency = COUNTRY_TO_CURRENCY[String(placement?.region_country_code || '').toUpperCase()]
  const preferred = [
    placement?.client_currency,
    placement?.currency,
    placement?.region_currency,
    countryCurrency,
    fallback,
  ]
    .map((value) => String(value || '').toUpperCase())
    .find(Boolean)

  return SUPPORTED_INVOICE_CURRENCIES.includes(preferred) ? preferred : (preferred || fallback)
}

// Map a derived invoice status onto a StatusChip tone.
const STATUS_CHIP_TONE = {
  PAID: 'success',
  OVERDUE: 'danger',
  DUE: 'warn',
  PARTIALLY_PAID: 'warn',
  SENT: 'accent',
  GENERATED: 'accent',
  DRAFT: 'neutral',
  CANCELLED: 'neutral',
}
const statusChipTone = (status) => STATUS_CHIP_TONE[String(status || '').toUpperCase()] || 'neutral'

const IconBack = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
)
const IconFilter = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h16M7 12h10M10 19h4" /></svg>
)
const IconDownload = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14" /></svg>
)

// A FilterPill that keeps a real, native <select> layered invisibly on top so
// the existing filter handlers and keyboard/dropdown behaviour are preserved.
function FilterSelect({ label, value, display, active, onChange, ariaLabel, children }) {
  return (
    <div className="inv-pill-wrap">
      <FilterPill active={active} dropdown value={display}>{label}</FilterPill>
      <select className="inv-pill-native" value={value} onChange={onChange} aria-label={ariaLabel || label}>
        {children}
      </select>
    </div>
  )
}

export default function InvoicesPage() {
  const toast = useToast()
  const { user } = useAuth()
  const roleName = user?.roleName
  const canManageInvoices = hasAnyRole(roleName, ACTION_ACCESS.invoices.manage)
  const canDeleteInvoices = hasAnyRole(roleName, ACTION_ACCESS.invoices.delete)
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()

  const [rows, setRows] = useState([])
  const [placements, setPlacements] = useState([])
  // Entities the caller may act on — the pick-list for inter-company invoices'
  // issuing and bill-to sides. /regions is already scoped to allowed entities.
  const [regions, setRegions] = useState([])
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  // Company group currency the backend consolidated the *_reporting fields into.
  const [reportingCurrency, setReportingCurrency] = useState('USD')
  // Whole-dataset KPI totals from the backend (every invoice, not just this
  // page): { reporting_currency, all, by_region }. Drives the KPI cards.
  const [reportingTotals, setReportingTotals] = useState(null)
  // Server-computed segmented-tab counts over the full filtered set (search +
  // client + region + date), so the tabs are correct across all pages.
  const [tabCountsData, setTabCountsData] = useState(null)
  const [pageSize, setPageSize] = useState(10)
  const loadSeq = useRef(0)
  const [search, setSearch] = useState('')
  // Debounced search that actually drives the server fetch (the raw `search`
  // still narrows the visible page instantly for responsiveness).
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [scopeFilter, setScopeFilter] = useState('')
  const [currencyFilter, setCurrencyFilter] = useState('')
  const [clientFilter, setClientFilter] = useState('')
  // Region is driven by the global top-nav switcher (no per-page dropdown).
  const { entityId: regionFilter, setEntityId } = useEntity()
  const [datePreset, setDatePreset] = useState('all')
  const [dateFrom, setDateFrom] = useState(() => getPresetRange('all').from)
  const [dateTo, setDateTo] = useState(() => getPresetRange('all').to)
  const [exporting, setExporting] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(true)
  const [sortConfig, setSortConfig] = useState({ key: 'invoice_date', direction: 'desc' })

  const [modal, setModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(BLANK_FORM)

  const [viewInvoiceId, setViewInvoiceId] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [emailFor, setEmailFor] = useState(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  // Approved-timesheet attachments selected in the create/edit modal (uploaded on save).
  const [invoiceFiles, setInvoiceFiles] = useState([])

  const [actionMenu, setActionMenu] = useState({ open: false, x: 0, y: 0, row: null })
  const [statusMenu, setStatusMenu] = useState({ open: false, x: 0, y: 0, row: null })
  const [paidModal, setPaidModal] = useState({ open: false, row: null })
  const [partialModal, setPartialModal] = useState({ open: false, row: null })
  const [partialAmount, setPartialAmount] = useState('')
  const [statusTdsApplicable, setStatusTdsApplicable] = useState('')
  const [statusTdsPercent, setStatusTdsPercent] = useState('')
  const [paidDate, setPaidDate] = useState('')
  const [statusConfirm, setStatusConfirm] = useState({ open: false, row: null, status: '' })
  const [statusLoading, setStatusLoading] = useState(false)
  const [appPrefs, setAppPrefs] = useState(() => getAppPreferences())
  const lastDuplicateWarningRef = useRef('')
  const [placementDrawerOpen, setPlacementDrawerOpen] = useState(false)
  const [quickPlacementLineIndex, setQuickPlacementLineIndex] = useState(0)
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

  useEffect(() => {
    setAppPrefs(getAppPreferences())
  }, [modal])

  const placementsById = useMemo(() => {
    const map = new Map()
    placements.forEach((placement) => map.set(String(placement.id), placement))
    return map
  }, [placements])

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

  // The date window is applied server-side so it spans every invoice, not just
  // the current page; the client-side pass below still narrows the rest.
  const load = async (pageNum = 1, range = { from: dateFrom, to: dateTo }) => {
    // Sequence guard: when filters change on arrival (e.g. a dashboard drill-down
    // to ?scope=overdue), the effect fires an unfiltered fetch and a filtered one
    // in quick succession. Without this guard, an out-of-order response could
    // clobber the newer one — leaving a stale total (154) with an empty list.
    const seq = ++loadSeq.current
    try {
      setLoading(true)
      const params = { page: pageNum, limit: pageSize }
      if (range.from) params.from = range.from
      if (range.to) params.to = range.to
      // Scope the paginated list server-side (region + status + scope + client +
      // search) so every page reflects the full filtered set, not just the rows
      // that happened to load. The KPI `totals` stay whole-book regardless, and
      // `tab_counts` cover the search/client/region/date scope — see backend.
      if (regionFilter) params.region_id = regionFilter
      if (statusFilter) params.status = statusFilter
      if (scopeFilter) params.scope = scopeFilter
      if (currencyFilter) params.currency = currencyFilter
      if (clientFilter) params.client_id = clientFilter
      if (searchQuery) params.search = searchQuery
      const [invoiceRes, placementRes, regionRes] = await Promise.all([
        api.get('/invoices', { params }),
        api.get('/invoices/placement-options'),
        api.get('/regions'),
      ])
      if (seq !== loadSeq.current) return // superseded by a newer load
      setRows(invoiceRes.data?.data || [])
      setTotal(invoiceRes.data?.total || 0)
      setReportingCurrency(invoiceRes.data?.reporting_currency || 'USD')
      setReportingTotals(invoiceRes.data?.totals || null)
      setTabCountsData(invoiceRes.data?.tab_counts || null)
      setPlacements(placementRes.data?.data || [])
      setRegions(regionRes.data?.data || [])
    } catch (error) {
      if (seq === loadSeq.current) toast.error(error.response?.data?.message || 'Failed to load invoices')
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }

  useEffect(() => {
    load(page)
  }, [page, pageSize, dateFrom, dateTo, regionFilter, statusFilter, scopeFilter, currencyFilter, clientFilter, searchQuery])

  // Debounce the search box into the term that triggers the server fetch, and
  // snap back to the first page whenever the query changes.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearchQuery((prev) => {
        const next = search.trim()
        if (next !== prev) setPage(1)
        return next
      })
    }, 350)
    return () => clearTimeout(t)
  }, [search])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const status = String(params.get('status') || '').toUpperCase()
    const scope = String(params.get('scope') || '').toLowerCase()
    const clientId = String(params.get('client_id') || '')
    const regionId = String(params.get('region_id') || '')
    const startDate = String(params.get('start_date') || '')
    const endDate = String(params.get('end_date') || '')
    const q = String(params.get('q') || '')

    setStatusFilter(STATUS_FILTER_OPTIONS.includes(status) ? status : '')
    setScopeFilter(['outstanding', 'overdue', 'collected'].includes(scope) ? scope : '')
    setCurrencyFilter(String(params.get('currency') || '').toUpperCase())
    setClientFilter(clientId)
    // An explicit region_id (a drill-down link) updates the global switcher;
    // otherwise leave the app-wide entity default as-is.
    if (regionId) setEntityId(regionId)
    const hasStart = /^\d{4}-\d{2}-\d{2}$/.test(startDate)
    const hasEnd = /^\d{4}-\d{2}-\d{2}$/.test(endDate)
    if (hasStart || hasEnd) {
      // An explicit range in the URL (e.g. drill-down from a dashboard) is a
      // custom range, not one of the presets.
      setDatePreset('custom')
      setDateFrom(hasStart ? startDate : '')
      setDateTo(hasEnd ? endDate : '')
    } else {
      const range = getPresetRange('all')
      setDatePreset('all')
      setDateFrom(range.from)
      setDateTo(range.to)
    }
    setPage(1)
    if (q) setSearch(q)
  }, [location.search])

  useEffect(() => {
    if (dateFrom && dateTo && dateTo < dateFrom) {
      setDateTo(dateFrom)
    }
  }, [dateFrom, dateTo])

  // "Custom Date Range" keeps whatever range the previous preset resolved to,
  // so the pickers open on a sensible starting point instead of empty.
  // Changing the window invalidates the current page, so go back to the first.
  const applyDatePreset = (preset) => {
    setDatePreset(preset)
    if (preset === 'custom') return
    const range = getPresetRange(preset)
    setDateFrom(range.from)
    setDateTo(range.to)
    setPage(1)
  }

  useEffect(() => {
    const closeMenus = () => {
      setActionMenu((prev) => ({ ...prev, open: false }))
      setStatusMenu((prev) => ({ ...prev, open: false }))
    }

    const handleEscape = (event) => {
      if (event.key === 'Escape') closeMenus()
    }

    window.addEventListener('click', closeMenus)
    window.addEventListener('resize', closeMenus)
    window.addEventListener('scroll', closeMenus, true)
    window.addEventListener('keydown', handleEscape)

    return () => {
      window.removeEventListener('click', closeMenus)
      window.removeEventListener('resize', closeMenus)
      window.removeEventListener('scroll', closeMenus, true)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [])

  const filtered = rows.filter((row) => {
    const needle = search.trim().toLowerCase()
    const matchSearch = !needle || [
      row.invoice_number,
      row.client_name,
      row.candidate_name,
      row.region_name,
    ].filter(Boolean).some((value) => String(value).toLowerCase().includes(needle))

    const matchStatus = !statusFilter || getInvoiceDisplayStatus(row) === statusFilter
    const matchClient = !clientFilter || String(row.client_id) === String(clientFilter)
    const matchRegion = !regionFilter || String(row.region_id) === String(regionFilter)
    const matchCurrency = !currencyFilter || String(row.currency || '').toUpperCase() === currencyFilter
    const matchDateRange = (!dateFrom && !dateTo) || isDateInRange(row.due_date, dateFrom, dateTo)

    const balanceOutstanding = normalizeNumber(row.balance_outstanding)
    const paymentReceived = normalizeNumber(row.payment_received_amount)
    const dueDate = row.due_date ? new Date(row.due_date) : null
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    if (dueDate) dueDate.setHours(0, 0, 0, 0)

    const isOutstanding = balanceOutstanding > 0 && !['PAID', 'CANCELLED'].includes(String(row.invoice_status || '').toUpperCase())
    const isOverdue = isOutstanding && dueDate && dueDate < today
    const isCollected = paymentReceived > 0
    const displayStatus = getInvoiceDisplayStatus(row)
    const isSent = displayStatus === 'SENT' || displayStatus === 'GENERATED'

    const matchScope =
      !scopeFilter ||
      (scopeFilter === 'outstanding' && isOutstanding) ||
      (scopeFilter === 'overdue' && isOverdue) ||
      (scopeFilter === 'collected' && isCollected) ||
      (scopeFilter === 'sent' && isSent)

    return matchSearch && matchStatus && matchClient && matchRegion && matchCurrency && matchDateRange && matchScope
  })

  const exportXlsx = async () => {
    setExporting(true)
    try {
      const params = new URLSearchParams()
      if (search.trim()) params.set('search', search.trim())
      if (statusFilter) params.set('status', statusFilter)
      if (scopeFilter) params.set('scope', scopeFilter)
      if (currencyFilter) params.set('currency', currencyFilter)
      if (clientFilter) params.set('client_id', clientFilter)
      if (regionFilter) params.set('region_id', regionFilter)
      if (dateFrom) params.set('from', dateFrom)
      if (dateTo) params.set('to', dateTo)
      params.set('format', 'xlsx')
      const range = (dateFrom || dateTo) ? `_${dateFrom || 'start'}_to_${dateTo || 'end'}` : ''
      await downloadFile(`/api/invoices/export?${params.toString()}`, `invoices${range}.xlsx`)
      toast.success('Invoices exported to Excel')
    } catch { toast.error('Export failed') }
    finally { setExporting(false) }
  }


  // Cross-filter Region ↔ Currency (currency is derived from region). The list
  // is server-paginated, so region/currency go to the backend; the options here
  // just prevent contradictory picks. `regions` is the full /regions list.
  const { visibleCurrencies, selectCurrency } = useRegionCurrencyFilter({
    regions,
    currencies: rows.map((r) => r.currency),
    regionFilter,
    currencyFilter,
    setRegionFilter: () => {},
    setCurrencyFilter,
    onAfterChange: () => setPage(1),
  })

  const sortedRows = useMemo(() => {
    const list = [...filtered]
    const { key, direction } = sortConfig || {}
    if (!key) return list

    const getValue = (row) => {
      if (key === 'invoice_number') return String(row.invoice_number || '').toLowerCase()
      if (key === 'client_name') return String(row.client_name || '').toLowerCase()
      if (key === 'particulars_count') return normalizeNumber(row.particulars_count || 1)
      if (key === 'invoice_date') return new Date(row.invoice_date || 0).getTime()
      if (key === 'due_date') return new Date(row.due_date || 0).getTime()
      if (key === 'total_amount') return normalizeNumber(row.total_amount)
      if (key === 'payment_received_amount') return normalizeNumber(row.payment_received_amount)
      if (key === 'balance_outstanding') return normalizeNumber(row.balance_outstanding)
      // Urgency order: most overdue first, then soonest due, closed states last.
      if (key === 'due_status') return getDueStatus(row).sort
      return ''
    }

    list.sort((a, b) => {
      const va = getValue(a)
      const vb = getValue(b)
      if (va < vb) return direction === 'asc' ? -1 : 1
      if (va > vb) return direction === 'asc' ? 1 : -1
      return 0
    })

    return list
  }, [filtered, sortConfig])

  const invoiceStats = useMemo(() => {
    const isRegionScoped = Boolean(regionFilter)

    // Preferred path: whole-dataset totals from the backend, so the cards reflect
    // every invoice in scope rather than just the rows on this page. The
    // all-regions view uses the consolidated group-currency `all` bucket; a single
    // region uses its native (billing-currency) figures plus the book-currency
    // `functional` split for the dual UK-style display.
    const t = reportingTotals
    if (t) {
      if (!isRegionScoped) {
        const a = t.all || {}
        return {
          totalAmount: normalizeNumber(a.invoiced),
          dueAmount: normalizeNumber(a.due),
          overdueAmount: normalizeNumber(a.overdue),
          paidAmount: normalizeNumber(a.received),
          totalAmountFn: 0,
          dueAmountFn: 0,
          overdueAmountFn: 0,
          paidAmountFn: 0,
          isRegionScoped: false,
          scopeCurrency: t.reporting_currency || reportingCurrency,
          functionalCurrency: null,
          showDual: false,
        }
      }
      const br = (t.by_region || {})[String(regionFilter)]
      if (br) {
        const fn = br.functional || {}
        const scopeCurrency = String(br.currency || 'USD').toUpperCase()
        const functionalCurrency = br.functional_currency
          ? String(br.functional_currency).toUpperCase()
          : null
        const showDual = Boolean(functionalCurrency && functionalCurrency !== scopeCurrency)
        return {
          totalAmount: normalizeNumber(br.invoiced),
          dueAmount: normalizeNumber(br.due),
          overdueAmount: normalizeNumber(br.overdue),
          paidAmount: normalizeNumber(br.received),
          totalAmountFn: normalizeNumber(fn.invoiced),
          dueAmountFn: normalizeNumber(fn.due),
          overdueAmountFn: normalizeNumber(fn.overdue),
          paidAmountFn: normalizeNumber(fn.received),
          isRegionScoped: true,
          scopeCurrency,
          functionalCurrency,
          showDual,
        }
      }
      // Region selected but it has no invoices in scope → all-zero cards.
      return {
        totalAmount: 0,
        dueAmount: 0,
        overdueAmount: 0,
        paidAmount: 0,
        totalAmountFn: 0,
        dueAmountFn: 0,
        overdueAmountFn: 0,
        paidAmountFn: 0,
        isRegionScoped: true,
        scopeCurrency: reportingCurrency,
        functionalCurrency: null,
        showDual: false,
      }
    }

    // Fallback: derive from the currently-loaded rows (used only if the backend
    // did not send `totals`, e.g. an older API). Undercounts across pages.
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const currenciesInScope = Array.from(new Set(filtered.map((row) => String(row.currency || 'USD').toUpperCase())))
    const scopeCurrency = isRegionScoped
      ? (currenciesInScope[0] || 'USD')
      : reportingCurrency

    // When a single entity is scoped and its book (functional) currency differs
    // from what it invoices in (TetriQ-UK bills USD, books GBP), also total the
    // book-currency value so both show side by side. GBP figures use each
    // invoice's stored rate/base, matching the ledger's per-date valuation.
    const functionalCurrency = isRegionScoped
      ? (filtered.find((r) => r.functional_currency)?.functional_currency || null)
      : null
    const showDual = Boolean(isRegionScoped && functionalCurrency && functionalCurrency !== scopeCurrency)
    // Prefer the rate implied by the invoice's booked base amount over the raw
    // exchange_rate column: UK rows reached by the migration backfill have
    // amount_base set but exchange_rate still at its DEFAULT 1, which would
    // otherwise render the unconverted USD figure under a GBP symbol.
    const fnRate = (row) => {
      const total = normalizeNumber(row.total_amount)
      const hasBase = row.amount_base != null && row.amount_base !== ''
      if (hasBase && total > 0) return normalizeNumber(row.amount_base) / total
      return Number(row.exchange_rate) > 0 ? Number(row.exchange_rate) : 1
    }
    const toFunctional = (value, row) => normalizeNumber(value) * fnRate(row)

    // Region-scoped → native amount (all rows share the region's currency);
    // consolidated → the backend's group-currency (*_reporting) copy, converted
    // per row so mixed currencies are never summed raw.
    const statAmount = (row, nativeField, reportingField) => normalizeNumber(
      isRegionScoped ? row[nativeField] : row[reportingField],
    )

    let totalAmount = 0
    let dueAmount = 0
    let overdueAmount = 0
    let paidAmount = 0
    let totalAmountFn = 0
    let dueAmountFn = 0
    let overdueAmountFn = 0
    let paidAmountFn = 0

    filtered.forEach((row) => {
      totalAmount += statAmount(row, 'total_amount', 'total_amount_reporting')
      paidAmount += statAmount(row, 'payment_received_amount', 'payment_received_amount_reporting')
      if (showDual) {
        totalAmountFn += row.amount_base != null && row.amount_base !== ''
          ? normalizeNumber(row.amount_base)
          : toFunctional(row.total_amount, row)
        paidAmountFn += toFunctional(row.payment_received_amount, row)
      }

      const status = String(row.invoice_status || '').toUpperCase()
      const isClosed = ['PAID', 'CANCELLED'].includes(status)
      const outstandingValue = normalizeNumber(row.balance_outstanding)
      const outstanding = outstandingValue > 0
      if (isClosed || !outstanding) return

      const outstandingScoped = statAmount(row, 'balance_outstanding', 'balance_outstanding_reporting')
      dueAmount += outstandingScoped
      if (showDual) dueAmountFn += toFunctional(outstandingValue, row)
      const dueDate = row.due_date ? new Date(row.due_date) : null
      if (dueDate && !Number.isNaN(dueDate.getTime())) {
        dueDate.setHours(0, 0, 0, 0)
        if (dueDate < today) {
          overdueAmount += outstandingScoped
          if (showDual) overdueAmountFn += toFunctional(outstandingValue, row)
        }
      }
    })

    return {
      totalAmount,
      dueAmount,
      overdueAmount,
      paidAmount,
      totalAmountFn,
      dueAmountFn,
      overdueAmountFn,
      paidAmountFn,
      isRegionScoped,
      scopeCurrency,
      functionalCurrency,
      showDual,
    }
  }, [filtered, reportingCurrency, regionFilter, reportingTotals])

  // Card label/value helpers: append "(USD | GBP)" and render both amounts
  // inline when a mixed-currency entity (e.g. UK) is scoped.
  const statLabel = (base) => `${base} ${invoiceStats.isRegionScoped
    ? (invoiceStats.showDual ? `(${invoiceStats.scopeCurrency} | ${invoiceStats.functionalCurrency})` : `(${invoiceStats.scopeCurrency})`)
    : '(USD)'}`
  const statValue = (usd, fn) => (invoiceStats.showDual
    ? `${fmt(usd, invoiceStats.scopeCurrency)}  |  ${fmt(fn, invoiceStats.functionalCurrency)}`
    : fmt(usd, invoiceStats.scopeCurrency))

  const toggleSort = (key) => {
    setSortConfig((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
      }
      return { key, direction: 'asc' }
    })
  }

  const sortMarker = (key) => {
    if (sortConfig.key !== key) return '↕'
    return sortConfig.direction === 'asc' ? '↑' : '↓'
  }

  const allowedPlacementsForLines = useMemo(() => {
    const selectedClientId = String(form.client_id || '')
    if (!selectedClientId) return placements
    return placements.filter((placement) => String(placement.client_id) === selectedClientId)
  }, [placements, form.client_id])
  const allowedPlacementOptions = useMemo(() => (
    allowedPlacementsForLines.map((placement) => ({
      value: String(placement.id),
      label: placement.placement_code || `#${placement.id}`,
      meta: `${placement.candidate_name} • ${placement.client_name}`,
      searchText: `${placement.job_title || ''} ${placement.region_name || ''}`.trim(),
    }))
  ), [allowedPlacementsForLines])

  // Inter-company mode: the invoice bills another entity, so there is no client
  // or placement — the issuing and bill-to entities come from these dropdowns.
  const isIcForm = form.invoice_type === 'INTER_COMPANY'
  const entitiesById = useMemo(() => {
    const map = new Map()
    regions.forEach((region) => map.set(String(region.id), region))
    return map
  }, [regions])
  const entityOptions = useMemo(() => (
    regions.map((region) => ({
      value: String(region.id),
      label: region.region_name,
      meta: [region.country_name, region.functional_currency || region.default_currency]
        .filter(Boolean)
        .join(' • '),
      searchText: `${region.region_code || ''} ${region.company_name || ''}`.trim(),
    }))
  ), [regions])

  const amounts = useMemo(() => {
    const subtotal = (form.line_items || []).reduce(
      (sum, item) => sum + normalizeNumber(item.quantity) * normalizeNumber(item.rate),
      0,
    )

    const computedTaxes = (form.tax_lines || [])
      .filter((line) => String(line.tax_name || '').trim() || normalizeNumber(line.tax_percent) > 0)
      .map((line) => ({
        ...line,
        tax_name: String(line.tax_name || 'Tax').trim(),
        tax_percent: normalizeNumber(line.tax_percent),
        tax_amount: (subtotal * normalizeNumber(line.tax_percent)) / 100,
      }))

    const taxAmount = computedTaxes.reduce((sum, line) => sum + normalizeNumber(line.tax_amount), 0)

    return {
      subtotal,
      taxAmount,
      total: subtotal + taxAmount,
      computedTaxes,
    }
  }, [form.line_items, form.tax_lines])

  const setFormValue = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))

  const handleInvoiceDateChange = (nextDate) => {
    setForm((prev) => ({
      ...prev,
      invoice_date: nextDate,
      due_date: prev.invoice_terms_label
        ? addDays(nextDate, extractNetDays(prev.invoice_terms_label))
        : prev.due_date,
    }))
  }

  const handleInvoiceNumberChange = (value) => {
    const nextNumber = String(value || '').toUpperCase()
    setFormValue('invoice_number', nextNumber)

    if (!appPrefs.warn_duplicate_invoice_number) return
    if (!nextNumber.trim()) return

    const duplicate = rows.find((row) => {
      if (editing && Number(row.id) === Number(editing.id)) return false
      return String(row.invoice_number || '').trim().toUpperCase() === nextNumber.trim()
    })
    if (duplicate) {
      if (lastDuplicateWarningRef.current !== nextNumber.trim()) {
        toast.warning(`Duplicate invoice number found: ${nextNumber}`)
        lastDuplicateWarningRef.current = nextNumber.trim()
      }
    } else {
      lastDuplicateWarningRef.current = ''
    }
  }

  const getPlacementByAnyId = (placementId) => {
    if (!placementId && placementId !== 0) return null
    return placementsById.get(String(placementId)) || null
  }

  const resolveInvoicePlacement = (invoice, row = null) => {
    const directPlacementId =
      invoice?.placement_id ||
      invoice?.line_items?.[0]?.placement_id ||
      row?.placement_id ||
      null

    return getPlacementByAnyId(directPlacementId)
  }

  const resolveInvoiceHeader = (invoice, row = null) => {
    const fallbackPlacement = resolveInvoicePlacement(invoice, row)

    return {
      placement_id: invoice?.placement_id
        ? String(invoice.placement_id)
        : fallbackPlacement?.id
          ? String(fallbackPlacement.id)
          : row?.placement_id
            ? String(row.placement_id)
            : '',
      client_id: invoice?.client_id
        ? String(invoice.client_id)
        : fallbackPlacement?.client_id
          ? String(fallbackPlacement.client_id)
          : row?.client_id
            ? String(row.client_id)
            : '',
      region_id: invoice?.region_id
        ? String(invoice.region_id)
        : fallbackPlacement?.region_id
          ? String(fallbackPlacement.region_id)
          : row?.region_id
            ? String(row.region_id)
            : '',
      client_name:
        invoice?.client_name ||
        fallbackPlacement?.client_name ||
        row?.client_name ||
        '',
      region_name:
        invoice?.region_name ||
        fallbackPlacement?.region_name ||
        row?.region_name ||
        '',
      currency:
        invoice?.currency ||
        resolveInvoiceCurrency(fallbackPlacement, row?.currency || 'USD') ||
        row?.currency ||
        'USD',
    }
  }

  const fetchPreviewInvoiceNumber = async (invoiceType = 'CLIENT') => {
    try {
      const response = await api.get('/invoices/next-number-preview', {
        params: invoiceType === 'INTER_COMPANY' ? { type: 'INTER_COMPANY' } : {},
      })
      return response.data?.data?.invoice_number || ''
    } catch {
      return ''
    }
  }

  const openCreate = async () => {
    const today = new Date().toISOString().slice(0, 10)
    const previewNumber = await fetchPreviewInvoiceNumber()

    setEditing(null)
    setInvoiceFiles([])
    setForm({
      ...BLANK_FORM,
      invoice_number: previewNumber,
      invoice_date: today,
      due_date: '',
      invoice_terms_label: '',
      billing_period_start: '',
      billing_period_end: '',
    })
    setModal(true)
  }

  useEffect(() => {
    if (searchParams.get('action') !== 'create' || !canManageInvoices) return
    void openCreate()
    setSearchParams({}, { replace: true })
  }, [searchParams, setSearchParams, canManageInvoices])

  // Deep-link to a specific invoice's detail view (e.g. from a client's
  // transaction list: /invoices?view=<id>). Open the read view, then strip the
  // param so a refresh/back doesn't re-open it — other filters are preserved.
  useEffect(() => {
    const viewId = searchParams.get('view')
    if (!viewId) return
    void openView({ id: viewId })
    const next = new URLSearchParams(searchParams)
    next.delete('view')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  // Deep-link to edit a specific invoice (e.g. Edit from a client's invoice
  // modal: /invoices?edit=<id>). Opens the full edit form on this page.
  useEffect(() => {
    const editId = searchParams.get('edit')
    if (!editId) return
    const next = new URLSearchParams(searchParams)
    next.delete('edit')
    setSearchParams(next, { replace: true })
    if (canManageInvoices) void openEdit({ id: editId })
  }, [searchParams, setSearchParams, canManageInvoices])

  const mapIncomingLineItems = (invoice, row = null) => {
    if (Array.isArray(invoice.line_items) && invoice.line_items.length > 0) {
      return invoice.line_items.map((item) => {
        const placement = getPlacementByAnyId(item.placement_id) || resolveInvoicePlacement(invoice, row)

        return {
          placement_id: item.placement_id ? String(item.placement_id) : placement?.id ? String(placement.id) : '',
          candidate_id: item.candidate_id
            ? String(item.candidate_id)
            : placement?.candidate_id
              ? String(placement.candidate_id)
              : '',
          candidate_name: item.candidate_name || placement?.candidate_name || row?.candidate_name || '',
          job_title: item.job_title || placement?.job_title || '',
          activity_label: item.activity_label || item.job_title || placement?.job_title || '',
          description: item.description || '',
          quantity: String(item.quantity ?? 1),
          rate: String(item.rate ?? item.unit_price ?? 0),
          amount: normalizeNumber(item.amount ?? item.line_total),
          line_date: item.line_date ? fmtDate(item.line_date) : '',
        }
      })
    }

    const placement = resolveInvoicePlacement(invoice, row)
    if (placement) {
      const quantity = getPlacementDefaultQuantity(placement)
      const rate = getPlacementBillRate(placement)

      return [
        {
          placement_id: String(placement.id),
          candidate_id: placement.candidate_id ? String(placement.candidate_id) : '',
          candidate_name: placement.candidate_name || row?.candidate_name || '',
          job_title: placement.job_title || '',
          activity_label: placement.job_title || placement.candidate_name || 'Professional Services',
          description: buildLineDescription({
            activity_label: placement.job_title || 'Professional Services',
            candidate_name: placement.candidate_name || row?.candidate_name || '',
            job_title: placement.job_title || '',
          }),
          quantity: String(quantity),
          rate: String(rate),
          amount: quantity * rate,
          line_date: '',
        },
      ]
    }

    return [createBlankLine()]
  }

  // Inter-company lines have no placement/candidate — map straight from the
  // stored description-driven rows.
  const mapIncomingIcLineItems = (invoice) => {
    if (Array.isArray(invoice.line_items) && invoice.line_items.length > 0) {
      return invoice.line_items.map((item) => ({
        ...createBlankLine(),
        activity_label: item.activity_label || '',
        description: item.description || '',
        quantity: String(item.quantity ?? 1),
        rate: String(item.rate ?? item.unit_price ?? 0),
        amount: normalizeNumber(item.amount ?? item.line_total),
        line_date: item.line_date ? fmtDate(item.line_date) : '',
      }))
    }
    return [createBlankLine()]
  }

  const mapIncomingTaxLines = (invoice) => {
    const candidateArrays = [
      invoice?.tax_lines,
      invoice?.taxes,
      invoice?.invoice_taxes,
      invoice?.tax_lines_json,
    ]

    const firstValidArray = candidateArrays.find((value) => Array.isArray(value) && value.length > 0)

    if (firstValidArray) {
      return firstValidArray.map((line) => ({
        tax_name: line.tax_name || line.name || '',
        tax_percent: String(line.tax_percent ?? line.tax_rate ?? line.percent ?? 0),
        tax_amount: normalizeNumber(line.tax_amount ?? line.amount ?? 0),
      }))
    }

    const singleTaxName = invoice?.tax_name || invoice?.name || ''
    const singleTaxPercent = invoice?.tax_percent ?? invoice?.tax_rate ?? invoice?.percent ?? 0
    const singleTaxAmount = invoice?.tax_amount ?? invoice?.amount ?? 0

    if (singleTaxName || normalizeNumber(singleTaxPercent) > 0 || normalizeNumber(singleTaxAmount) > 0) {
      return [{
        tax_name: singleTaxName || 'Tax',
        tax_percent: String(singleTaxPercent),
        tax_amount: normalizeNumber(singleTaxAmount),
      }]
    }

    return [createBlankTax()]
  }

  const openEdit = async (row) => {
    try {
      const response = await api.get(`/invoices/${row.id}`)
      const invoice = response.data?.data
      if (!invoice) {
        toast.error('Invoice details not found')
        return
      }

      const header = resolveInvoiceHeader(invoice, row)
      const isIc = String(invoice.invoice_type || '').toUpperCase() === 'INTER_COMPANY'
      const issuingRegionId = isIc
        ? (invoice.region_id ? String(invoice.region_id) : header.region_id)
        : header.region_id

      setEditing(invoice)
      setInvoiceFiles([])
      setForm({
        ...BLANK_FORM,
        invoice_number: invoice.invoice_number || row.invoice_number || '',
        invoice_type: isIc ? 'INTER_COMPANY' : 'CLIENT',
        bill_to_region_id: isIc && invoice.bill_to_region_id ? String(invoice.bill_to_region_id) : '',
        placement_id: isIc ? '' : header.placement_id,
        client_id: isIc ? '' : header.client_id,
        region_id: issuingRegionId,
        client_name: isIc ? '' : header.client_name,
        region_name: isIc
          ? (entitiesById.get(String(issuingRegionId))?.region_name || '')
          : header.region_name,
        currency: header.currency,
        invoice_date: fmtDate(invoice.invoice_date || row.invoice_date),
        due_date: fmtDate(invoice.due_date || row.due_date),
        invoice_terms_label: invoice.invoice_terms_label || invoice.default_payment_terms || '',
        billing_period_start: invoice.billing_period_start ? fmtDate(invoice.billing_period_start) : '',
        billing_period_end: invoice.billing_period_end ? fmtDate(invoice.billing_period_end) : '',
        invoice_status: invoice.invoice_status || row.invoice_status || 'GENERATED',
        invoice_template: invoice.invoice_template || placementsById.get(String(header.placement_id || ''))?.region_invoice_template || 'CLASSIC',
        customer_message: invoice.customer_message || '',
        internal_notes: invoice.internal_notes || '',
        notes: invoice.notes || '',
        line_items: isIc ? mapIncomingIcLineItems(invoice) : mapIncomingLineItems(invoice, row),
        tax_lines: isIc ? [createBlankTax()] : mapIncomingTaxLines(invoice),
      })
      setModal(true)
      setActionMenu({ open: false, x: 0, y: 0, row: null })
    } catch (error) {
      toast.error(error.response?.data?.message || 'Failed to load invoice details')
    }
  }

  const openView = (row) => {
    setViewInvoiceId(row?.id ?? null)
    setActionMenu({ open: false, x: 0, y: 0, row: null })
  }

  const applyHeaderFromPlacement = (placement, invoiceDateOverride) => {
    if (!placement) return

    const invoiceDate = invoiceDateOverride || form.invoice_date || new Date().toISOString().slice(0, 10)
    const terms = buildTermsFromPlacement(placement)
    const dueDate = invoiceDate ? addDays(invoiceDate, extractNetDays(terms)) : ''

    setForm((prev) => ({
      ...prev,
      placement_id: String(placement.id),
      client_id: String(placement.client_id),
      region_id: String(placement.region_id),
      client_name: placement.client_name || '',
      region_name: placement.region_name || '',
      currency: resolveInvoiceCurrency(placement, prev.currency),
      invoice_template: placement.region_invoice_template || prev.invoice_template || 'CLASSIC',
      invoice_terms_label: terms,
      due_date: dueDate,
      billing_period_start: prev.billing_period_start || fmtDate(placement.start_date),
      billing_period_end: prev.billing_period_end || fmtDate(placement.end_date),
    }))
  }

  const updateLine = (index, updates) => {
    setForm((prev) => {
      const nextLines = [...prev.line_items]
      nextLines[index] = { ...nextLines[index], ...updates }
      return { ...prev, line_items: nextLines }
    })
  }

  // Switching type is a create-time decision only (the backend rejects a change
  // after creation). Each series has its own number sequence, so pull a fresh
  // preview and clear the fields that belong to the other shape.
  const changeInvoiceType = async (nextType) => {
    if (editing) return
    if (nextType === form.invoice_type) return

    const previewNumber = await fetchPreviewInvoiceNumber(nextType)
    if (nextType === 'INTER_COMPANY') {
      setForm((prev) => ({
        ...prev,
        invoice_type: 'INTER_COMPANY',
        invoice_number: previewNumber || prev.invoice_number,
        placement_id: '',
        client_id: '',
        client_name: '',
        region_id: String(regionFilter || ''),
        region_name: '',
        bill_to_region_id: '',
        line_items: [createBlankLine()],
        tax_lines: [createBlankTax()],
      }))
    } else {
      setForm((prev) => ({
        ...prev,
        invoice_type: 'CLIENT',
        invoice_number: previewNumber || prev.invoice_number,
        bill_to_region_id: '',
        region_id: '',
        region_name: '',
        line_items: [createBlankLine()],
        tax_lines: [createBlankTax()],
      }))
    }
  }

  const onIssuingEntityChange = (regionId) => {
    const region = entitiesById.get(String(regionId))
    setForm((prev) => ({
      ...prev,
      region_id: regionId ? String(regionId) : '',
      region_name: region?.region_name || '',
      // An entity can't invoice itself — drop a bill-to that now collides.
      bill_to_region_id:
        String(prev.bill_to_region_id) === String(regionId) ? '' : prev.bill_to_region_id,
    }))
  }

  const onBillToEntityChange = (regionId) => {
    const region = entitiesById.get(String(regionId))
    // Default the invoice currency to what the counterparty actually settles in;
    // still editable via the Currency select.
    const counterpartyCurrency = String(
      region?.functional_currency || region?.default_currency || '',
    ).toUpperCase()
    setForm((prev) => ({
      ...prev,
      bill_to_region_id: regionId ? String(regionId) : '',
      currency: counterpartyCurrency || prev.currency,
    }))
  }

  const onLinePlacementChange = (index, placementId) => {
    const placement = placementsById.get(String(placementId))
    if (!placement) {
      updateLine(index, createBlankLine())
      return
    }

    if (form.client_id && String(form.client_id) !== String(placement.client_id)) {
      toast.error('All particulars in one invoice must belong to the same client')
      return
    }

    const quantity = getPlacementDefaultQuantity(placement)
    const rate = getPlacementBillRate(placement)
    const nextLine = {
      placement_id: String(placement.id),
      candidate_id: String(placement.candidate_id || ''),
      candidate_name: placement.candidate_name || '',
      job_title: placement.job_title || '',
      activity_label: placement.job_title || placement.candidate_name || 'Professional Services',
      description: buildLineDescription({
        activity_label: placement.job_title || 'Professional Services',
        candidate_name: placement.candidate_name,
        job_title: placement.job_title,
      }),
      quantity: String(quantity),
      rate: String(rate),
      amount: quantity * rate,
      line_date: '',
    }

    updateLine(index, nextLine)

    const isFirstLine = index === 0 && !form.client_id
    if (isFirstLine || String(form.client_id) !== String(placement.client_id)) {
      applyHeaderFromPlacement(placement)
    }

    if (index === 0) {
      setForm((prev) => ({ ...prev, placement_id: String(placement.id) }))
    }
  }

  const addLineItem = () => {
    if (!isIcForm && !form.client_id && form.line_items.some((line) => !line.placement_id)) {
      toast.error('Select the first placement before adding more particulars')
      return
    }
    setForm((prev) => ({ ...prev, line_items: [...prev.line_items, createBlankLine()] }))
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

  const openPlacementDrawer = async (lineIndex) => {
    const today = new Date().toISOString().slice(0, 10)
    setQuickPlacementSaving(false)
    setQuickPlacementLineIndex(lineIndex)
    setQuickPlacementDraft({
      ...BLANK_QUICK_PLACEMENT,
      job_title: form.line_items[lineIndex]?.job_title || '',
      start_date: today,
      currency: form.currency || 'USD',
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
      const detailRes = await api.get(`/placements/${createdId}`)
      const createdPlacement = detailRes.data?.data || createRes.data?.data
      setPlacements((prev) => [createdPlacement, ...prev])
      onLinePlacementChange(quickPlacementLineIndex, String(createdId))
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

  const removeLineItem = (index) => {
    if (form.line_items.length === 1) {
      toast.error('At least one particular is required')
      return
    }

    setForm((prev) => {
      const nextLines = prev.line_items.filter((_, lineIndex) => lineIndex !== index)
      const firstPlacement = placementsById.get(String(nextLines[0]?.placement_id || ''))
      const nextTerms = firstPlacement ? buildTermsFromPlacement(firstPlacement) : prev.invoice_terms_label
      const nextInvoiceDate = prev.invoice_date || ''
      const nextDueDate = nextInvoiceDate && nextTerms ? addDays(nextInvoiceDate, extractNetDays(nextTerms)) : prev.due_date

      return {
        ...prev,
        line_items: nextLines,
        placement_id: nextLines[0]?.placement_id || '',
        client_id: firstPlacement ? String(firstPlacement.client_id) : '',
        region_id: firstPlacement ? String(firstPlacement.region_id) : '',
        client_name: firstPlacement?.client_name || '',
        region_name: firstPlacement?.region_name || '',
        currency: resolveInvoiceCurrency(firstPlacement, prev.currency),
        invoice_template: firstPlacement?.region_invoice_template || prev.invoice_template || 'CLASSIC',
        invoice_terms_label: nextTerms || '',
        due_date: nextDueDate || '',
      }
    })
  }

  const addTaxLine = () => setForm((prev) => ({ ...prev, tax_lines: [...prev.tax_lines, createBlankTax()] }))

  const updateTaxLine = (index, updates) => {
    setForm((prev) => {
      const next = [...prev.tax_lines]
      next[index] = { ...next[index], ...updates }
      return { ...prev, tax_lines: next }
    })
  }

  const removeTaxLine = (index) => {
    setForm((prev) => {
      if (prev.tax_lines.length === 1) return { ...prev, tax_lines: [createBlankTax()] }
      return { ...prev, tax_lines: prev.tax_lines.filter((_, taxIndex) => taxIndex !== index) }
    })
  }

  const refreshDueDateFromTerms = (terms, invoiceDate) => {
    const nextInvoiceDate = invoiceDate || form.invoice_date
    setForm((prev) => ({
      ...prev,
      invoice_terms_label: terms,
      due_date: nextInvoiceDate ? addDays(nextInvoiceDate, extractNetDays(terms)) : '',
    }))
  }

  const buildPayload = () => {
    const isIc = form.invoice_type === 'INTER_COMPANY'

    // Inter-company lines are free-form (no placement/candidate); client lines
    // stay placement-driven exactly as before.
    const lineItems = (form.line_items || []).map((line) => (
      isIc
        ? {
            description: String(line.description || '').trim(),
            activity_label: line.activity_label || null,
            quantity: normalizeNumber(line.quantity),
            rate: normalizeNumber(line.rate),
            line_date: line.line_date || null,
          }
        : {
            placement_id: line.placement_id,
            candidate_id: line.candidate_id || null,
            candidate_name: line.candidate_name || '',
            job_title: line.job_title || '',
            activity_label: line.activity_label || '',
            description: buildLineDescription(line),
            quantity: normalizeNumber(line.quantity),
            rate: normalizeNumber(line.rate),
            line_date: line.line_date || null,
          }
    ))

    // Inter-company invoices are zero-rated; never send tax lines.
    const taxLines = isIc
      ? []
      : amounts.computedTaxes.map((line) => ({
          tax_name: line.tax_name,
          tax_percent: normalizeNumber(line.tax_percent),
        }))

    return {
      invoice_number: String(form.invoice_number || '').trim(),
      invoice_type: form.invoice_type,
      bill_to_region_id: isIc && form.bill_to_region_id ? Number(form.bill_to_region_id) : null,
      placement_id: isIc ? null : form.placement_id ? Number(form.placement_id) : null,
      client_id: isIc ? null : form.client_id ? Number(form.client_id) : null,
      region_id: form.region_id ? Number(form.region_id) : null,
      invoice_date: normalizeDateForApi(form.invoice_date),
      due_date: normalizeDateForApi(form.due_date),
      billing_period_start: normalizeDateForApi(form.billing_period_start) || null,
      billing_period_end: normalizeDateForApi(form.billing_period_end) || null,
      currency: form.currency,
      invoice_status: form.invoice_status,
      invoice_template: form.invoice_template || 'CLASSIC',
      invoice_terms_label: form.invoice_terms_label || null,
      customer_message: form.customer_message || null,
      internal_notes: form.internal_notes || null,
      notes: form.notes || null,
      line_items: lineItems,
      tax_lines: taxLines,
    }
  }

  const save = async ({ thenEmail = false } = {}) => {
    if (!form.invoice_date) {
      toast.error('Invoice date is required')
      return
    }

    // Terms drive the client due-date auto-fill; an inter-company invoice sets
    // its due date directly, so terms aren't required there.
    if (!isIcForm && !form.invoice_terms_label?.trim()) {
      toast.error('Invoice terms / net terms is required')
      return
    }

    if (!form.due_date) {
      toast.error('Due date is required')
      return
    }

    if (isIcForm) {
      if (!form.region_id) {
        toast.error('Issuing entity is required')
        return
      }
      if (!form.bill_to_region_id) {
        toast.error('Bill-to entity is required')
        return
      }
      if (String(form.region_id) === String(form.bill_to_region_id)) {
        toast.error('An entity cannot invoice itself')
        return
      }
      if (
        !(form.line_items || []).length ||
        form.line_items.some(
          (line) => !String(line.description || '').trim() || normalizeNumber(line.quantity) <= 0,
        )
      ) {
        toast.error('Each particular needs a description and a quantity greater than 0')
        return
      }
    } else if (!(form.line_items || []).length || form.line_items.some((line) => !line.placement_id)) {
      toast.error('Please select placement for all particulars')
      return
    }

    if (!String(form.invoice_number || '').trim()) {
      toast.error('Invoice number is required')
      return
    }

    // Inter-company invoices carry no approved timesheet, so don't force one.
    if (!editing && !isIcForm && invoiceFiles.length === 0) {
      toast.error('Please attach the approved timesheet (at least one document)')
      return
    }

    setSaving(true)
    try {
      const payload = buildPayload()
      let response
      if (editing) {
        response = await api.put(`/invoices/${editing.id}`, payload)
      } else {
        response = await api.post('/invoices', payload)
      }
      const savedInvoice = response?.data?.data
      const savedId = savedInvoice?.id || editing?.id

      // Upload any newly-attached approved timesheets to the saved invoice.
      if (savedId && invoiceFiles.length) {
        try {
          await uploadPendingAttachments('invoice', savedId, invoiceFiles)
        } catch (uploadError) {
          toast.error('Invoice saved, but document upload failed. Open the invoice to retry.')
        }
      }
      setInvoiceFiles([])

      toast.success(`Invoice ${editing ? 'updated' : 'created'} successfully`)
      setModal(false)
      if (thenEmail && savedId) {
        setEmailFor({ id: savedId, invoice_number: form.invoice_number || '' })
      }
      await load()
      if (savedId) {
        setRows((prevRows) => prevRows.map((row) => (
          Number(row.id) === Number(savedId)
            ? {
                ...row,
                ...savedInvoice,
                invoice_date: payload.invoice_date,
                due_date: payload.due_date,
                billing_period_start: payload.billing_period_start,
                billing_period_end: payload.billing_period_end,
              }
            : row
        )))
      }
    } catch (error) {
      toast.error(error.response?.data?.message || 'Failed to save invoice')
    } finally {
      setSaving(false)
    }
  }

  const handlePdf = async (id, number) => {
    try {
      await downloadFile(`/api/invoices/${id}/pdf`, `Invoice ${number}.pdf`)
      toast.success('Invoice PDF downloaded')
    } catch {
      toast.error('Failed to download invoice PDF')
    }
  }

  const openActionMenu = (event, row) => {
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()

    if (actionMenu.open && String(actionMenu.row?.id) === String(row.id)) {
      setActionMenu({ open: false, x: 0, y: 0, row: null })
      return
    }

    const menuWidth = 220
    // View + Edit + Download PDF, plus whatever this row and role allow.
    const itemCount = 3 + (canDeleteInvoices ? 1 : 0) + (canReceivePaymentFor(row) ? 2 : 0)
    const menuHeight = itemCount * 36 + 12
    const viewportPadding = 12
    const left = Math.min(
      Math.max(rect.right - menuWidth, viewportPadding),
      window.innerWidth - menuWidth - viewportPadding,
    )
    const hasSpaceBelow = rect.bottom + menuHeight + viewportPadding < window.innerHeight
    const top = hasSpaceBelow
      ? rect.bottom + 8
      : Math.max(rect.top - menuHeight - 8, viewportPadding)

    setActionMenu({
      open: true,
      x: left,
      y: top,
      row,
    })
  }

  const updateStatus = async (row, nextStatus, extra = {}) => {
    setStatusLoading(true)
    try {
      await api.patch(`/invoices/${row.id}/status`, {
        status: nextStatus,
        ...extra,
      })
      toast.success(`Invoice status changed to ${nextStatus.replace(/_/g, ' ')}`)
      setPaidModal({ open: false, row: null })
      setPartialModal({ open: false, row: null })
      setStatusConfirm({ open: false, row: null, status: '' })
      setPartialAmount('')
      setStatusTdsApplicable('')
      setStatusTdsPercent('')
      setPaidDate('')
      await load()
    } catch (error) {
      toast.error(error.response?.data?.message || 'Failed to update status')
    } finally {
      setStatusLoading(false)
    }
  }

  const openStatusMenu = (event, row) => {
    event.stopPropagation()
    if (!canManageInvoices) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (statusMenu.open && String(statusMenu.row?.id) === String(row.id)) {
      setStatusMenu({ open: false, x: 0, y: 0, row: null })
      return
    }
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
    setStatusMenu({ open: true, x: left, y: top, row })
  }

  const handleStatusSelection = (row, nextStatus) => {
    if (!row) return

    // '' means "unanswered" and blocks the save. A region without TDS is never
    // asked, so answer it up front rather than leaving the dialog unsubmittable.
    const initialTds = tdsAppliesTo(row) ? '' : false

    if (nextStatus === 'PARTIALLY_PAID') {
      setPartialAmount('')
      setStatusTdsApplicable(initialTds)
      setStatusTdsPercent('')
      setPartialModal({ open: true, row })
      return
    }

    if (nextStatus === 'PAID') {
      setStatusTdsApplicable(initialTds)
      setStatusTdsPercent('')
      setPaidDate(toDateKey(new Date()))
      setPaidModal({ open: true, row })
      return
    }

    if (
      ['PAID', 'PARTIALLY_PAID'].includes(String(row.invoice_status || '').toUpperCase()) &&
      ['OVERDUE', 'GENERATED', 'SENT'].includes(nextStatus)
    ) {
      setStatusConfirm({ open: true, row, status: nextStatus })
      return
    }

    updateStatus(row, nextStatus)
  }

  const statusTdsPercentNumber = normalizeNumber(statusTdsPercent)
  // Both checks pass vacuously for a region that doesn't withhold TDS, so its
  // payment dialog isn't blocked on a question it never asked.
  const hasTdsSelectionFor = (row) =>
    !tdsAppliesTo(row) || statusTdsApplicable === true || statusTdsApplicable === false
  const hasValidTdsPercentFor = (row) =>
    !tdsAppliesTo(row) || statusTdsApplicable !== true || statusTdsPercentNumber > 0
  const todayKey = toDateKey(new Date())
  // A payment can be backdated but not booked into the future. The round-trip
  // rejects impossible dates, which JS otherwise rolls forward (2026-02-31).
  const hasValidPaidDate = isRealDateKey(paidDate) && paidDate <= todayKey
  const getStatusTdsAmount = (row) => {
    if (statusTdsApplicable !== true) return 0
    return (normalizeNumber(row?.subtotal) * statusTdsPercentNumber) / 100
  }

  const closePaidModal = () => {
    if (statusLoading) return
    setPaidModal({ open: false, row: null })
    setStatusTdsApplicable('')
    setStatusTdsPercent('')
    setPaidDate('')
  }

  const closePartialModal = () => {
    if (statusLoading) return
    setPartialModal({ open: false, row: null })
    setPartialAmount('')
    setStatusTdsApplicable('')
    setStatusTdsPercent('')
  }

  const confirmPaidPayment = () => {
    if (!paidModal.row) return
    if (!hasTdsSelectionFor(paidModal.row)) {
      toast.error('Select whether TDS is paid')
      return
    }
    if (!hasValidTdsPercentFor(paidModal.row)) {
      toast.error('Enter TDS percentage')
      return
    }
    if (!hasValidPaidDate) {
      toast.error('Select a valid payment date')
      return
    }
    const tdsApplicable = tdsAppliesTo(paidModal.row) && statusTdsApplicable === true
    updateStatus(paidModal.row, 'PAID', {
      tds_applicable: tdsApplicable,
      tds_percent: tdsApplicable ? statusTdsPercentNumber : null,
      payment_date: paidDate,
    })
  }

  const confirmPartialPayment = () => {
    const amount = normalizeNumber(partialAmount)
    if (amount <= 0) {
      toast.error('Enter a valid partial payment amount')
      return
    }
    if (!partialModal.row) return
    if (!hasTdsSelectionFor(partialModal.row)) {
      toast.error('Select whether TDS is paid')
      return
    }
    if (!hasValidTdsPercentFor(partialModal.row)) {
      toast.error('Enter TDS percentage')
      return
    }
    const tdsApplicable = tdsAppliesTo(partialModal.row) && statusTdsApplicable === true
    updateStatus(partialModal.row, 'PARTIALLY_PAID', {
      amount_received: amount,
      tds_applicable: tdsApplicable,
      tds_percent: tdsApplicable ? statusTdsPercentNumber : null,
    })
  }

  const confirmDelete = async () => {
    if (!deleting) return
    setDeleteLoading(true)
    try {
      await api.delete(`/invoices/${deleting.id}`)
      toast.success('Invoice deleted successfully')
      setDeleting(null)
      setActionMenu({ open: false, x: 0, y: 0, row: null })
      await load()
    } catch (error) {
      toast.error(error.response?.data?.message || 'Failed to delete invoice')
    } finally {
      setDeleteLoading(false)
    }
  }

  const showClientBlock = true
  const showInvoiceMeta = true
  const showLineItems = true
  const showTaxSummary = true
  const showNotes = true
  const showTotals = true
  const totalTiles = [
    ['Subtotal', fmt(amounts.subtotal, form.currency)],
    ['Tax', fmt(amounts.taxAmount, form.currency)],
    ['Total', fmt(amounts.total, form.currency)],
  ].filter(Boolean)

  // Count of filters that deviate from the default view.
  const activeFilterCount = [
    search.trim(),
    statusFilter,
    scopeFilter,
    clientFilter,
    datePreset !== 'all' ? 'date' : '',
  ].filter(Boolean).length

  // Segmented-tab counts come from the backend (`tab_counts`), computed over the
  // full filtered set (search + client + region + date, minus the status/scope
  // the tabs toggle), so they're correct across every page. Fall back to a
  // page-local count only if an older API omits them.
  const tabCounts = tabCountsData || rows.reduce((acc, row) => {
    const needle = search.trim().toLowerCase()
    const matchSearch = !needle || [row.invoice_number, row.client_name, row.candidate_name, row.region_name]
      .filter(Boolean).some((value) => String(value).toLowerCase().includes(needle))
    const matchClient = !clientFilter || String(row.client_id) === String(clientFilter)
    const matchRegion = !regionFilter || String(row.region_id) === String(regionFilter)
    const matchDateRange = (!dateFrom && !dateTo) || isDateInRange(row.due_date, dateFrom, dateTo)
    if (!(matchSearch && matchClient && matchRegion && matchDateRange)) return acc
    const display = getInvoiceDisplayStatus(row)
    acc.all += 1
    if (display === 'SENT' || display === 'GENERATED') acc.sent += 1
    if (display === 'OVERDUE') acc.overdue += 1
    if (display === 'PAID') acc.paid += 1
    return acc
  }, { all: 0, sent: 0, overdue: 0, paid: 0 })
  const panelTabs = [
    { key: 'all', label: 'All', count: tabCounts.all },
    { key: 'sent', label: 'Sent', count: tabCounts.sent },
    { key: 'overdue', label: 'Overdue', count: tabCounts.overdue },
    { key: 'paid', label: 'Paid', count: tabCounts.paid },
  ]
  const activeTab = scopeFilter === 'overdue'
    ? 'overdue'
    : scopeFilter === 'sent'
      ? 'sent'
      : statusFilter === 'PAID'
        ? 'paid'
        : (statusFilter === 'SENT' || statusFilter === 'GENERATED')
          ? 'sent'
          : 'all'
  const handlePanelTab = (key) => {
    setScopeFilter(key === 'overdue' ? 'overdue' : key === 'sent' ? 'sent' : '')
    setStatusFilter(key === 'paid' ? 'PAID' : '')
    setPage(1)
  }

  const resetFilters = () => {
    const range = getPresetRange('all')
    setSearch('')
    setStatusFilter('')
    setScopeFilter('')
    setCurrencyFilter('')
    setClientFilter('')
    setDatePreset('all')
    setDateFrom(range.from)
    setDateTo(range.to)
    setPage(1)
    navigate('/invoices', { replace: true })
  }

  const invoiceColumns = [
    {
      key: 'invoice_number', header: 'Invoice #', primary: true, mono: true, width: 170,
      render: (row) => (
        <button
          type="button"
          className="inv-number-btn"
          onClick={() => openView(row)}
          title={`View invoice ${row.invoice_number}`}
        >
          {row.invoice_number}
        </button>
      ),
    },
    {
      key: 'client', header: customerLabel(), width: 220,
      sortAccessor: (row) => String(row.client_name || '').toLowerCase(),
      render: (row) => (
        <div className="inv-cellstack">
          <span className="inv-cell-main">
            {row.client_id
              ? <Link className="inv-cell-link" to={`/clients/${row.client_id}`}>{row.client_name}</Link>
              : (row.client_name || '—')}
          </span>
          <span className="inv-cell-sub">{row.region_name || 'No region'}</span>
        </div>
      ),
    },
    {
      key: 'invoice_date', header: 'Issue date', mono: true, width: 120,
      render: (row) => fmtDateDisplay(row.invoice_date),
    },
    {
      key: 'due_date', header: 'Due date', mono: true, width: 120,
      render: (row) => {
        const display = getInvoiceDisplayStatus(row)
        return <span className={display === 'OVERDUE' ? 'inv-danger' : undefined}>{fmtDateDisplay(row.due_date)}</span>
      },
    },
    {
      key: 'status', header: 'Status', width: 130,
      // Sort by urgency: signed days-to-due (most overdue first, then soonest
      // due, then later; closed/no-due-date rows have null and sort last).
      sortAccessor: (row) => getInvoiceDueInfo(row).diffDays,
      render: (row) => {
        const info = getInvoiceDueInfo(row)
        const chip = <StatusChip tone={statusChipTone(info.key)}>{info.label}</StatusChip>
        if (!canManageInvoices) return chip
        const isOpen = statusMenu.open && String(statusMenu.row?.id) === String(row.id)
        return (
          <button
            type="button"
            className={`inv-status-btn${isOpen ? ' is-open' : ''}`}
            onClick={(e) => openStatusMenu(e, row)}
            title="Change status"
          >
            {chip}
            <span className="inv-status-caret" aria-hidden="true">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
            </span>
          </button>
        )
      },
    },
    {
      key: 'total_amount', header: 'Amount', align: 'right', mono: true, width: 130,
      render: (row) => fmt(row.total_amount, row.currency),
    },
    {
      key: 'payment_received_amount', header: 'Received', align: 'right', mono: true, width: 130,
      render: (row) => <span className="inv-success-fig">{fmt(row.payment_received_amount, row.currency)}</span>,
    },
    {
      key: 'balance_outstanding', header: 'Balance', align: 'right', mono: true, width: 130,
      render: (row) => {
        const outstanding = normalizeNumber(row.balance_outstanding) > 0
        return <span className={outstanding ? 'inv-danger' : 'inv-success-fig'}>{fmt(row.balance_outstanding, row.currency)}</span>
      },
    },
    {
      key: 'actions', header: '', align: 'right', width: 52,
      render: (row) => (canManageInvoices ? (
        <button
          className="inv-kebab"
          type="button"
          onClick={(event) => openActionMenu(event, row)}
          aria-label={`Open actions for invoice ${row.invoice_number}`}
        >
          <span aria-hidden="true">•••</span>
        </button>
      ) : null),
    },
  ]

  const invoiceFooter = [
    { colSpan: 5, align: 'left', render: () => (
      <span className="inv-foot-note">{sortedRows.length} of {total} invoices{invoiceStats.isRegionScoped ? '' : ' · converted to USD'}</span>
    ) },
    { align: 'right', mono: true, render: () => statValue(invoiceStats.totalAmount, invoiceStats.totalAmountFn) },
    { align: 'right', mono: true, render: () => statValue(invoiceStats.paidAmount, invoiceStats.paidAmountFn) },
    { align: 'right', mono: true, render: () => statValue(invoiceStats.dueAmount, invoiceStats.dueAmountFn) },
    { render: () => null },
  ]

  return (
    <div className="dashboard-page invoices-page invoices-refresh">
      <div className="inv-header">
        <div className="inv-head-lead">
          <button type="button" className="inv-back" onClick={() => navigate(-1)} aria-label="Go back">
            <IconBack />
          </button>
          <div>
            <div className="inv-title">Invoices</div>
            <div className="inv-subtitle">
              Create invoices with multiple particulars, flexible taxes and payment-linked statuses.
            </div>
          </div>
        </div>
        <div className="inv-actions">
          <button
            type="button"
            className={`inv-iconbtn${filtersOpen ? ' is-active' : ''}`}
            onClick={() => setFiltersOpen((open) => !open)}
            aria-label="Toggle filters"
            title="Toggle filters"
          >
            <IconFilter />
          </button>
          <button
            type="button"
            className="secondary-btn"
            onClick={exportXlsx}
            disabled={exporting || filtered.length === 0}
            title="Download the filtered invoices as Excel"
          >
            {exporting ? 'Exporting…' : 'Export'}
          </button>
          {canManageInvoices ? <button className="primary-btn" onClick={openCreate}>+ New invoice</button> : null}
        </div>
      </div>

      <div className="inv-kpis">
        <StatCard
          label={statLabel('Invoiced')}
          value={statValue(invoiceStats.totalAmount, invoiceStats.totalAmountFn)}
          sub="All invoice totals in current scope"
        />
        <StatCard
          label={statLabel('Outstanding')}
          value={statValue(invoiceStats.dueAmount, invoiceStats.dueAmountFn)}
          sub="Receivables still open"
          accent
        />
        <StatCard
          label={statLabel('Overdue')}
          value={statValue(invoiceStats.overdueAmount, invoiceStats.overdueAmountFn)}
          sub="Past due receivables"
        />
        <StatCard
          label={statLabel('Received')}
          value={statValue(invoiceStats.paidAmount, invoiceStats.paidAmountFn)}
          sub="Collected against invoices"
        />
      </div>

      {filtersOpen ? (
        <div className="inv-filters">
          <span className="inv-activefilters">
            Active filters
            <span className="inv-count">{activeFilterCount}</span>
          </span>
          <input
            className="inv-search"
            placeholder="Search invoice #, client, candidate…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <FilterSelect
            label="Status"
            value={statusFilter}
            display={statusFilter ? statusFilter.replace(/_/g, ' ') : 'All'}
            active={Boolean(statusFilter)}
            onChange={(event) => { setStatusFilter(event.target.value); setPage(1) }}
          >
            <option value="">All Status</option>
            {STATUS_FILTER_OPTIONS.map((status) => (
              <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>
            ))}
          </FilterSelect>
          <FilterSelect
            label="Scope"
            value={scopeFilter}
            display={scopeFilter ? scopeFilter.charAt(0).toUpperCase() + scopeFilter.slice(1) : 'All'}
            active={Boolean(scopeFilter)}
            onChange={(event) => { setScopeFilter(event.target.value); setPage(1) }}
          >
            <option value="">All Scopes</option>
            <option value="sent">Sent</option>
            <option value="outstanding">Outstanding</option>
            <option value="overdue">Overdue</option>
            <option value="collected">Collected</option>
          </FilterSelect>
          <FilterSelect
            label="Currency"
            value={currencyFilter}
            display={currencyFilter ? `${currencySymbol(currencyFilter)} ${currencyFilter}` : 'All'}
            active={Boolean(currencyFilter)}
            onChange={(event) => selectCurrency(event.target.value)}
          >
            <option value="">All Currencies</option>
            {visibleCurrencies.map((code) => (
              <option key={code} value={code}>{currencySymbol(code)} {code}</option>
            ))}
          </FilterSelect>
          <FilterSelect
            label="Dates"
            value={datePreset}
            display={DATE_PRESETS.find((p) => p.value === datePreset)?.label || 'All Time'}
            active={datePreset !== 'all'}
            ariaLabel="Invoice date range"
            onChange={(event) => applyDatePreset(event.target.value)}
          >
            {DATE_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>{preset.label}</option>
            ))}
          </FilterSelect>
          {datePreset === 'custom' ? (
            <>
              <input
                className="inv-date"
                type="date"
                value={dateFrom}
                aria-label="Due date from"
                onChange={(event) => { setDateFrom(event.target.value); setPage(1) }}
              />
              <input
                className="inv-date"
                type="date"
                value={dateTo}
                aria-label="Due date to"
                min={dateFrom || undefined}
                onChange={(event) => { setDateTo(event.target.value); setPage(1) }}
              />
            </>
          ) : null}
          <button type="button" className="inv-reset" onClick={resetFilters}>Reset</button>
          <span className="inv-count-muted">{filtered.length} invoices</span>
        </div>
      ) : null}

      <div className="inv-panel">
        <PanelHeader
          title="Invoices"
          tabs={panelTabs}
          activeTab={activeTab}
          onTab={handlePanelTab}
          actions={(
            <button
              type="button"
              className="inv-iconbtn"
              onClick={exportXlsx}
              disabled={exporting || filtered.length === 0}
              aria-label="Export invoices"
              title="Export invoices"
            >
              <IconDownload />
            </button>
          )}
        />
        <DataTable
          columns={invoiceColumns}
          rows={sortedRows}
          getRowId={(row) => row.id}
          subLine={(row) => row.candidate_name || 'Multiple candidates'}
          loading={loading}
          empty="No invoices found"
          footer={sortedRows.length ? invoiceFooter : undefined}
        />
        {total > 0 && (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={setPage}
            onPageSizeChange={(size) => { setPageSize(size); setPage(1) }}
            label="invoices"
          />
        )}
      </div>

      <Modal
        open={modal}
        onClose={() => !saving && setModal(false)}
        title={editing ? `Edit Invoice ${form.invoice_number}` : (isIcForm ? 'New Inter-Company Invoice' : 'New Invoice')}
        maxWidth={1080}
        modalClassName="invoices-modal-card"
        footer={(
          <div className="invoices-modal-actions">
            <button className="secondary-btn" onClick={() => setModal(false)} disabled={saving}>
              Cancel
            </button>
            {!isIcForm && (
              <button className="secondary-btn" onClick={() => save({ thenEmail: true })} disabled={saving}>
                {saving ? 'Saving...' : 'Save & Email'}
              </button>
            )}
            <button className="primary-btn" onClick={() => save()} disabled={saving}>
              {saving ? 'Saving...' : 'Save Invoice'}
            </button>
          </div>
        )}
      >
        <div className="form-grid cols-3">
          {showInvoiceMeta && (
            <>
              <Select
                label="Invoice Type"
                value={form.invoice_type}
                disabled={!!editing}
                onChange={(event) => { void changeInvoiceType(event.target.value) }}
                hint={editing
                  ? 'Type is fixed after creation. Cancel and raise a new invoice to change it.'
                  : 'Inter-company invoices bill another entity — no client or placement.'}
              >
                <option value="CLIENT">Client Invoice</option>
                <option value="INTER_COMPANY">Inter-Company Invoice</option>
              </Select>
              <Input
                label="Invoice Number"
                required
                value={form.invoice_number}
                onChange={(event) => handleInvoiceNumberChange(event.target.value)}
                placeholder="Auto-generated preview"
                hint="Backend will always validate final uniqueness"
              />
              <Input
                label="Invoice Date"
                required
                type="date"
                value={form.invoice_date}
                onChange={(event) => handleInvoiceDateChange(event.target.value)}
              />
              <Input
                label="Due Date"
                required
                type="date"
                value={form.due_date}
                onChange={(event) => setFormValue('due_date', event.target.value)}
              />

              <Input
                label="Invoice Terms / Net Terms"
                value={form.invoice_terms_label}
                onChange={(event) => refreshDueDateFromTerms(event.target.value, form.invoice_date)}
                placeholder="e.g. Net 15, Net 30, Due on Receipt"
              />
              <Input
                label="Billing Period Start"
                type="date"
                value={form.billing_period_start}
                onChange={(event) => setFormValue('billing_period_start', event.target.value)}
              />
              <Input
                label="Billing Period End"
                type="date"
                value={form.billing_period_end}
                onChange={(event) => setFormValue('billing_period_end', event.target.value)}
              />

              <Select
                label="Invoice Status"
                value={form.invoice_status}
                onChange={(event) => setFormValue('invoice_status', event.target.value)}
              >
                {STATUS_OPTIONS.map((status) => (
                  <option key={status} value={status}>
                    {status.replace(/_/g, ' ')}
                  </option>
                ))}
              </Select>
            </>
          )}

          {showClientBlock && (
            isIcForm ? (
              <>
                <SearchableSelect
                  label="Issuing Entity"
                  required
                  value={form.region_id}
                  options={entityOptions}
                  placeholder="Select issuing entity..."
                  emptyMessage="No entities available"
                  onChange={(event) => onIssuingEntityChange(event.target.value)}
                />
                <SearchableSelect
                  label="Bill-To Entity"
                  required
                  value={form.bill_to_region_id}
                  options={entityOptions.filter((option) => option.value !== String(form.region_id))}
                  placeholder="Select counterparty entity..."
                  emptyMessage="No entities available"
                  onChange={(event) => onBillToEntityChange(event.target.value)}
                />
                <Select
                  label="Currency"
                  value={form.currency}
                  onChange={(event) => setFormValue('currency', event.target.value.toUpperCase())}
                  hint="Defaults to the counterparty's settlement currency. Inter-company invoices are zero-rated."
                >
                  {SUPPORTED_INVOICE_CURRENCIES.map((currency) => (
                    <option key={currency} value={currency}>{currency}</option>
                  ))}
                </Select>
              </>
            ) : (
              <>
                <Input label={customerLabel()} value={form.client_name} readOnly />
                <Input label="Region" value={form.region_name} readOnly />
                <Select
                  label="Currency"
                  value={form.currency}
                  onChange={(event) => setFormValue('currency', event.target.value.toUpperCase())}
                  hint="Auto selected from the client/region currency. All particulars in an invoice must stay in one currency."
                >
                  {SUPPORTED_INVOICE_CURRENCIES.map((currency) => (
                    <option key={currency} value={currency}>{currency}</option>
                  ))}
                </Select>
              </>
            )
          )}

          {showLineItems && (
            <div
              className="span-3"
              style={{
                background: 'var(--surface2)',
                border: '1px solid var(--border)',
                borderRadius: 12,
                padding: 16,
              }}
            >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontWeight: 800, color: 'var(--text)' }}>Invoice Particulars</div>
              <button className="btn btn-sm btn-primary" type="button" onClick={addLineItem}>
                + Add Particular
              </button>
            </div>

            <div style={{ display: 'grid', gap: 12 }}>
              {(form.line_items || []).map((line, index) => (
                <div
                  key={`line-${index}`}
                  style={{
                    border: '1px solid var(--border)',
                    background: 'var(--surface)',
                    borderRadius: 12,
                    padding: 14,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <div style={{ fontWeight: 700, color: 'var(--text)' }}>Particular {index + 1}</div>
                    <button className="btn btn-sm btn-ghost" type="button" onClick={() => removeLineItem(index)}>
                      Remove
                    </button>
                  </div>

                  <div className="form-grid cols-3">
                    {isIcForm ? (
                      <>
                        <Input
                          label="Description"
                          required
                          value={line.description}
                          onChange={(event) => updateLine(index, { description: event.target.value })}
                          placeholder="e.g. Management fee — Q2 FY26"
                        />
                        <Input
                          label="Reference / Particular"
                          value={line.activity_label}
                          onChange={(event) => updateLine(index, { activity_label: event.target.value })}
                          placeholder="Optional"
                        />
                        <Input
                          label="Line Date"
                          type="date"
                          value={line.line_date}
                          onChange={(event) => updateLine(index, { line_date: event.target.value })}
                        />
                        <Input
                          label="Qty / Units"
                          type="number"
                          value={line.quantity}
                          onChange={(event) => updateLine(index, { quantity: event.target.value })}
                        />
                        <Input
                          label="Rate"
                          type="number"
                          value={line.rate}
                          onChange={(event) => updateLine(index, { rate: event.target.value })}
                        />
                        <Input
                          label="Line Amount"
                          value={fmt(normalizeNumber(line.quantity) * normalizeNumber(line.rate), form.currency)}
                          readOnly
                        />
                      </>
                    ) : (
                      <>
                        <SearchableSelect
                          label="Placement"
                          required
                          value={line.placement_id}
                          options={allowedPlacementOptions}
                          placeholder="Search placement..."
                          emptyMessage="No placements found"
                          createLabel="+ Add placement"
                          onChange={(event) => onLinePlacementChange(index, event.target.value)}
                          onCreate={() => { void openPlacementDrawer(index) }}
                        />
                        <Input label="Candidate" value={line.candidate_name} readOnly />
                        <Input label="Job Title" value={line.job_title} readOnly />

                        <Input
                          label="Activity / Particular"
                          value={line.activity_label}
                          onChange={(event) =>
                            updateLine(index, {
                              activity_label: event.target.value,
                              description: buildLineDescription({ ...line, activity_label: event.target.value }),
                            })
                          }
                        />
                        <Input
                          label="Line Date"
                          type="date"
                          value={line.line_date}
                          onChange={(event) =>
                            updateLine(index, {
                              line_date: event.target.value,
                              description: buildLineDescription({ ...line, line_date: event.target.value }),
                            })
                          }
                        />
                        <Input
                          label="Description"
                          value={line.description}
                          onChange={(event) => updateLine(index, { description: event.target.value })}
                        />

                        <Input
                          label="Qty / Hours / Units"
                          type="number"
                          value={line.quantity}
                          onChange={(event) => updateLine(index, { quantity: event.target.value })}
                        />
                        <Input
                          label="Rate"
                          type="number"
                          value={line.rate}
                          onChange={(event) => updateLine(index, { rate: event.target.value })}
                        />
                        <Input
                          label="Line Amount"
                          value={fmt(normalizeNumber(line.quantity) * normalizeNumber(line.rate), form.currency)}
                          readOnly
                        />
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
            </div>
          )}

          {showTaxSummary && !isIcForm && (
            <div
              className="span-3"
              style={{
                background: 'var(--surface2)',
                border: '1px solid var(--border)',
                borderRadius: 12,
                padding: 16,
              }}
            >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ fontWeight: 800, color: 'var(--text)' }}>Tax Lines</div>
              <button className="btn btn-sm btn-primary" type="button" onClick={addTaxLine}>
                + Add Tax
              </button>
            </div>

            <div style={{ display: 'grid', gap: 12 }}>
              {(form.tax_lines || []).map((tax, index) => (
                <div
                  key={`tax-${index}`}
                  className="form-grid cols-3"
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    padding: 12,
                    background: 'var(--surface)',
                  }}
                >
                  <Input
                    label="Tax Name"
                    value={tax.tax_name}
                    onChange={(event) => updateTaxLine(index, { tax_name: event.target.value })}
                    placeholder="e.g. CGST, SGST, IGST"
                  />
                  <Input
                    label="Tax %"
                    type="number"
                    value={tax.tax_percent}
                    onChange={(event) => updateTaxLine(index, { tax_percent: event.target.value })}
                  />
                  <div>
                    <Input
                      label="Tax Amount"
                      value={fmt((amounts.subtotal * normalizeNumber(tax.tax_percent)) / 100, form.currency)}
                      readOnly
                    />
                    <div style={{ marginTop: 8 }}>
                      <button className="btn btn-sm btn-ghost" type="button" onClick={() => removeTaxLine(index)}>
                        Remove Tax
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            </div>
          )}

          {showTotals && (
            <div
              className="span-3"
              style={{
                background: 'var(--surface2)',
                borderRadius: 12,
                padding: 16,
                border: '1px solid var(--border)',
              }}
            >
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(totalTiles.length, 1)}, 1fr)`, gap: 16, textAlign: 'center' }}>
              {totalTiles.map(([label, value]) => (
                <div key={label}>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--text3)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                    }}
                  >
                    {label}
                  </div>
                  <div
                    style={{
                      fontSize: 18,
                      fontWeight: 800,
                      color: label === 'Total' ? 'var(--primary)' : 'var(--text)',
                      marginTop: 4,
                    }}
                  >
                    {value}
                  </div>
                </div>
              ))}
            </div>
            </div>
          )}

          {showNotes && (
            <>
              <div className="span-3">
                <Textarea
                  label="Customer Message"
                  value={form.customer_message}
                  onChange={(event) => setFormValue('customer_message', event.target.value)}
                  rows={2}
                />
              </div>
              <div className="span-3">
                <Textarea
                  label="Internal Notes"
                  value={form.internal_notes}
                  onChange={(event) => setFormValue('internal_notes', event.target.value)}
                  rows={3}
                />
              </div>
              <div className="span-3">
                <Textarea
                  label="General Notes"
                  value={form.notes}
                  onChange={(event) => setFormValue('notes', event.target.value)}
                  rows={2}
                />
              </div>
            </>
          )}

          <div className="span-3">
            <AttachmentsField
              entityType="invoice"
              entityId={editing?.id || null}
              pendingFiles={invoiceFiles}
              onPendingChange={setInvoiceFiles}
              label="Approved timesheet"
              hint="Client-approved timesheet(s) for this invoice — PDF, image, Excel or Word. Required."
              required
            />
          </div>
        </div>
      </Modal>

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
            {BILLING_TYPES.map((b) => (
              <option key={b.value} value={b.value}>{b.label}</option>
            ))}
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

      <InvoiceViewModal
        invoiceId={viewInvoiceId}
        onClose={() => setViewInvoiceId(null)}
        canEdit={canManageInvoices}
        onEdit={(inv) => { setViewInvoiceId(null); openEdit(inv) }}
      />


      <Modal
        open={paidModal.open}
        onClose={closePaidModal}
        title="Mark Invoice Paid"
        maxWidth={500}
        modalClassName="invoices-modal-card"
        footer={(
          <div className="invoices-modal-actions">
            <button
              className="secondary-btn"
              onClick={closePaidModal}
              disabled={statusLoading}
            >
              Cancel
            </button>
            <button
              className="primary-btn"
              onClick={confirmPaidPayment}
              disabled={
                statusLoading ||
                !hasTdsSelectionFor(paidModal.row) ||
                !hasValidTdsPercentFor(paidModal.row) ||
                !hasValidPaidDate
              }
            >
              {statusLoading ? 'Saving...' : 'Mark as Paid'}
            </button>
          </div>
        )}
      >
        <div className="status-payment-summary">
          <div>
            <span>Invoice</span>
            <strong>{paidModal.row?.invoice_number || '-'}</strong>
          </div>
          <div>
            <span>Outstanding</span>
            <strong>{paidModal.row ? fmt(paidModal.row.balance_outstanding, paidModal.row.currency) : '-'}</strong>
          </div>
        </div>

        <div className="status-tds-calculation">
          <Input
            label="Payment Date"
            type="date"
            value={paidDate}
            max={todayKey}
            onChange={(event) => setPaidDate(event.target.value)}
            hint="Date the payment was actually received."
          />
        </div>

        {tdsAppliesTo(paidModal.row) ? (
          <>
            <div className="status-tds-panel">
              <div>
                <strong>TDS paid?</strong>
                <small>Select Yes or No before marking this invoice paid.</small>
              </div>
              <div className="status-tds-options" role="radiogroup" aria-label="TDS paid">
                <label>
                  <input
                    type="radio"
                    name="paid_status_tds"
                    checked={statusTdsApplicable === true}
                    onChange={() => setStatusTdsApplicable(true)}
                  />
                  <span>Yes</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="paid_status_tds"
                    checked={statusTdsApplicable === false}
                    onChange={() => {
                      setStatusTdsApplicable(false)
                      setStatusTdsPercent('')
                    }}
                  />
                  <span>No</span>
                </label>
              </div>
            </div>

            {statusTdsApplicable === true ? (
              <div className="status-tds-calculation">
                <Input
                  label="TDS Percentage"
                  type="number"
                  min="0"
                  step="0.01"
                  value={statusTdsPercent}
                  onChange={(event) => setStatusTdsPercent(event.target.value)}
                />
                <Input
                  label="TDS Amount"
                  value={fmt(getStatusTdsAmount(paidModal.row), paidModal.row?.currency)}
                  readOnly
                  hint="Calculated from invoice principal before tax."
                />
              </div>
            ) : null}
          </>
        ) : null}
      </Modal>

      <Modal
        open={partialModal.open}
        onClose={closePartialModal}
        title="Add Partial Payment"
        maxWidth={500}
        modalClassName="invoices-modal-card"
        footer={(
          <div className="invoices-modal-actions">
            <button
              className="secondary-btn"
              onClick={closePartialModal}
              disabled={statusLoading}
            >
              Cancel
            </button>
            <button
              className="primary-btn"
              onClick={confirmPartialPayment}
              disabled={
                statusLoading ||
                !hasTdsSelectionFor(partialModal.row) ||
                !hasValidTdsPercentFor(partialModal.row)
              }
            >
              {statusLoading ? 'Saving...' : 'Save Partial Payment'}
            </button>
          </div>
        )}
      >
        <Input
          label="Amount Received"
          type="number"
          value={partialAmount}
          onChange={(event) => setPartialAmount(event.target.value)}
          hint={
            partialModal.row
              ? `Outstanding: ${fmt(partialModal.row.balance_outstanding, partialModal.row.currency)}`
              : ''
          }
        />

        {tdsAppliesTo(partialModal.row) ? (
          <>
            <div className="status-tds-panel">
              <div>
                <strong>TDS paid?</strong>
                <small>Select Yes or No before saving this partial payment.</small>
              </div>
              <div className="status-tds-options" role="radiogroup" aria-label="TDS paid">
                <label>
                  <input
                    type="radio"
                    name="partial_status_tds"
                    checked={statusTdsApplicable === true}
                    onChange={() => setStatusTdsApplicable(true)}
                  />
                  <span>Yes</span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="partial_status_tds"
                    checked={statusTdsApplicable === false}
                    onChange={() => {
                      setStatusTdsApplicable(false)
                      setStatusTdsPercent('')
                    }}
                  />
                  <span>No</span>
                </label>
              </div>
            </div>

            {statusTdsApplicable === true ? (
              <div className="status-tds-calculation">
                <Input
                  label="TDS Percentage"
                  type="number"
                  min="0"
                  step="0.01"
                  value={statusTdsPercent}
                  onChange={(event) => setStatusTdsPercent(event.target.value)}
                />
                <Input
                  label="TDS Amount"
                  value={fmt(getStatusTdsAmount(partialModal.row), partialModal.row?.currency)}
                  readOnly
                  hint="Calculated from invoice principal before tax."
                />
              </div>
            ) : null}
          </>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => !deleteLoading && setDeleting(null)}
        onConfirm={confirmDelete}
        loading={deleteLoading}
        title="Delete Invoice"
        message={`Delete invoice ${deleting?.invoice_number || ''}? This cannot be undone. If it has linked payments, deletion will be blocked.`}
      />

      <ConfirmDialog
        open={statusConfirm.open}
        onClose={() => !statusLoading && setStatusConfirm({ open: false, row: null, status: '' })}
        onConfirm={() => statusConfirm.row && updateStatus(statusConfirm.row, statusConfirm.status)}
        loading={statusLoading}
        title="Change Invoice Status"
        message={`Changing this invoice to ${String(statusConfirm.status || '').replace(/_/g, ' ')} will remove any auto-created payment records linked to the previous paid status. Continue?`}
      />

      {emailFor && (
        <SendInvoiceEmailModal invoice={emailFor} onClose={() => setEmailFor(null)} />
      )}

      {canManageInvoices && actionMenu.open && actionMenu.row && createPortal(
        <div
          className="floating-action-menu invoices-action-menu"
          style={{ top: actionMenu.y, left: actionMenu.x }}
          onClick={(event) => event.stopPropagation()}
        >
          <button className="floating-action-item invoice-menu-item" onClick={() => openView(actionMenu.row)}>
            <span className="invoice-menu-icon">V</span>
            <span>View</span>
          </button>
          <button className="floating-action-item invoice-menu-item" onClick={() => openEdit(actionMenu.row)}>
            <span className="invoice-menu-icon">E</span>
            <span>Edit</span>
          </button>
          {canReceivePaymentFor(actionMenu.row) ? (
            <>
              <button
                className="floating-action-item invoice-menu-item"
                onClick={() => {
                  handleStatusSelection(actionMenu.row, 'PAID')
                  setActionMenu({ open: false, x: 0, y: 0, row: null })
                }}
              >
                <span className="invoice-menu-icon">R</span>
                <span>Receive payment</span>
              </button>
              <button
                className="floating-action-item invoice-menu-item"
                onClick={() => {
                  handleStatusSelection(actionMenu.row, 'PARTIALLY_PAID')
                  setActionMenu({ open: false, x: 0, y: 0, row: null })
                }}
              >
                <span className="invoice-menu-icon">$</span>
                <span>Partial payment</span>
              </button>
            </>
          ) : null}
          <button
            className="floating-action-item invoice-menu-item"
            onClick={() => {
              handlePdf(actionMenu.row.id, actionMenu.row.invoice_number)
              setActionMenu({ open: false, x: 0, y: 0, row: null })
            }}
          >
            <span className="invoice-menu-icon">P</span>
            <span>Download PDF</span>
          </button>
          <button
            className="floating-action-item invoice-menu-item"
            onClick={() => {
              setEmailFor(actionMenu.row)
              setActionMenu({ open: false, x: 0, y: 0, row: null })
            }}
          >
            <span className="invoice-menu-icon">@</span>
            <span>Email to client</span>
          </button>
          {canDeleteInvoices ? (
            <button
              className="floating-action-item invoice-menu-item danger"
              onClick={() => {
                setDeleting(actionMenu.row)
                setActionMenu({ open: false, x: 0, y: 0, row: null })
              }}
            >
              <span className="invoice-menu-icon">D</span>
              <span>Delete</span>
            </button>
          ) : null}
        </div>,
        document.body,
      )}

      {canManageInvoices && statusMenu.open && statusMenu.row && createPortal(
        <div
          className="floating-action-menu invoice-status-menu"
          style={{ top: statusMenu.y, left: statusMenu.x }}
          onClick={(event) => event.stopPropagation()}
        >
          {STATUS_MENU_OPTIONS.map((status) => {
            const current = String(statusMenu.row.invoice_status || '').toUpperCase() === status
            return (
              <button
                key={status}
                className={`floating-action-item invoice-status-item${current ? ' is-current' : ''}`}
                disabled={current}
                onClick={() => {
                  const row = statusMenu.row
                  setStatusMenu({ open: false, x: 0, y: 0, row: null })
                  if (!current) handleStatusSelection(row, status)
                }}
              >
                <StatusChip tone={statusChipTone(status)}>{status.replace(/_/g, ' ')}</StatusChip>
                {current ? <span className="invoice-status-check" aria-hidden="true">✓</span> : null}
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </div>
  )
}


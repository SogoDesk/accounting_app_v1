import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams, useNavigate } from 'react-router-dom'
import api from '../services/api'
import {
  Modal,
  Drawer,
  Input,
  Select,
  SearchableSelect,
  Textarea,
  ConfirmDialog,
  currencySymbol,
  fmt,
  fmtDate,
  Card,
  StatCard,
  DataTable,
  StatusChip,
  FilterPill,
  PanelHeader,
} from '../components/ui/index.jsx'
import { useToast } from '../context/ToastContext'
import './PlacementsPage.css'
import { generatePlacementCode } from '../utils/placementHelpers'
import { generateCandidateCode } from '../utils/candidateHelpers'
import { COUNTRIES, COUNTRY_NAME_OPTIONS } from '../data/countries'
import { BILLING_TYPES, BILLING_TYPE_LABELS, billingFamily, placementMargin } from '../data/billingTypes'
import { buildRegionCode } from '../utils/regionHelpers'
import { useAuth } from '../context/AuthContext'
import { useEntity } from '../context/EntityContext'
import { ACTION_ACCESS, hasAnyRole } from '../utils/acl'
import { useRegionCurrencyFilter } from '../utils/useRegionCurrencyFilter'
import PlacementViewModal from '../components/PlacementViewModal'

// Per-unit labels for the rate-based billing types (Hourly/Daily/Weekly).
const BILLING_UNIT_ADJ = { HOURLY: 'per hour', DAILY: 'per day', WEEKLY: 'per week' }
const BILLING_UNITS_LABEL = {
  HOURLY: 'Expected Hours / Month',
  DAILY: 'Expected Days / Month',
  WEEKLY: 'Expected Weeks / Month',
}

const BLANK = {
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

const BLANK_CANDIDATE_FORM = {
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

const BLANK_CLIENT_FORM = {
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

function isForbiddenError(error) {
  const status = error?.response?.status
  return status === 401 || status === 403
}

// ---- Presentation helpers (visual only) ------------------------------------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function initialsOf(name = '') {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '—'
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase()
}

// "30 Jun 26" style short date from a yyyy-mm-dd (via fmtDate).
function shortEnd(d) {
  const safe = fmtDate(d)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(safe)
  if (!m) return safe
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1].slice(2)}`
}

// The headline bill / pay figure for a row, by billing family.
function billFigureOf(row) {
  const fam = billingFamily(row.billing_type)
  if (fam === 'RATE') return Number(row.bill_rate || 0)
  if (fam === 'FEE') return Number(row.one_time_fee_amount || 0)
  return Number(row.monthly_billing_amount || 0)
}
function payFigureOf(row) {
  if (billingFamily(row.billing_type) === 'FEE') return 0
  return Number(row.pay_rate || 0)
}
function moneyCell(value, currency, family) {
  if (!value) return '—'
  const decimals = family === 'RATE' ? 2 : 0
  return `${currencySymbol(currency)} ${Number(value).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`
}

// A ~62px progress ring built from inline SVG. `stroke` is a css var expression.
function Ring({ label, value, stroke }) {
  const pct = Math.max(0, Math.min(100, Math.round(value)))
  const r = 26
  const c = 2 * Math.PI * r
  const dash = (pct / 100) * c
  return (
    <div className="plc-ring">
      <div className="plc-ring-svg">
        <svg width="62" height="62" viewBox="0 0 62 62">
          <circle cx="31" cy="31" r={r} fill="none" strokeWidth="6" style={{ stroke: 'var(--surface-sunken)' }} />
          <circle
            cx="31" cy="31" r={r} fill="none" strokeWidth="6" strokeLinecap="round"
            style={{ stroke }}
            strokeDasharray={`${dash} ${c - dash}`}
            transform="rotate(-90 31 31)"
          />
        </svg>
        <span className="plc-ring-num">{pct}</span>
      </div>
      <span className="plc-ring-label">{label}</span>
    </div>
  )
}

const CheckIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
)
const AlertIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 16.5v.5" /></svg>
)

export default function PlacementsPage() {
  const toast = useToast()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { user } = useAuth()
  const roleName = user?.roleName
  const canManagePlacements = hasAnyRole(roleName, ACTION_ACCESS.placements.manage)
  const canDeletePlacements = hasAnyRole(roleName, ACTION_ACCESS.placements.delete)

  const [rows, setRows] = useState([])
  const [reportingCurrency, setReportingCurrency] = useState('USD')
  const [candidates, setCandidates] = useState([])
  const [clients, setClients] = useState([])
  const [regions, setRegions] = useState([])
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [clientFilter, setClientFilter] = useState('')
  // Region is driven by the global top-nav switcher (no per-page dropdown).
  const { entityId: regionFilter } = useEntity()
  const [currencyFilter, setCurrencyFilter] = useState('')
  const [modal, setModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [viewing, setViewing] = useState(null)
  const [form, setForm] = useState(BLANK)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [actionMenu, setActionMenu] = useState({ open: false, x: 0, y: 0, row: null })
  const [placementCodeTouched, setPlacementCodeTouched] = useState(false)
  const [drawer, setDrawer] = useState({ type: null, returnTo: null })
  const [drawerSaving, setDrawerSaving] = useState(false)
  const [candidateDraft, setCandidateDraft] = useState(BLANK_CANDIDATE_FORM)
  const [clientDraft, setClientDraft] = useState(BLANK_CLIENT_FORM)
  const [regionDraft, setRegionDraft] = useState(BLANK_REGION_FORM)
  const [billingFilter, setBillingFilter] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [activeTab, setActiveTab] = useState('placements')
  const [showFilters, setShowFilters] = useState(true)

  const load = async () => {
    try {
      setLoading(true)

      const [placementsRes, candidatesRes, clientsRes, regionsRes] = await Promise.all([
        api.get('/placements'),
        api.get('/candidates'),
        api.get('/clients'),
        api.get('/regions'),
      ])

      setRows(placementsRes.data?.data || [])
      setReportingCurrency(placementsRes.data?.reporting_currency || 'USD')
      setCandidates(candidatesRes.data?.data || [])
      setClients(clientsRes.data?.data || [])
      setRegions(regionsRes.data?.data || [])

      try {
        const usersRes = await api.get('/users')
        setUsers(usersRes.data?.data || [])
      } catch (userError) {
        if (isForbiddenError(userError)) {
          setUsers([])
        } else {
          throw userError
        }
      }
    } catch (e) {
      toast.error(e?.response?.data?.message || 'Failed to load placements')
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

  const candidateById = useMemo(() => {
    const map = {}
    candidates.forEach((c) => {
      map[String(c.id)] = c
    })
    return map
  }, [candidates])

  const clientById = useMemo(() => {
    const map = {}
    clients.forEach((c) => {
      map[String(c.id)] = c
    })
    return map
  }, [clients])

  const regionById = useMemo(() => {
    const map = {}
    regions.forEach((r) => {
      map[String(r.id)] = r
    })
    return map
  }, [regions])

  const candidateOptions = useMemo(() => (
    candidates.map((candidate) => ({
      value: String(candidate.id),
      label: candidate.full_name,
      meta: [candidate.candidate_code, candidate.job_title].filter(Boolean).join(' • '),
      searchText: `${candidate.email || ''} ${candidate.country || ''}`.trim(),
    }))
  ), [candidates])

  const clientOptionsForPicker = useMemo(() => (
    clients.map((client) => ({
      value: String(client.id),
      label: client.client_name,
      meta: [client.client_code, client.region_name || regionById[String(client.region_id)]?.region_name].filter(Boolean).join(' • '),
      searchText: `${client.primary_contact_name || ''} ${client.primary_contact_email || ''}`.trim(),
    }))
  ), [clients, regionById])

  const regionOptionsForPicker = useMemo(() => (
    regions.map((region) => ({
      value: String(region.id),
      label: region.region_name,
      meta: [region.country_name, region.default_currency].filter(Boolean).join(' • '),
      searchText: `${region.region_code || ''} ${region.company_name || ''}`.trim(),
    }))
  ), [regions])

  const userOptions = useMemo(() => (
    users.map((entry) => ({
      value: String(entry.id),
      label: entry.full_name,
      meta: entry.email || '',
      searchText: `${entry.role_name || ''} ${entry.phone || ''}`.trim(),
    }))
  ), [users])

  const countryOptions = useMemo(() => (
    COUNTRIES.map((country) => ({
      value: country.iso2,
      label: country.name,
      meta: `${country.currency} • ${country.symbol}`,
      searchText: `${country.iso2} ${country.currency}`.trim(),
    }))
  ), [])

  const openCreate = () => {
    setEditing(null)
    setViewing(null)
    setPlacementCodeTouched(false)
    setForm({
      ...BLANK,
      placement_code: generatePlacementCode(),
    })
    setModal(true)
  }

  useEffect(() => {
    if (searchParams.get('action') !== 'create' || !canManagePlacements) return
    openCreate()
    setSearchParams({}, { replace: true })
  }, [searchParams, setSearchParams, canManagePlacements])

  const openEdit = (row) => {
    setEditing(row)
    setViewing(null)
    setPlacementCodeTouched(true)
    setForm({
      ...BLANK,
      ...row,
      candidate_id: row.candidate_id ? String(row.candidate_id) : '',
      client_id: row.client_id ? String(row.client_id) : '',
      region_id: row.region_id ? String(row.region_id) : '',
      recruiter_id: row.recruiter_id ? String(row.recruiter_id) : '',
      account_manager_id: row.account_manager_id ? String(row.account_manager_id) : '',
      placement_code: row.placement_code || '',
      bill_rate: String(row.bill_rate ?? '0'),
      pay_rate: String(row.pay_rate ?? '0'),
      expected_hours_per_month: String(row.expected_hours_per_month ?? '160'),
      monthly_billing_amount: String(row.monthly_billing_amount ?? '0'),
      one_time_fee_amount: String(row.one_time_fee_amount ?? '0'),
      custom_payment_terms_days: String(row.custom_payment_terms_days ?? ''),
      tax_percent: String(row.tax_percent ?? '0'),
      tax_applicable: row.tax_applicable === true || row.tax_applicable === 'true',
    })
    setModal(true)
    setActionMenu({ open: false, x: 0, y: 0, row: null })
  }

  const openView = (row) => {
    setViewing(row)
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

  const set = (key, value) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value }

      if (key === 'candidate_id') {
        const selectedCandidate = candidateById[String(value)]
        if (selectedCandidate) {
          if (!prev.job_title || prev.job_title === candidateById[String(prev.candidate_id)]?.job_title) {
            next.job_title = selectedCandidate.job_title || ''
          }
        }
      }

      if (key === 'client_id') {
        const selectedClient = clientById[String(value)]
        if (selectedClient) {
          next.region_id = selectedClient.region_id ? String(selectedClient.region_id) : ''
          next.currency =
            selectedClient.currency ||
            regionById[String(selectedClient.region_id)]?.default_currency ||
            'USD'
        }
      }

      // Currency follows the selected region — pick a region (or a client, which
      // carries its region) and the placement currency adapts to it automatically.
      if (key === 'region_id') {
        const selectedRegion = regionById[String(value)]
        if (selectedRegion?.default_currency) {
          next.currency = selectedRegion.default_currency
        }
      }

      return next
    })
  }

  const setCandidateDraftValue = (key, value) => {
    setCandidateDraft((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'full_name' && !prev.candidate_code) next.candidate_code = generateCandidateCode(value)
      return next
    })
  }

  const setClientDraftValue = (key, value) => {
    setClientDraft((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'region_id') {
        const region = regionById[String(value)]
        if (region?.default_currency) next.currency = region.default_currency
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
        next.country_code = value
        next.country_name = country?.name || ''
        next.default_currency = country?.currency || prev.default_currency
      }
      return next
    })
  }

  const openCandidateDrawer = (initialName = '') => {
    setDrawerSaving(false)
    setCandidateDraft({
      ...BLANK_CANDIDATE_FORM,
      full_name: String(initialName || '').trim(),
      candidate_code: generateCandidateCode(initialName),
      job_title: form.job_title || '',
    })
    setDrawer({ type: 'candidate', returnTo: null })
  }

  const openClientDrawer = (initialName = '') => {
    const selectedRegion = regionById[String(form.region_id)]
    setDrawerSaving(false)
    setClientDraft({
      ...BLANK_CLIENT_FORM,
      client_name: String(initialName || '').trim(),
      region_id: form.region_id || '',
      currency: selectedRegion?.default_currency || form.currency || 'USD',
    })
    setDrawer({ type: 'client', returnTo: null })
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

  const save = async () => {
    const requiredFields = [
      ['candidate_id', 'Candidate'],
      ['client_id', 'Client'],
      ['region_id', 'Region'],
      ['job_title', 'Job title'],
      ['employment_type', 'Employment type'],
      ['billing_type', 'Billing type'],
      ['currency', 'Currency'],
      ['start_date', 'Start date'],
    ]
    const missing = requiredFields.filter(([key]) => !form[key]).map(([, label]) => label)
    if (missing.length) {
      toast.error(`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required`)
      return
    }

    const payload = {
      ...form,
      placement_code: editing
        ? (form.placement_code?.trim() || '')
        : (placementCodeTouched ? (form.placement_code?.trim() || '') : ''),
      tax_applicable: !!form.tax_applicable,
    }

    setSaving(true)
    try {
      if (editing) {
        await api.put(`/placements/${editing.id}`, payload)
      } else {
        await api.post('/placements', payload)
      }
      toast.success(`Placement ${editing ? 'updated' : 'created'} successfully`)
      setModal(false)
      setEditing(null)
      setForm(BLANK)
      setPlacementCodeTouched(false)
      load()
    } catch (e) {
      toast.error(e.response?.data?.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const saveCandidateQuickCreate = async () => {
    if (!candidateDraft.full_name) {
      toast.error('Candidate name is required')
      return
    }
    setDrawerSaving(true)
    try {
      const response = await api.post('/candidates', {
        ...candidateDraft,
        candidate_code: candidateDraft.candidate_code?.trim() || '',
      })
      const created = response.data?.data
      if (!created) throw new Error('Candidate create response missing data')
      setCandidates((prev) => [created, ...prev])
      setForm((prev) => ({
        ...prev,
        candidate_id: String(created.id),
        job_title: created.job_title || prev.job_title,
      }))
      toast.success('Candidate created successfully')
      closeDrawer()
    } catch (error) {
      toast.error(error.response?.data?.message || error.message || 'Failed to create candidate')
    } finally {
      setDrawerSaving(false)
    }
  }

  const saveClientQuickCreate = async () => {
    if (!clientDraft.client_name || !clientDraft.region_id || !clientDraft.currency) {
      toast.error('Client name, region, and currency are required')
      return
    }
    setDrawerSaving(true)
    try {
      const response = await api.post('/clients', {
        ...clientDraft,
        client_code: '',
      })
      const created = response.data?.data
      if (!created) throw new Error('Client create response missing data')
      const region = regionById[String(created.region_id)]
      const createdWithRegion = region ? { ...created, region_name: region.region_name } : created
      setClients((prev) => [createdWithRegion, ...prev])
      setForm((prev) => ({
        ...prev,
        client_id: String(created.id),
        region_id: created.region_id ? String(created.region_id) : prev.region_id,
        currency: created.currency || prev.currency,
      }))
      toast.success('Client created successfully')
      closeDrawer()
    } catch (error) {
      toast.error(error.response?.data?.message || error.message || 'Failed to create client')
    } finally {
      setDrawerSaving(false)
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
      if (drawer.returnTo === 'client') {
        setClientDraft((prev) => ({
          ...prev,
          region_id: String(created.id),
          currency: created.default_currency || prev.currency,
        }))
        setDrawer({ type: 'client', returnTo: null })
      } else {
        setForm((prev) => ({
          ...prev,
          region_id: String(created.id),
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

  const confirmDelete = async () => {
    if (!deleting) return
    setDeleteLoading(true)
    try {
      await api.delete(`/placements/${deleting.id}`)
      toast.success('Placement deleted successfully')
      setDeleting(null)
      load()
    } catch (e) {
      toast.error(e.response?.data?.message || 'Delete failed')
    } finally {
      setDeleteLoading(false)
    }
  }

  // Local short-date formatter (shadows the imported fmtDate within this
  // component). Defined here — above the useMemo hooks that call it — so it
  // isn't referenced in its temporal dead zone.
  const fmtDate = (value) => {
    if (!value) return null
    const d = new Date(value)
    return Number.isNaN(d.getTime())
      ? null
      : d.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' })
  }

  const filtered = rows.filter((r) => {
    const q = search.toLowerCase()
    const matchSearch =
      !q ||
      String(r.candidate_name || '').toLowerCase().includes(q) ||
      String(r.client_name || '').toLowerCase().includes(q) ||
      String(r.placement_code || '').toLowerCase().includes(q) ||
      String(r.job_title || '').toLowerCase().includes(q)

    const matchStatus = !statusFilter || r.placement_status === statusFilter
    const matchClient = !clientFilter || String(r.client_id) === String(clientFilter)
    const matchRegion = !regionFilter || String(r.region_id) === String(regionFilter)
    const matchCurrency = !currencyFilter || String(r.currency || '').toUpperCase() === currencyFilter
    const matchBilling = !billingFilter || String(r.billing_type).toUpperCase() === billingFilter
    return matchSearch && matchStatus && matchClient && matchRegion && matchCurrency && matchBilling
  })

  const clientOptions = useMemo(() => {
    const map = new Map()
    rows.forEach((row) => {
      const id = String(row.client_id || '')
      if (!id) return
      if (!map.has(id)) map.set(id, { id, name: row.client_name || `Client ${id}` })
    })
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [rows])

  const { visibleCurrencies, selectCurrency } = useRegionCurrencyFilter({
    regions,
    currencies: rows.map((r) => r.currency),
    regionFilter,
    currencyFilter,
    setRegionFilter: () => {},
    setCurrencyFilter,
  })

  const placementStats = useMemo(() => {
    const activeCount = filtered.filter((row) => String(row.placement_status || '').toUpperCase() === 'ACTIVE').length
    const grouped = new Map()
    filtered.forEach((row) => {
      const key = String(row.client_id || row.client_name || 'unknown')
      const name = row.client_name || 'Unknown Client'
      if (!grouped.has(key)) grouped.set(key, { client: name, count: 0 })
      grouped.get(key).count += 1
    })
    const groupedRows = Array.from(grouped.values()).sort((a, b) => b.count - a.count)
    // Average gross margin % across active placements that have revenue.
    // We average the percentage (currency-agnostic) rather than summing dollars
    // across mixed currencies, which would be meaningless.
    const activeWithRevenue = filtered.filter(
      (row) => String(row.placement_status || '').toUpperCase() === 'ACTIVE' && placementMargin(row).revenue > 0,
    )
    const avgMarginPct = activeWithRevenue.length
      ? Math.round(
          (activeWithRevenue.reduce((s, row) => s + placementMargin(row).pct, 0) / activeWithRevenue.length) * 10,
        ) / 10
      : 0
    return {
      total: filtered.length,
      active: activeCount,
      clientGroups: groupedRows.length,
      topClient: groupedRows[0] || null,
      avgMarginPct,
    }
  }, [filtered])

  // KPI aggregates. Monthly revenue/cost come from placementMargin() (the single
  // source of truth for economics). Across "All regions" each placement's figure
  // is converted to the company group currency via the backend-supplied
  // reporting_rate so mixed-currency placements aren't summed raw; a single
  // region needs no conversion (all one currency).
  const kpiConsolidated = !regionFilter
  const kpiCcy = kpiConsolidated
    ? reportingCurrency
    : (filtered.find((r) => r.currency)?.currency || reportingCurrency)
  const kpi = useMemo(() => {
    const active = filtered.filter((r) => String(r.placement_status || '').toUpperCase() === 'ACTIVE')
    let revenue = 0
    let cost = 0
    active.forEach((r) => {
      const m = placementMargin(r)
      const rate = kpiConsolidated ? (Number(r.reporting_rate) || 1) : 1
      revenue += m.revenue * rate
      cost += m.cost * rate
    })
    const today = new Date()
    const soon = new Date()
    soon.setDate(soon.getDate() + 30)
    const endingSoon = active.filter((r) => {
      if (!r.end_date) return false
      const d = new Date(fmtDate(r.end_date))
      return !Number.isNaN(d.getTime()) && d >= today && d <= soon
    }).length
    const activeCandidateIds = new Set(active.map((r) => String(r.candidate_id)))
    const bench = candidates.filter((c) => !activeCandidateIds.has(String(c.id)))
    const benchActive = bench.filter((c) => String(c.status || '').toUpperCase() === 'ACTIVE').length
    return {
      activeCount: active.length,
      revenue,
      cost,
      blended: placementStats.avgMarginPct,
      endingSoon,
      bench: bench.length,
      benchActive,
    }
  }, [filtered, candidates, placementStats.avgMarginPct, kpiConsolidated])

  const selected = useMemo(() => {
    if (!filtered.length) return null
    return filtered.find((r) => String(r.id) === String(selectedId)) || filtered[0]
  }, [filtered, selectedId])

  // Rail derivations for the selected placement (visual only).
  const selMargin = selected ? placementMargin(selected) : null
  const selType = String(selected?.billing_type || '').toUpperCase()
  const selUnit = { HOURLY: 'hr', DAILY: 'day', WEEKLY: 'wk' }[selType] || 'mo'
  // Utilisation from real timesheet units (actual_hours = SUM of this month's
  // timesheet units for the placement, from the API) over the contracted month.
  const expectedHours = Number(selected?.expected_hours_per_month || 0)
  const actualHours = Number(selected?.actual_hours || 0)
  const utilisation = selected && expectedHours > 0
    ? Math.min(100, Math.round((actualHours / expectedHours) * 100))
    : 0
  // Compliance checklist derived from the linked candidate's real fields.
  // expiryState: given a date, classify as ok / warn (<= ~30d out) / expired.
  const dayMs = 24 * 60 * 60 * 1000
  const expiryState = (value) => {
    if (!value) return null
    const d = new Date(value)
    if (Number.isNaN(d.getTime())) return null
    const days = Math.floor((d.getTime() - Date.now()) / dayMs)
    if (days < 0) return { state: 'expired', days }
    if (days <= 30) return { state: 'warn', days }
    return { state: 'ok', days }
  }
  const compChecks = selected
    ? (() => {
        const rows = []
        // Right to work: authorization present and not past-expiry.
        const wa = String(selected.work_authorization || '').trim()
        const waExp = expiryState(selected.work_auth_expiry)
        if (!wa) {
          rows.push({ name: 'Right to work', sub: 'Not on file', state: 'warn' })
        } else {
          const st = waExp ? waExp.state : 'ok'
          const sub = waExp
            ? (st === 'expired' ? `${wa} · expired ${fmtDate(selected.work_auth_expiry)}` : `${wa} · expires ${fmtDate(selected.work_auth_expiry)}`)
            : `${wa} · no expiry`
          rows.push({ name: 'Right to work', sub, state: st })
        }
        // Insurance certificate: driven by insurance_expiry.
        const insExp = expiryState(selected.insurance_expiry)
        rows.push({
          name: 'Insurance certificate',
          sub: insExp
            ? (insExp.state === 'expired' ? `Expired ${fmtDate(selected.insurance_expiry)}` : `Expires ${fmtDate(selected.insurance_expiry)}`)
            : 'Not on file',
          state: insExp ? insExp.state : 'warn',
        })
        // W9 / tax on file.
        rows.push({
          name: 'W9 / tax on file',
          sub: selected.w9_on_file ? 'On file' : 'Not on file',
          state: selected.w9_on_file ? 'ok' : 'warn',
        })
        return rows.map((r) => ({ ...r, warn: r.state !== 'ok' }))
      })()
    : []
  const compOk = compChecks.filter((c) => c.state === 'ok').length
  const compliancePct = compChecks.length ? Math.round((compOk / compChecks.length) * 100) : 0
  const hasWarn = compChecks.some((c) => c.warn)
  const compIssues = compChecks.length - compOk

  const iconBtn = (path) => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{path}</svg>
  )

  const placementColumns = [
    {
      key: 'candidate', header: 'Candidate', sortAccessor: (r) => String(r.candidate_name || '').toLowerCase(),
      render: (r) => (
        <div className="plc-cand">
          <span className="plc-avatar">{initialsOf(r.candidate_name)}</span>
          <div className="plc-cand-stack">
            <button type="button" className="cd-linkbtn plc-cand-name" onClick={(e) => { e.stopPropagation(); openView(r) }} title="View placement">{r.candidate_name || '—'}</button>
            <span className="plc-cand-sub">
              <span className="plc-mono">{r.placement_code || '—'}</span>
              {r.job_title ? ` · ${r.job_title}` : ''}
            </span>
          </div>
        </div>
      ),
    },
    {
      key: 'client', header: 'Client / end client', sortAccessor: (r) => String(r.client_name || '').toLowerCase(),
      render: (r) => (
        <div className="plc-twoline">
          <span className="plc-twoline-main">{r.client_name || '—'}</span>
          <span className="plc-twoline-sub">
            {r.end_client_name ? `End client: ${r.end_client_name}` : (r.vendor_name ? `Vendor: ${r.vendor_name}` : 'Direct')}
          </span>
        </div>
      ),
    },
    {
      key: 'billing', header: 'Billing type', sortAccessor: (r) => String(BILLING_TYPE_LABELS[r.billing_type] || String(r.billing_type || '').toUpperCase()).toLowerCase(),
      render: (r) => <StatusChip tone="accent">{BILLING_TYPE_LABELS[r.billing_type] || String(r.billing_type || '').toUpperCase()}</StatusChip>,
    },
    { key: 'bill', header: 'Bill', align: 'right', mono: true, sortAccessor: (r) => Number(placementMargin(r).revenue || 0), render: (r) => moneyCell(billFigureOf(r), r.currency, billingFamily(r.billing_type)) },
    { key: 'pay', header: 'Pay', align: 'right', mono: true, sortAccessor: (r) => Number(placementMargin(r).cost || 0), render: (r) => moneyCell(payFigureOf(r), r.currency, billingFamily(r.billing_type)) },
    {
      key: 'margin', header: 'Margin', align: 'right', mono: true, sortAccessor: (r) => Number(placementMargin(r).pct || 0),
      render: (r) => {
        const m = placementMargin(r)
        if (m.revenue <= 0) return <span className="plc-margin-low">—</span>
        return <span className={m.pct >= 30 ? 'plc-margin-ok' : 'plc-margin-low'}>{m.pct}%</span>
      },
    },
    {
      key: 'ends', header: 'Ends', align: 'right', mono: true, sortAccessor: (r) => r.end_date || '',
      render: (r) => {
        const st = String(r.placement_status || '').toUpperCase()
        if (st === 'ENDED' || st === 'COMPLETED' || st === 'CANCELLED') return 'Completed'
        if (!r.end_date) return '—'
        const d = new Date(fmtDate(r.end_date))
        const soon = new Date()
        soon.setDate(soon.getDate() + 45)
        const danger = !Number.isNaN(d.getTime()) && d <= soon
        return <span className={danger ? 'plc-ends-danger' : undefined}>{shortEnd(r.end_date)}</span>
      },
    },
  ]

  const candidateColumns = [
    {
      key: 'name', header: 'Candidate', sortAccessor: (c) => String(c.full_name || '').toLowerCase(),
      render: (c) => (
        <div className="plc-cand">
          <span className="plc-avatar">{initialsOf(c.full_name)}</span>
          <div className="plc-cand-stack">
            <span className="plc-cand-name">{c.full_name || '—'}</span>
            <span className="plc-cand-sub">
              <span className="plc-mono">{c.candidate_code || '—'}</span>
              {c.job_title ? ` · ${c.job_title}` : ''}
            </span>
          </div>
        </div>
      ),
    },
    { key: 'country', header: 'Country', sortAccessor: (c) => String(c.country || '').toLowerCase(), render: (c) => c.country || '—' },
    {
      key: 'status', header: 'Status', align: 'right', sortAccessor: (c) => String(c.status || '').toLowerCase(),
      render: (c) => <StatusChip tone={String(c.status || '').toUpperCase() === 'ACTIVE' ? 'success' : 'neutral'}>{String(c.status || '—').toUpperCase()}</StatusChip>,
    },
  ]

  return (
    <div className="plc-page">
      <div className="plc-head">
        <button type="button" className="plc-back" onClick={() => navigate('/dashboard')} aria-label="Back to dashboard">
          {iconBtn(<path d="M15 18l-6-6 6-6" />)}
        </button>
        <div className="plc-head-titles">
          <div className="plc-title">Placements &amp; candidates</div>
          <div className="plc-subtitle">
            Active assignments with margin, and the candidate bench behind them. Seven billing types drive how each one invoices.
          </div>
        </div>
        <div className="plc-head-actions">
          <button
            type="button"
            className={`plc-iconbtn${showFilters ? ' is-active' : ''}`}
            onClick={() => setShowFilters((v) => !v)}
            aria-label="Toggle filters"
          >
            {iconBtn(<path d="M3 5h18M6 12h12M10 19h4" />)}
          </button>
          <button type="button" className="plc-btn plc-btn-secondary" onClick={() => setActiveTab('candidates')}>
            {iconBtn(<><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0M16 3.5a3 3 0 0 1 0 5.8M21 20a6 6 0 0 0-4-5.6" /></>)}
            Candidates
          </button>
          {canManagePlacements ? (
            <button type="button" className="plc-btn plc-btn-primary" onClick={openCreate}>
              {iconBtn(<path d="M12 5v14M5 12h14" />)}
              New placement
            </button>
          ) : null}
        </div>
      </div>

      <div className="plc-kpis">
        <StatCard
          label="Active placements"
          value={kpi.activeCount.toLocaleString('en-US')}
          sub={`${kpi.endingSoon} ending within 30 days`}
          icon={iconBtn(<><rect x="4" y="5" width="16" height="16" rx="2" /><path d="M16 3v4M8 3v4M4 10h16" /></>)}
        />
        <StatCard
          label="Monthly revenue"
          prefix={currencySymbol(kpiCcy)}
          value={Math.round(kpi.revenue).toLocaleString('en-US')}
          sub="Projected bill run"
          icon={iconBtn(<path d="M12 3v18M7 7h7a3 3 0 0 1 0 6H8a3 3 0 0 0 0 6h9" />)}
        />
        <StatCard
          label="Monthly cost"
          prefix={currencySymbol(kpiCcy)}
          value={Math.round(kpi.cost).toLocaleString('en-US')}
          sub="Contractor pay run"
          icon={iconBtn(<path d="M12 3v18M7 17h7a3 3 0 0 0 0-6H8a3 3 0 0 1 0-6h9" />)}
        />
        <StatCard
          label="Blended margin"
          value={String(kpi.blended)}
          unit="%"
          sub="Across active placements"
          icon={iconBtn(<path d="M5 19 19 5M8 7.5a1.5 1.5 0 1 1 0-.01M16 16.5a1.5 1.5 0 1 1 0-.01" />)}
        />
        <StatCard
          label="Bench candidates"
          value={kpi.bench.toLocaleString('en-US')}
          sub={`${kpi.benchActive} available`}
          icon={iconBtn(<><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0M16 3.5a3 3 0 0 1 0 5.8M21 20a6 6 0 0 0-4-5.6" /></>)}
        />
      </div>

      {showFilters ? (
        <div className="plc-filters">
          <span className="plc-pill">
            <FilterPill active={!!clientFilter} dropdown value={clientFilter ? (clientOptions.find((c) => String(c.id) === String(clientFilter))?.name || '') : ''}>
              {clientFilter ? 'Client' : 'All clients'}
            </FilterPill>
            <select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} aria-label="Filter by client">
              <option value="">All clients</option>
              {clientOptions.map((client) => (
                <option key={client.id} value={client.id}>{client.name}</option>
              ))}
            </select>
          </span>

          <span className="plc-pill">
            <FilterPill active={!!statusFilter} dropdown value={statusFilter ? statusFilter.replace('_', ' ') : ''}>
              {statusFilter ? 'Status' : 'All status'}
            </FilterPill>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Filter by status">
              <option value="">All status</option>
              <option value="ACTIVE">Active</option>
              <option value="ON_HOLD">On Hold</option>
              <option value="ENDED">Ended</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </span>

          <span className="plc-pill">
            <FilterPill active={!!billingFilter} dropdown value={billingFilter ? (BILLING_TYPE_LABELS[billingFilter] || billingFilter) : ''}>
              {billingFilter ? 'Billing' : 'All billing types'}
            </FilterPill>
            <select value={billingFilter} onChange={(e) => setBillingFilter(e.target.value)} aria-label="Filter by billing type">
              <option value="">All billing types</option>
              {BILLING_TYPES.map((b) => (
                <option key={b.value} value={b.value}>{b.label}</option>
              ))}
            </select>
          </span>

          <span className="plc-pill">
            <FilterPill active={!!currencyFilter} dropdown value={currencyFilter ? `${currencySymbol(currencyFilter)} ${currencyFilter}` : ''}>
              {currencyFilter ? 'Currency' : 'All currencies'}
            </FilterPill>
            <select value={currencyFilter} onChange={(e) => selectCurrency(e.target.value)} aria-label="Filter by currency">
              <option value="">All currencies</option>
              {visibleCurrencies.map((code) => (
                <option key={code} value={code}>{currencySymbol(code)} {code}</option>
              ))}
            </select>
          </span>

          <div className="plc-search">
            <span className="plc-search-ico">{iconBtn(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3-3" /></>)}</span>
            <input
              placeholder="Candidate, client or code"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      ) : null}

      <div className="plc-content">
        <Card className="plc-panel">
          <PanelHeader
            title="Assignments"
            tabs={[
              { key: 'placements', label: 'Placements', count: filtered.length },
              { key: 'candidates', label: 'Candidates', count: candidates.length },
            ]}
            activeTab={activeTab}
            onTab={setActiveTab}
            actions={(
              <>
                <button type="button" className="plc-rail-iconbtn" aria-label="Export" title="Export">
                  {iconBtn(<><path d="M12 3v12M8 11l4 4 4-4" /><path d="M4 21h16" /></>)}
                </button>
                {canManagePlacements && selected ? (
                  <button type="button" className="plc-rail-iconbtn" aria-label="Actions" onClick={(e) => openActionMenu(e, selected)}>
                    {iconBtn(<><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></>)}
                  </button>
                ) : null}
              </>
            )}
          />

          {activeTab === 'placements' ? (
            <DataTable
              columns={placementColumns}
              rows={filtered}
              paginate
              pageLabel="placements"
              loading={loading}
              getRowId={(r) => String(r.id)}
              selectedId={selected ? String(selected.id) : null}
              onRowSelect={(r) => setSelectedId(String(r.id))}
              empty="No placements found"
              footer={[
                { colSpan: 5, render: () => `${filtered.length} of ${rows.length} active · monthly figures, group USD` },
                { align: 'right', mono: true, render: () => `${kpi.blended}%` },
                { render: () => '' },
              ]}
            />
          ) : (
            <DataTable
              columns={candidateColumns}
              rows={candidates}
              loading={loading}
              getRowId={(c) => String(c.id)}
              empty="No candidates found"
            />
          )}
        </Card>

        <div className="plc-rail">
          {selected ? (
            <>
              <Card>
                <div className="plc-rail-head">
                  <div className="plc-rail-code">{selected.placement_code || '—'} · {selected.candidate_name || '—'}</div>
                  {canManagePlacements ? (
                    <div className="plc-rail-actions">
                      <button type="button" className="plc-rail-iconbtn" aria-label="Edit" onClick={() => openEdit(selected)}>
                        {iconBtn(<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z" />)}
                      </button>
                      <button type="button" className="plc-rail-iconbtn" aria-label="Actions" onClick={(e) => openActionMenu(e, selected)}>
                        {iconBtn(<><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></>)}
                      </button>
                    </div>
                  ) : null}
                </div>
                <div className="plc-rail-job">
                  <span className="plc-avatar">{initialsOf(selected.candidate_name)}</span>
                  <div>
                    <div className="plc-rail-job-title">{selected.job_title || '—'}</div>
                    <div className="plc-rail-job-sub">{[selected.client_name, selected.region_name].filter(Boolean).join(' · ') || '—'}</div>
                  </div>
                </div>
                <div className="plc-rings">
                  <Ring
                    label="Margin"
                    value={selMargin ? Math.max(0, Math.min(100, selMargin.pct)) : 0}
                    stroke={selMargin && selMargin.pct >= 30 ? 'var(--success)' : 'var(--warn)'}
                  />
                  <Ring label="Utilisation" value={utilisation} stroke="var(--accent)" />
                  <Ring label="Compliance" value={compliancePct} stroke={hasWarn ? 'var(--warn)' : 'var(--success)'} />
                </div>
              </Card>

              <Card>
                <div className="plc-sec-head"><span className="plc-sec-title">Economics</span></div>
                <div className="plc-econ">
                  <div className="plc-econ-row"><span className="plc-econ-k">Monthly revenue</span><span className="plc-econ-v">{fmt(selMargin.revenue, selected.currency)}</span></div>
                  <div className="plc-econ-row"><span className="plc-econ-k">Monthly cost</span><span className="plc-econ-v">{fmt(selMargin.cost, selected.currency)}</span></div>
                  <div className="plc-econ-row"><span className="plc-econ-k">Monthly margin</span><span className="plc-econ-v">{fmt(selMargin.margin, selected.currency)}</span></div>
                  <div className="plc-econ-row"><span className="plc-econ-k">Unit spread</span><span className="plc-econ-v">{currencySymbol(selected.currency)} {selMargin.unitMargin.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} / {selUnit}</span></div>
                  <div className="plc-econ-row"><span className="plc-econ-k">Invoice cycle</span><span className="plc-econ-v">{[selected.invoice_cycle, selected.payment_terms].filter(Boolean).join(' · ') || '—'}</span></div>
                </div>
              </Card>

              <Card>
                <div className="plc-sec-head">
                  <span className="plc-sec-title">Compliance</span>
                  {compIssues > 0 ? <StatusChip tone="warn">{compIssues} {compIssues === 1 ? 'ISSUE' : 'ISSUES'}</StatusChip> : null}
                </div>
                <div className="plc-check">
                  {compChecks.map((c) => (
                    <div key={c.name} className={`plc-check-row${c.warn ? ' is-warn' : ''}`}>
                      <span className="plc-check-ico">{c.warn ? <AlertIcon /> : <CheckIcon />}</span>
                      <div className="plc-check-body">
                        <span className="plc-check-name">{c.name}</span>
                        <span className="plc-check-sub">{c.sub}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            </>
          ) : (
            <Card>
              <div className="plc-rail-job-sub">Select a placement to see margin, economics and compliance.</div>
            </Card>
          )}
        </div>
      </div>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title={editing ? 'Edit Placement' : 'New Placement'}
        maxWidth={980}
        modalClassName="placements-modal-card"
        footer={(
          <div className="placements-modal-actions">
            <button className="secondary-btn" onClick={() => setModal(false)}>Cancel</button>
            <button className="primary-btn" onClick={save} disabled={saving}>
              {saving ? 'Saving...' : 'Save Placement'}
            </button>
          </div>
        )}
      >
        <div className="form-grid cols-3">
          <Input
            label="Placement Code"
            value={form.placement_code}
            onChange={(e) => {
              setPlacementCodeTouched(true)
              set('placement_code', e.target.value.toUpperCase())
            }}
            hint="Preview shown by default. Leave as is for auto-generation, or change manually."
          />

          <SearchableSelect
            label="Candidate"
            required
            value={form.candidate_id}
            options={candidateOptions}
            placeholder="Search candidate..."
            emptyMessage="No candidates found"
            createLabel="+ Add candidate"
            onChange={(e) => set('candidate_id', e.target.value)}
            onCreate={(query) => openCandidateDrawer(query)}
          />

          <SearchableSelect
            label="Client"
            required
            value={form.client_id}
            options={clientOptionsForPicker}
            placeholder="Search client..."
            emptyMessage="No clients found"
            createLabel="+ Add client"
            onChange={(e) => set('client_id', e.target.value)}
            onCreate={(query) => openClientDrawer(query)}
          />

          <SearchableSelect
            label="Region"
            required
            value={form.region_id}
            options={regionOptionsForPicker}
            placeholder="Search region..."
            emptyMessage="No regions found"
            createLabel="+ Add region"
            onChange={(e) => set('region_id', e.target.value)}
            onCreate={(query) => openRegionDrawer(query)}
          />

          <Input
            label="Job Title"
            required
            value={form.job_title}
            onChange={(e) => set('job_title', e.target.value)}
          />

          <Input
            label="Currency"
            required
            value={form.currency ? `${currencySymbol(form.currency)} ${form.currency}` : ''}
            readOnly
            hint="Follows the selected region / client"
          />

          <Input
            label="End Client Name"
            value={form.end_client_name}
            onChange={(e) => set('end_client_name', e.target.value)}
          />

          <Input
            label="Vendor Name"
            value={form.vendor_name}
            onChange={(e) => set('vendor_name', e.target.value)}
          />

          <Select
            label="Employment Type"
            required
            value={form.employment_type}
            onChange={(e) => set('employment_type', e.target.value)}
          >
            <option value="CONTRACT">Contract</option>
            <option value="C2C">C2C</option>
            <option value="W2">W2</option>
            <option value="FULL_TIME">Full Time</option>
            <option value="PERMANENT">Permanent</option>
          </Select>

          <SearchableSelect
            label="Recruiter"
            value={form.recruiter_id}
            options={userOptions}
            placeholder="Search recruiter..."
            emptyMessage="No users found"
            onChange={(e) => set('recruiter_id', e.target.value)}
          />

          <SearchableSelect
            label="Account Manager"
            value={form.account_manager_id}
            options={userOptions}
            placeholder="Search account manager..."
            emptyMessage="No users found"
            onChange={(e) => set('account_manager_id', e.target.value)}
          />

          <Select
            label="Status"
            value={form.placement_status}
            onChange={(e) => set('placement_status', e.target.value)}
          >
            <option value="ACTIVE">Active</option>
            <option value="ON_HOLD">On Hold</option>
            <option value="ENDED">Ended</option>
            <option value="CANCELLED">Cancelled</option>
          </Select>

          <div className="span-3 form-section">Billing Details</div>

          <Select
            label="Billing Type"
            required
            value={form.billing_type}
            onChange={(e) => set('billing_type', e.target.value)}
          >
            {BILLING_TYPES.map((b) => (
              <option key={b.value} value={b.value}>{b.label}</option>
            ))}
          </Select>

          {/* Smart amount fields — only what's relevant to the chosen billing type */}
          {billingFamily(form.billing_type) === 'RATE' && (
            <>
              <Input
                label={`Bill Rate (${BILLING_UNIT_ADJ[form.billing_type] || 'per unit'})`}
                type="number"
                value={form.bill_rate}
                onChange={(e) => set('bill_rate', e.target.value)}
              />
              <Input
                label="Pay Rate"
                type="number"
                value={form.pay_rate}
                onChange={(e) => set('pay_rate', e.target.value)}
              />
              <Input
                label={BILLING_UNITS_LABEL[form.billing_type] || 'Expected Units / Month'}
                type="number"
                value={form.expected_hours_per_month}
                onChange={(e) => set('expected_hours_per_month', e.target.value)}
              />
            </>
          )}

          {billingFamily(form.billing_type) === 'FLAT' && (
            <>
              <Input
                label="Monthly Billing Amount"
                type="number"
                value={form.monthly_billing_amount}
                onChange={(e) => set('monthly_billing_amount', e.target.value)}
              />
              <Input
                label="Pay Rate (monthly)"
                type="number"
                value={form.pay_rate}
                onChange={(e) => set('pay_rate', e.target.value)}
              />
            </>
          )}

          {billingFamily(form.billing_type) === 'ANNUAL' && (
            <>
              <Input
                label="Annual Amount"
                hint="Invoiced as 1/12 each month"
                type="number"
                value={form.monthly_billing_amount}
                onChange={(e) => set('monthly_billing_amount', e.target.value)}
              />
              <Input
                label="Pay Rate (annual)"
                type="number"
                value={form.pay_rate}
                onChange={(e) => set('pay_rate', e.target.value)}
              />
            </>
          )}

          {billingFamily(form.billing_type) === 'FEE' && (
            <Input
              label={form.billing_type === 'PERM_FEE' ? 'Placement Fee' : 'Fixed / Project Fee'}
              hint="Billed once"
              type="number"
              value={form.one_time_fee_amount}
              onChange={(e) => set('one_time_fee_amount', e.target.value)}
            />
          )}

          <Select
            label="Invoice Cycle"
            value={form.invoice_cycle}
            onChange={(e) => set('invoice_cycle', e.target.value)}
          >
            <option value="WEEKLY">Weekly</option>
            <option value="BIWEEKLY">Bi-Weekly</option>
            <option value="MONTHLY">Monthly</option>
          </Select>

          <Select
            label="Payment Terms"
            value={form.payment_terms}
            onChange={(e) => set('payment_terms', e.target.value)}
          >
            <option value="NET_15">Net 15</option>
            <option value="NET_30">Net 30</option>
            <option value="NET_45">Net 45</option>
            <option value="CUSTOM">Custom</option>
          </Select>

          <Input
            label="Custom Payment Terms Days"
            type="number"
            value={form.custom_payment_terms_days}
            onChange={(e) => set('custom_payment_terms_days', e.target.value)}
          />

          <Input
            label="PO Number"
            value={form.po_number}
            onChange={(e) => set('po_number', e.target.value)}
          />

          <Input
            label="SOW Number"
            value={form.sow_number}
            onChange={(e) => set('sow_number', e.target.value)}
          />

          <div className="form-group">
            <label className="form-label">Tax Applicable</label>
            <select
              className="form-control"
              value={form.tax_applicable ? 'true' : 'false'}
              onChange={(e) => set('tax_applicable', e.target.value === 'true')}
            >
              <option value="false">No</option>
              <option value="true">Yes</option>
            </select>
          </div>

          <Input
            label="Tax Percent"
            type="number"
            value={form.tax_percent}
            onChange={(e) => set('tax_percent', e.target.value)}
          />

          <Input
            label="Start Date"
            type="date"
            required
            value={form.start_date}
            onChange={(e) => set('start_date', e.target.value)}
          />

          <Input
            label="End Date"
            type="date"
            value={form.end_date}
            onChange={(e) => set('end_date', e.target.value)}
          />

          <div className="span-3">
            <Textarea
              label="Notes"
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              rows={3}
            />
          </div>
        </div>
      </Modal>

      <Drawer
        open={drawer.type === 'candidate'}
        onClose={closeDrawer}
        title="Quick Add Candidate"
        width={560}
        footer={(
          <>
            <button className="secondary-btn" onClick={closeDrawer}>Cancel</button>
            <button className="primary-btn" onClick={saveCandidateQuickCreate} disabled={drawerSaving}>
              {drawerSaving ? 'Saving...' : 'Save Candidate'}
            </button>
          </>
        )}
      >
        <div className="form-grid cols-2">
          <Input label="Candidate Name" required value={candidateDraft.full_name} onChange={(e) => setCandidateDraftValue('full_name', e.target.value)} />
          <Input label="Candidate Code" value={candidateDraft.candidate_code} onChange={(e) => setCandidateDraftValue('candidate_code', e.target.value.toUpperCase())} />
          <Input label="Job Title" value={candidateDraft.job_title} onChange={(e) => setCandidateDraftValue('job_title', e.target.value)} />
          <Input label="Email" type="email" value={candidateDraft.email} onChange={(e) => setCandidateDraftValue('email', e.target.value)} />
          <Input label="Phone" value={candidateDraft.phone} onChange={(e) => setCandidateDraftValue('phone', e.target.value)} />
          <SearchableSelect label="Country" value={candidateDraft.country} options={COUNTRY_NAME_OPTIONS} placeholder="Search country..." emptyMessage="No countries found" onChange={(e) => setCandidateDraftValue('country', e.target.value)} />
          <div className="span-2"><Textarea label="Skills" value={candidateDraft.skills} onChange={(e) => setCandidateDraftValue('skills', e.target.value)} rows={2} /></div>
          <div className="span-2"><Textarea label="Notes" value={candidateDraft.notes} onChange={(e) => setCandidateDraftValue('notes', e.target.value)} rows={3} /></div>
          <Select label="Status" value={candidateDraft.status} onChange={(e) => setCandidateDraftValue('status', e.target.value)}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </Select>
        </div>
      </Drawer>

      <Drawer
        open={drawer.type === 'client'}
        onClose={closeDrawer}
        title="Quick Add Client"
        width={620}
        footer={(
          <>
            <button className="secondary-btn" onClick={closeDrawer}>Cancel</button>
            <button className="primary-btn" onClick={saveClientQuickCreate} disabled={drawerSaving}>
              {drawerSaving ? 'Saving...' : 'Save Client'}
            </button>
          </>
        )}
      >
        <div className="form-grid cols-2">
          <Input label="Client Name" required value={clientDraft.client_name} onChange={(e) => setClientDraftValue('client_name', e.target.value)} />
          <Input label="Client Code" value={clientDraft.client_code} readOnly hint="Generated on save" />
          <SearchableSelect
            label="Region"
            required
            value={clientDraft.region_id}
            options={regionOptionsForPicker}
            placeholder="Search region..."
            emptyMessage="No regions found"
            createLabel="+ Add region"
            onChange={(e) => setClientDraftValue('region_id', e.target.value)}
            onCreate={(query) => openRegionDrawer(query, 'client')}
          />
          <Input label="Currency" required value={clientDraft.currency} readOnly hint="Auto selected from region" />
          <Select label="Payment Terms" value={clientDraft.default_payment_terms} onChange={(e) => setClientDraftValue('default_payment_terms', e.target.value)}>
            <option value="NET_15">Net 15</option>
            <option value="NET_30">Net 30</option>
            <option value="NET_45">Net 45</option>
          </Select>
          <Select label="Invoice Cycle" value={clientDraft.default_invoice_cycle} onChange={(e) => setClientDraftValue('default_invoice_cycle', e.target.value)}>
            <option value="WEEKLY">Weekly</option>
            <option value="BIWEEKLY">Bi-Weekly</option>
            <option value="MONTHLY">Monthly</option>
          </Select>
          <div className="span-2"><Textarea label="Billing Address" value={clientDraft.billing_address} onChange={(e) => setClientDraftValue('billing_address', e.target.value)} rows={2} /></div>
          <Input label="Tax Identifier" value={clientDraft.tax_identifier} onChange={(e) => setClientDraftValue('tax_identifier', e.target.value)} />
          <Input label="Credit Limit" type="number" value={clientDraft.credit_limit} onChange={(e) => setClientDraftValue('credit_limit', e.target.value)} />
          <Input label="Contact Name" value={clientDraft.primary_contact_name} onChange={(e) => setClientDraftValue('primary_contact_name', e.target.value)} />
          <Input label="Contact Email" type="email" value={clientDraft.primary_contact_email} onChange={(e) => setClientDraftValue('primary_contact_email', e.target.value)} />
          <Input label="Contact Phone" value={clientDraft.primary_contact_phone} onChange={(e) => setClientDraftValue('primary_contact_phone', e.target.value)} />
          <Select label="Status" value={clientDraft.status} onChange={(e) => setClientDraftValue('status', e.target.value)}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </Select>
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

      <PlacementViewModal
        placement={viewing}
        canEdit={canManagePlacements}
        onEdit={(p) => openEdit(p)}
        onOpenDetail={(p) => navigate(`/placements/${p.id}`)}
        onClose={() => setViewing(null)}
      />

      <ConfirmDialog
        open={!!deleting}
        onClose={() => !deleteLoading && setDeleting(null)}
        onConfirm={confirmDelete}
        loading={deleteLoading}
        title="Delete Placement"
        message={`Delete placement ${deleting?.placement_code || ''}? This cannot be undone. If the placement has linked invoices, deletion will be blocked.`}
      />

      {canManagePlacements && actionMenu.open && actionMenu.row && createPortal(
        <div
          className="floating-action-menu placements-action-menu"
          style={{ top: actionMenu.y, left: actionMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button className="floating-action-item" onClick={() => openView(actionMenu.row)}>
            View
          </button>
          <button className="floating-action-item" onClick={() => openEdit(actionMenu.row)}>
            Edit
          </button>
          {canDeletePlacements ? (
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
        document.body
      )}
    </div>
  )
}

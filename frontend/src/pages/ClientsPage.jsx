import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams, useNavigate } from 'react-router-dom'
import api, { downloadFile } from '../services/api'
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
  customerLabel,
  StatCard,
  DataTable,
  StatusChip,
  FilterPill,
  PanelHeader,
} from '../components/ui/index.jsx'
import { useToast } from '../context/ToastContext'
import { generateClientCode } from '../utils/clientHelpers'
import { useAuth } from '../context/AuthContext'
import { useEntity } from '../context/EntityContext'
import { ACTION_ACCESS, hasAnyRole } from '../utils/acl'
import { COUNTRIES } from '../data/countries'
import { buildRegionCode } from '../utils/regionHelpers'
import './ClientsPage.css'

/* Local inline icons (stroked 24×24, currentColor) */
const Icon = ({ d, size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
)
const BackIcon = () => <Icon d={<><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></>} />
const ImportIcon = () => <Icon d={<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></>} />
const PlusIcon = () => <Icon d={<><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>} size={16} />
const SearchIcon = () => <Icon d={<><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></>} size={16} />
const DownloadIcon = () => <Icon d={<><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></>} size={16} />
const KebabIcon = () => <Icon d={<><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></>} size={16} />

/* Icons used inside StatCards */
const AccountsIcon = () => <Icon d={<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18" /></>} size={16} />
const BalanceIcon = () => <Icon d={<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></>} size={16} />
const AlertIcon = () => <Icon d={<><circle cx="12" cy="12" r="9" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>} size={16} />
const ClockIcon = () => <Icon d={<><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></>} size={16} />

const initialsOf = (name = '') =>
  String(name).trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '—'

const parseTerms = (t) => {
  const m = /(\d+)/.exec(String(t || ''))
  return m ? Number(m[1]) : null
}

/* Open balance per client (sum of invoice balance_outstanding) is returned by
   GET /clients as `open_balance`, in the client's own currency. */
const openBalanceOf = (r) => {
  const v = r.open_balance ?? r.outstanding ?? r.balance_outstanding
  return v == null || v === '' ? null : Number(v) || 0
}

/* Small local dropdown built on the shared FilterPill primitive. */
function FilterDropdown({ label, value, options, onSelect }) {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value)
  return (
    <div className="cl-fdrop">
      <FilterPill
        active={!!value}
        dropdown
        value={value ? current?.label : ''}
        onClick={() => setOpen((v) => !v)}
      >
        {value ? label : (options[0]?.label || label)}
      </FilterPill>
      {open ? (
        <>
          <div className="cl-fdrop-overlay" onClick={() => setOpen(false)} />
          <div className="cl-fdrop-menu">
            {options.map((o) => (
              <button
                key={o.value || '__all'}
                type="button"
                className={`cl-fdrop-item${o.value === value ? ' is-on' : ''}`}
                onClick={() => { onSelect(o.value); setOpen(false) }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  )
}

const BLANK = {
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

export default function ClientsPage() {
  const toast = useToast()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { user } = useAuth()
  const roleName = user?.roleName
  const canManageClients = hasAnyRole(roleName, ACTION_ACCESS.clients.manage)
  const canDeleteClients = hasAnyRole(roleName, ACTION_ACCESS.clients.delete)

  const [rows, setRows] = useState([])
  const [reportingCurrency, setReportingCurrency] = useState('USD')
  const [regions, setRegions] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [currencyFilter, setCurrencyFilter] = useState('')
  // Region is driven by the global top-nav switcher (no per-page dropdown).
  const { entityId: regionFilter } = useEntity()
  const [tab, setTab] = useState('all')
  const [selectedId, setSelectedId] = useState(null)
  const [modal, setModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [viewing, setViewing] = useState(null)
  const [form, setForm] = useState(BLANK)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [actionMenu, setActionMenu] = useState({ open: false, x: 0, y: 0, row: null })
  const [regionDrawerOpen, setRegionDrawerOpen] = useState(false)
  const [regionDraft, setRegionDraft] = useState(BLANK_REGION_FORM)
  const [drawerSaving, setDrawerSaving] = useState(false)

  const load = async () => {
    try {
      setLoading(true)
      const [c, r] = await Promise.all([api.get('/clients'), api.get('/regions')])
      setRows(c.data.data || [])
      setReportingCurrency(c.data?.reporting_currency || 'USD')
      setRegions(r.data.data || [])
    } catch {
      toast.error('Failed to load clients')
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

  const regionById = useMemo(() => {
    const map = {}
    regions.forEach((r) => {
      map[String(r.id)] = r
    })
    return map
  }, [regions])

  const regionOptions = useMemo(() => (
    regions.map((region) => ({
      value: String(region.id),
      label: region.region_name,
      meta: [region.country_name, region.default_currency].filter(Boolean).join(' • '),
      searchText: `${region.region_code || ''} ${region.company_name || ''}`.trim(),
    }))
  ), [regions])

  const countryOptions = useMemo(() => (
    COUNTRIES.map((country) => ({
      value: country.iso2,
      label: country.name,
      meta: `${country.currency} • ${country.symbol}`,
      searchText: `${country.iso2} ${country.currency}`.trim(),
    }))
  ), [])

  const previewClientCode = !editing ? generateClientCode(form.client_name) : form.client_code

  const openCreate = () => {
    setEditing(null)
    setViewing(null)
    setForm(BLANK)
    setModal(true)
  }

  useEffect(() => {
    if (searchParams.get('action') !== 'create' || !canManageClients) return
    openCreate()
    setSearchParams({}, { replace: true })
  }, [searchParams, setSearchParams, canManageClients])

  const openEdit = (row) => {
    setEditing(row)
    setViewing(null)
    setForm({
      ...BLANK,
      ...row,
      region_id: row.region_id ? String(row.region_id) : '',
      credit_limit: row.credit_limit != null ? String(row.credit_limit) : '0',
      client_code: row.client_code || '',
      currency: row.currency || row.region_currency || 'USD',
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

      if (key === 'region_id') {
        const selectedRegion = regionById[String(value)]
        if (selectedRegion?.default_currency) {
          next.currency = selectedRegion.default_currency
        }
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

  const openRegionDrawer = (initialName = '') => {
    setDrawerSaving(false)
    setRegionDraft({
      ...BLANK_REGION_FORM,
      region_name: String(initialName || '').trim(),
      region_code: buildRegionCode(initialName),
      default_currency: form.currency || 'USD',
    })
    setRegionDrawerOpen(true)
  }

  const closeRegionDrawer = () => {
    setRegionDrawerOpen(false)
    setDrawerSaving(false)
  }

  const save = async () => {
    if (!form.client_name || !form.region_id || !form.currency) {
      toast.error('Name, region and currency required')
      return
    }

    const payload = {
      ...form,
      client_code: editing ? form.client_code : '',
    }

    setSaving(true)
    try {
      if (editing) {
        await api.put(`/clients/${editing.id}`, payload)
      } else {
        await api.post('/clients', payload)
      }
      toast.success(`Client ${editing ? 'updated' : 'created'} successfully`)
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
      set('region_id', String(created.id))
      toast.success('Region created successfully')
      closeRegionDrawer()
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
      await api.delete(`/clients/${deleting.id}`)
      toast.success('Client deleted successfully')
      setDeleting(null)
      load()
    } catch (e) {
      toast.error(e.response?.data?.message || 'Delete failed')
    } finally {
      setDeleteLoading(false)
    }
  }

  const exportStatement = async (row) => {
    try {
      await downloadFile(
        `/reports/exports/client-statement?client_id=${row.id}`,
        `client_statement_${row.client_code || row.id}.csv`,
      )
      toast.success('Client statement exported')
    } catch (e) {
      toast.error(e.response?.data?.message || 'Failed to export statement')
    } finally {
      setActionMenu({ open: false, x: 0, y: 0, row: null })
    }
  }

  const isOverLimit = (r) => {
    const ob = openBalanceOf(r)
    return ob != null && ob > Number(r.credit_limit || 0)
  }

  const filtered = rows.filter((r) => {
    const q = search.toLowerCase()
    const matchSearch =
      !q ||
      String(r.client_name || '').toLowerCase().includes(q) ||
      String(r.client_code || '').toLowerCase().includes(q)

    const matchStatus = !statusFilter || r.status === statusFilter
    const matchRegion = !regionFilter || String(r.region_id) === String(regionFilter)
    const matchCurrency = !currencyFilter || String(r.currency) === String(currencyFilter)
    return matchSearch && matchStatus && matchRegion && matchCurrency
  })

  const tabCounts = useMemo(() => ({
    all: filtered.length,
    active: filtered.filter((r) => String(r.status || '').toUpperCase() === 'ACTIVE').length,
    over: filtered.filter(isOverLimit).length,
  }), [filtered])

  const visibleRows = useMemo(() => {
    if (tab === 'active') return filtered.filter((r) => String(r.status || '').toUpperCase() === 'ACTIVE')
    if (tab === 'over') return filtered.filter(isOverLimit)
    return filtered
  }, [filtered, tab])

  // Consolidated (All regions) → sum the backend's group-currency
  // open_balance_reporting so mixed-currency receivables aren't added raw.
  // A single region → native open_balance (all one currency).
  const consolidated = !regionFilter
  const kpiCcy = consolidated
    ? reportingCurrency
    : (filtered[0]?.currency || filtered[0]?.region_currency || reportingCurrency)

  const clientStats = useMemo(() => {
    const active = tabCounts.active
    const kpiBal = (r) => {
      const v = consolidated ? (r.open_balance_reporting ?? r.open_balance) : r.open_balance
      return v == null || v === '' ? null : Number(v) || 0
    }
    const balances = filtered.map(kpiBal).filter((v) => v != null)
    const openBalanceTotal = balances.length ? balances.reduce((s, v) => s + v, 0) : null
    const overLimit = tabCounts.over
    const termVals = filtered.map((r) => parseTerms(r.default_payment_terms)).filter((v) => v != null)
    const avgTerms = termVals.length ? Math.round(termVals.reduce((s, v) => s + v, 0) / termVals.length) : null
    return { total: filtered.length, active, openBalanceTotal, overLimit, avgTerms }
  }, [filtered, tabCounts, consolidated])
  // A client's currency is its region's currency, so Currency and Region are
  // two views of the same axis. Cross-filter their option lists (and auto-clear
  // a conflicting selection) so you can never pick an impossible pair like
  // "₹ INR" + a USD region and land on an empty table.
  const regionCurrencyById = useMemo(() => {
    const map = {}
    regions.forEach((r) => { if (r.default_currency) map[String(r.id)] = String(r.default_currency) })
    return map
  }, [regions])

  const currencyOptions = useMemo(() => {
    let uniq = Array.from(new Set(rows.map((r) => r.currency).filter(Boolean)))
    if (regionFilter) {
      const ccy = regionCurrencyById[String(regionFilter)]
      uniq = ccy ? uniq.filter((c) => c === ccy) : uniq
    }
    return [{ value: '', label: 'All currencies' }, ...uniq.map((c) => ({ value: c, label: `${currencySymbol(c)} ${c}` }))]
  }, [rows, regionFilter, regionCurrencyById])

  const selectCurrencyFilter = (v) => setCurrencyFilter(v)

  const activeFilterCount = [statusFilter, currencyFilter, search].filter(Boolean).length

  const openBalanceTotalLabel = clientStats.openBalanceTotal == null
    ? '—'
    : fmt(clientStats.openBalanceTotal, kpiCcy)

  const regionCount = useMemo(
    () => new Set(rows.map((r) => r.region_id).filter((v) => v != null)).size,
    [rows],
  )

  const columns = [
    {
      key: 'client_name',
      header: (customerLabel() || 'Client').toUpperCase(),
      primary: true,
      render: (r) => (
        <span className="cl-client">
          <span className="cl-avatar">{initialsOf(r.client_name)}</span>
          <span>{r.client_name}</span>
        </span>
      ),
    },
    { key: 'client_code', header: 'CODE', mono: true, render: (r) => r.client_code || '—' },
    { key: 'region_name', header: 'REGION', render: (r) => r.region_name || '—' },
    { key: 'default_payment_terms', header: 'TERMS', mono: true, render: (r) => r.default_payment_terms || '—' },
    { key: 'default_invoice_cycle', header: 'CYCLE', render: (r) => r.default_invoice_cycle || '—' },
    {
      key: 'credit_limit',
      header: 'CREDIT LIMIT',
      align: 'right',
      mono: true,
      render: (r) => fmt(r.credit_limit, r.currency),
    },
    {
      key: 'open_balance',
      header: 'OPEN BALANCE',
      align: 'right',
      mono: true,
      render: (r) => {
        const ob = openBalanceOf(r)
        if (ob == null) return '—'
        return <span className={isOverLimit(r) ? 'cl-over' : undefined}>{fmt(ob, r.currency)}</span>
      },
    },
    {
      key: 'status',
      header: 'STATUS',
      render: (r) => (
        isOverLimit(r)
          ? <StatusChip tone="danger">OVER LIMIT</StatusChip>
          : <StatusChip tone={String(r.status).toUpperCase() === 'ACTIVE' ? 'success' : 'neutral'}>{r.status}</StatusChip>
      ),
    },
    ...(canManageClients ? [{
      key: '_actions',
      header: '',
      align: 'right',
      width: 44,
      render: (r) => (
        <button
          type="button"
          className="cl-rowkebab"
          onClick={(e) => openActionMenu(e, r)}
          aria-label="Row actions"
        >
          <KebabIcon />
        </button>
      ),
    }] : []),
  ]

  return (
    <div className="dashboard-page clients-page cl-page">
      <div className="cl-head">
        <div className="cl-head-left">
          <button type="button" className="cl-back" onClick={() => navigate('/dashboard')} aria-label="Back to dashboard">
            <BackIcon />
          </button>
          <div>
            <div className="cl-title">{customerLabel() || 'Client'}s</div>
            <div className="cl-subtitle">
              {rows.length} billing accounts across {regionCount || 'multiple'} regions. Credit limits, terms and open balance at a glance.
            </div>
          </div>
        </div>
        <div className="cl-head-actions">
          <button
            type="button"
            className="cl-btn cl-btn-secondary"
            onClick={() => toast.info('Bulk import is not available yet')}
          >
            <ImportIcon /> Import
          </button>
          {canManageClients ? (
            <button type="button" className="cl-btn cl-btn-primary" onClick={openCreate}>
              <PlusIcon /> Add {(customerLabel() || 'client').toLowerCase()}
            </button>
          ) : null}
        </div>
      </div>

      <div className="cl-kpis">
        <StatCard
          label="Active clients"
          value={clientStats.active.toLocaleString('en-US')}
          sub={`${clientStats.total.toLocaleString('en-US')} total accounts`}
          icon={<AccountsIcon />}
        />
        <StatCard
          label="Open balance"
          value={clientStats.openBalanceTotal == null ? '—' : Number(clientStats.openBalanceTotal).toLocaleString('en-US', { maximumFractionDigits: 0 })}
          prefix={clientStats.openBalanceTotal == null ? undefined : currencySymbol(kpiCcy)}
          sub={consolidated ? `Converted to ${kpiCcy}` : `In ${kpiCcy}`}
          icon={<BalanceIcon />}
        />
        <StatCard
          label="Over credit limit"
          value={clientStats.overLimit.toLocaleString('en-US')}
          sub={clientStats.overLimit ? 'Needs attention' : 'All within limit'}
          icon={<AlertIcon />}
          accent={clientStats.overLimit > 0}
        />
        <StatCard
          label="Avg. payment terms"
          value={clientStats.avgTerms == null ? '—' : clientStats.avgTerms}
          unit={clientStats.avgTerms == null ? undefined : 'days'}
          sub="NET_30 is the default"
          icon={<ClockIcon />}
        />
      </div>

      <div className="cl-filters">
        <span className="cl-filter-count">Active filters<b>{activeFilterCount}</b></span>
        <FilterDropdown
          label="Status"
          value={statusFilter}
          onSelect={(v) => setStatusFilter(v)}
          options={[
            { value: '', label: 'All status' },
            { value: 'ACTIVE', label: 'Active' },
            { value: 'INACTIVE', label: 'Inactive' },
          ]}
        />
        <FilterDropdown
          label="Currency"
          value={currencyFilter}
          onSelect={selectCurrencyFilter}
          options={currencyOptions}
        />
        <div className="cl-search">
          <input
            placeholder="Search client or code"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <SearchIcon />
        </div>
      </div>

      <div className="cl-panel">
        <PanelHeader
          title={`All ${(customerLabel() || 'client').toLowerCase()}s`}
          tabs={[
            { key: 'all', label: 'All', count: tabCounts.all },
            { key: 'active', label: 'Active', count: tabCounts.active },
            { key: 'over', label: 'Over limit', count: tabCounts.over },
          ]}
          activeTab={tab}
          onTab={setTab}
          actions={(
            <div className="cl-panel-tools">
              <button type="button" className="cl-iconbtn" style={{ width: 36, height: 36 }} aria-label="Download"><DownloadIcon /></button>
              <button type="button" className="cl-iconbtn" style={{ width: 36, height: 36 }} aria-label="More"><KebabIcon /></button>
            </div>
          )}
        />
        <DataTable
          columns={columns}
          rows={visibleRows}
          paginate
          pageLabel="clients"
          loading={loading}
          getRowId={(r) => r.id}
          selectedId={selectedId}
          onRowSelect={(r) => { setSelectedId(r.id); navigate(`/clients/${r.id}`) }}
          subLine={(r) => (
            r.primary_contact_name || r.primary_contact_email
              ? `${r.primary_contact_name || ''}${r.primary_contact_name && r.primary_contact_email ? ' · ' : ''}${r.primary_contact_email || ''}`
              : null
          )}
          empty={`No ${(customerLabel() || 'client').toLowerCase()}s found`}
          footer={[
            { colSpan: 6, align: 'left', render: () => `Showing ${visibleRows.length} of ${rows.length}${consolidated ? ` · converted to ${kpiCcy}` : ''}` },
            { colSpan: 1, align: 'right', mono: true, render: () => openBalanceTotalLabel },
            { colSpan: canManageClients ? 2 : 1, render: () => null },
          ]}
        />
      </div>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title={editing ? 'Edit Client' : 'New Client'}
        maxWidth={760}
        modalClassName="clients-modal-card"
        footer={(
          <div className="clients-modal-actions">
            <button className="secondary-btn" onClick={() => setModal(false)}>Cancel</button>
            <button className="primary-btn" onClick={save} disabled={saving}>
              {saving ? 'Saving...' : 'Save Client'}
            </button>
          </div>
        )}
      >
        <div className="form-grid cols-2">
          <Input
            label="Client Name"
            required
            value={form.client_name}
            onChange={(e) => set('client_name', e.target.value)}
          />

          <Input
            label="Client Code"
            value={previewClientCode}
            readOnly
            hint={editing ? 'Stored client code' : 'Preview only. Final unique code is generated on save'}
          />

          <SearchableSelect
            label="Region"
            required
            value={form.region_id}
            options={regionOptions}
            placeholder="Search region..."
            emptyMessage="No regions found"
            createLabel="+ Add region"
            onChange={(e) => set('region_id', e.target.value)}
            onCreate={(query) => openRegionDrawer(query)}
          />

          <Input
            label="Currency"
            required
            value={form.currency}
            readOnly
            hint="Auto selected from region"
          />

          <Select
            label="Default Payment Terms"
            value={form.default_payment_terms}
            onChange={(e) => set('default_payment_terms', e.target.value)}
          >
            <option value="NET_15">Net 15</option>
            <option value="NET_30">Net 30</option>
            <option value="NET_45">Net 45</option>
          </Select>

          <Select
            label="Default Invoice Cycle"
            value={form.default_invoice_cycle}
            onChange={(e) => set('default_invoice_cycle', e.target.value)}
          >
            <option value="WEEKLY">Weekly</option>
            <option value="BIWEEKLY">Bi-Weekly</option>
            <option value="MONTHLY">Monthly</option>
          </Select>

          <div className="span-2">
            <Textarea
              label="Billing Address"
              value={form.billing_address}
              onChange={(e) => set('billing_address', e.target.value)}
              rows={2}
            />
          </div>

          <Input
            label="Tax Identifier"
            value={form.tax_identifier}
            onChange={(e) => set('tax_identifier', e.target.value)}
            placeholder="GST/VAT/EIN..."
          />

          <Input
            label="Credit Limit"
            type="number"
            value={form.credit_limit}
            onChange={(e) => set('credit_limit', e.target.value)}
          />

          <div className="span-2 form-section">Primary Contact</div>

          <Input
            label="Contact Name"
            value={form.primary_contact_name}
            onChange={(e) => set('primary_contact_name', e.target.value)}
          />

          <Input
            label="Contact Email"
            type="email"
            value={form.primary_contact_email}
            onChange={(e) => set('primary_contact_email', e.target.value)}
          />

          <Input
            label="Contact Phone"
            value={form.primary_contact_phone}
            onChange={(e) => set('primary_contact_phone', e.target.value)}
          />

          <Select
            label="Status"
            value={form.status}
            onChange={(e) => set('status', e.target.value)}
          >
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </Select>
        </div>
      </Modal>

      <Drawer
        open={regionDrawerOpen}
        onClose={closeRegionDrawer}
        title="Quick Add Region"
        width={520}
        footer={(
          <>
            <button className="secondary-btn" onClick={closeRegionDrawer}>Cancel</button>
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
          <div className="span-2">
            <Textarea label="Company Address" value={regionDraft.company_address} onChange={(e) => setRegionDraftValue('company_address', e.target.value)} rows={3} />
          </div>
        </div>
      </Drawer>

      <Modal
        open={!!viewing}
        onClose={() => setViewing(null)}
        title="View Client"
        maxWidth={760}
        modalClassName="clients-modal-card clients-modal-view-card"
        footer={(
          <div className="clients-modal-actions">
            {canManageClients && viewing ? (
              <button className="secondary-btn" onClick={() => openEdit(viewing)}>Edit</button>
            ) : null}
            <button className="primary-btn" onClick={() => setViewing(null)}>Close</button>
          </div>
        )}
      >
        {viewing && (
          <div className="form-grid cols-2">
            <Input label="Client Name" value={viewing.client_name || ''} readOnly />
            <Input label="Client Code" value={viewing.client_code || ''} readOnly />
            <Input label="Region" value={viewing.region_name || ''} readOnly />
            <Input label="Currency" value={`${currencySymbol(viewing.currency)} ${viewing.currency || ''}`} readOnly />
            <Input label="Default Payment Terms" value={viewing.default_payment_terms || ''} readOnly />
            <Input label="Default Invoice Cycle" value={viewing.default_invoice_cycle || ''} readOnly />
            <div className="span-2">
              <Textarea label="Billing Address" value={viewing.billing_address || ''} readOnly rows={2} />
            </div>
            <Input label="Tax Identifier" value={viewing.tax_identifier || ''} readOnly />
            <Input label="Credit Limit" value={String(viewing.credit_limit ?? '')} readOnly />
            <div className="span-2 form-section">Primary Contact</div>
            <Input label="Contact Name" value={viewing.primary_contact_name || ''} readOnly />
            <Input label="Contact Email" value={viewing.primary_contact_email || ''} readOnly />
            <Input label="Contact Phone" value={viewing.primary_contact_phone || ''} readOnly />
            <Input label="Status" value={viewing.status || ''} readOnly />
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => !deleteLoading && setDeleting(null)}
        onConfirm={confirmDelete}
        loading={deleteLoading}
        title="Delete Client"
        message={`Delete client ${deleting?.client_name || ''}? This cannot be undone. If the client has linked placements or invoices, deletion will be blocked.`}
      />

      {canManageClients && actionMenu.open && actionMenu.row && createPortal(
        <div
          className="floating-action-menu clients-action-menu"
          style={{ top: actionMenu.y, left: actionMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button className="floating-action-item" onClick={() => openView(actionMenu.row)}>
            View
          </button>
          <button className="floating-action-item" onClick={() => openEdit(actionMenu.row)}>
            Edit
          </button>
          <button className="floating-action-item" onClick={() => exportStatement(actionMenu.row)}>
            Export Statement
          </button>
          {canDeleteClients ? (
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

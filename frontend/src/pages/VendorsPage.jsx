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
  currencySymbol,
} from '../components/ui/index.jsx'
import StatCard from '../components/common/StatCard'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import { useEntity } from '../context/EntityContext'
import { ACTION_ACCESS, hasAnyRole } from '../utils/acl'
import { useRegionCurrencyFilter } from '../utils/useRegionCurrencyFilter'
import { useResizableColumns } from '../utils/useResizableColumns'
import { COUNTRIES, COUNTRY_BY_NAME } from '../data/countries'
import { buildRegionCode } from '../utils/regionHelpers'

const BLANK = {
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

export default function VendorsPage() {
  const toast = useToast()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { user } = useAuth()
  const roleName = user?.roleName
  const canManage = hasAnyRole(roleName, ACTION_ACCESS.vendors.manage)
  const canDelete = hasAnyRole(roleName, ACTION_ACCESS.vendors.delete)

  const [rows, setRows] = useState([])
  const [regions, setRegions] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [vsort, setVsort] = useState(null)
  const [statusFilter, setStatusFilter] = useState('')
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
  const [statusMenu, setStatusMenu] = useState({ open: false, x: 0, y: 0, row: null })
  const [statusSaving, setStatusSaving] = useState(false)
  const [regionDrawerOpen, setRegionDrawerOpen] = useState(false)
  const [regionDraft, setRegionDraft] = useState(BLANK_REGION_FORM)
  const [drawerSaving, setDrawerSaving] = useState(false)

  const load = async () => {
    try {
      setLoading(true)
      const [vendorRes, regionRes] = await Promise.all([api.get('/vendors'), api.get('/regions')])
      setRows(vendorRes.data?.data || [])
      setRegions(regionRes.data?.data || [])
    } catch (error) {
      toast.error(error.response?.data?.message || 'Failed to load vendors')
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
      setStatusMenu({ open: false, x: 0, y: 0, row: null })
    }
    const onKey = (e) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const regionById = useMemo(() => {
    const map = {}
    regions.forEach((region) => {
      map[String(region.id)] = region
    })
    return map
  }, [regions])

  // Currencies offered for a vendor, scoped to the selected region: the entity's
  // book (functional) currency, its suggested default, the region's country
  // currency, plus USD (group/reporting). For TetriQ-UK this yields GBP + USD.
  const currencyOptions = useMemo(() => {
    const region = regionById[String(form.region_id)]
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
    add(form.currency)
    add('USD')
    return list
  }, [regionById, form.region_id, form.currency])

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

  const openCreate = () => {
    setEditing(null)
    setViewing(null)
    setForm(BLANK)
    setModal(true)
  }

  useEffect(() => {
    if (searchParams.get('action') !== 'create' || !canManage) return
    openCreate()
    setSearchParams({}, { replace: true })
  }, [searchParams, setSearchParams, canManage])

  const openEdit = (row) => {
    setEditing(row)
    setViewing(null)
    setForm({
      ...BLANK,
      ...row,
      region_id: row.region_id ? String(row.region_id) : '',
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

  const openStatusMenu = (event, row) => {
    event.stopPropagation()
    if (!canManage) return
    const rect = event.currentTarget.getBoundingClientRect()
    // Toggle closed if the same row's menu is already open.
    if (statusMenu.open && String(statusMenu.row?.id) === String(row.id)) {
      setStatusMenu({ open: false, x: 0, y: 0, row: null })
      return
    }
    const menuWidth = 170
    const pad = 12
    const left = Math.min(Math.max(rect.left, pad), window.innerWidth - menuWidth - pad)
    setActionMenu({ open: false, x: 0, y: 0, row: null })
    setStatusMenu({ open: true, x: left, y: rect.bottom + 6, row })
  }

  const changeVendorStatus = async (row, nextStatus) => {
    if (!row || !canManage) return
    const current = String(row.status || '').toUpperCase()
    setStatusMenu({ open: false, x: 0, y: 0, row: null })
    if (current === nextStatus) return
    setStatusSaving(true)
    try {
      // The update endpoint merges { ...current, ...body }, so a partial body
      // with just the status is safe and preserves every other vendor field.
      await api.put(`/vendors/${row.id}`, { status: nextStatus })
      toast.success(`Vendor marked ${nextStatus === 'ACTIVE' ? 'active' : 'inactive'}`)
      load()
    } catch (error) {
      toast.error(error.response?.data?.message || 'Failed to update status')
    } finally {
      setStatusSaving(false)
    }
  }

  const set = (key, value) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'region_id') {
        const region = regionById[String(value)]
        // Vendors/AP default to the entity's book (functional) currency — that's
        // what consultants are paid in (e.g. GBP for TetriQ-UK). Fall back to the
        // region's default_currency when no functional currency is set.
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
    if (!form.vendor_name || !form.region_id) {
      toast.error('Vendor name and region are required')
      return
    }
    setSaving(true)
    try {
      if (editing) {
        await api.put(`/vendors/${editing.id}`, form)
      } else {
        await api.post('/vendors', form)
      }
      toast.success(`Vendor ${editing ? 'updated' : 'created'} successfully`)
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
      await api.delete(`/vendors/${deleting.id}`)
      toast.success('Vendor deleted successfully')
      setDeleting(null)
      load()
    } catch (error) {
      toast.error(error.response?.data?.message || 'Delete failed')
    } finally {
      setDeleteLoading(false)
    }
  }

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
    const matchSearch = !needle || [row.vendor_name, row.vendor_code, row.primary_contact_name]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle))
    const matchStatus = !statusFilter || row.status === statusFilter
    const matchRegion = !regionFilter || String(row.region_id) === String(regionFilter)
    const matchCurrency = !currencyFilter || String(row.currency || '').toUpperCase() === currencyFilter
    return matchSearch && matchStatus && matchRegion && matchCurrency
  })

  // Column sorting for the vendors table.
  const vHeaders = [
    { label: 'Vendor', key: 'vendor_name' },
    { label: 'Code', key: 'vendor_code' },
    { label: 'Region', key: 'region_name' },
    { label: 'Currency', key: 'currency' },
    { label: 'Contact', key: 'primary_contact_name' },
    { label: 'Terms', key: 'default_payment_terms' },
    { label: 'Status', key: 'status' },
    { label: 'Actions', key: null },
  ]
  const rz = useResizableColumns(vHeaders.length, 'rz:vendors')
  const sortedVendors = useMemo(() => {
    if (!vsort || !vsort.key) return filtered
    const cmp = (a, b) => {
      const ea = a === null || a === undefined || a === ''
      const eb = b === null || b === undefined || b === ''
      if (ea && eb) return 0
      if (ea) return 1
      if (eb) return -1
      return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
    }
    const dir = vsort.dir === 'desc' ? -1 : 1
    return [...filtered].sort((x, y) => dir * cmp(x[vsort.key], y[vsort.key]))
  }, [filtered, vsort])
  const toggleVsort = (key) => {
    if (!key) return
    setVsort((p) => (!p || p.key !== key ? { key, dir: 'asc' } : { key, dir: p.dir === 'asc' ? 'desc' : 'asc' }))
  }

  const { pageRows, paginationProps } = usePagination(sortedVendors, {
    resetKey: `${search}|${statusFilter}|${regionFilter}`,
  })

  const stats = useMemo(() => {
    const active = filtered.filter((row) => String(row.status || '').toUpperCase() === 'ACTIVE').length
    const withBanking = filtered.filter((row) => row.bank_account_number || row.bank_name).length
    return { total: filtered.length, active, withBanking }
  }, [filtered])

  return (
    <div className="dashboard-page vendors-page">
      <div className="page-header">
        <div className="page-head-left">
          <button type="button" className="page-back" onClick={() => navigate('/dashboard')} aria-label="Back to dashboard">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
          </button>
          <div>
            <div className="page-title">Vendors</div>
            <div className="page-subtitle">Manage suppliers, contacts, and payment defaults</div>
          </div>
        </div>
        <div className="page-actions">
          {canManage ? <button className="primary-btn" onClick={openCreate}>+ Add Vendor</button> : null}
        </div>
      </div>

      <div className="table-card glass-card">
        <div className="table-toolbar">
          <input className="search-input" placeholder="Search vendors..." value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="filter-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All Status</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </select>
          <select className="filter-select" value={currencyFilter} onChange={(e) => selectCurrency(e.target.value)}>
            <option value="">All Currencies</option>
            {visibleCurrencies.map((code) => (
              <option key={code} value={code}>{currencySymbol(code)} {code}</option>
            ))}
          </select>
          <button type="button" className="secondary-btn" onClick={() => {
            setSearch('')
            setStatusFilter('')
            setCurrencyFilter('')
          }}>
            Reset
          </button>
          <span className="text-muted text-sm" style={{ marginLeft: 'auto' }}>{filtered.length} vendors</span>
        </div>

        <div className="stats-grid stats-grid-three">
          <StatCard label="Total Vendors" value={stats.total.toLocaleString('en-US')} hint="All configured suppliers" />
          <StatCard label="Active Vendors" value={stats.active.toLocaleString('en-US')} hint="Ready for bills and payments" tone="success" />
          <StatCard label="Bank Details Ready" value={stats.withBanking.toLocaleString('en-US')} hint="Vendors with payout info" tone="info" />
        </div>

        <div className="table-wrap">
          <table className="saas-table" ref={rz.tableRef} style={rz.tableStyle}>
            {rz.colgroup}
            <thead>
              <tr>
                {vHeaders.map((h, i) => {
                  const active = vsort && vsort.key === h.key ? vsort.dir : null
                  return (
                    <th
                      key={h.label}
                      onClick={h.key ? () => toggleVsort(h.key) : undefined}
                      style={h.key ? { cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' } : undefined}
                      aria-sort={active ? (active === 'asc' ? 'ascending' : 'descending') : undefined}
                    >
                      {h.label}
                      {h.key ? (
                        <span style={{ marginLeft: 5, opacity: active ? 1 : 0.4, color: active ? 'var(--accent-text)' : undefined }}>
                          {active ? (active === 'asc' ? '▲' : '▼') : '↕'}
                        </span>
                      ) : null}
                      {rz.handle(i)}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonRows cols={8} />
              ) : sortedVendors.length === 0 ? (
                <tr className="empty-row"><td colSpan={8}>No vendors found</td></tr>
              ) : pageRows.map((row) => (
                <tr key={row.id}>
                  <td className="fw-bold"><Link to={`/vendors/${row.id}`} style={{ color: 'var(--primary)', textDecoration: 'none' }}>{row.vendor_name}</Link></td>
                  <td><span className="badge badge-gray">{row.vendor_code || '-'}</span></td>
                  <td className="td-muted">{row.region_name || '-'}</td>
                  <td className="td-mono">{currencySymbol(row.currency)} {row.currency}</td>
                  <td>
                    <div style={{ fontSize: 12 }}>
                      <div>{row.primary_contact_name || '-'}</div>
                      <div className="text-muted">{row.primary_contact_email || '-'}</div>
                    </div>
                  </td>
                  <td>{String(row.default_payment_terms || 'NET_30').replace(/_/g, ' ')}</td>
                  <td>
                    {canManage ? (
                      <button
                        type="button"
                        onClick={(e) => openStatusMenu(e, row)}
                        title="Change status"
                        disabled={statusSaving}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          background: 'transparent',
                          border: '1px solid transparent',
                          borderRadius: 8,
                          padding: '2px 4px',
                          cursor: statusSaving ? 'wait' : 'pointer',
                        }}
                      >
                        <Badge value={row.status} />
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.55 }} aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
                      </button>
                    ) : (
                      <Badge value={row.status} />
                    )}
                  </td>
                  <td>
                    <div className="td-actions">
                      {canManage ? <button className="clients-kebab-btn" onClick={(e) => openActionMenu(e, row)}>...</button> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && sortedVendors.length > 0 && (
            <Pagination {...paginationProps} label="vendors" />
          )}
        </div>
      </div>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title={editing ? 'Edit Vendor' : 'New Vendor'}
        maxWidth={760}
        modalClassName="clients-modal-card"
        footer={(
          <div className="clients-modal-actions">
            <button className="secondary-btn" onClick={() => setModal(false)}>Cancel</button>
            <button className="primary-btn" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save Vendor'}</button>
          </div>
        )}
      >
        <div className="form-grid cols-2">
          <Input label="Vendor Name" required value={form.vendor_name} onChange={(e) => set('vendor_name', e.target.value)} />
          <Input label="Vendor Code" value={form.vendor_code} onChange={(e) => set('vendor_code', e.target.value.toUpperCase())} hint="Leave blank to auto-generate" />
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
          <Select
            label="Currency"
            required
            value={form.currency}
            onChange={(e) => set('currency', e.target.value)}
            disabled={!form.region_id}
            hint={form.region_id ? 'Defaults to the entity book currency; change if this vendor is billed in another currency' : 'Select a region first'}
          >
            {currencyOptions.map((code) => (
              <option key={code} value={code}>{currencySymbol(code)} {code}</option>
            ))}
          </Select>
          <Select label="Default Payment Terms" value={form.default_payment_terms} onChange={(e) => set('default_payment_terms', e.target.value)}>
            <option value="NET_15">Net 15</option>
            <option value="NET_30">Net 30</option>
            <option value="NET_45">Net 45</option>
          </Select>
          <Select label="Status" value={form.status} onChange={(e) => set('status', e.target.value)}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </Select>
          <div className="span-2">
            <Textarea label="Billing Address" value={form.billing_address} onChange={(e) => set('billing_address', e.target.value)} rows={2} />
          </div>
          <Input label="Tax Identifier" value={form.tax_identifier} onChange={(e) => set('tax_identifier', e.target.value)} />
          <Input label="Bank Name" value={form.bank_name} onChange={(e) => set('bank_name', e.target.value)} />
          <Input label="Bank Account Name" value={form.bank_account_name} onChange={(e) => set('bank_account_name', e.target.value)} />
          <Input label="Bank Account Number" value={form.bank_account_number} onChange={(e) => set('bank_account_number', e.target.value)} />
          <Input label="Routing Number" value={form.bank_routing_number} onChange={(e) => set('bank_routing_number', e.target.value)} />
          <Input label="SWIFT / IFSC" value={form.bank_swift_ifsc} onChange={(e) => set('bank_swift_ifsc', e.target.value)} />
          <div className="span-2 form-section">Primary Contact</div>
          <Input label="Contact Name" value={form.primary_contact_name} onChange={(e) => set('primary_contact_name', e.target.value)} />
          <Input label="Contact Email" type="email" value={form.primary_contact_email} onChange={(e) => set('primary_contact_email', e.target.value)} />
          <Input label="Contact Phone" value={form.primary_contact_phone} onChange={(e) => set('primary_contact_phone', e.target.value)} />
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
        title="View Vendor"
        maxWidth={760}
        modalClassName="clients-modal-card"
        footer={(
          <div className="clients-modal-actions">
            {canManage && viewing ? (
              <button className="secondary-btn" onClick={() => openEdit(viewing)}>Edit</button>
            ) : null}
            <button className="primary-btn" onClick={() => setViewing(null)}>Close</button>
          </div>
        )}
      >
        {viewing ? (
          <div className="form-grid cols-2">
            <Input label="Vendor Name" value={viewing.vendor_name || ''} readOnly />
            <Input label="Vendor Code" value={viewing.vendor_code || ''} readOnly />
            <Input label="Region" value={viewing.region_name || ''} readOnly />
            <Input label="Currency" value={`${currencySymbol(viewing.currency)} ${viewing.currency || ''}`} readOnly />
            <Input label="Default Payment Terms" value={viewing.default_payment_terms || ''} readOnly />
            <Input label="Status" value={viewing.status || ''} readOnly />
            <div className="span-2"><Textarea label="Billing Address" value={viewing.billing_address || ''} readOnly rows={2} /></div>
            <Input label="Tax Identifier" value={viewing.tax_identifier || ''} readOnly />
            <Input label="Bank Name" value={viewing.bank_name || ''} readOnly />
            <Input label="Bank Account Name" value={viewing.bank_account_name || ''} readOnly />
            <Input label="Bank Account Number" value={viewing.bank_account_number || ''} readOnly />
            <Input label="Routing Number" value={viewing.bank_routing_number || ''} readOnly />
            <Input label="SWIFT / IFSC" value={viewing.bank_swift_ifsc || ''} readOnly />
            <div className="span-2 form-section">Primary Contact</div>
            <Input label="Contact Name" value={viewing.primary_contact_name || ''} readOnly />
            <Input label="Contact Email" value={viewing.primary_contact_email || ''} readOnly />
            <Input label="Contact Phone" value={viewing.primary_contact_phone || ''} readOnly />
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => !deleteLoading && setDeleting(null)}
        onConfirm={confirmDelete}
        loading={deleteLoading}
        title="Delete Vendor"
        message={`Delete vendor ${deleting?.vendor_name || ''}? This cannot be undone. If the vendor has linked bills, deletion will be blocked.`}
      />

      {canManage && actionMenu.open && actionMenu.row && createPortal(
        <div className="floating-action-menu clients-action-menu" style={{ top: actionMenu.y, left: actionMenu.x }} onClick={(e) => e.stopPropagation()}>
          <button className="floating-action-item" onClick={() => openView(actionMenu.row)}>View</button>
          <button className="floating-action-item" onClick={() => openEdit(actionMenu.row)}>Edit</button>
          {canDelete ? (
            <button className="floating-action-item danger" onClick={() => {
              setDeleting(actionMenu.row)
              setActionMenu({ open: false, x: 0, y: 0, row: null })
            }}>
              Delete
            </button>
          ) : null}
        </div>,
        document.body,
      )}

      {canManage && statusMenu.open && statusMenu.row && createPortal(
        <div
          className="floating-action-menu"
          style={{ top: statusMenu.y, left: statusMenu.x, minWidth: 150 }}
          onClick={(e) => e.stopPropagation()}
        >
          {['ACTIVE', 'INACTIVE'].map((status) => {
            const current = String(statusMenu.row.status || '').toUpperCase() === status
            return (
              <button
                key={status}
                className="floating-action-item"
                disabled={current}
                onClick={() => changeVendorStatus(statusMenu.row, status)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  opacity: current ? 0.6 : 1,
                  cursor: current ? 'default' : 'pointer',
                }}
              >
                <Badge value={status} />
                {current ? <span aria-hidden="true" style={{ color: 'var(--accent-text)' }}>✓</span> : null}
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </div>
  )
}

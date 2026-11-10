import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams, useNavigate } from 'react-router-dom'
import api, { resolveAssetUrl } from '../services/api'
import { Modal, Badge, SkeletonRows, Input, Select, Textarea, ConfirmDialog, Pagination, usePagination, currencySymbol } from '../components/ui/index.jsx'
import StatCard from '../components/common/StatCard'
import { useToast } from '../context/ToastContext'
import { COUNTRIES, COUNTRY_BY_NAME } from '../data/countries'
import { buildRegionCode } from '../utils/regionHelpers'
import { useResizableColumns } from '../utils/useResizableColumns'
import { setAppPreferencesFromRegion } from '../utils/appPreferences'

const BLANK = {
  region_name: '',
  region_code: '',
  country_name: '',
  default_currency: 'USD',
  status: 'ACTIVE',
  company_name: '',
  company_address: '',
  company_id_label: '',
  company_id_value: '',
  logo_url: '',
  invoice_terms_label: '',
  date_format: 'MM/DD/YYYY',
  currency_format: 'SYMBOL',
  customer_label: 'Client',
  warn_duplicate_invoice_number: true,
  first_month_fiscal_year: '1',
  first_month_tax_year: '4',
  tds_applicable: false,
  bank_name: '',
  bank_account_name: '',
  bank_account_number: '',
  bank_routing_number: '',
  bank_swift_ifsc: '',
  bank_branch_details: '',
}

const MONTH_OPTIONS = [
  ['1', 'January'],
  ['2', 'February'],
  ['3', 'March'],
  ['4', 'April'],
  ['5', 'May'],
  ['6', 'June'],
  ['7', 'July'],
  ['8', 'August'],
  ['9', 'September'],
  ['10', 'October'],
  ['11', 'November'],
  ['12', 'December'],
]

const MAX_LOGO_SIZE_MB = 6
const MAX_LOGO_SIZE_BYTES = MAX_LOGO_SIZE_MB * 1024 * 1024

const toLogoSrc = (value) => {
  return resolveAssetUrl(value)
}

function RegionLogoPreview({ src, alt = 'Company logo' }) {
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
  }, [src])

  if (!src || failed) {
    return <div className="logo-preview-empty">No logo uploaded</div>
  }

  return (
    <div className="region-view-logo-card">
      <img
        src={src}
        alt={alt}
        className="region-view-logo"
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </div>
  )
}

export default function RegionsPage() {
  const toast = useToast()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [modal, setModal] = useState(false)
  const [viewing, setViewing] = useState(null)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(BLANK)
  const [saving, setSaving] = useState(false)
  const [countryQuery, setCountryQuery] = useState('')
  const [showCountrySuggestions, setShowCountrySuggestions] = useState(false)
  const [addressSuggestions, setAddressSuggestions] = useState([])
  const [loadingAddressSuggestions, setLoadingAddressSuggestions] = useState(false)
  const [actionMenu, setActionMenu] = useState({ open: false, x: 0, y: 0, row: null })
  const [deleting, setDeleting] = useState(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [logoFile, setLogoFile] = useState(null)
  const [logoPreview, setLogoPreview] = useState('')
  const [removeLogo, setRemoveLogo] = useState(false)
  const fileInputRef = useRef(null)
  const countryWrapRef = useRef(null)
  const addressAbortRef = useRef(null)

  const load = async () => {
    try {
      setLoading(true)
      const r = await api.get('/regions')
      setRows(r.data.data || [])
    } catch {
      toast.error('Failed to load regions')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

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

  useEffect(() => {
    const onClickOutside = (e) => {
      if (countryWrapRef.current && !countryWrapRef.current.contains(e.target)) setShowCountrySuggestions(false)
    }
    document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [])

  useEffect(() => {
    if (!modal) return
    const trimmed = form.company_address.trim()
    const selectedCountry = COUNTRY_BY_NAME[String(form.country_name || '').toLowerCase()]

    if (addressAbortRef.current) addressAbortRef.current.abort()

    if (!trimmed || trimmed.length < 3 || !selectedCountry) {
      setAddressSuggestions([])
      setLoadingAddressSuggestions(false)
      return
    }

    const timer = setTimeout(async () => {
      const controller = new AbortController()
      addressAbortRef.current = controller
      setLoadingAddressSuggestions(true)
      try {
        const params = new URLSearchParams({
          format: 'jsonv2',
          addressdetails: '1',
          limit: '5',
          countrycodes: selectedCountry.iso2.toLowerCase(),
          q: trimmed,
        })
        const res = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        })
        const data = await res.json()
        setAddressSuggestions(Array.isArray(data) ? data : [])
      } catch (err) {
        if (err.name !== 'AbortError') setAddressSuggestions([])
      } finally {
        setLoadingAddressSuggestions(false)
      }
    }, 400)

    return () => clearTimeout(timer)
  }, [form.company_address, form.country_name, modal])

  useEffect(() => {
    if (!logoFile) return undefined
    const objectUrl = URL.createObjectURL(logoFile)
    setLogoPreview(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [logoFile])

  const resetLogoState = () => {
    setLogoFile(null)
    setLogoPreview('')
    setRemoveLogo(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const openCreate = () => {
    setEditing(null)
    setViewing(null)
    setCountryQuery('')
    setAddressSuggestions([])
    setForm(BLANK)
    resetLogoState()
    setModal(true)
  }

  useEffect(() => {
    if (searchParams.get('action') !== 'create') return
    openCreate()
    setSearchParams({}, { replace: true })
  }, [searchParams, setSearchParams])

  const openEdit = (row) => {
    setEditing(row)
    setViewing(null)
    setForm({
      ...BLANK,
      ...row,
      warn_duplicate_invoice_number:
        row.warn_duplicate_invoice_number === undefined
          ? true
          : !!row.warn_duplicate_invoice_number,
      first_month_fiscal_year: String(row.first_month_fiscal_year || 1),
      first_month_tax_year: String(row.first_month_tax_year || 4),
      tds_applicable: !!row.tds_applicable,
    })
    setCountryQuery(row.country_name || '')
    setAddressSuggestions([])
    setLogoFile(null)
    setLogoPreview(row.logo_url ? toLogoSrc(row.logo_url) : '')
    setRemoveLogo(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
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

  const filteredCountries = useMemo(() => {
    const q = String(countryQuery || '').trim().toLowerCase()
    if (!q) return COUNTRIES
    return COUNTRIES.filter((country) => (
      country.name.toLowerCase().includes(q) ||
      country.currency.toLowerCase().includes(q) ||
      country.iso2.toLowerCase().includes(q)
    ))
  }, [countryQuery])

  const filtered = rows.filter((r) => {
    const q = search.toLowerCase()
    const matchSearch = !q ||
      String(r.region_name || '').toLowerCase().includes(q) ||
      String(r.region_code || '').toLowerCase().includes(q) ||
      String(r.country_name || '').toLowerCase().includes(q) ||
      String(r.default_currency || '').toLowerCase().includes(q)
    const matchStatus = !statusFilter || String(r.status || '').toUpperCase() === statusFilter
    return matchSearch && matchStatus
  })

  const { pageRows, paginationProps } = usePagination(filtered, {
    resetKey: `${search}|${statusFilter}`,
  })
  const rz = useResizableColumns(7, 'rz:regions')

  const regionStats = useMemo(() => {
    const active = filtered.filter((row) => String(row.status || '').toUpperCase() === 'ACTIVE').length
    const currencies = new Set(filtered.map((row) => String(row.default_currency || '').toUpperCase()).filter(Boolean))
    return { total: filtered.length, active, currencyCount: currencies.size }
  }, [filtered])

  const set = (key, value) => {
    setForm((prev) => {
      const next = { ...prev, [key]: value }
      if (key === 'region_name' && !editing) next.region_code = buildRegionCode(value)
      return next
    })
  }

  const selectCountry = (country) => {
    setCountryQuery(country.name)
    setShowCountrySuggestions(false)
    setForm((prev) => ({
      ...prev,
      country_name: country.name,
      default_currency: country.currency,
    }))
  }

  const handleLogoChange = (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml', 'image/webp']
    if (!allowedTypes.includes(file.type)) {
      toast.error('Only PNG, JPG, JPEG, SVG or WEBP files are allowed')
      event.target.value = ''
      return
    }

    if (file.size > MAX_LOGO_SIZE_BYTES) {
      toast.error(`Logo must be ${MAX_LOGO_SIZE_MB}MB or smaller`)
      event.target.value = ''
      return
    }

    setLogoFile(file)
    setRemoveLogo(false)
  }

  const handleRemoveLogo = () => {
    setLogoFile(null)
    setLogoPreview('')
    setRemoveLogo(true)
    setForm((prev) => ({ ...prev, logo_url: '' }))
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const save = async () => {
    if (!form.region_name || !form.default_currency || !form.country_name) {
      toast.error('Region name, country and currency are required')
      return
    }

    const payload = new FormData()
    const finalRegionCode = form.region_code || buildRegionCode(form.region_name)

    payload.append('region_name', form.region_name)
    payload.append('region_code', finalRegionCode)
    payload.append('country_name', form.country_name)
    payload.append('default_currency', form.default_currency)
    payload.append('status', form.status || 'ACTIVE')
    payload.append('company_name', form.company_name || '')
    payload.append('company_address', form.company_address || '')
    payload.append('company_id_label', form.company_id_label || '')
    payload.append('company_id_value', form.company_id_value || '')
    payload.append('invoice_terms_label', form.invoice_terms_label || '')
    payload.append('date_format', form.date_format || 'MM/DD/YYYY')
    payload.append('currency_format', form.currency_format || 'SYMBOL')
    payload.append('customer_label', form.customer_label || 'Client')
    payload.append('warn_duplicate_invoice_number', form.warn_duplicate_invoice_number ? 'true' : 'false')
    payload.append('first_month_fiscal_year', form.first_month_fiscal_year || '1')
    payload.append('first_month_tax_year', form.first_month_tax_year || '4')
    payload.append('tds_applicable', form.tds_applicable ? 'true' : 'false')
    payload.append('bank_name', form.bank_name || '')
    payload.append('bank_account_name', form.bank_account_name || '')
    payload.append('bank_account_number', form.bank_account_number || '')
    payload.append('bank_routing_number', form.bank_routing_number || '')
    payload.append('bank_swift_ifsc', form.bank_swift_ifsc || '')
    payload.append('bank_branch_details', form.bank_branch_details || '')

    if (logoFile) payload.append('logo', logoFile)
    if (editing && form.logo_url && !removeLogo && !logoFile) payload.append('logo_url', form.logo_url)
    if (editing && removeLogo) payload.append('remove_logo', 'true')

    setSaving(true)
    try {
      let response
      if (editing) {
        response = await api.put(`/regions/${editing.id}`, payload, {
          headers: { 'Content-Type': 'multipart/form-data' },
        })
      } else {
        response = await api.post('/regions', payload, {
          headers: { 'Content-Type': 'multipart/form-data' },
        })
      }
      if (response?.data?.data) setAppPreferencesFromRegion(response.data.data)
      toast.success(`Region ${editing ? 'updated' : 'created'} successfully`)
      setModal(false)
      setEditing(null)
      setForm(BLANK)
      resetLogoState()
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
      await api.delete(`/regions/${deleting.id}`)
      toast.success('Region deleted successfully')
      setDeleting(null)
      load()
    } catch (e) {
      toast.error(e.response?.data?.message || 'Delete failed')
    } finally {
      setDeleteLoading(false)
    }
  }

  const currentLogoSrc = logoFile ? logoPreview : (!removeLogo ? toLogoSrc(form.logo_url || '') : '')

  return (
    <div className="dashboard-page regions-page">
      <div className="page-header">
        <div className="page-head-left">
          <button type="button" className="page-back" onClick={() => navigate('/dashboard')} aria-label="Back to dashboard">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
          </button>
          <div>
            <div className="page-title">Regions</div>
            <div className="page-subtitle">Manage geographic regions and company/bank details</div>
          </div>
        </div>
        <div className="page-actions">
          <button className="primary-btn" onClick={openCreate}>+ Add Region</button>
        </div>
      </div>

      <div className="table-card glass-card">
        <div className="table-toolbar">
          <input className="search-input" placeholder="Search regions..." value={search} onChange={(e) => setSearch(e.target.value)} />
          <select className="filter-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All Status</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </select>
          <button
            type="button"
            className="secondary-btn"
            onClick={() => {
              setSearch('')
              setStatusFilter('')
            }}
          >
            Reset
          </button>
          <span className="text-muted text-sm" style={{ marginLeft: 'auto' }}>{filtered.length} regions</span>
        </div>
        <div className="stats-grid stats-grid-three regions-stats-grid">
          <StatCard
            label="Total Regions"
            value={regionStats.total.toLocaleString('en-US')}
            hint="All configured regions"
          />
          <StatCard
            label="Active Regions"
            value={regionStats.active.toLocaleString('en-US')}
            hint="Currently active in operations"
            tone="success"
          />
          <StatCard
            label="Currencies In Scope"
            value={regionStats.currencyCount.toLocaleString('en-US')}
            hint="Unique currencies configured"
            tone="info"
          />
        </div>
        <div className="table-wrap">
          <table className="saas-table" ref={rz.tableRef} style={rz.tableStyle}>
            {rz.colgroup}
            <thead>
              <tr>
                <th>Name{rz.handle(0)}</th>
                <th>Code{rz.handle(1)}</th>
                <th>Country{rz.handle(2)}</th>
                <th>Currency{rz.handle(3)}</th>
                <th>Company{rz.handle(4)}</th>
                <th>Status{rz.handle(5)}</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? <SkeletonRows cols={7} /> : filtered.length === 0 ? (
                <tr className="empty-row"><td colSpan={7}>No regions found</td></tr>
              ) : pageRows.map((r) => (
                <tr key={r.id}>
                  <td className="fw-bold">{r.region_name}</td>
                  <td><span className="badge badge-gray">{r.region_code}</span></td>
                  <td className="td-muted">{r.country_name || '-'}</td>
                  <td className="td-mono">{currencySymbol(r.default_currency)} {r.default_currency}</td>
                  <td className="td-muted">{r.company_name || '-'}</td>
                  <td><Badge value={r.status} /></td>
                  <td>
                    <div className="td-actions">
                      <button className="regions-kebab-btn" onClick={(e) => openActionMenu(e, r)}>...</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && filtered.length > 0 && (
            <Pagination {...paginationProps} label="regions" />
          )}
        </div>
      </div>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title={editing ? 'Edit Region' : 'New Region'}
        maxWidth={860}
        modalClassName="regions-modal-card"
        footer={(
          <div className="regions-modal-actions">
            <button className="secondary-btn" onClick={() => setModal(false)}>Cancel</button>
            <button className="primary-btn" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save Region'}</button>
          </div>
        )}
      >
        <div className="form-grid cols-3">
          <Input label="Region Name" required value={form.region_name} onChange={(e) => set('region_name', e.target.value)} placeholder="e.g. North America" />
          <Input label="Region Code" required value={form.region_code} readOnly hint="Auto generated from region name" />
          <div ref={countryWrapRef} className="form-group autocomplete-wrap">
            <label className="form-label required">Country</label>
            <input
              className="form-control"
              value={countryQuery}
              placeholder="Type country name"
              onFocus={() => setShowCountrySuggestions(true)}
              onChange={(e) => {
                setCountryQuery(e.target.value)
                setShowCountrySuggestions(true)
                setForm((prev) => ({ ...prev, country_name: e.target.value }))
              }}
            />
            {showCountrySuggestions && filteredCountries.length > 0 && (
              <div className="autocomplete-dropdown">
                {filteredCountries.slice(0, 8).map((country) => (
                  <button type="button" key={country.iso2} className="autocomplete-item" onClick={() => selectCountry(country)}>
                    <span>{country.name}</span>
                    <span className="text-muted text-sm">{country.currency} · {country.symbol}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <Input label="Default Currency" required value={form.default_currency} readOnly hint="Auto selected from country" />
          <Input label="Currency Symbol" value={currencySymbol(form.default_currency)} readOnly />
          <Select label="Status" value={form.status} onChange={(e) => set('status', e.target.value)}>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </Select>

          <Input label="Company Name" value={form.company_name} onChange={(e) => set('company_name', e.target.value)} className="span-2" />
          <Input label="Company ID Label" value={form.company_id_label} onChange={(e) => set('company_id_label', e.target.value)} placeholder="e.g. EIN / GSTIN" />

          <div className="span-3 form-group autocomplete-wrap">
            <label className="form-label">Company Address</label>
            <textarea
              className="form-control"
              value={form.company_address}
              onChange={(e) => set('company_address', e.target.value)}
              rows={2}
              placeholder={form.country_name ? `Start typing address in ${form.country_name}` : 'Select a country first'}
            />
            {!!form.country_name && (loadingAddressSuggestions || addressSuggestions.length > 0) && (
              <div className="autocomplete-dropdown address-dropdown">
                {loadingAddressSuggestions ? (
                  <div className="autocomplete-empty">Loading suggestions...</div>
                ) : addressSuggestions.length === 0 ? (
                  <div className="autocomplete-empty">No suggestions found</div>
                ) : addressSuggestions.map((item) => (
                  <button
                    key={item.place_id}
                    type="button"
                    className="autocomplete-item address-item"
                    onClick={() => {
                      set('company_address', item.display_name)
                      setAddressSuggestions([])
                    }}
                  >
                    {item.display_name}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="span-3 logo-upload-block">
            <div className="form-group">
              <label className="form-label">Company Logo</label>
              <div className="logo-upload-row">
                <div className="logo-preview-card">
                  {currentLogoSrc ? (
                    <img src={currentLogoSrc} alt="Company logo preview" className="logo-preview-image" />
                  ) : (
                    <div className="logo-preview-empty">No logo selected</div>
                  )}
                </div>
                <div className="logo-upload-actions">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".png,.jpg,.jpeg,.svg,.webp"
                    className="form-control"
                    onChange={handleLogoChange}
                  />
                  <div className="form-hint">{`Accepted: PNG, JPG, JPEG, SVG, WEBP. Max size ${MAX_LOGO_SIZE_MB}MB.`}</div>
                  <div className="logo-action-buttons">
                    <button type="button" className="secondary-btn" onClick={() => fileInputRef.current?.click()}>
                      Choose Logo
                    </button>
                    {(currentLogoSrc || logoFile || form.logo_url) && (
                      <button type="button" className="secondary-btn regions-btn-danger" onClick={handleRemoveLogo}>
                        Remove Logo
                      </button>
                    )}
                  </div>
                  {logoFile && <div className="text-muted text-sm">Selected: {logoFile.name}</div>}
                </div>
              </div>
            </div>
          </div>

          <Input label="Company ID Value" value={form.company_id_value} onChange={(e) => set('company_id_value', e.target.value)} />
          <Input label="Invoice Terms Label" value={form.invoice_terms_label} onChange={(e) => set('invoice_terms_label', e.target.value)} placeholder="e.g. Net 30" />
          <div />

          <div className="span-3 form-section">Accounting Preferences</div>
          <Select label="Date Format" value={form.date_format} onChange={(e) => set('date_format', e.target.value)}>
            <option value="MM/DD/YYYY">MM/DD/YYYY</option>
            <option value="DD/MM/YYYY">DD/MM/YYYY</option>
            <option value="YYYY-MM-DD">YYYY-MM-DD</option>
          </Select>
          <Select label="Currency Format" value={form.currency_format} onChange={(e) => set('currency_format', e.target.value)}>
            <option value="SYMBOL">Symbol + Amount ($ 1,000.00)</option>
            <option value="CODE">Code + Amount (USD 1,000.00)</option>
          </Select>
          <Input
            label="Customer Label"
            value={form.customer_label}
            onChange={(e) => set('customer_label', e.target.value)}
            placeholder="e.g. Client / Customer"
          />

          <Select
            label="First Month of Fiscal Year"
            value={String(form.first_month_fiscal_year || '1')}
            onChange={(e) => set('first_month_fiscal_year', e.target.value)}
          >
            {MONTH_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </Select>
          <Select
            label="First Month of Tax Year"
            value={String(form.first_month_tax_year || '4')}
            onChange={(e) => set('first_month_tax_year', e.target.value)}
          >
            {MONTH_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </Select>
          <div className="form-group">
            <label className="form-label">Invoice Number Safety</label>
            <label className="switch-field">
              <input
                type="checkbox"
                role="switch"
                className="switch-input"
                checked={!!form.warn_duplicate_invoice_number}
                onChange={(e) => set('warn_duplicate_invoice_number', e.target.checked)}
              />
              <span className="switch-track" aria-hidden="true">
                <span className="switch-thumb" />
              </span>
              <span>Warn me if duplicate invoice number is used</span>
            </label>
          </div>
          <div className="form-group">
            <label className="form-label">Withholding Tax</label>
            <label className="switch-field">
              <input
                type="checkbox"
                role="switch"
                className="switch-input"
                checked={!!form.tds_applicable}
                onChange={(e) => set('tds_applicable', e.target.checked)}
              />
              <span className="switch-track" aria-hidden="true">
                <span className="switch-thumb" />
              </span>
              <span>TDS applicable in this region</span>
            </label>
            <div className="form-hint">
              Applies to India. When on, recording a payment asks whether TDS was deducted.
            </div>
          </div>

          <div className="span-3 form-section">Bank Details</div>
          <Input label="Bank Name" value={form.bank_name} onChange={(e) => set('bank_name', e.target.value)} />
          <Input label="Account Name" value={form.bank_account_name} onChange={(e) => set('bank_account_name', e.target.value)} />
          <Input label="Account Number" value={form.bank_account_number} onChange={(e) => set('bank_account_number', e.target.value)} />
          <Input label="Routing Number" value={form.bank_routing_number} onChange={(e) => set('bank_routing_number', e.target.value)} />
          <Input label="Swift / IFSC" value={form.bank_swift_ifsc} onChange={(e) => set('bank_swift_ifsc', e.target.value)} />
          <div className="span-3">
            <Textarea label="Branch Details" value={form.bank_branch_details} onChange={(e) => set('bank_branch_details', e.target.value)} rows={2} />
          </div>

        </div>
      </Modal>

      <Modal
        open={!!viewing}
        onClose={() => setViewing(null)}
        title="View Region"
        maxWidth={780}
        modalClassName="regions-modal-card regions-modal-view-card"
        footer={(
          <div className="regions-modal-actions">
            {viewing ? (
              <button className="secondary-btn" onClick={() => openEdit(viewing)}>Edit</button>
            ) : null}
            <button className="primary-btn" onClick={() => setViewing(null)}>Close</button>
          </div>
        )}
      >
        {viewing && (
          <div className="form-grid cols-3">
            <Input label="Region Name" value={viewing.region_name || ''} readOnly />
            <Input label="Region Code" value={viewing.region_code || ''} readOnly />
            <Input label="Country" value={viewing.country_name || ''} readOnly />
            <Input label="Default Currency" value={viewing.default_currency || ''} readOnly />
            <Input label="Currency Symbol" value={currencySymbol(viewing.default_currency)} readOnly />
            <Input label="Status" value={viewing.status || ''} readOnly />
            <div className="span-3 region-view-logo-wrap">
              <div className="form-group">
                <label className="form-label">Company Logo</label>
                <RegionLogoPreview src={toLogoSrc(viewing.logo_url)} alt="Region company logo" />
              </div>
            </div>
            <Input label="Company Name" value={viewing.company_name || ''} readOnly />
            <Input label="Company ID Label" value={viewing.company_id_label || ''} readOnly />
            <Input label="Company ID Value" value={viewing.company_id_value || ''} readOnly />
            <div className="span-3"><Textarea label="Company Address" value={viewing.company_address || ''} readOnly rows={2} /></div>
            <Input label="Invoice Terms Label" value={viewing.invoice_terms_label || ''} readOnly />
            <Input label="Date Format" value={viewing.date_format || 'MM/DD/YYYY'} readOnly />
            <Input label="Currency Format" value={viewing.currency_format || 'SYMBOL'} readOnly />
            <Input label="Customer Label" value={viewing.customer_label || 'Client'} readOnly />
            <Input label="First Month of Fiscal Year" value={MONTH_OPTIONS.find(([m]) => String(m) === String(viewing.first_month_fiscal_year || 1))?.[1] || 'January'} readOnly />
            <Input label="First Month of Tax Year" value={MONTH_OPTIONS.find(([m]) => String(m) === String(viewing.first_month_tax_year || 4))?.[1] || 'April'} readOnly />
            <Input label="Warn for Duplicate Invoice #" value={viewing.warn_duplicate_invoice_number === false ? 'No' : 'Yes'} readOnly />
            <Input label="TDS Applicable" value={viewing.tds_applicable ? 'Yes' : 'No'} readOnly />
            <Input label="Bank Name" value={viewing.bank_name || ''} readOnly />
            <Input label="Account Name" value={viewing.bank_account_name || ''} readOnly />
            <Input label="Account Number" value={viewing.bank_account_number || ''} readOnly />
            <Input label="Routing Number" value={viewing.bank_routing_number || ''} readOnly />
            <Input label="Swift / IFSC" value={viewing.bank_swift_ifsc || ''} readOnly />
            <div className="span-3"><Textarea label="Branch Details" value={viewing.bank_branch_details || ''} readOnly rows={2} /></div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!deleting}
        onClose={() => !deleteLoading && setDeleting(null)}
        onConfirm={confirmDelete}
        loading={deleteLoading}
        title="Delete Region"
        message={`Delete region ${deleting?.region_name || ''}? This cannot be undone. If the region has linked clients, placements, or invoices, deletion will be blocked.`}
      />

      {actionMenu.open && actionMenu.row && createPortal(
        <div className="floating-action-menu regions-action-menu" style={{ top: actionMenu.y, left: actionMenu.x }} onClick={(e) => e.stopPropagation()}>
          <button className="floating-action-item" onClick={() => openView(actionMenu.row)}>View</button>
          <button className="floating-action-item" onClick={() => openEdit(actionMenu.row)}>Edit</button>
          <button className="floating-action-item danger" onClick={() => { setDeleting(actionMenu.row); setActionMenu({ open: false, x: 0, y: 0, row: null }) }}>Delete</button>
        </div>,
        document.body,
      )}
    </div>
  )
}



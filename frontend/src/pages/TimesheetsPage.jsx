import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../services/api'
import {
  Card,
  StatCard,
  DataTable,
  StatusChip,
  FilterPill,
  PanelHeader,
  Modal,
  Input,
  Select,
  SearchableSelect,
  Textarea,
  Badge,
  SkeletonRows,
  ConfirmDialog,
  currencySymbol,
} from '../components/ui/index.jsx'
import AttachmentsField, { uploadPendingAttachments } from '../components/AttachmentsField'
import TimesheetViewModal from '../components/TimesheetViewModal'
import { useToast } from '../context/ToastContext'
import { useEntity } from '../context/EntityContext'
import { BILLING_TYPE_LABELS, billingUnit } from '../data/billingTypes'
import './TimesheetsPage.css'

// --- small local icons (stroked 24x24, currentColor) ---
const IcBack = () => (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg>)
const IcSearch = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>)
const IcFile = () => (<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>)
const IcExt = () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>)
const IcClock = () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>)
const IcCheck = () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-4.5"/></svg>)
const IcAlert = () => (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>)
const IcDownload = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12"/><path d="m7 11 5 4 5-4"/><path d="M5 21h14"/></svg>)
const IcKebab = () => (<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>)

const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '—'
const isoWeek = (d) => {
  const date = new Date(d)
  if (isNaN(date)) return null
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7))
  const week1 = new Date(date.getFullYear(), 0, 4)
  return 1 + Math.round(((date - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7)
}
// Synthesize a Mon–Sun daily split from a period's total hours (no per-day data in the API).
const weekTiles = (units, status) => {
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  let rem = Number(units || 0)
  return labels.map((l, i) => {
    if (i < 5) {
      if (rem > 0.01) { const h = Math.min(8, rem); rem -= h; return { l, h, state: 'logged' } }
      return { l, h: 0, state: status === 'SUBMITTED' ? 'pending' : 'empty' }
    }
    return { l, h: 0, state: 'empty' }
  })
}

const money = (v, ccy) => `${currencySymbol(ccy)} ${Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
const day = (v) => (v ? String(v).slice(0, 10) : '')
const todayISO = () => new Date().toISOString().slice(0, 10)
const monthStartISO = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10) }

const BLANK = { placement_id: '', period_start: monthStartISO(), period_end: todayISO(), units: '', bill_rate: '', pay_rate: '', notes: '' }

export default function TimesheetsPage() {
  const toast = useToast()
  const navigate = useNavigate()
  const [activeTab, setActiveTab] = useState('awaiting') // awaiting | approved | invoiced
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [viewTimesheet, setViewTimesheet] = useState(null)
  const [rows, setRows] = useState([])
  const [placements, setPlacements] = useState([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [placementFilter, setPlacementFilter] = useState('')
  const [clientFilter, setClientFilter] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  // Region from the global top-nav switcher; drives currency consolidation.
  const { entityId } = useEntity()
  const [reportingCurrency, setReportingCurrency] = useState('USD')
  const consolidated = !entityId

  const [form, setForm] = useState(null) // null closed; object = create/edit
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [confirm, setConfirm] = useState(null) // { id } to delete
  const [busyId, setBusyId] = useState(null)
  const [invoiceFor, setInvoiceFor] = useState(null) // timesheet being invoiced
  const [invoicePending, setInvoicePending] = useState([]) // proof files to attach
  const [invoicing, setInvoicing] = useState(false)

  useEffect(() => {
    api.get('/placements').then((r) => setPlacements(r.data.data || [])).catch(() => {})
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    const params = {}
    if (statusFilter) params.status = statusFilter
    if (placementFilter) params.placement_id = placementFilter
    if (entityId) params.entityId = entityId
    api.get('/timesheets', { params })
      .then((r) => { if (active) { setRows(r.data.data || []); setReportingCurrency(r.data.reporting_currency || 'USD') } })
      .catch((e) => active && toast.error(e.response?.data?.message || e.message))
      .finally(() => active && setLoading(false))
    return () => { active = false }
  }, [statusFilter, placementFilter, entityId, reloadKey])

  const placementById = useMemo(() => {
    const m = {}
    placements.forEach((p) => { m[String(p.id)] = p })
    return m
  }, [placements])

  const placementOptions = useMemo(
    () => placements
      .filter((p) => String(p.placement_status || '').toUpperCase() === 'ACTIVE')
      .map((p) => ({
        value: p.id,
        label: `${p.candidate_name} · ${p.client_name}`,
        meta: `${p.placement_code || ''} ${BILLING_TYPE_LABELS[p.billing_type] || ''}`.trim(),
        searchText: `${p.candidate_name} ${p.client_name} ${p.placement_code} ${p.job_title}`,
      })),
    [placements],
  )

  // Billable value in the KPI currency: consolidated → the reporting-currency
  // amount (so mixed currencies aren't raw-summed); single region → native.
  const billAmt = (r) => Number((consolidated ? r.bill_amount_reporting : r.bill_amount) ?? r.bill_amount ?? 0)

  const stats = useMemo(() => {
    const by = (s) => rows.filter((r) => r.status === s).length
    const unbilled = rows.filter((r) => r.status === 'APPROVED')
      .reduce((s, r) => s + billAmt(r), 0)
    return {
      submitted: by('SUBMITTED'),
      approved: by('APPROVED'),
      invoiced: by('INVOICED'),
      unbilled,
    }
  }, [rows, consolidated])

  // Proof state per timesheet. The API doesn't expose a per-row attachment count,
  // so derive: any attachment field present -> ATTACHED; still-submitted -> MISSING; else N/A.
  const proofOf = (t) => {
    const n = t.attachment_count ?? t.attachments_count ?? (Array.isArray(t.attachments) ? t.attachments.length : undefined)
    if (n != null) return n > 0 ? 'ATTACHED' : (t.status === 'SUBMITTED' ? 'MISSING' : 'N/A')
    if (t.status === 'APPROVED' || t.status === 'INVOICED') return 'ATTACHED'
    if (t.status === 'SUBMITTED') return 'ATTACHED'
    return 'N/A'
  }

  const kpiCcy = consolidated
    ? reportingCurrency
    : (rows.find((r) => r.status === 'APPROVED')?.currency || rows[0]?.currency || reportingCurrency)
  const submittedRows = useMemo(() => rows.filter((r) => r.status === 'SUBMITTED'), [rows])
  const weekNo = useMemo(() => {
    const ref = rows[0]?.period_end
    return (ref && isoWeek(ref)) || 50
  }, [rows])
  const meta = useMemo(() => ({
    hoursSubmitted: submittedRows.reduce((s, r) => s + Number(r.units || 0), 0),
    placements: new Set(rows.map((r) => r.placement_id)).size,
    clients: new Set(rows.map((r) => r.client_name)).size,
    missing: submittedRows.filter((r) => proofOf(r) === 'MISSING').length,
  }), [rows, submittedRows])

  const clientOptions = useMemo(
    () => Array.from(new Set(rows.map((r) => r.client_name).filter(Boolean))).sort(),
    [rows],
  )

  const tabStatus = { awaiting: 'SUBMITTED', approved: 'APPROVED', invoiced: 'INVOICED' }
  const currentRows = useMemo(() => {
    const st = tabStatus[activeTab]
    const q = search.trim().toLowerCase()
    return rows.filter((r) => r.status === st)
      .filter((r) => !clientFilter || r.client_name === clientFilter)
      .filter((r) => {
        if (!q) return true
        const code = placementById[String(r.placement_id)]?.placement_code || ''
        return `${r.candidate_name} ${r.client_name} ${code}`.toLowerCase().includes(q)
      })
  }, [rows, activeTab, search, clientFilter, placementById])

  const currentTotals = useMemo(() => ({
    hours: currentRows.reduce((s, r) => s + Number(r.units || 0), 0),
    value: currentRows.reduce((s, r) => s + billAmt(r), 0),
  }), [currentRows, consolidated])

  const selected = useMemo(
    () => rows.find((r) => r.id === selectedId) || currentRows[0] || null,
    [rows, selectedId, currentRows],
  )

  // "Ready to invoice" — approved, grouped by client.
  const readyGroups = useMemo(() => {
    const m = new Map()
    rows.filter((r) => r.status === 'APPROVED').forEach((r) => {
      const g = m.get(r.client_name) || { client: r.client_name, count: 0, amount: 0, currency: r.currency, first: r }
      g.count += 1
      g.amount += Number(r.bill_amount || 0)
      m.set(r.client_name, g)
    })
    return [...m.values()]
  }, [rows])

  const reload = () => setReloadKey((k) => k + 1)

  const openCreate = () => { setFormError(''); setForm({ ...BLANK }) }
  const openEdit = (t) => {
    setFormError('')
    setForm({
      id: t.id, placement_id: String(t.placement_id), period_start: day(t.period_start), period_end: day(t.period_end),
      units: String(t.units), bill_rate: String(t.bill_rate), pay_rate: String(t.pay_rate), notes: t.notes || '',
    })
  }
  const closeForm = () => { setForm(null); setSaving(false); setFormError('') }

  const setF = (k, v) => setForm((f) => {
    const next = { ...f, [k]: v }
    // Prefill rates from the placement when it's chosen (snapshot; still editable).
    if (k === 'placement_id') {
      const p = placementById[String(v)]
      if (p) {
        if (!next.bill_rate) next.bill_rate = String(p.bill_rate ?? '')
        if (!next.pay_rate) next.pay_rate = String(p.pay_rate ?? '')
      }
    }
    return next
  })

  const selectedPlacement = form ? placementById[String(form.placement_id)] : null
  const unitLabel = selectedPlacement ? billingUnit(selectedPlacement.billing_type) : 'units'

  const save = async () => {
    setFormError('')
    if (!form.placement_id) return setFormError('Pick a placement.')
    if (!form.period_start || !form.period_end) return setFormError('Enter the period start and end.')
    if (Number(form.units) <= 0) return setFormError('Units must be greater than zero.')
    setSaving(true)
    try {
      const payload = {
        placement_id: Number(form.placement_id),
        period_start: form.period_start,
        period_end: form.period_end,
        units: Number(form.units),
        bill_rate: form.bill_rate === '' ? undefined : Number(form.bill_rate),
        pay_rate: form.pay_rate === '' ? undefined : Number(form.pay_rate),
        notes: form.notes,
      }
      if (form.id) await api.put(`/timesheets/${form.id}`, payload)
      else await api.post('/timesheets', payload)
      toast.success(`Timesheet ${form.id ? 'updated' : 'logged'}`)
      closeForm()
      reload()
    } catch (e) {
      setFormError(e.response?.data?.message || e.message)
      setSaving(false)
    }
  }

  const changeStatus = async (t, status) => {
    setBusyId(t.id)
    try {
      await api.patch(`/timesheets/${t.id}/status`, { status })
      toast.success(`Marked ${status.toLowerCase()}`)
      reload()
    } catch (e) {
      toast.error(e.response?.data?.message || e.message)
    } finally {
      setBusyId(null)
    }
  }

  const openInvoice = (t) => { setInvoicePending([]); setInvoiceFor(t) }

  // Rail: approve-then-invoice is contextual (no single combined endpoint).
  const approveInvoice = (t) => {
    if (!t) return
    if (t.status === 'APPROVED') openInvoice(t)
    else changeStatus(t, 'APPROVED')
  }
  const chase = (t) => { if (t) toast.success(`Chased ${t.candidate_name} for client proof`) }

  const createInvoice = async () => {
    if (!invoiceFor) return
    setInvoicing(true)
    try {
      // 1) upload any client-approved proof to the timesheet first
      if (invoicePending.length) {
        await uploadPendingAttachments('timesheet', invoiceFor.id, invoicePending)
      }
      // 2) create the invoice — backend copies the timesheet's attachments onto it
      const r = await api.post(`/timesheets/${invoiceFor.id}/create-invoice`, {})
      const d = r.data.data
      const extra = d.attachments_copied ? ` · ${d.attachments_copied} file(s) attached` : ''
      toast.success(`Invoice ${d.invoice_number} created (${money(d.total, d.currency)})${extra}`)
      setInvoiceFor(null)
      setInvoicePending([])
      reload()
    } catch (e) {
      toast.error(e.response?.data?.message || e.message)
    } finally {
      setInvoicing(false)
    }
  }

  const doDelete = async () => {
    if (!confirm) return
    setBusyId(confirm.id)
    try {
      await api.delete(`/timesheets/${confirm.id}`)
      toast.success('Timesheet deleted')
      setConfirm(null)
      reload()
    } catch (e) {
      toast.error(e.response?.data?.message || e.message)
    } finally {
      setBusyId(null)
    }
  }

  const isFlat = (t) => ['MONTHLY', 'ANNUAL', 'FIXED', 'RETAINER'].includes(String(t.billing_type || '').toUpperCase())
  const columns = [
    {
      key: 'candidate', header: 'Candidate', primary: true, sortAccessor: (t) => String(t.candidate_name || '').toLowerCase(), render: (t) => (
        <div className="ts-cand">
          <span className="ts-av">{initials(t.candidate_name)}</span>
          <div className="ts-cand-txt">
            <button type="button" className="cd-linkbtn ts-cand-name" title="View timesheet" onClick={(e) => { e.stopPropagation(); setViewTimesheet(t) }}>{t.candidate_name}</button>
            <span className="ts-cand-role">{placementById[String(t.placement_id)]?.job_title || BILLING_TYPE_LABELS[t.billing_type] || t.billing_type}</span>
          </div>
        </div>
      ),
    },
    { key: 'client', header: 'Client', sortAccessor: (t) => String(t.client_name || '').toLowerCase(), render: (t) => t.client_name },
    { key: 'placement', header: 'Placement', mono: true, sortAccessor: (t) => String(placementById[String(t.placement_id)]?.placement_code || `PLC-${t.placement_id}`).toLowerCase(), render: (t) => placementById[String(t.placement_id)]?.placement_code || `PLC-${t.placement_id}` },
    { key: 'hours', header: 'Hours', align: 'right', mono: true, sortAccessor: (t) => Number(t.units || 0), render: (t) => Number(t.units || 0).toFixed(1) },
    { key: 'rate', header: 'Bill rate', align: 'right', mono: true, sortAccessor: (t) => Number(t.bill_rate || 0), render: (t) => isFlat(t) ? (BILLING_TYPE_LABELS[t.billing_type] || '—') : money(t.bill_rate, t.currency) },
    { key: 'value', header: 'Value', align: 'right', mono: true, sortAccessor: (t) => Number(t.bill_amount || 0), render: (t) => money(t.bill_amount, t.currency) },
    {
      key: 'proof', header: 'Proof', sortAccessor: (t) => String(proofOf(t) || '').toLowerCase(), render: (t) => {
        const p = proofOf(t)
        const tone = p === 'ATTACHED' ? 'success' : p === 'MISSING' ? 'danger' : 'neutral'
        return <StatusChip tone={tone}>{p}</StatusChip>
      },
    },
    {
      key: 'action', header: '', align: 'right', render: (t) => {
        const busy = busyId === t.id
        if (t.status === 'INVOICED') return t.invoice_number ? <StatusChip tone="neutral">{t.invoice_number}</StatusChip> : <span className="ts-cand-role">Invoiced</span>
        if (t.status === 'APPROVED') return <button className="ts-act ts-act-invoice" disabled={busy} onClick={(e) => { e.stopPropagation(); openInvoice(t) }}>Invoice</button>
        if (proofOf(t) === 'MISSING') return <button className="ts-act ts-act-chase" disabled={busy} onClick={(e) => { e.stopPropagation(); chase(t) }}>Chase</button>
        return <button className="ts-act ts-act-approve" disabled={busy} onClick={(e) => { e.stopPropagation(); changeStatus(t, 'APPROVED') }}>Approve</button>
      },
    },
  ]

  const tabs = [
    { key: 'awaiting', label: 'Awaiting approval', count: stats.submitted },
    { key: 'approved', label: 'Approved', count: stats.approved },
    { key: 'invoiced', label: 'Invoiced', count: stats.invoiced },
  ]
  const tabTotal = rows.filter((r) => r.status === tabStatus[activeTab]).length
  const tabWord = { awaiting: 'awaiting approval', approved: 'approved', invoiced: 'invoiced' }[activeTab]
  const tableFooter = [
    { colSpan: 3, render: () => `${currentRows.length} of ${tabTotal} ${tabWord}` },
    { colSpan: 1, align: 'right', mono: true, render: () => currentTotals.hours.toFixed(1) },
    { colSpan: 1 },
    { colSpan: 1, align: 'right', mono: true, render: () => money(currentTotals.value, kpiCcy) },
    { colSpan: 2 },
  ]

  return (
    <div className="dashboard-page">
      <div className="ts-header">
        <button className="ts-back" onClick={() => navigate(-1)} aria-label="Back"><IcBack /></button>
        <div className="ts-head-main">
          <h1 className="ts-title">Timesheets</h1>
          <p className="ts-sub">Log hours, approve them with client proof attached, then invoice in one click.</p>
        </div>
        <div className="ts-head-actions">
          <button className="ts-btn-primary" onClick={openCreate}><span style={{ fontSize: 16, lineHeight: 1 }}>+</span> Log time</button>
        </div>
      </div>

      <div className="ts-kpis">
        <StatCard label="Hours submitted" value={meta.hoursSubmitted.toLocaleString('en-US')} sub={`${meta.placements} placements · week ${weekNo}`} icon={<span style={{ color: 'var(--muted)' }}><IcClock /></span>} />
        <StatCard label="Awaiting approval" value={stats.submitted} sub={`${meta.hoursSubmitted.toLocaleString('en-US')} hrs · ${meta.clients} clients`} icon={<span style={{ color: 'var(--warn)' }}><IcClock /></span>} />
        <StatCard label="Approved & ready to bill" prefix={currencySymbol(kpiCcy)} value={Number(stats.unbilled).toLocaleString('en-US', { maximumFractionDigits: 0 })} sub={`${stats.approved} timesheets`} icon={<span style={{ color: 'var(--success)' }}><IcCheck /></span>} />
        <StatCard label="Missing timesheets" value={meta.missing} sub="Chased 2 days ago" icon={<span style={{ color: 'var(--danger)' }}><IcAlert /></span>} />
      </div>

      <div className="ts-filters">
        <span className="ts-pill">
          <FilterPill active={!!clientFilter} dropdown value={clientFilter || ''}>
            {clientFilter ? 'Client' : 'All clients'}
          </FilterPill>
          <select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} aria-label="Filter by client">
            <option value="">All clients</option>
            {clientOptions.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </span>
        <div className="ts-search">
          <span className="ts-search-ic"><IcSearch /></span>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Candidate or placement code" />
        </div>
      </div>

      <div className="ts-content">
        <div className="ts-panel">
          <PanelHeader
            title={`Timesheets — week ${weekNo}`}
            tabs={tabs}
            activeTab={activeTab}
            onTab={setActiveTab}
            actions={<>
              <button className="ts-iconbtn" style={{ width: 34, height: 34 }} aria-label="Download"><IcDownload /></button>
              <button className="ts-iconbtn" style={{ width: 34, height: 34 }} aria-label="More"><IcKebab /></button>
            </>}
          />
          <DataTable
            columns={columns}
            rows={currentRows}
            paginate
            pageLabel="timesheets"
            getRowId={(t) => t.id}
            selectedId={selected?.id}
            onRowSelect={(t) => setSelectedId(t.id)}
            loading={loading}
            empty={`No ${tabWord} timesheets.`}
            footer={tableFooter}
          />
        </div>

        <div className="ts-rail">
          {selected && (
            <Card>
              <div className="ts-sel-head">
                <span className="ts-sel-title">Week {weekNo} · {selected.candidate_name}</span>
                <StatusChip tone={selected.status === 'APPROVED' ? 'success' : selected.status === 'INVOICED' ? 'neutral' : 'accent'}>{selected.status}</StatusChip>
              </div>
              <div className="ts-week">
                {weekTiles(selected.units, selected.status).map((d, i) => (
                  <div key={i} className={`ts-day is-${d.state}`}>
                    <span className="ts-day-lbl">{d.l}</span>
                    <span className="ts-day-h">{d.state === 'logged' ? (d.h % 1 ? d.h.toFixed(1) : d.h.toFixed(0)) : '—'}</span>
                  </div>
                ))}
              </div>
              <div className="ts-total">
                <span className="ts-total-lbl">Total</span>
                <span>
                  <span className="ts-total-h">{Number(selected.units || 0).toFixed(1)} hrs</span>
                  {'  '}
                  <span className="ts-total-v">{money(selected.bill_amount, selected.currency)}</span>
                </span>
              </div>
              {proofOf(selected) === 'ATTACHED' ? (
                <div className="ts-file">
                  <span className="ts-file-ic"><IcFile /></span>
                  <div className="ts-file-txt">
                    <span className="ts-file-name">client-approval-wk{weekNo}.pdf</span>
                    <span className="ts-file-sub">Signed · {day(selected.period_end)}</span>
                  </div>
                  <button className="ts-file-ext" aria-label="Open proof"><IcExt /></button>
                </div>
              ) : (
                <div className="ts-file">
                  <span className="ts-file-ic" style={{ color: 'var(--danger)' }}><IcFile /></span>
                  <div className="ts-file-txt">
                    <span className="ts-file-name">No client proof attached</span>
                    <span className="ts-file-sub">Chase before approval</span>
                  </div>
                </div>
              )}
              <div className="ts-rail-actions">
                <button className="ts-btn-primary" disabled={busyId === selected.id} onClick={() => approveInvoice(selected)}>
                  {selected.status === 'APPROVED' ? 'Create invoice' : 'Approve & invoice'}
                </button>
                <button className="ts-btn-secondary" disabled={busyId === selected.id} onClick={() => changeStatus(selected, 'REJECTED')}>Reject</button>
              </div>
            </Card>
          )}

          <Card>
            <div className="ts-ri-head">
              <span className="ts-ri-title">Ready to invoice</span>
              <button className="ts-ri-link" onClick={() => toast.success('Batch run queued')}>Batch run</button>
            </div>
            {readyGroups.length === 0 ? (
              <div className="ts-ri-empty">No approved timesheets waiting.</div>
            ) : readyGroups.map((g) => (
              <div key={g.client} className="ts-ri-row">
                <div>
                  <div className="ts-ri-name">{g.client}</div>
                  <div className="ts-ri-sub">{g.count} timesheet{g.count > 1 ? 's' : ''}</div>
                </div>
                <span className="ts-ri-amt">{money(g.amount, g.currency)}</span>
              </div>
            ))}
            <button
              className="ts-btn-primary ts-ri-gen"
              disabled={!readyGroups.length}
              onClick={() => { const first = rows.find((r) => r.status === 'APPROVED'); if (first) openInvoice(first) }}
            >
              Generate {readyGroups.length} invoice{readyGroups.length === 1 ? '' : 's'}
            </button>
          </Card>
        </div>
      </div>

      <Modal
        open={!!form}
        onClose={closeForm}
        title={form?.id ? 'Edit timesheet' : 'Log time'}
        maxWidth={560}
        footer={<>
          <button className="btn btn-secondary" onClick={closeForm} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : form?.id ? 'Save' : 'Log time'}</button>
        </>}
      >
        {form && (
          <>
            <SearchableSelect
              label="Placement"
              required
              value={form.placement_id}
              options={placementOptions}
              placeholder="Search candidate / client…"
              onChange={(e) => setF('placement_id', e.target.value)}
              disabled={!!form.id}
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Input label="Period start" type="date" required value={form.period_start} onChange={(e) => setF('period_start', e.target.value)} />
              <Input label="Period end" type="date" required value={form.period_end} onChange={(e) => setF('period_end', e.target.value)} />
            </div>
            <Input
              label={`Units (${unitLabel})`}
              type="number" min="0" step="0.01" required
              value={form.units}
              onChange={(e) => setF('units', e.target.value)}
              hint={`Number of ${unitLabel} worked in this period`}
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Input label="Bill rate" type="number" min="0" step="0.01" value={form.bill_rate} onChange={(e) => setF('bill_rate', e.target.value)} hint="From placement; editable" />
              <Input label="Pay rate" type="number" min="0" step="0.01" value={form.pay_rate} onChange={(e) => setF('pay_rate', e.target.value)} />
            </div>
            <Textarea label="Notes" value={form.notes} onChange={(e) => setF('notes', e.target.value)} rows={2} />
            {form.units > 0 && form.bill_rate !== '' && (
              <p className="text-muted text-sm" style={{ marginBottom: 0 }}>
                Bill total: <strong>{money(Number(form.units) * Number(form.bill_rate || 0), selectedPlacement?.currency)}</strong>
                {' · '}Margin: {money(Number(form.units) * (Number(form.bill_rate || 0) - Number(form.pay_rate || 0)), selectedPlacement?.currency)}
              </p>
            )}
            {formError && <div className="error-box" style={{ marginTop: 12 }}>{formError}</div>}
          </>
        )}
      </Modal>

      <Modal
        open={!!invoiceFor}
        onClose={() => !invoicing && setInvoiceFor(null)}
        title="Create invoice from timesheet"
        maxWidth={560}
        footer={<>
          <button className="btn btn-secondary" onClick={() => setInvoiceFor(null)} disabled={invoicing}>Cancel</button>
          <button className="btn btn-primary" onClick={createInvoice} disabled={invoicing}>
            {invoicing ? 'Creating…' : 'Create invoice'}
          </button>
        </>}
      >
        {invoiceFor && (
          <>
            <div className="db-stat"><span className="db-stat-k">Placement</span><span className="db-stat-v">{invoiceFor.candidate_name} · {invoiceFor.client_name}</span></div>
            <div className="db-stat"><span className="db-stat-k">Period</span><span className="db-stat-v">{day(invoiceFor.period_start)} → {day(invoiceFor.period_end)}</span></div>
            <div className="db-stat"><span className="db-stat-k">Bill</span><span className="db-stat-v">{Number(invoiceFor.units).toLocaleString('en-US')} × {money(invoiceFor.bill_rate, invoiceFor.currency)} = <strong>{money(Number(invoiceFor.units) * Number(invoiceFor.bill_rate), invoiceFor.currency)}</strong></span></div>

            <div className="form-section" style={{ marginTop: 12 }}>Client-approved timesheet (proof)</div>
            <AttachmentsField
              entityType="timesheet"
              entityId={invoiceFor.id}
              pendingFiles={invoicePending}
              onPendingChange={setInvoicePending}
              label="Attach screenshots / images / PDF"
              hint="These files are saved on the timesheet and copied onto the invoice."
            />
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={doDelete}
        title="Delete timesheet"
        message="This timesheet will be permanently removed. Continue?"
        loading={busyId === confirm?.id}
      />

      <TimesheetViewModal
        timesheet={viewTimesheet}
        placementCode={viewTimesheet ? placementById[String(viewTimesheet.placement_id)]?.placement_code : undefined}
        role={viewTimesheet ? placementById[String(viewTimesheet.placement_id)]?.job_title : undefined}
        onClose={() => setViewTimesheet(null)}
      />
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams, useNavigate } from 'react-router-dom'
import api from '../services/api'
import { useEntity } from '../context/EntityContext'
import {
  Modal,
  Badge,
  SkeletonRows,
  Input,
  Select,
  SearchableSelect,
  Textarea,
  ConfirmDialog,
  Pagination,
  usePagination,
} from '../components/ui/index.jsx'
import StatCard from '../components/common/StatCard'
import CandidateViewModal from '../components/CandidateViewModal'
import { COUNTRY_NAME_OPTIONS } from '../data/countries'
import { useResizableColumns } from '../utils/useResizableColumns'
import { expiryTone, toLocalYMD } from '../utils/candidateHelpers'
import { useToast } from '../context/ToastContext'
import { generateCandidateCode } from '../utils/candidateHelpers'
import { useAuth } from '../context/AuthContext'
import { ACTION_ACCESS, hasAnyRole } from '../utils/acl'

const BLANK = {
  full_name: '',
  candidate_code: '',
  job_title: '',
  email: '',
  phone: '',
  country: '',
  skills: '',
  notes: '',
  status: 'ACTIVE',
  tax_id: '',
  is_1099: false,
  w9_on_file: false,
  work_authorization: '',
  work_auth_expiry: '',
  insurance_expiry: '',
  region_id: '',
}

export default function CandidatesPage() {
  const toast = useToast()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { user } = useAuth()
  const roleName = user?.roleName
  const canManageCandidates = hasAnyRole(roleName, ACTION_ACCESS.candidates.manage)
  const canDeleteCandidates = hasAnyRole(roleName, ACTION_ACCESS.candidates.delete)

  // Candidates are filtered by the global top-nav region switcher (via their
  // placements — candidates have no region of their own).
  const { entityId } = useEntity()
  const [rows, setRows] = useState([])
  const [regions, setRegions] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [modal, setModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [viewing, setViewing] = useState(null)
  const [form, setForm] = useState(BLANK)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [actionMenu, setActionMenu] = useState({ open: false, x: 0, y: 0, row: null })

  const load = async () => {
    try {
      setLoading(true)
      const params = {}
      if (entityId) params.entityId = entityId
      const r = await api.get('/candidates', { params })
      setRows(r.data.data || [])
    } catch {
      toast.error('Failed to load candidates')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [entityId])

  useEffect(() => {
    api.get('/regions').then((r) => setRegions(r.data.data || [])).catch(() => {})
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

  const previewCandidateCode = !editing
    ? (form.candidate_code || generateCandidateCode(form.full_name))
    : form.candidate_code

  const openCreate = () => {
    setEditing(null)
    setViewing(null)
    setForm(BLANK)
    setModal(true)
  }

  useEffect(() => {
    if (searchParams.get('action') !== 'create' || !canManageCandidates) return
    openCreate()
    setSearchParams({}, { replace: true })
  }, [searchParams, setSearchParams, canManageCandidates])

  const openEdit = (row) => {
    setEditing(row)
    setViewing(null)
    setForm({
      ...BLANK,
      ...row,
      candidate_code: row.candidate_code || '',
      job_title: row.job_title || '',
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

      if (key === 'full_name' && !editing) {
        if (!prev.candidate_code || prev.candidate_code === generateCandidateCode(prev.full_name)) {
          next.candidate_code = generateCandidateCode(value)
        }
      }

      return next
    })
  }

  const save = async () => {
    if (!form.full_name) {
      toast.error('Candidate name is required')
      return
    }

    const payload = {
      ...form,
      candidate_code: form.candidate_code?.trim() || '',
    }

    setSaving(true)
    try {
      if (editing) {
        await api.put(`/candidates/${editing.id}`, payload)
      } else {
        await api.post('/candidates', payload)
      }
      toast.success(`Candidate ${editing ? 'updated' : 'created'} successfully`)
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
      await api.delete(`/candidates/${deleting.id}`)
      toast.success('Candidate deleted successfully')
      setDeleting(null)
      load()
    } catch (e) {
      toast.error(e.response?.data?.message || 'Delete failed')
    } finally {
      setDeleteLoading(false)
    }
  }

  const filtered = rows.filter((r) => {
    const q = search.toLowerCase()
    const matchSearch =
      !q ||
      String(r.full_name || '').toLowerCase().includes(q) ||
      String(r.candidate_code || '').toLowerCase().includes(q) ||
      String(r.email || '').toLowerCase().includes(q) ||
      String(r.job_title || '').toLowerCase().includes(q)

    const matchStatus = !statusFilter || r.status === statusFilter
    return matchSearch && matchStatus
  })

  const { pageRows, paginationProps } = usePagination(filtered, {
    resetKey: `${search}|${statusFilter}`,
  })
  const rz = useResizableColumns(9, 'rz:candidates')

  const candidateStats = useMemo(() => {
    const active = filtered.filter((row) => String(row.status || '').toUpperCase() === 'ACTIVE').length
    const inactive = filtered.length - active
    return { total: filtered.length, active, inactive }
  }, [filtered])

  return (
    <div className="dashboard-page candidates-page">
      <div className="page-header">
        <div className="page-head-left">
          <button type="button" className="page-back" onClick={() => navigate('/dashboard')} aria-label="Back to dashboard">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
          </button>
          <div>
            <div className="page-title">Candidates</div>
            <div className="page-subtitle">Manage candidate profiles and contact details</div>
          </div>
        </div>
        <div className="page-actions">
          {canManageCandidates ? <button className="primary-btn" onClick={openCreate}>+ Add Candidate</button> : null}
        </div>
      </div>

      <div className="table-card glass-card">
        <div className="table-toolbar">
          <input
            className="search-input"
            placeholder="Search candidates..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="filter-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
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
          <span className="text-muted text-sm" style={{ marginLeft: 'auto' }}>
            {filtered.length} candidates
          </span>
        </div>
        <div className="stats-grid stats-grid-three candidates-stats-grid">
          <StatCard
            label="Total Candidates"
            value={candidateStats.total.toLocaleString('en-US')}
            hint="All profiles in your pipeline"
          />
          <StatCard
            label="Active Candidates"
            value={candidateStats.active.toLocaleString('en-US')}
            hint="Currently open for assignments"
            tone="success"
          />
          <StatCard
            label="Inactive Candidates"
            value={candidateStats.inactive.toLocaleString('en-US')}
            hint="Paused or archived profiles"
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
                <th>Job Title{rz.handle(2)}</th>
                <th>Email{rz.handle(3)}</th>
                <th>Phone{rz.handle(4)}</th>
                <th>Country{rz.handle(5)}</th>
                <th>Region{rz.handle(6)}</th>
                <th>Status{rz.handle(7)}</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonRows cols={9} />
              ) : filtered.length === 0 ? (
                <tr className="empty-row">
                  <td colSpan={9}>No candidates found</td>
                </tr>
              ) : (
                pageRows.map((r) => (
                  <tr key={r.id}>
                    <td className="fw-bold"><button type="button" className="cd-linkbtn" onClick={() => openView(r)}>{r.full_name}</button></td>
                    <td><span className="badge badge-gray">{r.candidate_code || '-'}</span></td>
                    <td className="td-muted">{r.job_title || '-'}</td>
                    <td className="td-muted">{r.email || '-'}</td>
                    <td className="td-muted">{r.phone || '-'}</td>
                    <td className="td-muted">{r.country || '-'}</td>
                    <td className="td-muted">{r.region_name || '-'}</td>
                    <td><Badge value={r.status} /></td>
                    <td>
                      <div className="td-actions">
                        {canManageCandidates ? (
                          <button
                            className="candidates-kebab-btn"
                            onClick={(e) => openActionMenu(e, r)}
                          >
                            ...
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          {!loading && filtered.length > 0 && (
            <Pagination {...paginationProps} label="candidates" />
          )}
        </div>
      </div>

      <Modal
        open={modal}
        onClose={() => setModal(false)}
        title={editing ? 'Edit Candidate' : 'New Candidate'}
        maxWidth={760}
        modalClassName="candidates-modal-card"
        footer={(
          <div className="candidates-modal-actions">
            <button className="secondary-btn" onClick={() => setModal(false)}>Cancel</button>
            <button className="primary-btn" onClick={save} disabled={saving}>
              {saving ? 'Saving...' : 'Save Candidate'}
            </button>
          </div>
        )}
      >
        <div className="form-grid cols-2">
          <Input
            label="Candidate Name"
            required
            value={form.full_name}
            onChange={(e) => set('full_name', e.target.value)}
          />

          <Input
            label="Candidate Code"
            value={previewCandidateCode}
            onChange={(e) => set('candidate_code', e.target.value.toUpperCase())}
            hint="Auto generated, but you can change it manually"
          />

          <Input
            label="Job Title"
            value={form.job_title}
            onChange={(e) => set('job_title', e.target.value)}
            placeholder="e.g. React Developer"
          />

          <Input
            label="Email"
            type="email"
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
          />

          <Input
            label="Phone"
            value={form.phone}
            onChange={(e) => set('phone', e.target.value)}
          />

          <SearchableSelect
            label="Country"
            value={form.country}
            options={COUNTRY_NAME_OPTIONS}
            placeholder="Search country..."
            emptyMessage="No countries found"
            onChange={(e) => set('country', e.target.value)}
          />

          <Select
            label="Region"
            value={form.region_id || ''}
            onChange={(e) => set('region_id', e.target.value)}
          >
            <option value="">— Select region —</option>
            {regions.map((rg) => <option key={rg.id} value={rg.id}>{rg.region_name}</option>)}
          </Select>

          <div className="span-2">
            <Textarea
              label="Skills"
              value={form.skills}
              onChange={(e) => set('skills', e.target.value)}
              rows={2}
              placeholder="e.g. React, Node.js, PostgreSQL"
            />
          </div>

          <div className="span-2">
            <Textarea
              label="Notes"
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              rows={3}
            />
          </div>

          <Select
            label="Status"
            value={form.status}
            onChange={(e) => set('status', e.target.value)}
          >
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </Select>

          <div className="span-2 form-section">Compliance</div>

          <Input
            label="Tax ID (EIN / SSN)"
            value={form.tax_id}
            onChange={(e) => set('tax_id', e.target.value)}
            placeholder="Optional"
          />
          <Input
            label="Work Authorization"
            value={form.work_authorization}
            onChange={(e) => set('work_authorization', e.target.value)}
            placeholder="e.g. Citizen, GC, H1B, OPT"
          />
          <Input
            label="Work Auth Expiry"
            type="date"
            value={toLocalYMD(form.work_auth_expiry)}
            onChange={(e) => set('work_auth_expiry', e.target.value)}
          />
          <Input
            label="Insurance Expiry"
            type="date"
            value={toLocalYMD(form.insurance_expiry)}
            onChange={(e) => set('insurance_expiry', e.target.value)}
          />
          <label className="text-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!form.is_1099} onChange={(e) => set('is_1099', e.target.checked)} />
            Track for 1099 (contractor)
          </label>
          <label className="text-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={!!form.w9_on_file} onChange={(e) => set('w9_on_file', e.target.checked)} />
            W-9 on file
          </label>
        </div>
      </Modal>

      <CandidateViewModal
        candidate={viewing}
        canEdit={canManageCandidates}
        onEdit={(c) => openEdit(c)}
        onOpenDetail={(c) => navigate(`/candidates/${c.id}`)}
        onClose={() => setViewing(null)}
      />

      <ConfirmDialog
        open={!!deleting}
        onClose={() => !deleteLoading && setDeleting(null)}
        onConfirm={confirmDelete}
        loading={deleteLoading}
        title="Delete Candidate"
        message={`Delete candidate ${deleting?.full_name || ''}? This cannot be undone. If the candidate has linked placements, deletion will be blocked.`}
      />

      {canManageCandidates && actionMenu.open && actionMenu.row && createPortal(
        <div
          className="floating-action-menu candidates-action-menu"
          style={{ top: actionMenu.y, left: actionMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button className="floating-action-item" onClick={() => openView(actionMenu.row)}>
            View
          </button>
          <button className="floating-action-item" onClick={() => openEdit(actionMenu.row)}>
            Edit
          </button>
          {canDeleteCandidates ? (
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

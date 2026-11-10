import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import api from '../services/api'
import { Modal, Badge, SkeletonRows, Input, Select, PasswordInput, fmtDateDisplay } from '../components/ui/index.jsx'
import StatCard from '../components/common/StatCard'
import { useToast } from '../context/ToastContext'
import { useAuth } from '../context/AuthContext'
import { ACTION_ACCESS, hasAnyRole } from '../utils/acl'

const BLANK = { full_name:'', email:'', password:'', role_id:'', phone:'', status:'ACTIVE' }

export default function UsersPage() {
  const toast = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  const { user } = useAuth()
  const roleName = user?.roleName
  const canManageUsers = hasAnyRole(roleName, ACTION_ACCESS.users.manage)
  const [rows, setRows] = useState([])
  const [roles, setRoles] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [modal, setModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(BLANK)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    try {
      setLoading(true)
      const [u, r] = await Promise.all([api.get('/users'), api.get('/roles')])
      setRows(u.data.data || [])
      setRoles(r.data.data || [])
    } catch { toast.error('Failed to load') } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const openCreate = () => { setEditing(null); setForm(BLANK); setModal(true) }
  const openEdit = (row) => { setEditing(row); setForm({ ...BLANK, ...row, role_id: row.role_id || '', password: '' }); setModal(true) }

  useEffect(() => {
    if (searchParams.get('action') !== 'create' || !canManageUsers) return
    openCreate()
    setSearchParams({}, { replace: true })
  }, [searchParams, setSearchParams, canManageUsers])

  const save = async () => {
    if (!form.full_name || !form.email || !form.role_id) { toast.error('Name, email and role required'); return }
    if (!editing && !form.password) { toast.error('Password required for new user'); return }
    setSaving(true)
    try {
      if (editing) await api.put(`/users/${editing.id}`, form)
      else await api.post('/users', form)
      toast.success(`User ${editing ? 'updated' : 'created'}`)
      setModal(false); load()
    } catch (e) { toast.error(e.response?.data?.message || 'Save failed') } finally { setSaving(false) }
  }

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const filtered = rows.filter(r => {
    const s = search.toLowerCase()
    const matchSearch = !search || r.full_name.toLowerCase().includes(s) || r.email.toLowerCase().includes(s) || r.role_name?.toLowerCase().includes(s)
    const matchRole = !roleFilter || String(r.role_id || '') === roleFilter
    const matchStatus = !statusFilter || String(r.status || '').toUpperCase() === statusFilter
    return matchSearch && matchRole && matchStatus
  })

  const userStats = useMemo(() => {
    const active = filtered.filter((row) => String(row.status || '').toUpperCase() === 'ACTIVE').length
    return { total: filtered.length, active, inactive: filtered.length - active }
  }, [filtered])

  return (
    <div className="dashboard-page users-page">
      <div className="page-header">
        <div><div className="page-title">Users</div><div className="page-subtitle">Manage system access and role assignments</div></div>
        <div className="page-actions">{canManageUsers ? <button className="primary-btn" onClick={openCreate}>+ Add User</button> : null}</div>
      </div>

      <div className="table-card glass-card">
        <div className="table-toolbar">
          <input className="search-input" placeholder="Search by name, email, role..." value={search} onChange={e => setSearch(e.target.value)} />
          <select className="filter-select" value={roleFilter} onChange={e => setRoleFilter(e.target.value)}>
            <option value="">All Roles</option>
            {roles.map((role) => (
              <option key={role.id} value={String(role.id)}>{role.role_name}</option>
            ))}
          </select>
          <select className="filter-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="">All Status</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </select>
          <button
            type="button"
            className="secondary-btn"
            onClick={() => {
              setSearch('')
              setRoleFilter('')
              setStatusFilter('')
            }}
          >
            Reset
          </button>
          <span className="text-muted text-sm" style={{ marginLeft: 'auto' }}>{filtered.length} users</span>
        </div>
        <div className="stats-grid stats-grid-three users-stats-grid">
          <StatCard
            label="Total Users"
            value={userStats.total.toLocaleString('en-US')}
            hint="All user accounts"
          />
          <StatCard
            label="Active Users"
            value={userStats.active.toLocaleString('en-US')}
            hint="Currently active accounts"
            tone="success"
          />
          <StatCard
            label="Inactive Users"
            value={userStats.inactive.toLocaleString('en-US')}
            hint="Disabled or paused accounts"
            tone="info"
          />
        </div>
        <div className="table-wrap">
          <table className="saas-table">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Phone</th><th>Last Login</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {loading ? <SkeletonRows cols={7} /> : filtered.length === 0
                ? <tr className="empty-row"><td colSpan={7}>No users found</td></tr>
                : filtered.map(r => (
                  <tr key={r.id}>
                    <td className="fw-bold">{r.full_name}</td>
                    <td className="td-muted text-sm">{r.email}</td>
                    <td><span className="badge badge-blue">{r.role_name}</span></td>
                    <td className="td-muted text-sm">{r.phone || '—'}</td>
                    <td className="td-muted text-sm">{r.last_login_at ? fmtDateDisplay(r.last_login_at) : 'Never'}</td>
                    <td><Badge value={r.status} /></td>
                    <td><div className="td-actions">{canManageUsers ? <button className="secondary-btn" onClick={() => openEdit(r)}>Edit</button> : null}</div></td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      <Modal open={canManageUsers && modal} onClose={() => setModal(false)} title={editing ? 'Edit User' : 'New User'} maxWidth={560} modalClassName="users-modal-card"
        footer={<div className="users-modal-actions"><button className="secondary-btn" onClick={() => setModal(false)}>Cancel</button><button className="primary-btn" onClick={save} disabled={saving}>{saving ? 'Saving...' : 'Save User'}</button></div>}>
        <div className="form-grid cols-2">
          <Input label="Full Name" required value={form.full_name} onChange={e => set('full_name', e.target.value)} autoComplete="off" />
          <Input label="Email" required type="email" value={form.email} onChange={e => set('email', e.target.value)} autoComplete="off" />
          <Select label="Role" required value={form.role_id} onChange={e => set('role_id', e.target.value)}>
            <option value="">Select role…</option>
            {roles.map(r => <option key={r.id} value={r.id}>{r.role_name}</option>)}
          </Select>
          <Input label="Phone" value={form.phone} onChange={e => set('phone', e.target.value)} autoComplete="off" />
          <PasswordInput label={editing ? 'New Password (leave blank to keep)' : 'Password'} required={!editing}
            value={form.password} onChange={e => set('password', e.target.value)}
            autoComplete="new-password"
            placeholder={editing ? 'Leave blank to keep current' : 'Min 8 characters'} />
          <Select label="Status" value={form.status} onChange={e => set('status', e.target.value)}>
            <option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option>
          </Select>
        </div>
      </Modal>
    </div>
  )
}

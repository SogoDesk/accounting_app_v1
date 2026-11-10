import { useEffect, useState } from 'react'
import api from '../../services/api'
import { useToast } from '../../context/ToastContext'
import { Modal, Input, SkeletonRows, ConfirmDialog } from '../../components/ui/index.jsx'
import { PERMISSION_GROUPS, PERMISSION_LABELS } from '../../data/permissions'

const BLANK = { role_name: '', description: '', permissions: [] }

export default function RolesTab() {
  const toast = useToast()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(BLANK)
  const [saving, setSaving] = useState(false)
  const [toDelete, setToDelete] = useState(null)

  const load = async () => {
    try {
      setLoading(true)
      const r = await api.get('/roles')
      setRows(r.data.data || [])
    } catch { toast.error('Failed to load roles') } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const openCreate = () => { setEditing(null); setForm(BLANK); setModal(true) }
  const openEdit = (row) => {
    setEditing(row)
    setForm({ role_name: row.role_name, description: row.description || '', permissions: [...(row.permissions || [])] })
    setModal(true)
  }

  const toggle = (key) => setForm(f => ({
    ...f,
    permissions: f.permissions.includes(key) ? f.permissions.filter(k => k !== key) : [...f.permissions, key],
  }))
  const toggleGroup = (keys, on) => setForm(f => ({
    ...f,
    permissions: on ? [...new Set([...f.permissions, ...keys])] : f.permissions.filter(k => !keys.includes(k)),
  }))

  const save = async () => {
    if (!editing && !form.role_name.trim()) { toast.error('Role name required'); return }
    setSaving(true)
    try {
      const body = { role_name: form.role_name, description: form.description, permissions: form.permissions }
      if (editing) await api.put(`/roles/${editing.id}`, body)
      else await api.post('/roles', body)
      toast.success(`Role ${editing ? 'updated' : 'created'}`)
      setModal(false); load()
    } catch (e) { toast.error(e.response?.data?.message || 'Save failed') } finally { setSaving(false) }
  }

  const remove = async () => {
    try {
      await api.delete(`/roles/${toDelete.id}`)
      toast.success('Role deleted'); setToDelete(null); load()
    } catch (e) { toast.error(e.response?.data?.message || 'Delete failed'); setToDelete(null) }
  }

  return (
    <div className="table-card glass-card">
      <div className="table-toolbar">
        <strong>Roles &amp; permissions</strong>
        <button className="primary-btn" style={{ marginLeft: 'auto' }} onClick={openCreate}>+ Add role</button>
      </div>
      <div style={{ padding: '0 16px' }}>
        <p className="text-muted text-sm">
          Permissions control which sections each role sees in the menu. Built-in roles can be tuned but not deleted.
        </p>
      </div>
      <div className="table-wrap">
        <table className="saas-table">
          <thead><tr><th>Role</th><th>Description</th><th>Users</th><th>Access</th><th>Actions</th></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={5} /> : rows.map(r => (
              <tr key={r.id}>
                <td className="fw-bold">{r.role_name}{r.is_system ? <span className="badge badge-gray" style={{ marginLeft: 8 }}>Built-in</span> : null}</td>
                <td className="td-muted text-sm">{r.description || '—'}</td>
                <td>{r.user_count}</td>
                <td className="td-muted text-sm">{(r.permissions || []).length} modules</td>
                <td><div className="td-actions">
                  <button className="secondary-btn" onClick={() => openEdit(r)}>Edit</button>
                  {!r.is_system ? <button className="secondary-btn" onClick={() => setToDelete(r)}>Delete</button> : null}
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={modal} onClose={() => setModal(false)} title={editing ? `Edit role: ${editing.role_name}` : 'New role'} maxWidth={640}
        footer={<><button className="secondary-btn" onClick={() => setModal(false)}>Cancel</button><button className="primary-btn" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save role'}</button></>}>
        <div className="form-grid cols-2">
          <Input label="Role name" required value={form.role_name} disabled={editing?.is_system}
            onChange={e => set_role(setForm, e.target.value)} hint={editing?.is_system ? 'Built-in role name is fixed' : 'Stored as UPPER_SNAKE_CASE'} />
          <Input label="Description" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
        </div>
        <div style={{ marginTop: 8 }}>
          <div className="fw-bold" style={{ marginBottom: 8 }}>Module access</div>
          {PERMISSION_GROUPS.map(group => {
            const allOn = group.keys.every(k => form.permissions.includes(k))
            return (
              <div key={group.label} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span className="fw-bold text-sm">{group.label}</span>
                  <button type="button" className="text-sm" onClick={() => toggleGroup(group.keys, !allOn)}
                    style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer', padding: 0 }}>{allOn ? 'Clear all' : 'Select all'}</button>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 6 }}>
                  {group.keys.map(key => (
                    <label key={key} style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                      <input type="checkbox" checked={form.permissions.includes(key)} onChange={() => toggle(key)} />
                      <span className="text-sm">{PERMISSION_LABELS[key] || key}</span>
                    </label>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </Modal>

      <ConfirmDialog open={!!toDelete} onClose={() => setToDelete(null)} onConfirm={remove}
        title="Delete role" message={`Delete role "${toDelete?.role_name}"? This cannot be undone.`} />
    </div>
  )
}

// Keep role_name normalization light in the UI; the backend canonicalizes it.
function set_role(setForm, value) {
  setForm(f => ({ ...f, role_name: value }))
}

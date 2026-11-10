import { useEffect, useState } from 'react'
import api from '../../services/api'
import { useToast } from '../../context/ToastContext'
import { Modal, Input, Select, SkeletonRows, ConfirmDialog } from '../../components/ui/index.jsx'

const BLANK = { name: '', rate_percent: '', region_id: '', is_default: false, status: 'ACTIVE' }

export default function TaxTab() {
  const toast = useToast()
  const [rows, setRows] = useState([])
  const [regions, setRegions] = useState([])
  const [loading, setLoading] = useState(true)
  const [modal, setModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(BLANK)
  const [saving, setSaving] = useState(false)
  const [toDelete, setToDelete] = useState(null)

  const load = async () => {
    try {
      setLoading(true)
      const [t, r] = await Promise.all([api.get('/settings/tax-rates'), api.get('/regions')])
      setRows(t.data.data || [])
      setRegions(r.data.data || [])
    } catch { toast.error('Failed to load tax rates') } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const openCreate = () => { setEditing(null); setForm(BLANK); setModal(true) }
  const openEdit = (row) => { setEditing(row); setForm({ name: row.name, rate_percent: row.rate_percent, region_id: row.region_id || '', is_default: !!row.is_default, status: row.status }); setModal(true) }

  const save = async () => {
    if (!form.name.trim()) { toast.error('Name required'); return }
    if (!(Number(form.rate_percent) >= 0)) { toast.error('Rate required'); return }
    setSaving(true)
    try {
      const body = { name: form.name.trim(), rate_percent: Number(form.rate_percent), region_id: form.region_id || null, is_default: form.is_default, status: form.status }
      if (editing) await api.put(`/settings/tax-rates/${editing.id}`, body)
      else await api.post('/settings/tax-rates', body)
      toast.success(`Tax rate ${editing ? 'updated' : 'created'}`)
      setModal(false); load()
    } catch (e) { toast.error(e.response?.data?.message || 'Save failed') } finally { setSaving(false) }
  }

  const remove = async () => {
    try {
      await api.delete(`/settings/tax-rates/${toDelete.id}`)
      toast.success('Tax rate deleted'); setToDelete(null); load()
    } catch (e) { toast.error(e.response?.data?.message || 'Delete failed') }
  }

  return (
    <div className="table-card glass-card">
      <div className="table-toolbar">
        <strong>Tax rates</strong>
        <button className="primary-btn" style={{ marginLeft: 'auto' }} onClick={openCreate}>+ Add tax rate</button>
      </div>
      <div className="table-wrap">
        <table className="saas-table">
          <thead><tr><th>Name</th><th style={{ textAlign: 'right' }}>Rate %</th><th>Applies to</th><th>Default</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={6} /> : rows.length === 0
              ? <tr className="empty-row"><td colSpan={6}>No tax rates yet. Add one to reuse across invoices and bills.</td></tr>
              : rows.map(r => (
                <tr key={r.id}>
                  <td className="fw-bold">{r.name}</td>
                  <td className="td-mono" style={{ textAlign: 'right' }}>{Number(r.rate_percent).toFixed(2)}%</td>
                  <td>{r.region_name || 'All regions'}</td>
                  <td>{r.is_default ? <span className="badge badge-green">Default</span> : '—'}</td>
                  <td><span className={`badge ${r.status === 'ACTIVE' ? 'badge-green' : 'badge-gray'}`}>{r.status}</span></td>
                  <td><div className="td-actions">
                    <button className="secondary-btn" onClick={() => openEdit(r)}>Edit</button>
                    <button className="secondary-btn" onClick={() => setToDelete(r)}>Delete</button>
                  </div></td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <Modal open={modal} onClose={() => setModal(false)} title={editing ? 'Edit tax rate' : 'New tax rate'} maxWidth={480}
        footer={<><button className="secondary-btn" onClick={() => setModal(false)}>Cancel</button><button className="primary-btn" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button></>}>
        <div className="form-grid cols-2">
          <Input label="Name" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. VAT 20%" />
          <Input label="Rate %" required type="number" step="0.001" min="0" max="100" value={form.rate_percent} onChange={e => set('rate_percent', e.target.value)} />
          <Select label="Applies to region" value={form.region_id} onChange={e => set('region_id', e.target.value)} hint="Leave blank for all regions">
            <option value="">All regions</option>
            {regions.map(r => <option key={r.id} value={r.id}>{r.region_name}</option>)}
          </Select>
          <Select label="Status" value={form.status} onChange={e => set('status', e.target.value)}>
            <option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option>
          </Select>
        </div>
        <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
          <input type="checkbox" checked={form.is_default} onChange={e => set('is_default', e.target.checked)} />
          <span>Use as the default tax rate</span>
        </label>
      </Modal>

      <ConfirmDialog open={!!toDelete} onClose={() => setToDelete(null)} onConfirm={remove}
        title="Delete tax rate" message={`Delete "${toDelete?.name}"? This cannot be undone.`} />
    </div>
  )
}

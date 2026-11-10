import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../../services/api'

export default function CategoriesPage() {
  const [ready, setReady] = useState(true)
  const [message, setMessage] = useState('')
  const [rows, setRows] = useState([])
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [accountId, setAccountId] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const load = () => {
    setLoading(true)
    api.get('/expenses/categories', { params: { all: 'true' } })
      .then((r) => { setReady(r.data.ready !== false); setMessage(r.data.message || ''); setRows(r.data.data || []) })
      .catch((e) => setError(e.response?.data?.message || e.message))
      .finally(() => setLoading(false))
  }
  useEffect(() => {
    load()
    api.get('/gl/chart-of-accounts').then((r) => setAccounts((r.data.data || []).filter((a) => ['EXPENSE', 'ASSET'].includes(a.account_type)))).catch(() => {})
  }, [])

  const add = async () => {
    if (!name.trim()) { setError('Enter a category name'); return }
    setSaving(true); setError('')
    try { await api.post('/expenses/categories', { name, gl_account_id: accountId || null }); setName(''); setAccountId(''); load() }
    catch (e) { setError(e.response?.data?.message || e.message) }
    finally { setSaving(false) }
  }
  const setStatus = async (c, active) => {
    if (c.is_active === active) return
    // optimistic flip so the dropdown feels instant
    setRows((prev) => prev.map((row) => (row.id === c.id ? { ...row, is_active: active } : row)))
    try { await api.put(`/expenses/categories/${c.id}`, { is_active: active }) }
    catch (e) { setError(e.response?.data?.message || e.message); load() }
  }

  return (
    <div className="dashboard-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Expense Categories</h1>
          <p className="page-subtitle">Each category maps to a ledger account, so spend lands in the right place on the P&amp;L.</p>
        </div>
      </div>

      {!ready ? (
        <div className="table-card glass-card" style={{ padding: 24 }}>
          <h3 style={{ marginTop: 0 }}>Expenses not enabled yet</h3>
          <p className="text-muted">{message || 'Apply migration 003 and restart the backend.'}</p>
        </div>
      ) : (
        <div className="table-card glass-card">
          <div className="table-toolbar" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input className="filter-select" style={{ flex: '1 1 200px' }} placeholder="New category name" value={name} onChange={(e) => setName(e.target.value)} />
            <select className="filter-select" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">Map to ledger account…</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.account_code} · {a.account_name}</option>)}
            </select>
            <button className="primary-btn" onClick={add} disabled={saving}>{saving ? 'Adding…' : 'Add category'}</button>
          </div>
          {error && <p style={{ color: 'var(--danger)', fontSize: 13, padding: '0 4px' }}>{error}</p>}

          <div className="table-wrap">
            <table className="saas-table">
              <thead><tr><th>Category</th><th>Ledger account</th><th style={{ width: 150 }}>Status</th></tr></thead>
              <tbody>
                {loading ? <tr><td colSpan={3} className="empty-row">Loading…</td></tr>
                : rows.length === 0 ? <tr><td colSpan={3} className="empty-row">No categories yet.</td></tr>
                : rows.map((c) => (
                  <tr key={c.id}>
                    <td className="fw-bold"><Link to={`/expenses/categories/${c.id}`} state={{ from: '/expenses/categories', label: 'Categories' }} style={{ color: 'var(--primary)', textDecoration: 'none' }}>{c.name}</Link></td>
                    <td className="text-muted text-sm">{c.account_code ? `${c.account_code} · ${c.gl_account_name}` : '—'}</td>
                    <td>
                      <select
                        className="filter-select" style={{ height: 32, fontSize: 13, padding: '0 10px', width: 130 }}
                        value={c.is_active ? 'active' : 'inactive'}
                        onChange={(e) => setStatus(c, e.target.value === 'active')}
                      >
                        <option value="active">Active</option>
                        <option value="inactive">Inactive</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

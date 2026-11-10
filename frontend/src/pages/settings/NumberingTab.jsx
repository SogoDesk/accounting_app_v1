import { useEffect, useState } from 'react'
import api from '../../services/api'
import { useToast } from '../../context/ToastContext'
import { SkeletonRows } from '../../components/ui/index.jsx'

const YEAR = new Date().getFullYear()

const preview = (row) => {
  const pad = ''.padStart(Math.max(1, Number(row.padding) || 1), '0').replace(/0$/, '1')
  const num = pad // e.g. "0001"
  return row.include_year ? `${row.prefix}-${YEAR}-${num}` : `${row.prefix}-${num}`
}

export default function NumberingTab() {
  const toast = useToast()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [savingType, setSavingType] = useState(null)

  const load = async () => {
    try {
      setLoading(true)
      const r = await api.get('/settings/numbering')
      setRows(r.data.data || [])
    } catch { toast.error('Failed to load numbering') } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const setField = (doc_type, k, v) => setRows(rows => rows.map(r => r.doc_type === doc_type ? { ...r, [k]: v } : r))

  const save = async (row) => {
    setSavingType(row.doc_type)
    try {
      await api.put(`/settings/numbering/${row.doc_type}`, {
        prefix: row.prefix, padding: Number(row.padding), include_year: row.include_year,
      })
      toast.success(`${row.label} numbering saved`)
      load()
    } catch (e) { toast.error(e.response?.data?.message || 'Save failed') } finally { setSavingType(null) }
  }

  return (
    <div className="table-card glass-card">
      <div className="table-toolbar"><strong>Document numbering</strong><span className="text-muted text-sm">Applies to newly created documents only</span></div>
      <div className="table-wrap">
        <table className="saas-table">
          <thead><tr><th>Document</th><th>Prefix</th><th>Digits</th><th>Include year</th><th>Next looks like</th><th></th></tr></thead>
          <tbody>
            {loading ? <SkeletonRows cols={6} /> : rows.map(row => (
              <tr key={row.doc_type}>
                <td className="fw-bold">{row.label}</td>
                <td>
                  <input className="form-control" style={{ maxWidth: 110 }} value={row.prefix}
                    onChange={e => setField(row.doc_type, 'prefix', e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
                </td>
                <td>
                  <input className="form-control" type="number" min={1} max={12} style={{ maxWidth: 80 }} value={row.padding}
                    onChange={e => setField(row.doc_type, 'padding', e.target.value)} />
                </td>
                <td>
                  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <input type="checkbox" checked={!!row.include_year} onChange={e => setField(row.doc_type, 'include_year', e.target.checked)} />
                    <span className="text-sm">{row.include_year ? 'Yes' : 'No'}</span>
                  </label>
                </td>
                <td className="td-mono">{preview(row)}</td>
                <td><button className="secondary-btn" onClick={() => save(row)} disabled={savingType === row.doc_type}>{savingType === row.doc_type ? 'Saving…' : 'Save'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

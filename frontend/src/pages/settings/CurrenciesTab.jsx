import { useEffect, useState } from 'react'
import api from '../../services/api'
import { useToast } from '../../context/ToastContext'
import { Input, Select, SkeletonRows, fmtDateDisplay } from '../../components/ui/index.jsx'

const COMMON = ['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'SGD', 'AED', 'JPY']

export default function CurrenciesTab() {
  const toast = useToast()
  const [groupCurrency, setGroupCurrency] = useState('USD')
  const [savingGroup, setSavingGroup] = useState(false)
  const [rates, setRates] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ from_currency: '', to_currency: '', rate: '', rate_date: '' })
  const [savingRate, setSavingRate] = useState(false)

  const load = async () => {
    try {
      setLoading(true)
      const [c, r] = await Promise.all([api.get('/settings/company'), api.get('/settings/exchange-rates')])
      setGroupCurrency(c.data.data?.group_currency || 'USD')
      setRates(r.data.data || [])
    } catch { toast.error('Failed to load currency settings') } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const saveGroup = async () => {
    setSavingGroup(true)
    try {
      await api.put('/settings/company', { group_currency: groupCurrency })
      toast.success('Reporting currency updated')
    } catch (e) { toast.error(e.response?.data?.message || 'Save failed') } finally { setSavingGroup(false) }
  }

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const saveRate = async () => {
    const from = String(form.from_currency).trim().toUpperCase()
    const to = String(form.to_currency).trim().toUpperCase()
    if (!from || !to) { toast.error('From and To currency required'); return }
    if (from === to) { toast.error('From and To must differ'); return }
    if (!(Number(form.rate) > 0)) { toast.error('Rate must be a positive number'); return }
    setSavingRate(true)
    try {
      await api.post('/settings/exchange-rates', { from_currency: from, to_currency: to, rate: Number(form.rate), rate_date: form.rate_date || undefined })
      toast.success(`Manual rate ${from}→${to} saved`)
      setForm({ from_currency: '', to_currency: '', rate: '', rate_date: '' })
      load()
    } catch (e) { toast.error(e.response?.data?.message || 'Save failed') } finally { setSavingRate(false) }
  }

  return (
    <div>
      <div className="table-card glass-card" style={{ marginBottom: 16 }}>
        <div className="table-toolbar"><strong>Reporting (group) currency</strong></div>
        <div style={{ padding: 16, maxWidth: 420 }}>
          <p className="text-muted text-sm" style={{ marginTop: 0 }}>
            All consolidated, cross-entity reports are converted into this currency. Individual entities keep their own functional currency.
          </p>
          <Select label="Group currency" value={groupCurrency} onChange={e => setGroupCurrency(e.target.value)}>
            {COMMON.map(c => <option key={c} value={c}>{c}</option>)}
          </Select>
          <button className="primary-btn" onClick={saveGroup} disabled={savingGroup}>{savingGroup ? 'Saving…' : 'Save reporting currency'}</button>
        </div>
      </div>

      <div className="table-card glass-card">
        <div className="table-toolbar"><strong>Exchange rates</strong><span className="text-muted text-sm">Manual rates override the daily API feed</span></div>
        <div style={{ padding: 16, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, alignItems: 'end' }}>
          <Input label="From" placeholder="EUR" value={form.from_currency} onChange={e => set('from_currency', e.target.value.toUpperCase())} />
          <Input label="To" placeholder="USD" value={form.to_currency} onChange={e => set('to_currency', e.target.value.toUpperCase())} />
          <Input label="Rate" type="number" step="0.00000001" placeholder="1.08" value={form.rate} onChange={e => set('rate', e.target.value)} />
          <Input label="As of date" type="date" value={form.rate_date} onChange={e => set('rate_date', e.target.value)} hint="Defaults to today" />
          <button className="primary-btn" onClick={saveRate} disabled={savingRate} style={{ height: 40 }}>{savingRate ? 'Saving…' : '+ Set manual rate'}</button>
        </div>
        <div className="table-wrap">
          <table className="saas-table">
            <thead><tr><th>From</th><th>To</th><th style={{ textAlign: 'right' }}>Rate</th><th>As of</th><th>Source</th></tr></thead>
            <tbody>
              {loading ? <SkeletonRows cols={5} /> : rates.length === 0
                ? <tr className="empty-row"><td colSpan={5}>No rates yet. Add a manual rate above.</td></tr>
                : rates.map((r, i) => (
                  <tr key={`${r.from_currency}-${r.to_currency}-${i}`}>
                    <td className="fw-bold">{r.from_currency}</td>
                    <td>{r.to_currency}</td>
                    <td className="td-mono" style={{ textAlign: 'right' }}>{Number(r.rate).toLocaleString('en-US', { maximumFractionDigits: 6 })}</td>
                    <td className="td-muted text-sm">{fmtDateDisplay(r.rate_date)}</td>
                    <td><span className={`badge ${r.source === 'MANUAL' ? 'badge-cyan' : 'badge-gray'}`}>{r.source}</span></td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

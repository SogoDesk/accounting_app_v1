import { useEffect, useState } from 'react'
import api from '../../services/api'
import { useToast } from '../../context/ToastContext'

export default function NotificationsTab() {
  const toast = useToast()
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    try {
      const r = await api.get('/settings/reminders')
      const d = r.data.data || {}
      setForm({
        enabled: !!d.enabled,
        send_on_due: !!d.send_on_due,
        days_before_due: Number(d.days_before_due) || 0,
        overdue_days: Array.isArray(d.overdue_days) ? d.overdue_days.join(', ') : '',
        email: !!(d.channels_json?.email),
        in_app: d.channels_json?.in_app === undefined ? true : !!d.channels_json.in_app,
      })
    } catch { toast.error('Failed to load reminder settings') }
  }
  useEffect(() => { load() }, [])

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const save = async () => {
    setSaving(true)
    try {
      const overdue_days = String(form.overdue_days).split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n) && n > 0)
      await api.put('/settings/reminders', {
        enabled: form.enabled,
        send_on_due: form.send_on_due,
        days_before_due: Number(form.days_before_due) || 0,
        overdue_days,
        channels_json: { email: form.email, in_app: form.in_app },
      })
      toast.success('Reminder settings saved')
      load()
    } catch (e) { toast.error(e.response?.data?.message || 'Save failed') } finally { setSaving(false) }
  }

  if (!form) return <div className="table-card glass-card" style={{ padding: 24 }}><span className="text-muted">Loading…</span></div>

  const Row = ({ label, hint, children }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
      <div><div className="fw-bold">{label}</div>{hint ? <div className="text-muted text-sm">{hint}</div> : null}</div>
      <div>{children}</div>
    </div>
  )

  return (
    <div className="table-card glass-card">
      <div className="table-toolbar"><strong>Invoice reminders</strong><span className="text-muted text-sm">Automatic follow-ups for receivables</span></div>
      <div style={{ padding: '4px 16px 16px', maxWidth: 640 }}>
        <Row label="Enable reminders" hint="Master switch for all invoice reminders">
          <label className="switch-lite"><input type="checkbox" checked={form.enabled} onChange={e => set('enabled', e.target.checked)} /> {form.enabled ? 'On' : 'Off'}</label>
        </Row>
        <Row label="Remind before due" hint="Days before the due date to send an early reminder">
          <input className="form-control" type="number" min={0} style={{ width: 90 }} value={form.days_before_due} onChange={e => set('days_before_due', e.target.value)} disabled={!form.enabled} />
        </Row>
        <Row label="Remind on due date" hint="Send a reminder the day an invoice falls due">
          <label className="switch-lite"><input type="checkbox" checked={form.send_on_due} onChange={e => set('send_on_due', e.target.checked)} disabled={!form.enabled} /> {form.send_on_due ? 'Yes' : 'No'}</label>
        </Row>
        <Row label="Overdue reminders" hint="Days after due to chase, comma-separated (e.g. 1, 3, 7)">
          <input className="form-control" style={{ width: 160 }} value={form.overdue_days} onChange={e => set('overdue_days', e.target.value)} placeholder="1, 3, 7" disabled={!form.enabled} />
        </Row>
        <Row label="Channels" hint="Where reminders are delivered">
          <div style={{ display: 'flex', gap: 16 }}>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={form.in_app} onChange={e => set('in_app', e.target.checked)} disabled={!form.enabled} /> In-app</label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={form.email} onChange={e => set('email', e.target.checked)} disabled={!form.enabled} /> Email</label>
          </div>
        </Row>
        <div style={{ marginTop: 16 }}>
          <button className="primary-btn" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save reminder settings'}</button>
        </div>
      </div>
    </div>
  )
}

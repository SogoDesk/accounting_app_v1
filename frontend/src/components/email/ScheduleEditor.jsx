import { useState } from 'react'
import { card, sectionLabel } from './styles'

const GROUPS = [
  { field: 'before_due_days', title: 'Before the due date', suffix: 'before', sort: (a, b) => b - a },
  { field: 'overdue_days', title: 'After the due date', suffix: 'after', sort: (a, b) => a - b },
]

export default function ScheduleEditor({ schedule, saving, onSave, onError }) {
  const [dayInput, setDayInput] = useState({ before_due_days: '', overdue_days: '' })

  if (!schedule) return null

  const daysIn = (field) => schedule[field] || []

  const addDay = (field) => {
    const n = Number(dayInput[field])
    if (!Number.isInteger(n) || n < 1 || n > 365) {
      onError('Enter a number of days between 1 and 365')
      return
    }
    if (daysIn(field).includes(n)) {
      onError('That day is already in the schedule')
      return
    }
    setDayInput(d => ({ ...d, [field]: '' }))
    onSave({ [field]: [...daysIn(field), n] })
  }

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <div style={{ ...sectionLabel, marginBottom: 0 }}>When this sends</div>
        <label style={{ marginLeft: 'auto', display: 'inline-flex', gap: 7, alignItems: 'center', fontSize: 12.5, color: 'var(--text2)' }}>
          <input type="checkbox" checked={!!schedule.enabled} disabled={saving}
            onChange={e => onSave({ enabled: e.target.checked })} />
          <span>Automatic reminders on</span>
        </label>
      </div>

      {GROUPS.map(g => (
        <div key={g.field} style={{ marginTop: 18 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text2)', marginBottom: 9 }}>{g.title}</div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {[...daysIn(g.field)].sort(g.sort).map(n => (
              <span key={n} style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                padding: '6px 9px 6px 13px', borderRadius: 999, fontSize: 12.5, fontWeight: 600,
                background: 'var(--primary)', color: '#fff',
              }}>
                {n} {n === 1 ? 'day' : 'days'} {g.suffix}
                <button type="button" title="Remove" disabled={saving}
                  onClick={() => onSave({ [g.field]: daysIn(g.field).filter(d => d !== n) })}
                  style={{
                    width: 17, height: 17, borderRadius: '50%', border: 0, padding: 0,
                    background: 'rgba(255,255,255,.25)', color: '#fff', fontSize: 11, lineHeight: 1,
                  }}>x</button>
              </span>
            ))}

            {daysIn(g.field).length === 0 && (
              <span style={{ fontSize: 12.5, color: 'var(--text2)' }}>None set.</span>
            )}

            <input className="form-control" type="number" min="1" max="365"
              style={{ width: 78, height: 32, fontSize: 12 }} placeholder="days"
              value={dayInput[g.field]} disabled={saving}
              onChange={e => setDayInput(d => ({ ...d, [g.field]: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addDay(g.field) } }} />
            <button type="button" className="secondary-btn" disabled={saving || !dayInput[g.field]}
              style={{ height: 32, fontSize: 12, padding: '0 14px' }} onClick={() => addDay(g.field)}>
              Add
            </button>
          </div>

          {g.field === 'before_due_days' && (
            <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 12.5, color: 'var(--text2)', marginTop: 11 }}>
              <input type="checkbox" checked={!!schedule.send_on_due} disabled={saving}
                onChange={e => onSave({ send_on_due: e.target.checked })} />
              <span>Also send on the due date itself</span>
            </label>
          )}
        </div>
      ))}

      <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 18, lineHeight: 1.5 }}>
        Each point sends once per invoice, and stops as soon as it is paid.
      </div>
    </div>
  )
}

export function scheduleSummary(schedule, templateKey) {
  if (!schedule) return null
  if (templateKey === 'INVOICE') return 'Sent manually from an invoice'
  if (!schedule.enabled) return 'Reminders are turned off'

  const parts = [
    ...[...(schedule.before_due_days || [])].sort((a, b) => b - a).map(n => `${n}d before`),
    ...(schedule.send_on_due ? ['on the due date'] : []),
    ...[...(schedule.overdue_days || [])].sort((a, b) => a - b).map(n => `${n}d after`),
  ]
  return parts.length ? `Sends ${parts.join(', ')}` : 'No send points set'
}

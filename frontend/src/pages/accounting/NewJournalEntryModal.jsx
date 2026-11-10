import { useMemo, useState } from 'react'
import api from '../../services/api'
import { Modal, SearchableSelect } from '../../components/ui'
import { formatMoney, todayISO } from './glHelpers'

// Manual journal entry form. Lines are entered in the selected entity's
// functional currency. Enforces debit = credit before it lets you post.

const blankLine = () => ({ accountId: '', debit: '', credit: '', memo: '' })

const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100

export default function NewJournalEntryModal({ open, onClose, entities, accounts, onPosted }) {
  const [entityId, setEntityId] = useState('')
  const [entryDate, setEntryDate] = useState(todayISO())
  const [description, setDescription] = useState('')
  const [lines, setLines] = useState([blankLine(), blankLine()])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Only real, postable accounts — control accounts (AR/AP) are system-only.
  const accountOptions = useMemo(
    () =>
      (accounts || [])
        .filter((a) => a.is_active && !a.is_control)
        .map((a) => ({
          value: a.id,
          label: `${a.account_code} · ${a.account_name}`,
          meta: a.account_type,
          searchText: `${a.account_code} ${a.account_name} ${a.account_type}`,
        })),
    [accounts],
  )

  const entityCcy = useMemo(() => {
    const e = (entities || []).find((r) => String(r.id) === String(entityId))
    return e ? (e.functional_currency || e.default_currency || 'USD') : 'USD'
  }, [entities, entityId])

  const totals = useMemo(() => {
    const debit = round2(lines.reduce((s, l) => s + Number(l.debit || 0), 0))
    const credit = round2(lines.reduce((s, l) => s + Number(l.credit || 0), 0))
    return { debit, credit, balanced: debit === credit && debit > 0, diff: round2(debit - credit) }
  }, [lines])

  const reset = () => {
    setEntityId('')
    setEntryDate(todayISO())
    setDescription('')
    setLines([blankLine(), blankLine()])
    setError('')
    setSaving(false)
  }

  const close = () => {
    reset()
    onClose?.()
  }

  const updateLine = (idx, patch) =>
    setLines((ls) => ls.map((l, i) => (i === idx ? { ...l, ...patch } : l)))

  const addLine = () => setLines((ls) => [...ls, blankLine()])
  const removeLine = (idx) =>
    setLines((ls) => (ls.length <= 2 ? ls : ls.filter((_, i) => i !== idx)))

  const submit = async () => {
    setError('')
    if (!entityId) return setError('Pick the entity (location) this entry belongs to.')
    if (!entryDate) return setError('Choose an entry date.')
    const filled = lines.filter((l) => l.accountId && (Number(l.debit) > 0 || Number(l.credit) > 0))
    if (filled.length < 2) return setError('Add at least two lines with an account and an amount.')
    if (!totals.balanced) {
      return setError(`Debits and credits must match. They differ by ${formatMoney(Math.abs(totals.diff), entityCcy)}.`)
    }
    setSaving(true)
    try {
      await api.post('/gl/journal-entries', {
        entityId: Number(entityId),
        entryDate,
        description,
        lines: filled.map((l) => ({
          accountId: Number(l.accountId),
          debit: Number(l.debit || 0),
          credit: Number(l.credit || 0),
          memo: l.memo,
        })),
      })
      onPosted?.()
      close()
    } catch (e) {
      setError(e.response?.data?.message || e.message || 'Could not post the entry.')
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="New journal entry"
      maxWidth={820}
      footer={
        <>
          <div className={`je-balance ${totals.balanced ? 'is-ok' : 'is-off'}`}>
            {totals.balanced ? '✓ Balanced' : 'Out of balance'} · Dr {formatMoney(totals.debit, entityCcy)} / Cr {formatMoney(totals.credit, entityCcy)}
          </div>
          <button className="btn btn-secondary" onClick={close} disabled={saving}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={saving || !totals.balanced}>
            {saving ? 'Posting…' : 'Post entry'}
          </button>
        </>
      }
    >
      <p className="text-muted text-sm" style={{ marginTop: 0 }}>
        Record an adjustment by hand. Enter amounts in the entity’s own currency; the two sides must
        balance before you can post.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 14 }}>
        <div className="form-group">
          <label className="form-label required">Entity</label>
          <select className="form-control" value={entityId} onChange={(e) => setEntityId(e.target.value)}>
            <option value="">Select…</option>
            {(entities || []).map((r) => (
              <option key={r.id} value={r.id}>{r.region_name}</option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label required">Date</label>
          <input type="date" className="form-control" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Currency</label>
          <input className="form-control" value={entityCcy} disabled readOnly />
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">Description</label>
        <input
          className="form-control"
          placeholder="e.g. Reclassify office supplies"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="table-wrap" style={{ marginTop: 8 }}>
        <table className="saas-table je-lines">
          <thead>
            <tr>
              <th style={{ minWidth: 240 }}>Account</th>
              <th style={{ width: 130, textAlign: 'right' }}>Debit</th>
              <th style={{ width: 130, textAlign: 'right' }}>Credit</th>
              <th>Memo</th>
              <th style={{ width: 36 }} />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, idx) => (
              <tr key={idx}>
                <td>
                  <SearchableSelect
                    value={l.accountId}
                    options={accountOptions}
                    placeholder="Search account…"
                    onChange={(e) => updateLine(idx, { accountId: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    type="number" min="0" step="0.01" className="form-control" style={{ textAlign: 'right' }}
                    value={l.debit}
                    onChange={(e) => updateLine(idx, { debit: e.target.value, credit: e.target.value ? '' : l.credit })}
                  />
                </td>
                <td>
                  <input
                    type="number" min="0" step="0.01" className="form-control" style={{ textAlign: 'right' }}
                    value={l.credit}
                    onChange={(e) => updateLine(idx, { credit: e.target.value, debit: e.target.value ? '' : l.debit })}
                  />
                </td>
                <td>
                  <input
                    className="form-control"
                    placeholder="Optional"
                    value={l.memo}
                    onChange={(e) => updateLine(idx, { memo: e.target.value })}
                  />
                </td>
                <td style={{ textAlign: 'center' }}>
                  <button
                    type="button" className="btn btn-secondary" title="Remove line"
                    style={{ padding: '4px 8px' }}
                    onClick={() => removeLine(idx)} disabled={lines.length <= 2}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button type="button" className="btn btn-secondary" style={{ marginTop: 10 }} onClick={addLine}>
        + Add line
      </button>

      {error && <div className="error-box" style={{ marginTop: 12 }}>{error}</div>}
    </Modal>
  )
}

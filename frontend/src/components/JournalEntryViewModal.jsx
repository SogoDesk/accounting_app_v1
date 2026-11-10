import { useEffect, useState } from 'react'
import api from '../services/api'
import { Modal, StatusChip, fmt, fmtDateDisplay } from './ui/index.jsx'
import './InvoiceViewModal.css'

const num = (v) => { const n = Number(v || 0); return Number.isNaN(n) ? 0 : n }
const initialsOf = (name = '') => String(name).trim().split(/\s+/).slice(0, 2)
  .map((w) => w[0]).join('').toUpperCase() || '—'

const SOURCE_LABELS = {
  INVOICE: 'Invoice', BILL: 'Bill', PAYMENT: 'Payment', VENDOR_PAYMENT: 'Vendor payment',
  MANUAL: 'Manual', EXPENSE: 'Expense', ADJUSTMENT: 'Adjustment',
}

// Read-only journal-entry viewer — floating, double-entry document layout.
// Self-contained: give it an entryId and it fetches /gl/journal-entries/:id.
export default function JournalEntryViewModal({ entryId, onClose }) {
  const [entry, setEntry] = useState(null)
  const [loading, setLoading] = useState(false)
  const open = entryId != null

  useEffect(() => {
    if (entryId == null) { setEntry(null); return }
    let alive = true
    setLoading(true)
    api.get(`/gl/journal-entries/${entryId}`)
      .then((r) => { if (alive) setEntry(r.data?.data || null) })
      .catch(() => { if (alive) setEntry(null) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [entryId])

  const e = entry
  const ccy = e?.entity_currency
  const lines = Array.isArray(e?.lines) ? e.lines : []
  const debit = lines.reduce((s, l) => s + num(l.debit_base), 0)
  const credit = lines.reduce((s, l) => s + num(l.credit_base), 0)
  const balanced = Math.abs(debit - credit) < 0.005

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={e ? `Journal Entry ${e.entry_no}` : 'Journal Entry'}
      maxWidth={860}
      modalClassName="iv-modal"
      footer={<div className="iv-actions"><button type="button" className="primary-btn" onClick={onClose}>Close</button></div>}
    >
      {loading && !e ? (
        <div className="iv-state">Loading…</div>
      ) : !e ? (
        <div className="iv-state">Journal entry not found.</div>
      ) : (
        <div className="iv-doc">
          <div className="iv-mast">
            <div className="iv-mast-left">
              <div className="iv-mast-eyebrow">Journal Entry</div>
              <div className="iv-mast-number">{e.entry_no}</div>
              <div className="iv-mast-issuer">{SOURCE_LABELS[e.source] || e.source} · {e.entity_name}</div>
            </div>
            <div className="iv-mast-right">
              <StatusChip tone={balanced ? 'success' : 'warn'}>{balanced ? 'Balanced' : (e.status || 'Posted')}</StatusChip>
              <div className="iv-mast-due">
                <span className="iv-mast-due-label">Amount</span>
                <span className="iv-mast-due-val">{fmt(e.amount_base != null ? e.amount_base : debit, ccy)}</span>
              </div>
            </div>
          </div>

          <div className="iv-parties">
            <div className="iv-party">
              <div className="iv-party-label">Entity</div>
              <div className="iv-party-body">
                <span className="iv-avatar">{initialsOf(e.entity_name)}</span>
                <div>
                  <div className="iv-party-name">{e.entity_name || '—'}</div>
                  <div className="iv-party-sub">{SOURCE_LABELS[e.source] || e.source}</div>
                </div>
              </div>
            </div>
            <div className="iv-meta">
              <div className="iv-meta-row"><span>Date</span><strong>{fmtDateDisplay(e.entry_date)}</strong></div>
              <div className="iv-meta-row"><span>Source</span><strong>{SOURCE_LABELS[e.source] || e.source}</strong></div>
              <div className="iv-meta-row"><span>Currency</span><strong>{ccy || '—'}</strong></div>
              <div className="iv-meta-row"><span>Status</span><strong>{e.status || 'POSTED'}</strong></div>
            </div>
          </div>

          {e.description ? (
            <div className="iv-notes"><div className="iv-note"><div className="iv-note-label">Description</div><div>{e.description}</div></div></div>
          ) : null}

          <div>
            <div className="iv-section-label">Lines</div>
            <div className="iv-items">
              <div className="iv-items-head je-lines-row">
                <span>Account</span>
                <span className="iv-col-amt">Debit</span>
                <span className="iv-col-amt">Credit</span>
              </div>
              {lines.length === 0 ? (
                <div className="iv-items-empty">No lines.</div>
              ) : lines.map((l) => (
                <div className="iv-item je-lines-row" key={l.id}>
                  <div>
                    <div className="iv-item-main"><span style={{ fontFamily: 'var(--font-mono)' }}>{l.account_code}</span> · {l.account_name}</div>
                    {l.memo ? <div className="iv-item-sub">{l.memo}</div> : null}
                  </div>
                  <div className="iv-col-amt">{num(l.debit_base) > 0 ? fmt(l.debit_base, ccy) : '—'}</div>
                  <div className="iv-col-amt">{num(l.credit_base) > 0 ? fmt(l.credit_base, ccy) : '—'}</div>
                </div>
              ))}
              <div className="iv-item je-lines-row je-lines-total">
                <div>{balanced ? 'Balanced ✓' : 'Totals'}</div>
                <div className="iv-col-amt">{fmt(debit, ccy)}</div>
                <div className="iv-col-amt">{fmt(credit, ccy)}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

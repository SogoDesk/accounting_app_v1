import { useEffect, useState } from 'react'
import api, { downloadFile } from '../services/api'
import AttachmentsViewer from './AttachmentsViewer'
import { Modal, StatusChip, fmt, fmtDateDisplay } from './ui/index.jsx'
import { useToast } from '../context/ToastContext'
import './InvoiceViewModal.css'

const num = (v) => { const n = Number(v || 0); return Number.isNaN(n) ? 0 : n }

const approvalTone = (status) => {
  const s = String(status || '').toUpperCase()
  if (s === 'APPROVED') return 'success'
  if (s === 'REJECTED') return 'danger'
  if (s === 'PENDING' || s === 'SUBMITTED') return 'warn'
  return 'neutral'
}

const initialsOf = (name = '') => String(name).trim().split(/\s+/).slice(0, 2)
  .map((w) => w[0]).join('').toUpperCase() || '—'

// Read-only bill viewer, laid out like a bill document (mirrors InvoiceViewModal).
// Self-contained: give it a billId and it fetches /bills/:id.
export default function BillViewModal({ billId, onClose, onEdit, canEdit = false, onApprove, onReject }) {
  const toast = useToast()
  const [bill, setBill] = useState(null)
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [acting, setActing] = useState(false)
  const open = billId != null

  const handlePdf = async () => {
    if (!bill) return
    setDownloading(true)
    try {
      await downloadFile(`/api/bills/${bill.id}/pdf`, `Bill ${bill.bill_number}.pdf`)
      toast.success('Bill PDF downloaded')
    } catch {
      toast.error('Failed to download bill PDF')
    } finally {
      setDownloading(false)
    }
  }

  useEffect(() => {
    if (billId == null) { setBill(null); return }
    let alive = true
    setLoading(true)
    api.get(`/bills/${billId}`)
      .then((r) => { if (alive) setBill(r.data?.data || null) })
      .catch(() => { if (alive) setBill(null) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [billId])

  const act = async (fn) => {
    if (!bill || !fn) return
    setActing(true)
    try { await fn(bill) } finally { setActing(false) }
  }

  const b = bill
  const ccy = b?.currency
  const approvalPending = ['PENDING', 'SUBMITTED'].includes(String(b?.approval_status || '').toUpperCase())
  const canApprove = b && approvalPending && (onApprove || onReject)
  const balance = num(b?.balance_outstanding)
  const paid = num(b?.payment_paid_amount)
  const items = b?.line_items || []
  const history = b?.approval_history || []
  const paidClosed = balance <= 0 && num(b?.total_amount) > 0
  const payLabel = paidClosed ? 'Paid' : paid > 0 ? 'Partially paid' : 'Unpaid'
  const payTone = paidClosed ? 'success' : paid > 0 ? 'warn' : 'neutral'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={b ? `Bill ${b.bill_number}` : 'Bill'}
      maxWidth={900}
      modalClassName="iv-modal"
      footer={(
        <div className="iv-actions">
          {b ? (
            <button type="button" className="secondary-btn" onClick={handlePdf} disabled={downloading}>
              {downloading ? 'Preparing…' : 'Download PDF'}
            </button>
          ) : null}
          {b && canEdit && onEdit ? (
            <button type="button" className="secondary-btn" onClick={() => onEdit(b)}>Edit</button>
          ) : null}
          {canApprove && onReject ? (
            <button type="button" className="secondary-btn" onClick={() => act(onReject)} disabled={acting}>Reject</button>
          ) : null}
          {canApprove && onApprove ? (
            <button type="button" className="primary-btn" onClick={() => act(onApprove)} disabled={acting}>
              {acting ? 'Working…' : 'Approve'}
            </button>
          ) : null}
          <button type="button" className={canApprove ? 'secondary-btn' : 'primary-btn'} onClick={onClose}>Close</button>
        </div>
      )}
    >
      {loading && !b ? (
        <div className="iv-state">Loading…</div>
      ) : !b ? (
        <div className="iv-state">Bill not found.</div>
      ) : (
        <div className="iv-doc">
          {/* Masthead */}
          <div className="iv-mast">
            <div className="iv-mast-left">
              <div className="iv-mast-eyebrow">Vendor bill</div>
              <div className="iv-mast-number">{b.bill_number}</div>
              <div className="iv-mast-issuer">{b.region_name || '—'}</div>
            </div>
            <div className="iv-mast-right">
              <div style={{ display: 'flex', gap: 6 }}>
                <StatusChip tone={payTone}>{payLabel}</StatusChip>
                <StatusChip tone={approvalTone(b.approval_status)}>{String(b.approval_status || '—').replace(/_/g, ' ')}</StatusChip>
              </div>
              <div className="iv-mast-due">
                <span className="iv-mast-due-label">{balance > 0 ? 'Balance due' : 'Amount'}</span>
                <span className={`iv-mast-due-val${balance > 0 ? ' is-open' : ''}`}>
                  {fmt(balance > 0 ? balance : b.total_amount, ccy)}
                </span>
              </div>
            </div>
          </div>

          {/* Vendor + meta */}
          <div className="iv-parties">
            <div className="iv-party">
              <div className="iv-party-label">Bill from</div>
              <div className="iv-party-body">
                <span className="iv-avatar">{initialsOf(b.vendor_name)}</span>
                <div>
                  <div className="iv-party-name">{b.vendor_name || '—'}</div>
                  <div className="iv-party-sub">Vendor · {b.region_name || '—'}</div>
                </div>
              </div>
            </div>
            <div className="iv-meta">
              <div className="iv-meta-row"><span>Bill date</span><strong>{fmtDateDisplay(b.bill_date)}</strong></div>
              <div className="iv-meta-row"><span>Due date</span><strong>{fmtDateDisplay(b.due_date)}</strong></div>
              <div className="iv-meta-row"><span>Currency</span><strong>{ccy || '—'}</strong></div>
              {b.external_reference ? <div className="iv-meta-row"><span>Reference</span><strong>{b.external_reference}</strong></div> : null}
            </div>
          </div>

          {/* Line items */}
          <div className="iv-items">
            <div className="iv-items-head">
              <span className="iv-col-desc">Description</span>
              <span className="iv-col-qty">Qty</span>
              <span className="iv-col-rate">Unit price</span>
              <span className="iv-col-amt">Line total</span>
            </div>
            {items.length === 0 ? (
              <div className="iv-items-empty">No line items on this bill.</div>
            ) : items.map((item) => (
              <div className="iv-item" key={item.id}>
                <div className="iv-col-desc"><div className="iv-item-main">{item.description || '—'}</div></div>
                <div className="iv-col-qty">{num(item.quantity).toFixed(2)}</div>
                <div className="iv-col-rate">{fmt(item.unit_price, ccy)}</div>
                <div className="iv-col-amt">{fmt(item.line_total, ccy)}</div>
              </div>
            ))}
          </div>

          {/* Totals */}
          <div className="iv-summary">
            <div className="iv-totals">
              {b.subtotal != null ? <div className="iv-total-row"><span>Subtotal</span><span className="iv-mono">{fmt(b.subtotal, ccy)}</span></div> : null}
              {b.tax_amount != null ? <div className="iv-total-row"><span>Tax</span><span className="iv-mono">{fmt(b.tax_amount, ccy)}</span></div> : null}
              <div className="iv-total-row iv-total-grand"><span>Total</span><span className="iv-mono">{fmt(b.total_amount, ccy)}</span></div>
              <div className="iv-total-row"><span>Paid</span><span className="iv-mono iv-paid">− {fmt(paid, ccy)}</span></div>
              <div className={`iv-total-row iv-total-balance${balance > 0 ? ' is-open' : ''}`}>
                <span>Balance due</span><span className="iv-mono">{fmt(balance, ccy)}</span>
              </div>
            </div>
          </div>

          {/* Approval history */}
          {history.length > 0 && (
            <div>
              <div className="iv-section-label">Approval history</div>
              <div style={{ display: 'grid', gap: 8 }}>
                {history.map((entry) => (
                  <div key={entry.id} className="iv-applied" style={{ padding: '10px 14px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                      <strong style={{ fontSize: 13 }}>{String(entry.action || '').replace(/_/g, ' ')}</strong>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{fmtDateDisplay(entry.acted_at)}</span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{entry.acted_by_name || 'System'}</div>
                    {entry.comments ? <div style={{ fontSize: 13, marginTop: 6 }}>{entry.comments}</div> : null}
                  </div>
                ))}
              </div>
            </div>
          )}

          {b.notes ? (
            <div className="iv-notes"><div className="iv-note"><div className="iv-note-label">Notes</div><div>{b.notes}</div></div></div>
          ) : null}

          <AttachmentsViewer entityType="bill" entityId={b.id} title="Vendor invoices" />
        </div>
      )}
    </Modal>
  )
}

import { useEffect, useState } from 'react'
import api, { downloadFile } from '../services/api'
import { Modal, StatusChip, fmt, fmtDateDisplay } from './ui/index.jsx'
import { useToast } from '../context/ToastContext'
import './InvoiceViewModal.css'

const initialsOf = (name = '') => String(name).trim().split(/\s+/).slice(0, 2)
  .map((w) => w[0]).join('').toUpperCase() || '—'

// Read-only client-payment (receipt) viewer — floating & document-styled.
// Self-contained: give it a paymentId and it fetches /payments/:id.
export default function PaymentReceiptViewModal({ paymentId, onClose, onEdit, canEdit = false }) {
  const toast = useToast()
  const [p, setP] = useState(null)
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const open = paymentId != null

  useEffect(() => {
    if (paymentId == null) { setP(null); return }
    let alive = true
    setLoading(true)
    api.get(`/payments/${paymentId}`)
      .then((r) => { if (alive) setP(r.data?.data || null) })
      .catch(() => { if (alive) setP(null) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [paymentId])

  const handlePdf = async () => {
    if (!p) return
    setDownloading(true)
    try {
      await downloadFile(`/api/payments/${p.id}/receipt`, `Receipt ${p.payment_code || p.reference_number || p.id}.pdf`)
      toast.success('Receipt downloaded')
    } catch {
      toast.error('Failed to download receipt')
    } finally {
      setDownloading(false)
    }
  }

  const ccy = p?.currency
  const tds = p && p.tds_applicable && Number(p.tds_amount || 0) > 0
  const gross = p ? Number(p.amount_received || 0) + (tds ? Number(p.tds_amount || 0) : 0) : 0
  const payer = String(p?.client_name || '—')
  const sub = p ? [p.candidate_name, p.placement_code].filter(Boolean).join(' · ') : ''

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={p ? `Receipt ${p.payment_code || p.reference_number || ''}` : 'Receipt'}
      maxWidth={840}
      modalClassName="iv-modal"
      footer={(
        <div className="iv-actions">
          {p ? (
            <button type="button" className="secondary-btn" onClick={handlePdf} disabled={downloading}>
              {downloading ? 'Preparing…' : 'Download PDF'}
            </button>
          ) : null}
          {p && canEdit && onEdit ? (
            <button type="button" className="secondary-btn" onClick={() => onEdit(p)}>Edit</button>
          ) : null}
          <button type="button" className="primary-btn" onClick={onClose}>Close</button>
        </div>
      )}
    >
      {loading && !p ? (
        <div className="iv-state">Loading…</div>
      ) : !p ? (
        <div className="iv-state">Receipt not found.</div>
      ) : (
        <div className="iv-doc">
          <div className="iv-mast">
            <div className="iv-mast-left">
              <div className="iv-mast-eyebrow">Payment receipt</div>
              <div className="iv-mast-number">{p.payment_code || p.reference_number || '—'}</div>
              <div className="iv-mast-issuer">{fmtDateDisplay(p.payment_date)} · {String(p.payment_mode || '—').replace(/_/g, ' ')}</div>
            </div>
            <div className="iv-mast-right">
              <StatusChip tone="success">Received</StatusChip>
              <div className="iv-mast-due">
                <span className="iv-mast-due-label">Amount received</span>
                <span className="iv-mast-due-val">{fmt(p.amount_received, ccy)}</span>
              </div>
            </div>
          </div>

          <div className="iv-parties">
            <div className="iv-party">
              <div className="iv-party-label">Received from</div>
              <div className="iv-party-body">
                <span className="iv-avatar">{initialsOf(payer)}</span>
                <div>
                  <div className="iv-party-name">{payer}</div>
                  {sub ? <div className="iv-party-sub">{sub}</div> : null}
                </div>
              </div>
            </div>
            <div className="iv-meta">
              <div className="iv-meta-row"><span>Payment date</span><strong>{fmtDateDisplay(p.payment_date)}</strong></div>
              <div className="iv-meta-row"><span>Method</span><strong>{String(p.payment_mode || '—').replace(/_/g, ' ')}</strong></div>
              <div className="iv-meta-row"><span>Reference</span><strong>{p.reference_number || '—'}</strong></div>
              <div className="iv-meta-row"><span>Currency</span><strong>{ccy || '—'}</strong></div>
            </div>
          </div>

          <div>
            <div className="iv-section-label">Applied to invoice</div>
            <div className="iv-applied">
              <div className="iv-applied-head">
                <span className="iv-applied-no">{p.invoice_number || '—'}</span>
                <StatusChip tone={String(p.invoice_status).toUpperCase() === 'PAID' ? 'success' : String(p.invoice_status).toUpperCase() === 'OVERDUE' ? 'danger' : 'accent'}>
                  {String(p.invoice_status || '—').replace(/_/g, ' ')}
                </StatusChip>
              </div>
              <div className="iv-applied-grid">
                <div className="iv-applied-cell"><span>Invoice total</span><strong>{fmt(p.invoice_total_amount, ccy)}</strong></div>
                <div className="iv-applied-cell"><span>Applied</span><strong>{fmt(p.amount_received, ccy)}</strong></div>
                <div className="iv-applied-cell"><span>Balance remaining</span><strong>{fmt(p.invoice_balance_outstanding, ccy)}</strong></div>
              </div>
            </div>
          </div>

          <div className="iv-summary">
            <div className="iv-totals">
              {tds ? (
                <>
                  <div className="iv-total-row"><span>Gross</span><span className="iv-mono">{fmt(gross, ccy)}</span></div>
                  <div className="iv-total-row"><span>TDS ({Number(p.tds_percent || 0)}%)</span><span className="iv-mono iv-paid">− {fmt(p.tds_amount, ccy)}</span></div>
                </>
              ) : null}
              <div className="iv-total-row iv-total-grand"><span>Net received</span><span className="iv-mono">{fmt(p.amount_received, ccy)}</span></div>
            </div>
          </div>

          {p.notes ? (
            <div className="iv-notes"><div className="iv-note"><div className="iv-note-label">Notes</div><div>{p.notes}</div></div></div>
          ) : null}
        </div>
      )}
    </Modal>
  )
}

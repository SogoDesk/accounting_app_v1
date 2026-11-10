import { useEffect, useState } from 'react'
import api, { downloadFile } from '../services/api'
import { Modal, StatusChip, fmt, fmtDateDisplay } from './ui/index.jsx'
import { useToast } from '../context/ToastContext'
import './InvoiceViewModal.css'

const num = (v) => { const n = Number(v || 0); return Number.isNaN(n) ? 0 : n }
const initialsOf = (name = '') => String(name).trim().split(/\s+/).slice(0, 2)
  .map((w) => w[0]).join('').toUpperCase() || '—'

// Read-only vendor-payment (disbursement) voucher, floating & document-styled.
// Self-contained: give it a paymentId and it fetches /vendor-payments/:id.
export default function VendorPaymentViewModal({ paymentId, onClose, onEdit, canEdit = false }) {
  const toast = useToast()
  const [p, setP] = useState(null)
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const open = paymentId != null

  useEffect(() => {
    if (paymentId == null) { setP(null); return }
    let alive = true
    setLoading(true)
    api.get(`/vendor-payments/${paymentId}`)
      .then((r) => { if (alive) setP(r.data?.data || null) })
      .catch(() => { if (alive) setP(null) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [paymentId])

  const ccy = p?.currency

  const handlePdf = async () => {
    if (!p) return
    setDownloading(true)
    try {
      await downloadFile(`/api/vendor-payments/${p.id}/receipt`, `Payment ${p.payment_code || p.reference_number || p.id}.pdf`)
      toast.success('Payment voucher downloaded')
    } catch {
      toast.error('Failed to download payment voucher')
    } finally {
      setDownloading(false)
    }
  }

  const payer = txtVendor(p)
  const sub = p?.bill_number ? `Bill ${p.bill_number}` : ''

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={p ? `Payment ${p.payment_code || p.reference_number || ''}` : 'Payment'}
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
        <div className="iv-state">Payment not found.</div>
      ) : (
        <div className="iv-doc">
          <div className="iv-mast">
            <div className="iv-mast-left">
              <div className="iv-mast-eyebrow">Payment voucher</div>
              <div className="iv-mast-number">{p.payment_code || p.reference_number || '—'}</div>
              <div className="iv-mast-issuer">{fmtDateDisplay(p.payment_date)} · {String(p.payment_method || '—').replace(/_/g, ' ')}</div>
            </div>
            <div className="iv-mast-right">
              <StatusChip tone="success">Paid</StatusChip>
              <div className="iv-mast-due">
                <span className="iv-mast-due-label">Amount paid</span>
                <span className="iv-mast-due-val">{fmt(p.amount_paid, ccy)}</span>
              </div>
            </div>
          </div>

          <div className="iv-parties">
            <div className="iv-party">
              <div className="iv-party-label">Paid to</div>
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
              <div className="iv-meta-row"><span>Method</span><strong>{String(p.payment_method || '—').replace(/_/g, ' ')}</strong></div>
              <div className="iv-meta-row"><span>Reference</span><strong>{p.reference_number || '—'}</strong></div>
              <div className="iv-meta-row"><span>Currency</span><strong>{ccy || '—'}</strong></div>
            </div>
          </div>

          <div>
            <div className="iv-section-label">Applied to bill</div>
            <div className="iv-applied">
              <div className="iv-applied-head">
                <span className="iv-applied-no">{p.bill_number || '—'}</span>
                <StatusChip tone={String(p.bill_status).toUpperCase() === 'PAID' ? 'success' : 'accent'}>
                  {String(p.bill_status || '—').replace(/_/g, ' ')}
                </StatusChip>
              </div>
              <div className="iv-applied-grid">
                <div className="iv-applied-cell"><span>Bill total</span><strong>{fmt(p.bill_total_amount, ccy)}</strong></div>
                <div className="iv-applied-cell"><span>Applied</span><strong>{fmt(p.amount_paid, ccy)}</strong></div>
                <div className="iv-applied-cell"><span>Balance remaining</span><strong>{fmt(p.bill_balance_outstanding, ccy)}</strong></div>
              </div>
            </div>
          </div>

          <div className="iv-summary">
            <div className="iv-totals">
              <div className="iv-total-row iv-total-grand"><span>Net paid</span><span className="iv-mono">{fmt(p.amount_paid, ccy)}</span></div>
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

function txtVendor(p) {
  return String(p?.vendor_name || '—')
}

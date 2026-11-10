import { useEffect, useState } from 'react'
import api, { downloadFile } from '../services/api'
import AttachmentsViewer from './AttachmentsViewer'
import { Modal, StatusChip, fmt, fmtDateDisplay, customerLabel } from './ui/index.jsx'
import { useToast } from '../context/ToastContext'
import './InvoiceViewModal.css'

const num = (v) => { const n = Number(v || 0); return Number.isNaN(n) ? 0 : n }

const statusTone = (status) => {
  const s = String(status || '').toUpperCase()
  if (s === 'PAID') return 'success'
  if (s === 'OVERDUE') return 'danger'
  if (s === 'PARTIALLY_PAID') return 'warn'
  if (s === 'CANCELLED' || s === 'DRAFT') return 'neutral'
  return 'accent'
}

const initialsOf = (name = '') => String(name).trim().split(/\s+/).slice(0, 2)
  .map((w) => w[0]).join('').toUpperCase() || '—'

// Read-only invoice detail viewer, laid out like an actual invoice document.
// Self-contained: give it an invoiceId and it fetches /invoices/:id.
export default function InvoiceViewModal({ invoiceId, onClose, onEdit, canEdit = false }) {
  const toast = useToast()
  const [invoice, setInvoice] = useState(null)
  const [loading, setLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const open = invoiceId != null

  useEffect(() => {
    if (invoiceId == null) { setInvoice(null); return }
    let alive = true
    setLoading(true)
    api.get(`/invoices/${invoiceId}`)
      .then((r) => { if (alive) setInvoice(r.data?.data || null) })
      .catch(() => { if (alive) setInvoice(null) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [invoiceId])

  const v = invoice

  const handlePdf = async () => {
    if (!v) return
    setDownloading(true)
    try {
      await downloadFile(`/api/invoices/${v.id}/pdf`, `Invoice ${v.invoice_number}.pdf`)
      toast.success('Invoice PDF downloaded')
    } catch {
      toast.error('Failed to download invoice PDF')
    } finally {
      setDownloading(false)
    }
  }

  const ccy = v?.currency
  const balance = num(v?.balance_outstanding)
  const items = v?.line_items || []
  const taxes = v?.tax_lines || []

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={v ? `Invoice ${v.invoice_number}` : 'Invoice'}
      maxWidth={880}
      modalClassName="iv-modal"
      footer={(
        <div className="iv-actions">
          {v ? (
            <button type="button" className="secondary-btn" onClick={handlePdf} disabled={downloading}>
              {downloading ? 'Preparing…' : 'Download PDF'}
            </button>
          ) : null}
          {v && canEdit && onEdit ? (
            <button type="button" className="secondary-btn" onClick={() => onEdit(v)}>Edit</button>
          ) : null}
          <button type="button" className="primary-btn" onClick={onClose}>Close</button>
        </div>
      )}
    >
      {loading && !v ? (
        <div className="iv-state">Loading…</div>
      ) : !v ? (
        <div className="iv-state">Invoice not found.</div>
      ) : (
        <div className="iv-doc">
          {/* Masthead */}
          <div className="iv-mast">
            <div className="iv-mast-left">
              <div className="iv-mast-eyebrow">Invoice</div>
              <div className="iv-mast-number">{v.invoice_number}</div>
              <div className="iv-mast-issuer">{v.region_name || '—'}</div>
            </div>
            <div className="iv-mast-right">
              <StatusChip tone={statusTone(v.invoice_status)}>
                {String(v.invoice_status || 'DRAFT').replace(/_/g, ' ')}
              </StatusChip>
              <div className="iv-mast-due">
                <span className="iv-mast-due-label">{balance > 0 ? 'Balance due' : 'Amount'}</span>
                <span className={`iv-mast-due-val${balance > 0 ? ' is-open' : ''}`}>
                  {fmt(balance > 0 ? balance : v.total_amount, ccy)}
                </span>
              </div>
            </div>
          </div>

          {/* Parties + meta */}
          <div className="iv-parties">
            <div className="iv-party">
              <div className="iv-party-label">Billed to</div>
              <div className="iv-party-body">
                <span className="iv-avatar">{initialsOf(v.client_name)}</span>
                <div>
                  <div className="iv-party-name">{v.client_name || '—'}</div>
                  <div className="iv-party-sub">{customerLabel()} · {v.region_name || '—'}</div>
                </div>
              </div>
            </div>
            <div className="iv-meta">
              <div className="iv-meta-row"><span>Invoice date</span><strong>{fmtDateDisplay(v.invoice_date)}</strong></div>
              <div className="iv-meta-row"><span>Due date</span><strong>{fmtDateDisplay(v.due_date)}</strong></div>
              <div className="iv-meta-row"><span>Terms</span><strong>{String(v.invoice_terms_label || '—').replace(/_/g, ' ')}</strong></div>
              <div className="iv-meta-row"><span>Currency</span><strong>{ccy || '—'}</strong></div>
              {(v.billing_period_start || v.billing_period_end) && (
                <div className="iv-meta-row"><span>Billing period</span><strong>{fmtDateDisplay(v.billing_period_start)} – {fmtDateDisplay(v.billing_period_end)}</strong></div>
              )}
            </div>
          </div>

          {/* Line items */}
          <div className="iv-items">
            <div className="iv-items-head">
              <span className="iv-col-desc">Description</span>
              <span className="iv-col-qty">Qty</span>
              <span className="iv-col-rate">Rate</span>
              <span className="iv-col-amt">Amount</span>
            </div>
            {items.length === 0 ? (
              <div className="iv-items-empty">No particulars on this invoice.</div>
            ) : items.map((item) => (
              <div className="iv-item" key={item.id}>
                <div className="iv-col-desc">
                  <div className="iv-item-main">{item.description || item.job_title || '—'}</div>
                  <div className="iv-item-sub">
                    {[item.candidate_name || v.candidate_name, item.placement_code, item.activity_label, item.line_date ? fmtDateDisplay(item.line_date) : null]
                      .filter(Boolean).join(' · ') || null}
                  </div>
                </div>
                <div className="iv-col-qty">{num(item.quantity).toFixed(2)}</div>
                <div className="iv-col-rate">{fmt(item.rate, ccy)}</div>
                <div className="iv-col-amt">{fmt(item.amount, ccy)}</div>
              </div>
            ))}
          </div>

          {/* Totals */}
          <div className="iv-summary">
            {taxes.length > 0 && (
              <div className="iv-taxlines">
                <div className="iv-taxlines-label">Taxes</div>
                {taxes.map((t, i) => (
                  <div className="iv-taxline" key={t.id || i}>
                    <span>{t.tax_name} · {num(t.tax_percent).toFixed(2)}%</span>
                    <span className="iv-mono">{fmt(t.tax_amount, ccy)}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="iv-totals">
              <div className="iv-total-row"><span>Subtotal</span><span className="iv-mono">{fmt(v.subtotal, ccy)}</span></div>
              <div className="iv-total-row"><span>Tax</span><span className="iv-mono">{fmt(v.tax_amount, ccy)}</span></div>
              <div className="iv-total-row iv-total-grand"><span>Total</span><span className="iv-mono">{fmt(v.total_amount, ccy)}</span></div>
              <div className="iv-total-row"><span>Paid</span><span className="iv-mono iv-paid">− {fmt(v.payment_received_amount, ccy)}</span></div>
              <div className={`iv-total-row iv-total-balance${balance > 0 ? ' is-open' : ''}`}>
                <span>Balance due</span><span className="iv-mono">{fmt(balance, ccy)}</span>
              </div>
            </div>
          </div>

          {/* Notes */}
          {(v.customer_message || v.notes || v.internal_notes) && (
            <div className="iv-notes">
              {v.customer_message ? <div className="iv-note"><div className="iv-note-label">Customer message</div><div>{v.customer_message}</div></div> : null}
              {v.notes ? <div className="iv-note"><div className="iv-note-label">Notes</div><div>{v.notes}</div></div> : null}
              {v.internal_notes ? <div className="iv-note"><div className="iv-note-label">Internal notes</div><div>{v.internal_notes}</div></div> : null}
            </div>
          )}

          <AttachmentsViewer entityType="invoice" entityId={v.id} title="Approved timesheets" />
        </div>
      )}
    </Modal>
  )
}

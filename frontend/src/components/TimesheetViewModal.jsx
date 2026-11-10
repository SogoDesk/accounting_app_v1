import AttachmentsViewer from './AttachmentsViewer'
import { Modal, StatusChip, fmt, fmtDateDisplay } from './ui/index.jsx'
import './InvoiceViewModal.css'

const num = (v) => { const n = Number(v || 0); return Number.isNaN(n) ? 0 : n }
const initialsOf = (name = '') => String(name).trim().split(/\s+/).slice(0, 2)
  .map((w) => w[0]).join('').toUpperCase() || '—'

const statusTone = (s) => {
  const v = String(s || '').toUpperCase()
  if (v === 'APPROVED') return 'success'
  if (v === 'INVOICED') return 'neutral'
  if (v === 'REJECTED') return 'danger'
  return 'accent'
}

// Read-only timesheet viewer — floating, document-styled. Driven by the list
// row object; `placementCode`/`role` can be passed in for richer display.
export default function TimesheetViewModal({ timesheet, placementCode, role, onClose }) {
  const t = timesheet
  const open = t != null
  const ccy = t?.currency
  const flat = t && t.billing_type && String(t.billing_type).toUpperCase() !== 'HOURLY' && num(t.bill_rate) === 0

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t ? `Timesheet · ${t.candidate_name || ''}` : 'Timesheet'}
      maxWidth={800}
      modalClassName="iv-modal"
      footer={<div className="iv-actions"><button type="button" className="primary-btn" onClick={onClose}>Close</button></div>}
    >
      {!t ? null : (
        <div className="iv-doc">
          <div className="iv-mast">
            <div className="iv-mast-left">
              <div className="iv-mast-eyebrow">Timesheet</div>
              <div className="iv-mast-number" style={{ fontFamily: 'var(--font-ui)' }}>{t.candidate_name || '—'}</div>
              <div className="iv-mast-issuer">{[t.client_name, placementCode].filter(Boolean).join(' · ') || '—'}</div>
            </div>
            <div className="iv-mast-right">
              <StatusChip tone={statusTone(t.status)}>{String(t.status || '—').replace(/_/g, ' ')}</StatusChip>
              <div className="iv-mast-due">
                <span className="iv-mast-due-label">Billable value</span>
                <span className="iv-mast-due-val">{fmt(t.bill_amount, ccy)}</span>
              </div>
            </div>
          </div>

          <div className="iv-parties">
            <div className="iv-party">
              <div className="iv-party-label">Candidate</div>
              <div className="iv-party-body">
                <span className="iv-avatar">{initialsOf(t.candidate_name)}</span>
                <div>
                  <div className="iv-party-name">{t.candidate_name || '—'}</div>
                  <div className="iv-party-sub">{role || placementCode || '—'}</div>
                </div>
              </div>
            </div>
            <div className="iv-meta">
              <div className="iv-meta-row"><span>Period</span><strong>{fmtDateDisplay(t.period_start)} – {fmtDateDisplay(t.period_end)}</strong></div>
              <div className="iv-meta-row"><span>Client</span><strong>{t.client_name || '—'}</strong></div>
              <div className="iv-meta-row"><span>Bill rate</span><strong>{flat ? String(t.billing_type).replace(/_/g, ' ') : fmt(t.bill_rate, ccy)}</strong></div>
              <div className="iv-meta-row"><span>Currency</span><strong>{ccy || '—'}</strong></div>
              {t.invoice_number ? <div className="iv-meta-row"><span>Invoice</span><strong>{t.invoice_number}</strong></div> : null}
            </div>
          </div>

          <div className="iv-summary">
            <div className="iv-totals">
              <div className="iv-total-row"><span>Hours logged</span><span className="iv-mono">{num(t.units).toFixed(1)}</span></div>
              {!flat ? <div className="iv-total-row"><span>Bill rate</span><span className="iv-mono">{fmt(t.bill_rate, ccy)}</span></div> : null}
              <div className="iv-total-row iv-total-grand"><span>Billable value</span><span className="iv-mono">{fmt(t.bill_amount, ccy)}</span></div>
            </div>
          </div>

          {t.notes ? (
            <div className="iv-notes"><div className="iv-note"><div className="iv-note-label">Notes</div><div>{t.notes}</div></div></div>
          ) : null}

          <AttachmentsViewer entityType="timesheet" entityId={t.id} title="Client approval / proof" />
        </div>
      )}
    </Modal>
  )
}

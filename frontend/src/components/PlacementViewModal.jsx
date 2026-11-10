import { Modal, StatusChip, fmt, fmtDate, currencySymbol } from './ui/index.jsx'
import './InvoiceViewModal.css'

const num = (v) => { const n = Number(v || 0); return Number.isNaN(n) ? 0 : n }
const initialsOf = (name = '') => String(name).trim().split(/\s+/).slice(0, 2)
  .map((w) => w[0]).join('').toUpperCase() || '—'

const statusTone = (s) => {
  const v = String(s || '').toUpperCase()
  if (v === 'ACTIVE') return 'success'
  if (v === 'ON_HOLD') return 'warn'
  if (v === 'CANCELLED') return 'danger'
  return 'neutral' // ENDED / other
}

const billingLabel = (t) => String(t || '').replace(/_/g, ' ') || '—'
const isCustomTerms = (t) => /custom/i.test(String(t || ''))

// Read-only placement viewer — floating, document-styled (mirrors the Sales /
// Purchases view modals). Driven by the list row object.
export default function PlacementViewModal({ placement, onClose, onEdit, onOpenDetail, canEdit = false }) {
  const p = placement
  const open = p != null
  const ccy = p?.currency
  const billingType = String(p?.billing_type || '').toUpperCase()
  const flat = p && billingType && billingType !== 'HOURLY' && num(p.bill_rate) === 0

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={p ? `Placement ${p.placement_code || ''}`.trim() : 'Placement'}
      maxWidth={820}
      modalClassName="iv-modal"
      footer={(
        <div className="iv-actions">
          {p && onOpenDetail ? (
            <button type="button" className="cd-linkbtn" style={{ marginRight: 'auto' }} onClick={() => onOpenDetail(p)}>Open full profile →</button>
          ) : null}
          {p && canEdit && onEdit ? (
            <button type="button" className="secondary-btn" onClick={() => onEdit(p)}>Edit</button>
          ) : null}
          <button type="button" className="primary-btn" onClick={onClose}>Close</button>
        </div>
      )}
    >
      {!p ? null : (
        <div className="iv-doc">
          {/* Masthead */}
          <div className="iv-mast">
            <div className="iv-mast-left">
              <div className="iv-mast-eyebrow">Placement</div>
              <div className="iv-mast-number" style={{ fontFamily: 'var(--font-ui)' }}>{p.placement_code || '—'}</div>
              <div className="iv-mast-issuer">{[p.candidate_name, p.client_name].filter(Boolean).join(' · ') || '—'}</div>
            </div>
            <div className="iv-mast-right">
              <StatusChip tone={statusTone(p.placement_status)}>{String(p.placement_status || '—').replace(/_/g, ' ')}</StatusChip>
              <div className="iv-mast-due">
                <span className="iv-mast-due-label">{flat ? 'Billing' : 'Bill rate'}</span>
                <span className="iv-mast-due-val">{flat ? billingLabel(p.billing_type) : fmt(p.bill_rate, ccy)}</span>
              </div>
            </div>
          </div>

          {/* Candidate + meta */}
          <div className="iv-parties">
            <div className="iv-party">
              <div className="iv-party-label">Candidate</div>
              <div className="iv-party-body">
                <span className="iv-avatar">{initialsOf(p.candidate_name)}</span>
                <div>
                  <div className="iv-party-name">{p.candidate_name || '—'}</div>
                  <div className="iv-party-sub">{p.job_title || '—'}</div>
                </div>
              </div>
            </div>
            <div className="iv-meta">
              <div className="iv-meta-row"><span>Client</span><strong>{p.client_name || '—'}</strong></div>
              <div className="iv-meta-row"><span>Region</span><strong>{p.region_name || '—'}</strong></div>
              <div className="iv-meta-row"><span>Currency</span><strong>{ccy ? `${currencySymbol(ccy)} ${ccy}` : '—'}</strong></div>
              {p.employment_type ? <div className="iv-meta-row"><span>Employment type</span><strong>{String(p.employment_type).replace(/_/g, ' ')}</strong></div> : null}
              {p.recruiter_name ? <div className="iv-meta-row"><span>Recruiter</span><strong>{p.recruiter_name}</strong></div> : null}
              {p.account_manager_name ? <div className="iv-meta-row"><span>Account manager</span><strong>{p.account_manager_name}</strong></div> : null}
              <div className="iv-meta-row"><span>Period</span><strong>{fmtDate(p.start_date) || '—'} – {fmtDate(p.end_date) || '—'}</strong></div>
              {p.end_client_name ? <div className="iv-meta-row"><span>End client</span><strong>{p.end_client_name}</strong></div> : null}
              {p.vendor_name ? <div className="iv-meta-row"><span>Vendor</span><strong>{p.vendor_name}</strong></div> : null}
            </div>
          </div>

          {/* Billing */}
          <div className="iv-section-label">Billing</div>
          <div className="iv-summary">
            <div className="iv-totals">
              <div className="iv-total-row"><span>Billing type</span><span>{billingLabel(p.billing_type)}</span></div>
              {num(p.bill_rate) > 0 ? <div className="iv-total-row"><span>Bill rate</span><span className="iv-mono">{fmt(p.bill_rate, ccy)}</span></div> : null}
              {num(p.pay_rate) > 0 ? <div className="iv-total-row"><span>Pay rate</span><span className="iv-mono">{fmt(p.pay_rate, ccy)}</span></div> : null}
              {num(p.expected_hours_per_month) > 0 ? <div className="iv-total-row"><span>Expected hours / month</span><span className="iv-mono">{num(p.expected_hours_per_month).toFixed(1)}</span></div> : null}
              {num(p.monthly_billing_amount) > 0 ? <div className="iv-total-row"><span>Monthly amount</span><span className="iv-mono">{fmt(p.monthly_billing_amount, ccy)}</span></div> : null}
              {num(p.one_time_fee_amount) > 0 ? <div className="iv-total-row"><span>One-time fee</span><span className="iv-mono">{fmt(p.one_time_fee_amount, ccy)}</span></div> : null}
              {p.invoice_cycle ? <div className="iv-total-row"><span>Invoice cycle</span><span>{String(p.invoice_cycle).replace(/_/g, ' ')}</span></div> : null}
              {p.payment_terms ? <div className="iv-total-row"><span>Payment terms</span><span>{String(p.payment_terms).replace(/_/g, ' ')}{isCustomTerms(p.payment_terms) && p.custom_payment_terms_days ? ` (${p.custom_payment_terms_days} days)` : ''}</span></div> : null}
              <div className="iv-total-row"><span>Tax</span><span>{p.tax_applicable ? `${num(p.tax_percent)}%` : 'No'}</span></div>
            </div>
          </div>

          {/* Contract references */}
          {(p.po_number || p.sow_number) ? (
            <div className="iv-parties">
              <div className="iv-meta" style={{ gridColumn: '1 / -1' }}>
                {p.po_number ? <div className="iv-meta-row"><span>PO number</span><strong>{p.po_number}</strong></div> : null}
                {p.sow_number ? <div className="iv-meta-row"><span>SOW number</span><strong>{p.sow_number}</strong></div> : null}
              </div>
            </div>
          ) : null}

          {p.notes ? (
            <div className="iv-notes"><div className="iv-note"><div className="iv-note-label">Notes</div><div>{p.notes}</div></div></div>
          ) : null}
        </div>
      )}
    </Modal>
  )
}

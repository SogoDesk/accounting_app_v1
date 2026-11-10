import AttachmentsViewer from './AttachmentsViewer'
import { Modal, StatusChip, fmt, fmtDateDisplay } from './ui/index.jsx'
import './InvoiceViewModal.css'

const initialsOf = (name = '') => String(name).trim().split(/\s+/).slice(0, 2)
  .map((w) => w[0]).join('').toUpperCase() || '—'

const statusTone = (s) => {
  const v = String(s || '').toUpperCase()
  if (v === 'PAID' || v === 'REIMBURSED') return 'success'
  if (v === 'RECORDED') return 'accent'
  return 'neutral'
}

// Read-only expense voucher — floating, document-styled. Driven by the list
// row object (the expenses list already carries every field it shows).
export default function ExpenseViewModal({ expense, onClose, onEdit, onDelete }) {
  const e = expense
  const open = e != null
  const ccy = e?.currency
  const method = e?.is_reimbursable ? `${e.paid_by || 'Staff'} (reimbursable)` : (e?.payment_method_name || e?.vendor_name || '—')
  // A reimbursed expense is settled — it can no longer be edited or deleted.
  const mutable = e && String(e.status || '').toUpperCase() !== 'REIMBURSED'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={e ? 'Expense' : 'Expense'}
      maxWidth={780}
      modalClassName="iv-modal"
      footer={(
        <div className="iv-actions">
          {e && mutable && onDelete ? (
            <button type="button" className="secondary-btn iv-btn-danger" onClick={() => onDelete(e)}>Delete</button>
          ) : null}
          {e && mutable && onEdit ? (
            <button type="button" className="secondary-btn" onClick={() => onEdit(e)}>Edit</button>
          ) : null}
          <button type="button" className="primary-btn" onClick={onClose}>Close</button>
        </div>
      )}
    >
      {!e ? null : (
        <div className="iv-doc">
          <div className="iv-mast">
            <div className="iv-mast-left">
              <div className="iv-mast-eyebrow">Expense</div>
              <div className="iv-mast-number" style={{ fontFamily: 'var(--font-ui)' }}>{e.category_name || 'Expense'}</div>
              <div className="iv-mast-issuer">{e.description || '—'}</div>
            </div>
            <div className="iv-mast-right">
              <StatusChip tone={statusTone(e.status)}>{String(e.status || 'RECORDED').replace(/_/g, ' ')}</StatusChip>
              <div className="iv-mast-due">
                <span className="iv-mast-due-label">Amount</span>
                <span className="iv-mast-due-val">{fmt(e.total_amount, ccy)}</span>
              </div>
            </div>
          </div>

          <div className="iv-parties">
            <div className="iv-party">
              <div className="iv-party-label">Paid via</div>
              <div className="iv-party-body">
                <span className="iv-avatar">{initialsOf(e.category_name || method)}</span>
                <div>
                  <div className="iv-party-name">{method}</div>
                  <div className="iv-party-sub">{e.entity_name || '—'}</div>
                </div>
              </div>
            </div>
            <div className="iv-meta">
              <div className="iv-meta-row"><span>Date</span><strong>{fmtDateDisplay(e.expense_date)}</strong></div>
              <div className="iv-meta-row"><span>Category</span><strong>{e.category_name || '—'}</strong></div>
              <div className="iv-meta-row"><span>Region</span><strong>{e.entity_name || '—'}</strong></div>
              <div className="iv-meta-row"><span>Currency</span><strong>{ccy || '—'}</strong></div>
              {e.expense_type ? <div className="iv-meta-row"><span>Type</span><strong>{String(e.expense_type).replace(/_/g, ' ')}</strong></div> : null}
              <div className="iv-meta-row"><span>Reimbursable</span><strong>{e.is_reimbursable ? 'Yes' : 'No'}</strong></div>
            </div>
          </div>

          <div className="iv-summary">
            <div className="iv-totals">
              <div className="iv-total-row iv-total-grand"><span>Total</span><span className="iv-mono">{fmt(e.total_amount, ccy)}</span></div>
            </div>
          </div>

          <AttachmentsViewer entityType="expense" entityId={e.id} title="Receipt" />
        </div>
      )}
    </Modal>
  )
}

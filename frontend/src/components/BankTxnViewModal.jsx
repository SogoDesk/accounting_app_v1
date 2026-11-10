import { Modal, StatusChip, fmt, fmtDateDisplay } from './ui/index.jsx'
import './InvoiceViewModal.css'

const num = (v) => { const n = Number(v || 0); return Number.isNaN(n) ? 0 : n }

// Read-only bank-transaction viewer — floating, document-styled. Driven by the
// list row object (+ the owning account for context).
export default function BankTxnViewModal({ txn, account, onClose }) {
  const t = txn
  const open = t != null
  const ccy = t?.currency || account?.currency
  const amount = num(t?.amount)
  const isDebit = amount < 0
  const matched = String(t?.status || '').toUpperCase() === 'MATCHED'
  const accountLabel = account ? `${account.bank_name || account.name || 'Account'}${account.account_number_masked ? ` ····${String(account.account_number_masked).slice(-4)}` : ''}` : '—'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Bank transaction"
      maxWidth={720}
      modalClassName="iv-modal"
      footer={<div className="iv-actions"><button type="button" className="primary-btn" onClick={onClose}>Close</button></div>}
    >
      {!t ? null : (
        <div className="iv-doc">
          <div className="iv-mast">
            <div className="iv-mast-left">
              <div className="iv-mast-eyebrow">Bank transaction</div>
              <div className="iv-mast-number" style={{ fontFamily: 'var(--font-ui)', fontSize: 20 }}>{t.description || '—'}</div>
              <div className="iv-mast-issuer">{fmtDateDisplay(t.txn_date)} · {accountLabel}</div>
            </div>
            <div className="iv-mast-right">
              <StatusChip tone={matched ? 'success' : 'warn'}>{matched ? 'Matched' : 'Unmatched'}</StatusChip>
              <div className="iv-mast-due">
                <span className="iv-mast-due-label">{isDebit ? 'Debit' : 'Credit'}</span>
                <span className={`iv-mast-due-val${isDebit ? ' is-danger' : ''}`}>{amount >= 0 ? '+' : ''}{fmt(amount, ccy)}</span>
              </div>
            </div>
          </div>

          <div className="iv-parties">
            <div className="iv-meta" style={{ gridColumn: '1 / -1' }}>
              <div className="iv-meta-row"><span>Date</span><strong>{fmtDateDisplay(t.txn_date)}</strong></div>
              <div className="iv-meta-row"><span>Account</span><strong>{accountLabel}</strong></div>
              <div className="iv-meta-row"><span>Direction</span><strong>{isDebit ? 'Debit (out)' : 'Credit (in)'}</strong></div>
              <div className="iv-meta-row"><span>Amount</span><strong>{fmt(Math.abs(amount), ccy)}</strong></div>
              {t.balance != null ? <div className="iv-meta-row"><span>Running balance</span><strong>{fmt(t.balance, ccy)}</strong></div> : null}
              {t.reference ? <div className="iv-meta-row"><span>Reference</span><strong>{t.reference}</strong></div> : null}
              <div className="iv-meta-row"><span>Status</span><strong>{matched ? 'Matched' : 'Unmatched'}</strong></div>
              {t.matched_label || t.matched_type ? <div className="iv-meta-row"><span>Matched to</span><strong>{t.matched_label || t.matched_type}</strong></div> : null}
              {t.currency ? <div className="iv-meta-row"><span>Currency</span><strong>{ccy || '—'}</strong></div> : null}
            </div>
          </div>

          {t.notes ? (
            <div className="iv-notes"><div className="iv-note"><div className="iv-note-label">Notes</div><div>{t.notes}</div></div></div>
          ) : null}
        </div>
      )}
    </Modal>
  )
}

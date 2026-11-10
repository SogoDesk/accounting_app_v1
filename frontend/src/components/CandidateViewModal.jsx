import AttachmentsViewer from './AttachmentsViewer'
import { Modal, StatusChip, fmtDate } from './ui/index.jsx'
import './InvoiceViewModal.css'

const initialsOf = (name = '') => String(name).trim().split(/\s+/).slice(0, 2)
  .map((w) => w[0]).join('').toUpperCase() || '—'

const statusTone = (s) => (String(s || '').toUpperCase() === 'ACTIVE' ? 'success' : 'neutral')

// Amber/red flag for a compliance expiry: past → Expired, within 30 days → Expiring.
const expiryTone = (d) => {
  if (!d) return null
  const t = Date.parse(`${String(d).slice(0, 10)}T00:00:00`)
  if (Number.isNaN(t)) return null
  const days = Math.floor((t - Date.now()) / 86400000)
  if (days < 0) return { tone: 'danger', label: 'Expired' }
  if (days <= 30) return { tone: 'warn', label: 'Expiring' }
  return null
}

// Read-only candidate viewer — floating, document-styled. Driven by the list
// row object (the candidates list carries every field it shows).
export default function CandidateViewModal({ candidate, onClose, onEdit, onOpenDetail, canEdit = false }) {
  const c = candidate
  const open = c != null
  const waTone = expiryTone(c?.work_auth_expiry)
  const insTone = expiryTone(c?.insurance_expiry)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={c ? `Candidate · ${c.full_name || ''}` : 'Candidate'}
      maxWidth={800}
      modalClassName="iv-modal"
      footer={(
        <div className="iv-actions">
          {c && onOpenDetail ? (
            <button type="button" className="cd-linkbtn" style={{ marginRight: 'auto' }} onClick={() => onOpenDetail(c)}>Open full profile →</button>
          ) : null}
          {c && canEdit && onEdit ? (
            <button type="button" className="secondary-btn" onClick={() => onEdit(c)}>Edit</button>
          ) : null}
          <button type="button" className="primary-btn" onClick={onClose}>Close</button>
        </div>
      )}
    >
      {!c ? null : (
        <div className="iv-doc">
          <div className="iv-mast">
            <div className="iv-mast-left">
              <div className="iv-mast-eyebrow">Candidate</div>
              <div className="iv-mast-number" style={{ fontFamily: 'var(--font-ui)' }}>{c.full_name || '—'}</div>
              <div className="iv-mast-issuer">{c.job_title || '—'}</div>
            </div>
            <div className="iv-mast-right">
              <StatusChip tone={statusTone(c.status)}>{String(c.status || '—').replace(/_/g, ' ')}</StatusChip>
              <div className="iv-mast-due">
                <span className="iv-mast-due-label">Code</span>
                <span className="iv-mast-due-val">{c.candidate_code || '—'}</span>
              </div>
            </div>
          </div>

          <div className="iv-parties">
            <div className="iv-party">
              <div className="iv-party-label">Candidate</div>
              <div className="iv-party-body">
                <span className="iv-avatar">{initialsOf(c.full_name)}</span>
                <div>
                  <div className="iv-party-name">{c.full_name || '—'}</div>
                  <div className="iv-party-sub">{c.job_title || '—'}</div>
                </div>
              </div>
            </div>
            <div className="iv-meta">
              <div className="iv-meta-row"><span>Email</span><strong>{c.email || '—'}</strong></div>
              <div className="iv-meta-row"><span>Phone</span><strong>{c.phone || '—'}</strong></div>
              <div className="iv-meta-row"><span>Country</span><strong>{c.country || '—'}</strong></div>
              <div className="iv-meta-row"><span>Region</span><strong>{c.region_name || '—'}</strong></div>
              <div className="iv-meta-row"><span>Status</span><strong>{String(c.status || '—').replace(/_/g, ' ')}</strong></div>
              {c.tax_id ? <div className="iv-meta-row"><span>Tax ID</span><strong>{c.tax_id}</strong></div> : null}
              {c.work_authorization ? <div className="iv-meta-row"><span>Work authorization</span><strong>{c.work_authorization}</strong></div> : null}
            </div>
          </div>

          <div className="iv-section-label">Compliance</div>
          <div className="iv-meta" style={{ gridColumn: '1 / -1' }}>
            <div className="iv-meta-row">
              <span>Work auth expiry</span>
              <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                {c.work_auth_expiry ? fmtDate(c.work_auth_expiry) : '—'}
                {waTone ? <StatusChip tone={waTone.tone}>{waTone.label}</StatusChip> : null}
              </strong>
            </div>
            <div className="iv-meta-row">
              <span>Insurance expiry</span>
              <strong style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                {c.insurance_expiry ? fmtDate(c.insurance_expiry) : '—'}
                {insTone ? <StatusChip tone={insTone.tone}>{insTone.label}</StatusChip> : null}
              </strong>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            {c.is_1099 ? <StatusChip tone="accent">1099 contractor</StatusChip> : null}
            <StatusChip tone={c.w9_on_file ? 'success' : 'neutral'}>{c.w9_on_file ? 'W-9 on file' : 'W-9 missing'}</StatusChip>
          </div>

          {c.skills ? (
            <div className="iv-notes"><div className="iv-note"><div className="iv-note-label">Skills</div><div>{c.skills}</div></div></div>
          ) : null}
          {c.notes ? (
            <div className="iv-notes"><div className="iv-note"><div className="iv-note-label">Notes</div><div>{c.notes}</div></div></div>
          ) : null}

          <AttachmentsViewer entityType="candidate" entityId={c.id} title="Documents" />
        </div>
      )}
    </Modal>
  )
}

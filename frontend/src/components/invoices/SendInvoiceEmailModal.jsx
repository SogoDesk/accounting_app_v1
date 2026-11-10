import { useEffect, useRef, useState } from 'react'
import api from '../../services/api'
import { useToast } from '../../context/ToastContext'
import { Modal } from '../ui/index.jsx'

const PREVIEW_CSS = `
  html,body{margin:0;padding:0;overflow-x:hidden}
  body{font:14px/1.65 -apple-system,'Segoe UI',Roboto,sans-serif;color:#1a1a1a}
  img{max-width:100%;height:auto}
  table{max-width:100%!important}
`

export default function SendInvoiceEmailModal({ invoice, onClose }) {
  const toast = useToast()
  const frameRef = useRef(null)

  const [preview, setPreview] = useState(null)
  const [history, setHistory] = useState([])
  const [attachPdf, setAttachPdf] = useState(true)
  const [frameHeight, setFrameHeight] = useState(260)
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (!invoice) return undefined
    let alive = true
    setLoading(true)

    Promise.all([
      api.get('/email-templates').then(r => (r.data.data || []).find(t => t.template_key === 'INVOICE')),
      api.get(`/invoices/${invoice.id}/email-history`).catch(() => ({ data: { data: [] } })),
    ])
      .then(async ([tpl, hist]) => {
        if (!alive) return
        setHistory(hist.data.data || [])
        if (!tpl) return
        const p = await api.post('/email-templates/preview', {
          subject: tpl.subject,
          body: tpl.body,
          footer_note: tpl.footer_note || '',
          invoice_id: invoice.id,
        })
        if (alive) setPreview(p.data.data)
      })
      .catch(() => { if (alive) toast.error('Could not build the preview') })
      .finally(() => { if (alive) setLoading(false) })

    return () => { alive = false }
  }, [invoice])

  const fitFrame = () => {
    const doc = frameRef.current?.contentDocument
    if (!doc?.body) return
    setFrameHeight(Math.max(180, doc.body.scrollHeight + 12))
  }

  const send = async () => {
    setSending(true)
    try {
      const r = await api.post(`/invoices/${invoice.id}/send-email`, { attach_pdf: attachPdf })
      toast.success(r.data.message)
      onClose(true)
    } catch (e) {
      toast.error(e.response?.data?.message || 'Could not queue the email')
    } finally { setSending(false) }
  }

  const noEmail = preview && String(preview.recipient || '').startsWith('(')
  const lastSent = history[0]

  return (
    <Modal
      open={!!invoice}
      onClose={() => onClose(false)}
      title={`Email invoice ${invoice?.invoice_number || ''}`}
      maxWidth={680}
      footer={<>
        <button className="secondary-btn" onClick={() => onClose(false)}>Cancel</button>
        <button className="primary-btn" onClick={send} disabled={sending || loading || noEmail}>
          {sending ? 'Queueing…' : 'Send email'}
        </button>
      </>}
    >
      {loading ? (
        <div className="skeleton" style={{ height: 340, borderRadius: 10 }} />
      ) : (
        <>
          <div style={{ display: 'flex', gap: 16, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
            <span style={{ width: 60, flexShrink: 0, fontSize: 13, color: 'var(--text3)' }}>To</span>
            <span style={{ fontSize: 14, color: noEmail ? 'var(--danger)' : 'var(--text)' }}>
              {preview?.recipient || '—'}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 16, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
            <span style={{ width: 60, flexShrink: 0, fontSize: 13, color: 'var(--text3)' }}>Subject</span>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{preview?.subject || '—'}</span>
          </div>

          {noEmail && (
            <div style={{
              margin: '16px 0 0', padding: '12px 14px', borderRadius: 10, fontSize: 13, lineHeight: 1.5,
              background: 'color-mix(in srgb, var(--danger) 10%, transparent)', color: 'var(--danger)',
            }}>
              This client has no contact email address. Add one on the client record before sending.
            </div>
          )}

          <iframe
            ref={frameRef}
            title="Invoice email preview"
            sandbox="allow-same-origin"
            scrolling="no"
            onLoad={fitFrame}
            style={{
              width: '100%', height: frameHeight, border: 0, display: 'block',
              margin: '18px 0 4px', background: 'transparent', overflow: 'hidden',
            }}
            srcDoc={`<!doctype html><meta charset="utf-8"><base href="${window.location.origin}/"><style>${PREVIEW_CSS}</style><body>${preview?.html || ''}</body>`}
            key={preview?.html ? preview.html.length : 0}
          />

          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            paddingTop: 14, borderTop: '1px solid var(--border)',
          }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={attachPdf} onChange={e => setAttachPdf(e.target.checked)} />
              <span>Attach <strong>{`Invoice ${invoice?.invoice_number || ''}.pdf`}</strong></span>
            </label>

            {lastSent && (
              <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text3)' }}>
                Last sent {new Date(lastSent.created_at).toLocaleDateString(undefined, {
                  day: 'numeric', month: 'short',
                })} · {history.length} time{history.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
        </>
      )}
    </Modal>
  )
}

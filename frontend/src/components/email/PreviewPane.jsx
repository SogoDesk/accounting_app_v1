import { useRef, useState } from 'react'
import { card, sectionLabel, previewDoc } from './styles'

export default function PreviewPane({ preview, invoices, invoiceId, onInvoiceChange, sticky = true }) {
  const frameRef = useRef(null)
  const [height, setHeight] = useState(420)

  const fit = () => {
    const doc = frameRef.current?.contentDocument
    if (doc?.body) setHeight(Math.min(900, Math.max(260, doc.body.scrollHeight + 12)))
  }

  return (
    <div style={{
      ...card, padding: 0, overflow: 'hidden',
      ...(sticky ? { position: 'sticky', top: 16 } : {}),
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        padding: '18px 26px', borderBottom: '1px solid var(--border)', background: 'var(--surface2)',
      }}>
        <div style={{ ...sectionLabel, marginBottom: 0 }}>Preview</div>
        <div style={{ fontSize: 12, color: 'var(--text3)' }}>
          {preview?.recipient ? `to ${preview.recipient}` : ''}
        </div>
        <select className="form-control"
          title="Render with made-up sample values, or with a real invoice from your books"
          style={{ height: 32, fontSize: 12, maxWidth: 300, marginLeft: 'auto' }}
          value={invoiceId} onChange={e => onInvoiceChange(e.target.value)}>
          <option value="">Sample data</option>
          {invoices.length > 0 && (
            <optgroup label="Use a real invoice">
              {invoices.map(i => (
                <option key={i.id} value={i.id}>
                  {i.client_name} &middot; {i.invoice_number}
                  {i.primary_contact_email ? '' : ' (no email)'}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>

      <div style={{ padding: 24, background: 'var(--surface2)' }}>
        <div style={{
          borderRadius: 14, overflow: 'hidden', background: '#fff',
          border: '1px solid var(--border2)', boxShadow: '0 14px 44px rgba(16,40,60,.14)',
        }}>
          <div style={{ padding: '18px 22px', borderBottom: '1px solid #eceff3' }}>
            <div style={{ fontSize: 11, color: '#8a939f' }}>Subject</div>
            <div style={{ fontSize: 14.5, fontWeight: 700, color: '#111', marginTop: 2 }}>
              {preview?.subject || 'No subject'}
            </div>
          </div>
          <iframe
            ref={frameRef}
            title="Email preview"
            sandbox="allow-same-origin"
            scrolling="no"
            onLoad={fit}
            style={{ width: '100%', height, border: 0, display: 'block', background: '#fff' }}
            srcDoc={previewDoc(preview?.html)}
          />
        </div>
      </div>
    </div>
  )
}

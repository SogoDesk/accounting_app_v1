import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import api from '../services/api'

const fmtSize = (n) => {
  const b = Number(n || 0)
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}

const isPdf = (mime, name) => mime === 'application/pdf' || /\.pdf$/i.test(name || '')
const isImage = (mime, name) => /^image\//.test(mime || '') || /\.(png|jpe?g|webp|gif)$/i.test(name || '')

/**
 * Read-only list of an invoice/bill's attachments. Each file name is a link;
 * clicking it opens an in-app preview popup (PDF / image inline, other types
 * fall back to download) — never a new browser tab.
 */
export default function AttachmentsViewer({ entityType, entityId, title = 'Attachments' }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [preview, setPreview] = useState(null) // { att, url, kind }
  const [loadingId, setLoadingId] = useState(null)

  useEffect(() => {
    let active = true
    if (!entityId) { setItems([]); return undefined }
    setLoading(true)
    api
      .get(`/attachments/${entityType}/${entityId}`)
      .then((r) => active && setItems(r.data?.data || []))
      .catch(() => {})
      .finally(() => active && setLoading(false))
    return () => { active = false }
  }, [entityType, entityId])

  // Revoke the object URL when the preview closes / unmounts.
  useEffect(() => () => { if (preview?.url) URL.revokeObjectURL(preview.url) }, [preview])

  const openPreview = async (att) => {
    setLoadingId(att.id)
    try {
      const res = await api.get(`/attachments/file/${att.id}`, { responseType: 'blob' })
      const url = URL.createObjectURL(res.data)
      const kind = isPdf(att.mime_type, att.file_name)
        ? 'pdf'
        : isImage(att.mime_type, att.file_name)
          ? 'image'
          : 'other'
      setPreview({ att, url, kind })
    } catch {
      /* ignore */
    } finally {
      setLoadingId(null)
    }
  }

  const closePreview = () => {
    setPreview((p) => { if (p?.url) URL.revokeObjectURL(p.url); return null })
  }

  const downloadCurrent = () => {
    if (!preview) return
    const a = document.createElement('a')
    a.href = preview.url
    a.download = preview.att.file_name || 'document'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  if (!entityId) return null

  return (
    <div className="span-3 attachments-viewer">
      <div className="attachments-viewer-head">
        {title}{items.length ? <span className="attachments-viewer-count">{items.length}</span> : null}
      </div>

      {loading ? (
        <div className="attachments-empty">Loading…</div>
      ) : items.length === 0 ? (
        <div className="attachments-empty">No documents attached.</div>
      ) : (
        <ul className="attachments-list">
          {items.map((att) => (
            <li key={att.id} className="attachments-item">
              <button
                type="button"
                className="attachments-name"
                onClick={() => openPreview(att)}
                disabled={loadingId === att.id}
                title="Preview"
              >
                {att.file_name}
              </button>
              <span className="attachments-size">{fmtSize(att.file_size)}</span>
            </li>
          ))}
        </ul>
      )}

      {preview && createPortal(
        <div className="attachment-preview-overlay" onClick={closePreview} role="presentation">
          <div className="attachment-preview-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="attachment-preview-head">
              <span className="attachment-preview-title" title={preview.att.file_name}>{preview.att.file_name}</span>
              <div className="attachment-preview-actions">
                <button type="button" className="secondary-btn" onClick={downloadCurrent}>Download</button>
                <button type="button" className="attachment-preview-close" onClick={closePreview} aria-label="Close preview">×</button>
              </div>
            </div>
            <div className="attachment-preview-body">
              {preview.kind === 'pdf' && (
                <iframe title={preview.att.file_name} src={preview.url} className="attachment-preview-frame" />
              )}
              {preview.kind === 'image' && (
                <img alt={preview.att.file_name} src={preview.url} className="attachment-preview-img" />
              )}
              {preview.kind === 'other' && (
                <div className="attachment-preview-other">
                  <p>Inline preview isn’t available for this file type.</p>
                  <button type="button" className="primary-btn" onClick={downloadCurrent}>Download to view</button>
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}

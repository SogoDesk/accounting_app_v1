import { useEffect, useRef, useState } from 'react'
import api from '../services/api'

// File types accepted for supporting documents (timesheets, vendor invoices).
export const ATTACHMENT_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.gif,.xls,.xlsx,.csv,.doc,.docx'

const fmtSize = (n) => {
  const b = Number(n || 0)
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}

// Upload newly-selected files to an existing record. Used by parent forms after
// the invoice/bill has been created or updated.
export async function uploadPendingAttachments(entityType, entityId, files) {
  if (!files || !files.length) return
  const fd = new FormData()
  files.forEach((f) => fd.append('files', f))
  await api.post(`/attachments/${entityType}/${entityId}`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  })
}

/**
 * Reusable attachments control.
 * - `pendingFiles` / `onPendingChange`: newly-picked files the PARENT uploads on save.
 * - When `entityId` is set (edit mode) it also loads existing attachments and
 *   supports download + delete in place.
 */
export default function AttachmentsField({
  entityType,
  entityId = null,
  pendingFiles = [],
  onPendingChange,
  label = 'Attachments',
  hint = '',
  required = false,
}) {
  const inputRef = useRef(null)
  const [existing, setExisting] = useState([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState(null)

  useEffect(() => {
    let active = true
    if (!entityId) { setExisting([]); return undefined }
    setLoading(true)
    api
      .get(`/attachments/${entityType}/${entityId}`)
      .then((res) => active && setExisting(res.data?.data || []))
      .catch(() => {})
      .finally(() => active && setLoading(false))
    return () => { active = false }
  }, [entityType, entityId])

  const addFiles = (fileList) => {
    const incoming = Array.from(fileList || [])
    if (incoming.length) onPendingChange?.([...pendingFiles, ...incoming])
    if (inputRef.current) inputRef.current.value = ''
  }

  const removePending = (idx) => onPendingChange?.(pendingFiles.filter((_, i) => i !== idx))

  const download = async (att) => {
    setBusyId(att.id)
    try {
      const res = await api.get(`/attachments/file/${att.id}`, { responseType: 'blob' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(res.data)
      a.download = att.file_name || 'document'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(a.href)
    } catch { /* ignore */ } finally { setBusyId(null) }
  }

  const removeExisting = async (att) => {
    setBusyId(att.id)
    try {
      await api.delete(`/attachments/${att.id}`)
      setExisting((prev) => prev.filter((x) => x.id !== att.id))
    } catch { /* ignore */ } finally { setBusyId(null) }
  }

  const totalCount = existing.length + pendingFiles.length

  return (
    <div className="attachments-field">
      <div className="attachments-head">
        <span className="form-label">{label}{required ? ' *' : ''}</span>
        {hint ? <span className="attachments-hint">{hint}</span> : null}
      </div>

      <button type="button" className="attachments-add-btn" onClick={() => inputRef.current?.click()}>
        + Add files
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        style={{ display: 'none' }}
        onChange={(e) => addFiles(e.target.files)}
      />

      {loading || totalCount > 0 ? (
        <ul className="attachments-list">
          {existing.map((att) => (
            <li key={`e-${att.id}`} className="attachments-item">
              <button
                type="button"
                className="attachments-name"
                onClick={() => download(att)}
                disabled={busyId === att.id}
                title="Download"
              >
                {att.file_name}
              </button>
              <span className="attachments-size">{fmtSize(att.file_size)}</span>
              <button
                type="button"
                className="attachments-remove"
                onClick={() => removeExisting(att)}
                disabled={busyId === att.id}
                aria-label={`Delete ${att.file_name}`}
              >
                ×
              </button>
            </li>
          ))}
          {pendingFiles.map((f, idx) => (
            <li key={`p-${idx}`} className="attachments-item is-pending">
              <span className="attachments-name" title={f.name}>{f.name}</span>
              <span className="attachments-size">{fmtSize(f.size)} · new</span>
              <button
                type="button"
                className="attachments-remove"
                onClick={() => removePending(idx)}
                aria-label={`Remove ${f.name}`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="attachments-empty">
          {required ? 'At least one document is required.' : 'No documents attached yet.'}
        </div>
      )}
    </div>
  )
}

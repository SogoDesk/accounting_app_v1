import { useState } from 'react'

// Shows an invitation link with a copy button.
export default function InviteLinkBox({ url, days }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard unavailable; the field is selectable */ }
  }

  return (
    <div className="plat-invite">
      <label className="td-muted text-sm">Invitation link{days ? ` (valid ${days} days)` : ''}</label>
      <div className="plat-invite-row">
        <input className="form-control" readOnly value={url} onFocus={(e) => e.target.select()} />
        <button type="button" className="cl-btn cl-btn-secondary" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  )
}

import { useRef } from 'react'
import { resolveAssetUrl } from '../../services/api'
import { card, sectionLabel } from './styles'

const HINT = 'Optional. Appears at the top of every email automatically. Use a wide image, around 600x120.'

export default function BannerUpload({ banner, baseUrl, uploading, onUpload, onRemove }) {
  const fileRef = useRef(null)

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ ...sectionLabel, marginBottom: 0 }}>Header banner</div>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif"
          style={{ display: 'none' }}
          onChange={e => { onUpload(e.target.files?.[0]); e.target.value = '' }} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button type="button" className="secondary-btn" disabled={uploading}
            style={{ height: 30, fontSize: 12, padding: '0 14px' }}
            onClick={() => fileRef.current?.click()}>
            {uploading ? 'Uploading...' : banner ? 'Replace' : 'Upload'}
          </button>
          {banner && (
            <button type="button" className="secondary-btn is-danger"
              style={{ height: 30, fontSize: 12, padding: '0 14px' }} onClick={onRemove}>
              Remove
            </button>
          )}
        </div>
      </div>

      {!baseUrl && (
        <div style={{
          marginTop: 14, padding: '10px 12px', borderRadius: 8, fontSize: 12, lineHeight: 1.5,
          background: 'color-mix(in srgb, var(--warning) 12%, transparent)', color: 'var(--warning)',
        }}>
          PUBLIC_BASE_URL is not set, so images use relative paths that mail clients cannot load.
        </div>
      )}

      {banner ? (
        <div style={{
          width: '100%', marginTop: 14, borderRadius: 10, overflow: 'hidden',
          border: '1px solid var(--border)', background: 'var(--surface2)',
        }}>
          <img src={resolveAssetUrl(banner.path || banner.url)} alt=""
            style={{ width: '100%', maxHeight: 150, objectFit: 'cover', display: 'block' }} />
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--text2)', marginTop: 14, lineHeight: 1.5 }}>
          {HINT}
        </div>
      )}
    </div>
  )
}

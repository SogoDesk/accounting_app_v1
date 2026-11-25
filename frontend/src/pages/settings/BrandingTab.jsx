import { useEffect, useState } from 'react'
import api, { resolveAssetUrl } from '../../services/api'
import { useToast } from '../../context/ToastContext'
import { Input } from '../../components/ui/index.jsx'
import { refreshBranding } from '../../utils/branding'

// Company-wide branding: the name, logo, colours and email sender name used on
// invoices, emails and in the app whenever an entity (Organization tab) has not
// set its own.
const FIELDS = ['display_name', 'logo_url', 'primary_color', 'accent_color', 'email_sender_name']
const HEX = /^#[0-9A-Fa-f]{6}$/

export default function BrandingTab() {
  const toast = useToast()
  const [form, setForm] = useState(Object.fromEntries(FIELDS.map((f) => [f, ''])))
  const [groupCurrency, setGroupCurrency] = useState('USD')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.get('/settings/company')
      .then((res) => {
        const data = res.data.data || {}
        setGroupCurrency(data.group_currency || 'USD')
        setForm(Object.fromEntries(FIELDS.map((f) => [f, data[f] || ''])))
      })
      .catch(() => toast.error('Failed to load branding'))
      .finally(() => setLoading(false))
  }, [])

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }))

  const save = async () => {
    for (const key of ['primary_color', 'accent_color']) {
      if (form[key] && !HEX.test(form[key])) {
        toast.error('Colours must look like #1D4ED8')
        return
      }
    }
    setSaving(true)
    try {
      // group_currency is required by the endpoint; send the stored value back.
      await api.put('/settings/company', { group_currency: groupCurrency, ...form })
      await refreshBranding()
      toast.success('Branding updated')
    } catch (e) {
      toast.error(e.response?.data?.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const logoPreview = resolveAssetUrl(form.logo_url)

  return (
    <div className="table-card glass-card">
      <div className="table-toolbar">
        <strong>Company branding</strong>
        <span className="text-muted text-sm">Used wherever an entity has not set its own</span>
      </div>
      <div style={{ padding: 16, maxWidth: 560, display: 'grid', gap: 12 }}>
        <p className="text-muted text-sm" style={{ margin: 0 }}>
          Invoices, emails and the app header show these. An entity's own company name, logo and
          colours (Organization tab) take priority for that entity's documents.
        </p>
        <Input label="Company display name" placeholder="Leave blank to use the account name"
          value={form.display_name} disabled={loading} onChange={(e) => set('display_name', e.target.value)} />
        <Input label="Logo URL" placeholder="https://… or /uploads/…"
          hint="An https address, or the /uploads/ path of a logo already uploaded"
          value={form.logo_url} disabled={loading} onChange={(e) => set('logo_url', e.target.value)} />
        {logoPreview ? (
          <img src={logoPreview} alt="Logo preview" style={{ maxWidth: 180, maxHeight: 60, objectFit: 'contain' }} />
        ) : null}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Input label="Primary colour" placeholder="#111827" value={form.primary_color} disabled={loading}
            onChange={(e) => set('primary_color', e.target.value.trim())} />
          <Input label="Accent colour" placeholder="#1D4ED8" value={form.accent_color} disabled={loading}
            onChange={(e) => set('accent_color', e.target.value.trim())} />
        </div>
        <Input label="Email sender name" placeholder="Leave blank to use the company name"
          hint="Shown as the From name on invoice emails"
          value={form.email_sender_name} disabled={loading} onChange={(e) => set('email_sender_name', e.target.value)} />
        <div>
          <button className="primary-btn" onClick={save} disabled={saving || loading}>
            {saving ? 'Saving…' : 'Save branding'}
          </button>
        </div>
      </div>
    </div>
  )
}

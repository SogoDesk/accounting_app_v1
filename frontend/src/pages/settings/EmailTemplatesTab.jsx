import { useEffect, useMemo, useRef, useState } from 'react'
import api from '../../services/api'
import { useToast } from '../../context/ToastContext'
import { ConfirmDialog } from '../../components/ui/index.jsx'
import { card, sectionLabel } from '../../components/email/styles'
import ScheduleEditor, { scheduleSummary } from '../../components/email/ScheduleEditor'
import BannerUpload from '../../components/email/BannerUpload'
import PreviewPane from '../../components/email/PreviewPane'

const DocIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" width="20" height="20">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6M8 13h8M8 17h5" />
  </svg>
)

const BellIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" width="20" height="20">
    <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </svg>
)

const BackIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
    <path d="M19 12H5M11 18l-6-6 6-6" />
  </svg>
)

const META = {
  INVOICE: { Icon: DocIcon, when: 'Sent when you email an invoice to a client', scheduled: false },
  REMINDER: { Icon: BellIcon, when: 'Sent before and after the due date while unpaid', scheduled: true },
}

const TOKEN_GROUPS = [
  { title: 'Invoice', keys: ['invoice_number', 'invoice_date', 'due_date', 'payment_terms', 'total_amount', 'balance_due', 'currency'] },
  { title: 'Client', keys: ['client_name', 'contact_name'] },
  { title: 'Your company', keys: ['company_name', 'company_address', 'region_name', 'logo_url', 'header_banner_url', 'footer_note'] },
  { title: 'Timing', keys: ['days_until_due', 'days_overdue'] },
]

const fmtWhen = (v) => {
  if (!v) return '-'
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function EmailTemplatesTab() {
  const toast = useToast()
  const bodyRef = useRef(null)
  const previewTimer = useRef(null)

  const [templates, setTemplates] = useState([])
  const [tokens, setTokens] = useState([])
  const [editingKey, setEditingKey] = useState(null)
  const [draft, setDraft] = useState({ subject: '', body: '', footer_note: '' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [confirmLeave, setConfirmLeave] = useState(false)

  const [invoices, setInvoices] = useState([])
  const [previewInvoiceId, setPreviewInvoiceId] = useState('')
  const [preview, setPreview] = useState(null)

  const [schedule, setSchedule] = useState(null)
  const [savingSchedule, setSavingSchedule] = useState(false)

  const [assets, setAssets] = useState([])
  const [baseUrl, setBaseUrl] = useState('')
  const [uploading, setUploading] = useState(false)
  const [assetsVersion, setAssetsVersion] = useState(0)

  const active = useMemo(
    () => templates.find(t => t.template_key === editingKey) || null,
    [templates, editingKey],
  )

  const dirty = active
    ? draft.subject !== active.subject
      || draft.body !== active.body
      || draft.footer_note !== (active.footer_note || '')
    : false

  const banner = assets.find(a => a.role === 'banner') || null

  const tokenGroups = useMemo(() => {
    const byKey = Object.fromEntries(tokens.map(t => [t.key, t]))
    return TOKEN_GROUPS
      .map(g => ({
        ...g,
        items: g.keys.map(k => byKey[k]).filter(t => t && (!t.reminderOnly || editingKey === 'REMINDER')),
      }))
      .filter(g => g.items.length)
  }, [tokens, editingKey])

  const loadAssets = async () => {
    try {
      const r = await api.get('/email-templates/assets')
      setAssets(r.data.data || [])
      setBaseUrl(r.data.base_url || '')
      setAssetsVersion(v => v + 1)
    } catch { /* optional */ }
  }

  const load = async () => {
    try {
      setLoading(true)
      const [t, inv, sch] = await Promise.all([
        api.get('/email-templates'),
        api.get('/email-templates/preview-invoices').catch(() => ({ data: { data: [] } })),
        api.get('/email-templates/schedule').catch(() => ({ data: { data: null } })),
      ])
      setTemplates(t.data.data || [])
      setTokens(t.data.tokens || [])
      setInvoices(inv.data.data || [])
      setSchedule(sch.data.data || null)
      loadAssets()
    } catch (e) {
      toast.error(e.response?.data?.message || 'Failed to load email templates')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  useEffect(() => {
    if (active) setDraft({ subject: active.subject, body: active.body, footer_note: active.footer_note || '' })
  }, [active])

  useEffect(() => {
    if (!editingKey) return undefined
    clearTimeout(previewTimer.current)
    previewTimer.current = setTimeout(() => {
      api.post('/email-templates/preview', {
        subject: draft.subject, body: draft.body, footer_note: draft.footer_note,
        invoice_id: previewInvoiceId || null,
      })
        .then(r => setPreview(r.data.data))
        .catch(() => setPreview(null))
    }, 350)
    return () => clearTimeout(previewTimer.current)
  }, [draft.subject, draft.body, draft.footer_note, previewInvoiceId, editingKey, assetsVersion])

  const insertToken = (key) => {
    const el = bodyRef.current
    const text = `{{${key}}}`
    if (!el) { setDraft(d => ({ ...d, body: d.body + text })); return }
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? start
    setDraft(d => ({ ...d, body: el.value.slice(0, start) + text + el.value.slice(end) }))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + text.length, start + text.length)
    })
  }

  const uploadBanner = async (file) => {
    if (!file) return
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      await api.post('/email-templates/assets?role=banner', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      toast.success('Header banner uploaded')
      await loadAssets()
    } catch (e) {
      toast.error(e.response?.data?.message || 'Upload failed')
    } finally { setUploading(false) }
  }

  const removeBanner = async () => {
    if (!banner) return
    try {
      await api.delete(`/email-templates/assets/${encodeURIComponent(banner.filename)}`)
      toast.success('Header banner removed')
      loadAssets()
    } catch (e) {
      toast.error(e.response?.data?.message || 'Delete failed')
    }
  }

  const save = async () => {
    if (!draft.subject.trim()) { toast.error('Subject is required'); return }
    if (!draft.body.trim()) { toast.error('Body is required'); return }
    setSaving(true)
    try {
      const r = await api.put(`/email-templates/${editingKey}`, draft)
      setTemplates(ts => ts.map(t => (t.template_key === editingKey ? r.data.data : t)))
      toast.success('Template saved')
    } catch (e) {
      toast.error(e.response?.data?.message || 'Save failed')
    } finally { setSaving(false) }
  }

  const reset = async () => {
    setResetting(true)
    try {
      const r = await api.post(`/email-templates/${editingKey}/reset`)
      setTemplates(ts => ts.map(t => (t.template_key === editingKey ? r.data.data : t)))
      toast.success('Reset to default')
      setConfirmReset(false)
    } catch (e) {
      toast.error(e.response?.data?.message || 'Reset failed')
    } finally { setResetting(false) }
  }

  const saveSchedule = async (next) => {
    setSavingSchedule(true)
    try {
      const r = await api.put('/email-templates/schedule', { ...schedule, ...next })
      setSchedule(r.data.data)
    } catch (e) {
      toast.error(e.response?.data?.message || 'Could not save the schedule')
    } finally { setSavingSchedule(false) }
  }

  const leave = () => { setEditingKey(null); setPreview(null); setConfirmLeave(false) }
  const tryLeave = () => (dirty ? setConfirmLeave(true) : leave())

  if (loading) {
    return (
      <div className="glass-card" style={{ padding: 20, borderRadius: 16 }}>
        <div className="skeleton" style={{ height: 84, borderRadius: 12, marginBottom: 12 }} />
        <div className="skeleton" style={{ height: 84, borderRadius: 12 }} />
      </div>
    )
  }

  if (!editingKey) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em' }}>Email templates</div>
          <div style={{ fontSize: 13, color: 'var(--text2)', marginTop: 3 }}>
            The wording sent to clients with invoices and payment reminders.
          </div>
        </div>

        <div className="glass-card" style={{ borderRadius: 16, overflow: 'hidden' }}>
          {templates.map((t, i) => {
            const { Icon, when } = META[t.template_key] || {}
            const summary = scheduleSummary(schedule, t.template_key)
            return (
              <div key={t.template_key}
                style={{
                  display: 'flex', alignItems: 'center', gap: 18, padding: '22px 24px',
                  borderTop: i ? '1px solid var(--border)' : 'none',
                }}>
                <span style={{
                  width: 46, height: 46, borderRadius: 12, flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'color-mix(in srgb, var(--primary) 12%, transparent)', color: 'var(--primary)',
                }}>
                  {Icon && <Icon />}
                </span>

                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>{t.name}</div>
                  <div style={{ fontSize: 12.5, color: 'var(--text2)', marginTop: 3 }}>{when}</div>
                  <div style={{
                    fontSize: 12, color: 'var(--text3)', marginTop: 7,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    Subject: {t.subject}
                  </div>
                  {summary && (
                    <div style={{
                      display: 'inline-block', marginTop: 10, padding: '4px 11px', borderRadius: 999,
                      fontSize: 11.5, fontWeight: 600,
                      background: 'color-mix(in srgb, var(--primary) 10%, transparent)',
                      color: 'var(--primary-text)',
                    }}>
                      {summary}
                    </div>
                  )}
                </div>

                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 10 }}>
                    Updated {fmtWhen(t.updated_at)}
                  </div>
                  <button className="primary-btn" onClick={() => setEditingKey(t.template_key)}>
                    Edit template
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
        paddingBottom: 18, borderBottom: '1px solid var(--border)',
      }}>
        <button className="secondary-btn" onClick={tryLeave}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <BackIcon /> Templates
        </button>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.01em' }}>{active?.name}</div>
          <div style={{ fontSize: 12.5, color: 'var(--text2)', marginTop: 2 }}>{META[editingKey]?.when}</div>
        </div>
        {dirty && (
          <span style={{
            fontSize: 11.5, fontWeight: 600, padding: '4px 11px', borderRadius: 999,
            background: 'color-mix(in srgb, var(--warning) 14%, transparent)', color: 'var(--warning)',
          }}>
            Unsaved changes
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
          <button className="secondary-btn" onClick={() => setConfirmReset(true)}>Reset</button>
          <button className="primary-btn" onClick={save} disabled={saving || !dirty}>
            {saving ? 'Saving...' : 'Save changes'}
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 28, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24, minWidth: 0 }}>
          <div style={card}>
            <div style={sectionLabel}>Subject line</div>
            <input className="form-control" value={draft.subject}
              onChange={e => setDraft(d => ({ ...d, subject: e.target.value }))}
              placeholder="Invoice {{invoice_number}} from {{company_name}}" />
          </div>

          {META[editingKey]?.scheduled && (
            <ScheduleEditor
              schedule={schedule}
              saving={savingSchedule}
              onSave={saveSchedule}
              onError={toast.error}
            />
          )}

          <BannerUpload
            banner={banner}
            baseUrl={baseUrl}
            uploading={uploading}
            onUpload={uploadBanner}
            onRemove={removeBanner}
          />

          <div style={card}>
            <div style={sectionLabel}>Body (HTML)</div>
            <textarea
              ref={bodyRef}
              className="form-control"
              style={{
                minHeight: 380, resize: 'vertical',
                fontFamily: "'SF Mono','Fira Code',monospace", fontSize: 12.5, lineHeight: 1.65,
              }}
              value={draft.body}
              onChange={e => setDraft(d => ({ ...d, body: e.target.value }))}
            />
          </div>

          <div style={card}>
            <div style={sectionLabel}>Footer note</div>
            <textarea className="form-control" rows={2} style={{ resize: 'vertical' }}
              value={draft.footer_note}
              onChange={e => setDraft(d => ({ ...d, footer_note: e.target.value }))}
              placeholder="e.g. info@tetriqsolutions.com &middot; +1 (804) 336-2001" />
            <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 9, lineHeight: 1.5 }}>
              Prints at the bottom under your company name and address. Those come from the
              issuing region, set them in <strong>Settings &rarr; Organization</strong>.
            </div>
          </div>

          <div style={card}>
            <div style={sectionLabel}>Insert a value</div>
            <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: -4, marginBottom: 14, lineHeight: 1.5 }}>
              Click one to drop it into the body at your cursor.
            </div>
            {tokenGroups.map(g => (
              <div key={g.title} style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--text2)', marginBottom: 8 }}>
                  {g.title}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {g.items.map(t => (
                    <button key={t.key} type="button" onClick={() => insertToken(t.key)}
                      title={t.label} className="token-chip"
                      style={{
                        fontSize: 11, fontFamily: "'SF Mono','Fira Code',monospace",
                        padding: '5px 10px', borderRadius: 999,
                        border: '1px solid color-mix(in srgb, var(--primary) 28%, transparent)',
                        background: 'color-mix(in srgb, var(--primary) 8%, transparent)',
                        color: 'var(--primary-text)', transition: 'background .15s ease, color .15s ease',
                      }}>
                      {t.key}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <PreviewPane
          preview={preview}
          invoices={invoices}
          invoiceId={previewInvoiceId}
          onInvoiceChange={setPreviewInvoiceId}
        />
      </div>

      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={reset}
        loading={resetting}
        title="Reset to default"
        message={`Discard your changes to the ${active?.name?.toLowerCase()} and restore the built-in wording?`}
      />

      <ConfirmDialog
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        onConfirm={leave}
        title="Discard changes"
        message="You have unsaved changes. Leave the editor and lose them?"
      />
    </div>
  )
}

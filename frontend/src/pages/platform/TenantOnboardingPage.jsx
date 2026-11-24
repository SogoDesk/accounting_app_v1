import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Card, Input, PanelHeader, Select } from '../../components/ui/index.jsx'
import { COUNTRIES } from '../../data/countries'
import platformApi from '../../services/platformApi'
import InviteLinkBox from './InviteLinkBox'
import { Icon, ICONS } from './platformUi'
import '../ClientsPage.css'

const STEPS = ['Company', 'Accounting', 'Administrator', 'Review']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December']

// Mirrors the backend rule and the company login page.
const CODE_RE = /^[A-Z0-9](?:[A-Z0-9-]{0,48}[A-Z0-9])$/
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

const suggestCode = (name) =>
  String(name).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20)

const BLANK = {
  tenant_name: '',
  tenant_code: '',
  country: '',
  currency: 'USD',
  fiscal_start_month: 1,
  admin_name: '',
  admin_email: '',
}

export default function TenantOnboardingPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [form, setForm] = useState(BLANK)
  const [codeTouched, setCodeTouched] = useState(false)
  const [codeCheck, setCodeCheck] = useState({ state: 'idle' }) // idle|checking|ok|taken|invalid
  const [errors, setErrors] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [result, setResult] = useState(null)

  const countries = useMemo(
    () => [...COUNTRIES].filter((c) => c.name).sort((a, b) => a.name.localeCompare(b.name)),
    []
  )

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }))

  const onName = (value) => {
    setForm((f) => ({ ...f, tenant_name: value, tenant_code: codeTouched ? f.tenant_code : suggestCode(value) }))
  }

  const onCountry = (name) => {
    const c = countries.find((x) => x.name === name)
    setForm((f) => ({ ...f, country: name, currency: c?.currency || f.currency }))
  }

  // Live availability check for the company code (debounced).
  useEffect(() => {
    const code = form.tenant_code
    if (!code) { setCodeCheck({ state: 'idle' }); return }
    if (!CODE_RE.test(code)) { setCodeCheck({ state: 'invalid' }); return }
    setCodeCheck({ state: 'checking' })
    const t = setTimeout(async () => {
      try {
        const res = await platformApi.get('/tenants/check-code', { params: { code } })
        setCodeCheck({ state: res.data.data.available ? 'ok' : 'taken' })
      } catch {
        setCodeCheck({ state: 'idle' })
      }
    }, 350)
    return () => clearTimeout(t)
  }, [form.tenant_code])

  const validate = (s) => {
    const e = {}
    if (s === 0) {
      if (!form.tenant_name.trim()) e.tenant_name = 'Company name is required.'
      if (!CODE_RE.test(form.tenant_code)) e.tenant_code = '2–50 letters, numbers or hyphens; no hyphen at the start or end.'
      else if (codeCheck.state === 'taken') e.tenant_code = 'This code is already taken.'
      else if (codeCheck.state === 'checking') e.tenant_code = 'Checking availability…'
    }
    if (s === 1) {
      if (!/^[A-Z]{3}$/.test(form.currency)) e.currency = 'Use a 3-letter currency code, e.g. USD.'
    }
    if (s === 2) {
      if (!form.admin_name.trim()) e.admin_name = 'Administrator name is required.'
      if (!EMAIL_RE.test(form.admin_email.trim())) e.admin_email = 'Enter a valid email address.'
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const next = () => { if (validate(step)) setStep((s) => s + 1) }
  const back = () => { setErrors({}); setStep((s) => s - 1) }

  const submit = async () => {
    setSubmitError('')
    try {
      setSubmitting(true)
      const res = await platformApi.post('/tenants', {
        tenant_name: form.tenant_name.trim(),
        tenant_code: form.tenant_code,
        currency: form.currency,
        fiscal_start_month: Number(form.fiscal_start_month),
        admin_name: form.admin_name.trim(),
        admin_email: form.admin_email.trim(),
      })
      setResult(res.data.data)
    } catch (error) {
      setSubmitError(error.response?.data?.message || 'Unable to onboard client.')
    } finally {
      setSubmitting(false)
    }
  }

  if (result) {
    const inv = result.invite
    return (
      <div className="dashboard-page cl-page">
        <Card className="plat-card plat-success">
          <div className="plat-success-icon" aria-hidden="true">✓</div>
          <h2>{result.tenant.tenant_name} is ready</h2>
          <p className="td-muted">
            Company code <strong>{result.tenant.tenant_code.toLowerCase()}</strong> · {result.currency} ·
            fiscal year {result.fiscal_year?.label}
          </p>

          <div className="plat-callout">
            {inv.email_sent
              ? inv.email_driver === 'console'
                ? <>The invitation email was <strong>saved to the server outbox</strong> (email sending is not configured). Share the link below with {result.admin.email}.</>
                : <>An invitation email was sent to <strong>{result.admin.email}</strong>.</> 
                
      : <>The invitation email <strong>could not be sent</strong>{inv.email_error ? ` (${inv.email_error})` : ''}. Share the link below with {result.admin.email}.</>}
          </div>

          <InviteLinkBox url={inv.url} days={inv.expires_in_days} />

          <div className="plat-actions">
            <Link className="cl-btn cl-btn-secondary" to="/platform/tenants">Back to clients</Link>
            <button type="button" className="cl-btn cl-btn-primary" onClick={() => navigate(`/platform/tenants/${result.tenant.id}`)}>
              View client
            </button>
          </div>
        </Card>
      </div>
    )
  }

  const codeHint = {
    checking: 'Checking…',
    ok: '✓ Available',
    taken: 'Already taken',
    invalid: 'Letters, numbers and hyphens only',
    idle: 'Users type this (in lowercase) when they sign in',
  }[codeCheck.state]

  return (
    <div className="dashboard-page cl-page">
      <div className="cl-head">
        <div className="cl-head-left">
          <button type="button" className="cl-back" onClick={() => navigate('/platform/tenants')} aria-label="Back to clients">
            <Icon d={ICONS.back} />
          </button>
          <div>
            <div className="cl-title">Onboard a client</div>
            <div className="cl-subtitle">Set up a new company and invite its administrator. Takes about a minute.</div>
          </div>
        </div>
        <div className="cl-head-actions">
          <Link className="cl-btn cl-btn-secondary" to="/platform/tenants">Cancel</Link>
        </div>
      </div>

      <ol className="plat-stepper">
        {STEPS.map((label, i) => (
          <li key={label} className={i === step ? 'current' : i < step ? 'done' : ''}>
            <span className="plat-step-num">{i < step ? '✓' : i + 1}</span>
            <span>{label}</span>
          </li>
        ))}
      </ol>

      <Card className="plat-card">
        <PanelHeader title={['Company details', 'Accounting setup', 'Company administrator', 'Review & create'][step]} />
        {step === 0 && (
          <div className="form-grid cols-2">
            <Input label="Company name" required value={form.tenant_name}
              onChange={(e) => onName(e.target.value)} hint={errors.tenant_name} autoFocus />
            <Input label="Company code" required value={form.tenant_code}
              onChange={(e) => { setCodeTouched(true); set('tenant_code', e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '')) }}
              hint={errors.tenant_code || codeHint} />
            <Select label="Country" value={form.country} onChange={(e) => onCountry(e.target.value)}
              hint="Used to suggest the base currency">
              <option value="">Select a country…</option>
              {countries.map((c) => <option key={c.iso2 || c.name} value={c.name}>{c.name}</option>)}
            </Select>
          </div>
        )}

        {step === 1 && (
          <div className="form-grid cols-2">
            <Input label="Base currency" required value={form.currency} maxLength={3}
              onChange={(e) => set('currency', e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
              hint={errors.currency || 'Group reporting currency, e.g. USD, GBP, INR'} />
            <Select label="Fiscal year starts in" value={form.fiscal_start_month}
              onChange={(e) => set('fiscal_start_month', Number(e.target.value))}
              hint="Creates the current fiscal year with 12 monthly periods">
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </Select>
            <div className="plat-note">
              The company starts with the standard chart of accounts, default roles
              (Super Admin, Finance Admin, Account Manager, Recruiter), document numbering
              and email templates. The client can change these later in Settings.
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="form-grid cols-2">
            <Input label="Administrator name" required value={form.admin_name}
              onChange={(e) => set('admin_name', e.target.value)} hint={errors.admin_name} />
            <Input label="Administrator email" required type="email" value={form.admin_email}
              onChange={(e) => set('admin_email', e.target.value)} hint={errors.admin_email} />
            <div className="plat-note">
              The administrator gets the Super Admin role and an email invitation to set their own
              password. You never see or choose their password.
            </div>
          </div>
        )}

        {step === 3 && (
          <dl className="plat-review">
            <dt>Company</dt><dd>{form.tenant_name}</dd>
            <dt>Company code</dt><dd>{form.tenant_code} <span className="td-muted">(signs in as “{form.tenant_code.toLowerCase()}”)</span></dd>
            {form.country && (<><dt>Country</dt><dd>{form.country}</dd></>)}
            <dt>Base currency</dt><dd>{form.currency}</dd>
            <dt>Fiscal year starts</dt><dd>{MONTHS[form.fiscal_start_month - 1]}</dd>
            <dt>Administrator</dt><dd>{form.admin_name} · {form.admin_email}</dd>
          </dl>
        )}

        {submitError && <div className="login-error" role="alert">{submitError}</div>}

        <div className="plat-actions">
          {step > 0 && <button type="button" className="cl-btn cl-btn-secondary" onClick={back} disabled={submitting}>Back</button>}
          {step < STEPS.length - 1
            ? <button type="button" className="cl-btn cl-btn-primary" onClick={next}>Continue</button>
            : <button type="button" className="cl-btn cl-btn-primary" onClick={submit} disabled={submitting}>
                {submitting ? 'Creating…' : 'Create client & send invite'}
              </button>}
        </div>
      </Card>
    </div>
  )
}

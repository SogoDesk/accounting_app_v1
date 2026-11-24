import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import api from '../services/api'
import { setStoredTenant } from '../utils/tenant'
import logo from '../assets/tetriq-no-bg.png'
import './login.css'

// Public page a newly invited client administrator lands on from their email.
export default function AcceptInvitePage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const token = params.get('token') || ''

  const [invite, setInvite] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(null)

  useEffect(() => {
    if (!token) { setLoadError('This invitation link is incomplete.'); return }
    api.get(`/auth/invite/${encodeURIComponent(token)}`)
      .then((res) => setInvite(res.data.data))
      .catch((err) => setLoadError(err.response?.data?.message || 'This invitation link is invalid.'))
  }, [token])

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return }
    if (password !== confirm) { setError('Passwords do not match.'); return }
    try {
      setSaving(true)
      const res = await api.post('/auth/invite/accept', { token, password })
      const code = res.data.data.company_code
      setStoredTenant({ slug: code, name: invite?.company_name })
      setDone(code)
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to set your password.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="login-page">
      <div className="login-orb orb-a"></div>
      <div className="login-orb orb-b"></div>
      <div className="login-orb orb-c"></div>

      <div className="login-shell">
        <div className="login-card">
          <div className="login-logo">
            <img className="logo-image" src={logo} alt="TetriQ Solutions" />
          </div>

          {loadError ? (
            <>
              <h1>Invitation unavailable</h1>
              <div className="login-error" role="alert"><span className="error-icon">!</span>{loadError}</div>
              <div className="login-footnote"><Link to="/">Go to sign in</Link></div>
            </>
          ) : done ? (
            <>
              <h1>You're all set</h1>
              <p>Your password is saved. Sign in with company code <strong>{done}</strong>.</p>
              <button className="login-btn" type="button" onClick={() => navigate('/', { replace: true })}>
                <span className="btn-text">Go to sign in</span>
              </button>
            </>
          ) : !invite ? (
            <p>Checking your invitation…</p>
          ) : (
            <>
              <h1>Welcome to {invite.company_name}</h1>
              <p>Set a password for <strong>{invite.email}</strong></p>

              <form onSubmit={submit} className="login-form">
                <label htmlFor="invite-password">New password</label>
                <div className="input-wrap">
                  <input id="invite-password" type={show ? 'text' : 'password'} autoComplete="new-password"
                    placeholder="At least 8 characters" value={password} onChange={(e) => setPassword(e.target.value)} />
                  <button type="button" className="toggle-btn" onClick={() => setShow((v) => !v)}>
                    {show ? 'Hide' : 'Show'}
                  </button>
                </div>

                <label htmlFor="invite-confirm">Confirm password</label>
                <input id="invite-confirm" type={show ? 'text' : 'password'} autoComplete="new-password"
                  placeholder="Repeat your password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />

                {error && (
                  <div className="login-error" role="alert"><span className="error-icon">!</span>{error}</div>
                )}

                <button className="login-btn" type="submit" disabled={saving}>
                  <span className="btn-text">{saving ? 'Saving' : 'Set password'}</span>
                  {saving && <span className="spinner" aria-hidden="true"></span>}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

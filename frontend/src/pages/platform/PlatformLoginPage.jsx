import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { usePlatformAuth } from '../../context/PlatformAuthContext'
import logo from '../../assets/tetriq-no-bg.png'
import '../login.css'

// Sign-in for the single platform operator account. Unlike the company login
// there is no company code: this account is not part of any tenant.
export default function PlatformLoginPage() {
  const { login } = usePlatformAuth()
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (!email || !password) {
      setError('Please enter both email and password.')
      return
    }
    try {
      setLoading(true)
      await login(email.trim(), password)
      navigate('/platform/dashboard', { replace: true })
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to sign in.')
    } finally {
      setLoading(false)
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

          <h1>Platform Console</h1>
          <p>Onboard and manage client companies</p>

          <form onSubmit={handleSubmit} className="login-form">
            <label htmlFor="platform-email">Email Address</label>
            <input
              id="platform-email"
              type="email"
              autoComplete="username"
              placeholder="operator@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />

            <label htmlFor="platform-password">Password</label>
            <div className="input-wrap">
              <input
                id="platform-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="toggle-btn"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>``

            {error && (
              <div className="login-error" role="alert" aria-live="polite">
                <span className="error-icon">!</span>
                {error}
              </div>
            )}

            <button className="login-btn" type="submit" disabled={loading}>
              <span className="btn-text">{loading ? 'Signing In' : 'Sign in to Platform'}</span>
              {loading && <span className="spinner" aria-hidden="true"></span>}
            </button>
          </form>

          <div className="login-footnote">
            Company user? <Link to="/">Sign in to your company</Link>
          </div>
        </div>
      </div>
    </div>
  )
}

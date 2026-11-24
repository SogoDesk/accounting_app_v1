import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { usePlatformAuth } from '../context/PlatformAuthContext'
import { useTheme } from '../context/ThemeContext'
import './shell.css'
import './PlatformLayout.css'

// Platform console shell. Uses the same top-bar design (sdb-* classes from
// shell.css) as the company app's MainLayout, so both look alike.

const Svg = ({ children }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
)
const SunIcon = () => <Svg><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></Svg>
const MoonIcon = () => <Svg><path d="M12 3a6 6 0 1 0 9 9 9 9 0 1 1-9-9z" /></Svg>
const LogoutIcon = () => <Svg><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></Svg>
const CheckIcon = () => <Svg><path d="M20 6 9 17l-5-5" /></Svg>
const PlusIcon = () => <Svg><path d="M12 5v14M5 12h14" /></Svg>
const GridIcon = () => <Svg><rect x="3" y="3" width="8" height="8" rx="2" /><rect x="13" y="3" width="8" height="5" rx="2" /><rect x="13" y="12" width="8" height="9" rx="2" /><rect x="3" y="15" width="8" height="6" rx="2" /></Svg>
const BuildingIcon = () => <Svg><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1" /></Svg>

const NAV = [
  { path: '/platform/dashboard', label: 'Dashboard', icon: <GridIcon /> },
  { path: '/platform/tenants', label: 'Clients', icon: <BuildingIcon /> },
  { path: '/platform/tenants/new', label: 'Onboard client', icon: <PlusIcon /> },
]

// Most specific nav item whose path prefixes the current URL.
const activePath = (pathname) =>
  NAV.map((n) => n.path)
    .filter((p) => pathname === p || pathname.startsWith(`${p}/`))
    .sort((a, b) => b.length - a.length)[0]

export default function PlatformLayout() {
  const { admin, logout } = usePlatformAuth()
  const { dark, toggle, accent, setAccent, accents } = useTheme()
  const navigate = useNavigate()
  const location = useLocation()
  const [profileOpen, setProfileOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const profileRef = useRef(null)

  const current = activePath(location.pathname)
  // "Onboard client" lives under Clients in the top pill.
  const pillActive = current === '/platform/tenants/new' ? '/platform/tenants' : current

  useEffect(() => {
    const onDown = (e) => {
      if (profileRef.current && !profileRef.current.contains(e.target)) setProfileOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  useEffect(() => { setMobileNavOpen(false); setProfileOpen(false) }, [location.pathname])

  const go = (path) => navigate(path)

  const signOut = () => {
    logout()
    navigate('/platform/login', { replace: true })
  }

  const displayName = admin?.fullName || admin?.email || 'Platform admin'
  const initials = displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase()

  return (
    <div className="sdb-shell">
      <div className="sdb-app-card">
        <header className="sdb-topbar">
          <button
            type="button"
            className="sdb-hamburger"
            aria-label="Open navigation menu"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen((v) => !v)}
          >
            <span /><span /><span />
          </button>

          <div className="sdb-brand">
            <div className="sdb-logo" aria-hidden="true">SD</div>
            <div className="sdb-brand-text">
              <div className="sdb-brand-title">SogoDesk Books</div>
              <div className="sdb-brand-sub">Platform console</div>
            </div>
          </div>

          <nav className="sdb-nav" aria-label="Platform navigation">
            <div className="sdb-nav-pill">
              {NAV.filter((n) => n.path !== '/platform/tenants/new').map((item) => (
                <div className="sdb-nav-slot" key={item.path}>
                  <button
                    type="button"
                    className={`sdb-nav-item${pillActive === item.path ? ' is-active' : ''}`}
                    onClick={() => go(item.path)}
                  >
                    <span>{item.label}</span>
                  </button>
                </div>
              ))}
            </div>
          </nav>

          <div className="sdb-right">
            <button type="button" className="plat-top-cta" onClick={() => go('/platform/tenants/new')}>
              <PlusIcon />
              <span>Onboard client</span>
            </button>

            <div className="sdb-profile" ref={profileRef}>
              <button
                type="button"
                className="sdb-avatar-btn"
                aria-label="Account menu"
                aria-expanded={profileOpen}
                onClick={() => setProfileOpen((v) => !v)}
              >
                <span className="sdb-avatar">{initials}</span>
              </button>
              {profileOpen ? (
                <div className="sdb-profile-menu" role="menu">
                  <div className="sdb-profile-head">
                    <span className="sdb-avatar">{initials}</span>
                    <div>
                      <div className="sdb-profile-name">{displayName}</div>
                      <span className="sdb-role-chip">PLATFORM ADMIN</span>
                    </div>
                  </div>
                  <div className="sdb-menu-divider" />
                  <button type="button" className="sdb-menu-item" role="menuitem" onClick={toggle}>
                    {dark ? <SunIcon /> : <MoonIcon />}
                    <span>{dark ? 'Switch to light mode' : 'Switch to dark mode'}</span>
                  </button>
                  <div className="sdb-menu-divider" />
                  <div className="sdb-theme-label">Theme colour</div>
                  {accents.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      role="menuitemradio"
                      aria-checked={accent === option.key}
                      className={`sdb-accent-row${accent === option.key ? ' is-active' : ''}`}
                      onClick={() => setAccent(option.key)}
                    >
                      <span className="sdb-accent-swatch" style={{ background: option.hex }} aria-hidden="true" />
                      <span className="sdb-accent-label">{option.label}</span>
                      {accent === option.key ? <span className="sdb-accent-check" aria-hidden="true"><CheckIcon /></span> : null}
                    </button>
                  ))}
                  <div className="sdb-menu-divider" />
                  <button type="button" className="sdb-menu-item is-danger" role="menuitem" onClick={signOut}>
                    <LogoutIcon />
                    <span>Logout</span>
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        {mobileNavOpen ? (
          <div className="sdb-drawer-backdrop" onClick={() => setMobileNavOpen(false)}>
            <nav className="sdb-drawer" aria-label="Platform navigation" onClick={(e) => e.stopPropagation()}>
              <div className="sdb-drawer-head">
                <div className="sdb-brand-title">Platform console</div>
                <button type="button" className="sdb-drawer-close" aria-label="Close navigation menu" onClick={() => setMobileNavOpen(false)}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
                </button>
              </div>
              <div className="sdb-drawer-body">
                {NAV.map((item) => (
                  <button
                    key={item.path}
                    type="button"
                    className={`sdb-drawer-item${current === item.path ? ' is-current' : ''}`}
                    onClick={() => go(item.path)}
                  >
                    <span className="sdb-drawer-item-icon">{item.icon}</span>
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            </nav>
          </div>
        ) : null}

        <section className="sdb-page page-content">
          <Outlet />
        </section>
      </div>
    </div>
  )
}

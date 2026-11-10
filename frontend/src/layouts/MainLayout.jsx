import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import { useEntity } from '../context/EntityContext'
import api from '../services/api'
import { setAppPreferencesFromRegion } from '../utils/appPreferences'
import './shell.css'

const SearchIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
)

const ChevronDownIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
)

const BellIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </svg>
)

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
    <path d="m5 12 5 5 9-11" />
  </svg>
)

const SunIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4" />
  </svg>
)

const MoonIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </svg>
)

const KeyIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="m10.8 12.2 7-7M15 5h4v4M13 7l4 4" />
  </svg>
)

const LogoutIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="m16 17 5-5-5-5M21 12H9" />
  </svg>
)

const EyeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

const EyeOffIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="m3 3 18 18" />
    <path d="M10.6 10.6A3 3 0 0 0 12 15a3 3 0 0 0 2.4-1.2" />
    <path d="M9.9 4.3A10.8 10.8 0 0 1 12 4c6.5 0 10 8 10 8a18.5 18.5 0 0 1-3.1 4.3" />
    <path d="M6.6 6.6C3.7 8.6 2 12 2 12s3.5 8 10 8a10.8 10.8 0 0 0 4.4-.9" />
  </svg>
)

// `perm` maps a nav item to a permission module key. When the signed-in user's
// role has a permission set defined, the menu is filtered by these keys; when it
// doesn't (null), we fall back to the hardcoded `roles` list.
const NAV = [
  { path: '/dashboard', label: 'Home', icon: 'grid', group: 'home', roles: [], perm: 'dashboard' },
  { path: '/clients', label: 'Clients', icon: 'building', group: 'sales', roles: ['SUPER_ADMIN', 'FINANCE_ADMIN', 'ACCOUNT_MANAGER'], perm: 'clients' },
  { path: '/invoices', label: 'Invoices', icon: 'file', group: 'sales', roles: ['SUPER_ADMIN', 'FINANCE_ADMIN', 'ACCOUNT_MANAGER'], perm: 'invoices' },
  { path: '/payments', label: 'Payments', icon: 'card', group: 'sales', roles: ['SUPER_ADMIN', 'FINANCE_ADMIN'], perm: 'payments' },
  { path: '/vendors', label: 'Vendors', icon: 'building', group: 'purchases', roles: ['SUPER_ADMIN', 'FINANCE_ADMIN'], perm: 'vendors' },
  { path: '/bills', label: 'Bills', icon: 'file', group: 'purchases', roles: ['SUPER_ADMIN', 'FINANCE_ADMIN'], perm: 'bills' },
  { path: '/vendor-payments', label: 'Vendor Payments', icon: 'card', group: 'purchases', roles: ['SUPER_ADMIN', 'FINANCE_ADMIN'], perm: 'vendorPayments' },
  { path: '/approvals', label: 'Approvals', icon: 'shield', group: 'purchases', roles: ['SUPER_ADMIN', 'FINANCE_ADMIN'], perm: 'approvals' },
  { path: '/expenses', label: 'Variable Expenses', icon: 'card', group: 'expenses', roles: ['SUPER_ADMIN', 'ADMIN', 'FINANCE_ADMIN'], perm: 'expenses' },
  { path: '/expenses/fixed', label: 'Fixed Expenses', icon: 'file', group: 'expenses', roles: ['SUPER_ADMIN', 'ADMIN', 'FINANCE_ADMIN'], perm: 'expenses' },
  { path: '/expenses/categories', label: 'Categories', icon: 'briefcase', group: 'expenses', roles: ['SUPER_ADMIN', 'ADMIN', 'FINANCE_ADMIN'], perm: 'expenses' },
  { path: '/expenses/summary', label: 'Monthly Summary', icon: 'grid', group: 'expenses', roles: ['SUPER_ADMIN', 'ADMIN', 'FINANCE_ADMIN'], perm: 'expenses' },
  { path: '/accounting', label: 'Overview', icon: 'grid', group: 'accounting', roles: ['SUPER_ADMIN', 'ADMIN', 'FINANCE_ADMIN'], perm: 'accounting' },
  { path: '/accounting/reports', label: 'Financial Reports', icon: 'grid', group: 'accounting', roles: ['SUPER_ADMIN', 'ADMIN', 'FINANCE_ADMIN'], perm: 'accounting' },
  { path: '/accounting/journal-entries', label: 'Journal Entries', icon: 'file', group: 'accounting', roles: ['SUPER_ADMIN', 'ADMIN', 'FINANCE_ADMIN'], perm: 'accounting' },
  { path: '/accounting/chart-of-accounts', label: 'Chart of Accounts', icon: 'briefcase', group: 'accounting', roles: ['SUPER_ADMIN', 'ADMIN', 'FINANCE_ADMIN'], perm: 'accounting' },
  { path: '/accounting/period-close', label: 'Period Close', icon: 'shield', group: 'accounting', roles: ['SUPER_ADMIN', 'ADMIN', 'FINANCE_ADMIN'], perm: 'accounting' },
  { path: '/banking', label: 'Banking & Reconciliation', icon: 'card', group: 'accounting', roles: ['SUPER_ADMIN', 'ADMIN', 'FINANCE_ADMIN'], perm: 'banking' },
  { path: '/candidates', label: 'Candidates', icon: 'users', group: 'workforce', roles: ['SUPER_ADMIN', 'FINANCE_ADMIN', 'ACCOUNT_MANAGER', 'RECRUITER'], perm: 'candidates' },
  { path: '/placements', label: 'Placements', icon: 'briefcase', group: 'workforce', roles: ['SUPER_ADMIN', 'FINANCE_ADMIN', 'ACCOUNT_MANAGER', 'RECRUITER'], perm: 'placements' },
  { path: '/timesheets', label: 'Timesheets', icon: 'file', group: 'workforce', roles: ['SUPER_ADMIN', 'ADMIN', 'FINANCE_ADMIN'], perm: 'timesheets' },
  { path: '/settings/organization', label: 'Organization', icon: 'globe', group: 'settings', roles: ['SUPER_ADMIN', 'ADMIN', 'FINANCE_ADMIN'], perm: 'regions' },
  { path: '/settings/currencies', label: 'Currencies & Rates', icon: 'card', group: 'settings', roles: ['SUPER_ADMIN', 'ADMIN', 'FINANCE_ADMIN'], perm: 'settings' },
  { path: '/settings/numbering', label: 'Numbering', icon: 'file', group: 'settings', roles: ['SUPER_ADMIN', 'ADMIN', 'FINANCE_ADMIN'], perm: 'settings' },
  { path: '/settings/tax', label: 'Tax & Rates', icon: 'briefcase', group: 'settings', roles: ['SUPER_ADMIN', 'ADMIN', 'FINANCE_ADMIN'], perm: 'settings' },
  { path: '/settings/email-templates', label: 'Email Templates', icon: 'file', group: 'settings', roles: ['SUPER_ADMIN', 'ADMIN', 'FINANCE_ADMIN'], perm: 'settings' },
  { path: '/settings/notifications', label: 'Notifications', icon: 'shield', group: 'settings', roles: ['SUPER_ADMIN', 'ADMIN', 'FINANCE_ADMIN'], perm: 'settings' },
  { path: '/settings/users', label: 'Users', icon: 'users', group: 'settings', roles: ['SUPER_ADMIN', 'ADMIN'], perm: 'users' },
  { path: '/settings/roles', label: 'Roles & Permissions', icon: 'shield', group: 'settings', roles: ['SUPER_ADMIN'], perm: 'users' },
  { path: '/settings/audit', label: 'Audit Logs', icon: 'shield', group: 'settings', roles: ['SUPER_ADMIN', 'ADMIN'], perm: 'auditLogs' },
]

const NAV_GROUP_ORDER = [
  { key: 'home', label: 'Home', icon: 'grid' },
  { key: 'sales', label: 'Sales', icon: 'card' },
  { key: 'purchases', label: 'Purchases', icon: 'building' },
  { key: 'expenses', label: 'Expenses', icon: 'card' },
  { key: 'accounting', label: 'Accounting', icon: 'briefcase' },
  { key: 'workforce', label: 'Workforce', icon: 'users' },
  { key: 'settings', label: 'Settings', icon: 'globe' },
]

// One brand tint for every section badge.
const NAV_GROUP_COLOR = {
  home: 'var(--primary)',
  sales: 'var(--primary)',
  purchases: 'var(--primary)',
  expenses: 'var(--primary)',
  accounting: 'var(--primary)',
  workforce: 'var(--primary)',
  settings: 'var(--primary)',
}

const SEARCH_ACTIONS = [
  {
    path: '/settings/organization?action=create',
    label: 'Add Region',
    hint: 'Create geographic region',
    icon: 'globe',
    roles: ['SUPER_ADMIN', 'FINANCE_ADMIN'],
    keywords: ['add region', 'new region', 'create region', 'region setup', 'company bank details'],
  },
  {
    path: '/clients?action=create',
    label: 'Add Client',
    hint: 'Create billing account',
    icon: 'building',
    roles: ['SUPER_ADMIN', 'FINANCE_ADMIN', 'ACCOUNT_MANAGER'],
    keywords: ['add client', 'new client', 'create client', 'customer', 'billing account'],
  },
  {
    path: '/vendors?action=create',
    label: 'Add Vendor',
    hint: 'Create payable vendor',
    icon: 'building',
    roles: ['SUPER_ADMIN', 'FINANCE_ADMIN'],
    keywords: ['add vendor', 'new vendor', 'create vendor', 'supplier', 'payable vendor'],
  },
  {
    path: '/candidates?action=create',
    label: 'Add Candidate',
    hint: 'Create candidate profile',
    icon: 'users',
    roles: ['SUPER_ADMIN', 'FINANCE_ADMIN', 'ACCOUNT_MANAGER', 'RECRUITER'],
    keywords: ['add candidate', 'new candidate', 'create candidate', 'consultant', 'profile'],
  },
  {
    path: '/placements?action=create',
    label: 'Add Placement',
    hint: 'Create placement record',
    icon: 'briefcase',
    roles: ['SUPER_ADMIN', 'FINANCE_ADMIN', 'ACCOUNT_MANAGER', 'RECRUITER'],
    keywords: ['add placement', 'new placement', 'create placement', 'assignment', 'job placement'],
  },
  {
    path: '/invoices?action=create',
    label: 'New Invoice',
    hint: 'Create invoice',
    icon: 'file',
    roles: ['SUPER_ADMIN', 'FINANCE_ADMIN', 'ACCOUNT_MANAGER'],
    keywords: ['add invoice', 'new invoice', 'create invoice', 'generate invoice', 'bill client'],
  },
  {
    path: '/payments?action=create',
    label: 'Record Payment',
    hint: 'Add payment collection',
    icon: 'card',
    roles: ['SUPER_ADMIN', 'FINANCE_ADMIN'],
    keywords: ['add payment', 'new payment', 'record payment', 'create payment', 'payment received', 'collection'],
  },
  {
    path: '/bills?action=create',
    label: 'New Bill',
    hint: 'Create vendor bill',
    icon: 'file',
    roles: ['SUPER_ADMIN', 'FINANCE_ADMIN'],
    keywords: ['add bill', 'new bill', 'create bill', 'vendor invoice', 'payable bill'],
  },
  {
    path: '/vendor-payments?action=create',
    label: 'Vendor Payment',
    hint: 'Record payable payment',
    icon: 'card',
    roles: ['SUPER_ADMIN', 'FINANCE_ADMIN'],
    keywords: ['vendor payment', 'pay bill', 'ap payment', 'disbursement'],
  },
  {
    path: '/approvals',
    label: 'Pending Approvals',
    hint: 'Review submitted bills',
    icon: 'shield',
    roles: ['SUPER_ADMIN', 'FINANCE_ADMIN'],
    keywords: ['approvals', 'pending approvals', 'approve bills', 'bill review'],
  },
  {
    path: '/settings/users?action=create',
    label: 'Add User',
    hint: 'Create system user',
    icon: 'users',
    roles: ['SUPER_ADMIN'],
    keywords: ['add user', 'new user', 'create user', 'invite user', 'system user'],
  },
  {
    path: '/invoices?scope=overdue',
    label: 'Overdue Invoices',
    hint: 'View overdue receivables',
    icon: 'file',
    roles: ['SUPER_ADMIN', 'FINANCE_ADMIN', 'ACCOUNT_MANAGER'],
    keywords: ['overdue', 'overdue invoices', 'late invoices', 'past due', 'follow up'],
  },
  {
    path: '/invoices?scope=outstanding',
    label: 'Outstanding Invoices',
    hint: 'View pending collections',
    icon: 'file',
    roles: ['SUPER_ADMIN', 'FINANCE_ADMIN', 'ACCOUNT_MANAGER'],
    keywords: ['outstanding', 'pending collection', 'pending invoices', 'receivables'],
  },
]

const iconFor = (type) => {
  switch (type) {
    case 'globe':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" /></svg>
    case 'building':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1" /></svg>
    case 'users':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2" /><circle cx="10" cy="7" r="3" /><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a3 3 0 0 1 0 5.8" /></svg>
    case 'briefcase':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" /></svg>
    case 'file':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h8" /></svg>
    case 'card':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></svg>
    case 'shield':
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3l8 3v6c0 5-3.5 8.5-8 9-4.5-.5-8-4-8-9V6z" /><path d="m9 12 2 2 4-4" /></svg>
    default:
      return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="8" height="8" rx="2" /><rect x="13" y="3" width="8" height="5" rx="2" /><rect x="13" y="12" width="8" height="9" rx="2" /><rect x="3" y="15" width="8" height="6" rx="2" /></svg>
  }
}

export default function MainLayout({ children }) {
  const { user, logout, hasRole } = useAuth()
  const { dark, toggle, accent, setAccent, accents } = useTheme()
  // The top-bar region pill IS the app-wide entity switcher: it writes the
  // shared EntityContext (`entityId`), which the dashboard filters on and every
  // other page seeds its own filter from. '' means "All regions" (consolidated).
  const { entityId, setEntityId } = useEntity()
  const navigate = useNavigate()
  const location = useLocation()
  const [profileOpen, setProfileOpen] = useState(false)
  const [openChangePassword, setOpenChangePassword] = useState(false)
  const [isChangingPassword, setIsChangingPassword] = useState(false)
  const [passwordError, setPasswordError] = useState('')
  const [passwordSuccess, setPasswordSuccess] = useState('')
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  })
  const [showPasswords, setShowPasswords] = useState({
    current: false,
    next: false,
    confirm: false,
  })
  const [searchTerm, setSearchTerm] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  // `openGroup` = which nav-pill group dropdown is open (null = none). Replaces
  // the old sidebar accordion state; only one dropdown is open at a time.
  const [openGroup, setOpenGroup] = useState(null)
  const [regionOpen, setRegionOpen] = useState(false)
  // Mobile off-canvas nav drawer (the centre pill is hidden ≤1080px).
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [regions, setRegions] = useState([])
  // Derived from the shared entity selection, not stored locally, so the pill,
  // the dashboard picker and every page stay in sync.
  const activeRegion = regions.find((r) => String(r.id) === String(entityId)) || null
  const profileRef = useRef(null)
  const searchRef = useRef(null)
  const searchInputRef = useRef(null)
  const navRef = useRef(null)
  const regionRef = useRef(null)

  // Effective permission keys for the signed-in user's role. `null` means the
  // role has no custom permission set, so we fall back to the hardcoded roles.
  const [myPerms, setMyPerms] = useState(null)
  useEffect(() => {
    let alive = true
    api.get('/settings/my-permissions')
      .then((r) => { if (alive) setMyPerms(Array.isArray(r.data?.data) ? r.data.data : null) })
      .catch(() => { if (alive) setMyPerms(null) })
    return () => { alive = false }
  }, [])

  const navItems = useMemo(() => NAV.filter((item) => {
    if (myPerms === null) return hasRole(...item.roles)
    return item.perm ? myPerms.includes(item.perm) : hasRole(...item.roles)
  }), [hasRole, myPerms])
  const groupedNavItems = useMemo(() => {
    return NAV_GROUP_ORDER.map((group) => ({
      ...group,
      items: navItems.filter((item) => item.group === group.key),
    })).filter((group) => group.items.length > 0)
  }, [navItems])

  const homeItem = useMemo(() => navItems.find((i) => i.group === 'home'), [navItems])
  const activeGroup = useMemo(() => {
    const match = navItems.find(
      (i) => i.group !== 'home' && location.pathname.startsWith(i.path),
    )
    return match ? match.group : null
  }, [navItems, location.pathname])

  // The single most-specific nav item that the current URL maps to. Drives the
  // "current page" highlight inside a group dropdown.
  const activeItemPath = useMemo(() => {
    let best = null
    navItems.forEach((i) => {
      if (location.pathname === i.path || location.pathname.startsWith(`${i.path}/`)) {
        if (!best || i.path.length > best.length) best = i.path
      }
    })
    return best
  }, [navItems, location.pathname])

  const searchItems = useMemo(() => {
    const query = searchTerm.trim().toLowerCase()
    const pageItems = navItems.map((item) => ({
      ...item,
      hint: 'Open page',
      searchText: `${item.label} ${item.path.replace('/', '')}`,
      type: 'page',
    }))
    const actionItems = SEARCH_ACTIONS
      .filter((item) => hasRole(...item.roles))
      .map((item) => ({
        ...item,
        searchText: `${item.label} ${item.hint} ${item.keywords.join(' ')}`,
        type: 'action',
      }))
    const items = [...actionItems, ...pageItems]

    if (!query) return items
    return items.filter((item) => item.searchText.toLowerCase().includes(query))
  }, [hasRole, navItems, searchTerm])

  const displayName = user?.fullName || user?.email || 'User'
  const roleName = user?.roleName || 'MEMBER'
  const initials = String(displayName).trim().slice(0, 2).toUpperCase()

  useEffect(() => {
    let alive = true
    const loadRegionPreferences = async () => {
      try {
        const res = await api.get('/regions')
        const rows = res.data?.data || []
        if (!alive) return
        setRegions(rows)
        if (!rows.length) return
        // Apply formatting prefs for the currently selected entity, or fall back
        // to the first ACTIVE region for the "All regions" default. Never force
        // an entity selection here — respect whatever the user already chose.
        const selected = rows.find((row) => String(row.id) === String(entityId))
        const preferred = rows.find((row) => String(row.status || '').toUpperCase() === 'ACTIVE') || rows[0]
        setAppPreferencesFromRegion(selected || preferred)
      } catch {
        // silent on purpose
      }
    }
    loadRegionPreferences()
    return () => { alive = false }
  }, [])

  // Focus the search field when its popover opens.
  useEffect(() => {
    if (searchOpen) requestAnimationFrame(() => searchInputRef.current?.focus())
  }, [searchOpen])

  useEffect(() => {
    const handleOutside = (event) => {
      if (profileRef.current && !profileRef.current.contains(event.target)) setProfileOpen(false)
      if (searchRef.current && !searchRef.current.contains(event.target)) setSearchOpen(false)
      if (navRef.current && !navRef.current.contains(event.target)) setOpenGroup(null)
      if (regionRef.current && !regionRef.current.contains(event.target)) setRegionOpen(false)
    }
    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setProfileOpen(false)
        setSearchOpen(false)
        setOpenGroup(null)
        setRegionOpen(false)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [])

  const handleLogout = () => {
    setProfileOpen(false)
    logout()
    navigate('/')
  }

  const scrollToAppTop = () => {
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior: 'smooth' })
      document.scrollingElement?.scrollTo({ top: 0, left: 0, behavior: 'smooth' })
    })
  }

  const resetPasswordModal = () => {
    setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' })
    setPasswordError('')
    setPasswordSuccess('')
    setIsChangingPassword(false)
    setShowPasswords({ current: false, next: false, confirm: false })
  }

  const closePasswordModal = () => {
    setOpenChangePassword(false)
    resetPasswordModal()
  }

  const handlePasswordFieldChange = (key, value) => {
    setPasswordForm((prev) => ({ ...prev, [key]: value }))
    setPasswordError('')
    setPasswordSuccess('')
  }

  const handleChangePasswordSubmit = async (event) => {
    event.preventDefault()

    const currentPassword = passwordForm.currentPassword.trim()
    const newPassword = passwordForm.newPassword.trim()
    const confirmPassword = passwordForm.confirmPassword.trim()

    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordError('Please fill current, new and confirm password.')
      return
    }

    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters.')
      return
    }

    if (newPassword !== confirmPassword) {
      setPasswordError('New password and confirm password do not match.')
      return
    }

    try {
      setIsChangingPassword(true)
      await api.post('/users/change-password', { currentPassword, newPassword, confirmPassword })
      setPasswordSuccess('Password changed successfully.')
      setTimeout(closePasswordModal, 500)
    } catch (error) {
      setPasswordError(error.response?.data?.message || 'Unable to change password right now.')
    } finally {
      setIsChangingPassword(false)
    }
  }

  const navigateTo = (path) => {
    navigate(path)
    scrollToAppTop()
    setSearchOpen(false)
    setSearchTerm('')
    setProfileOpen(false)
    setOpenGroup(null)
    setRegionOpen(false)
    setMobileNavOpen(false)
  }

  const selectRegion = (region) => {
    // null → "All regions" (consolidated): clear the entity but keep the last
    // region's formatting prefs so dates/currency labels stay sensible.
    setEntityId(region?.id ?? '')
    if (region) setAppPreferencesFromRegion(region)
    setRegionOpen(false)
  }

  useEffect(() => {
    scrollToAppTop()
    setOpenGroup(null)
  }, [location.pathname, location.search])

  useEffect(() => {
    const enhanceTables = () => {
      document.querySelectorAll('.saas-table').forEach((table) => {
        const labels = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent.trim())
        if (!labels.length) return

        table.querySelectorAll('tbody tr').forEach((row) => {
          Array.from(row.children).forEach((cell, index) => {
            if (cell.tagName !== 'TD' || cell.colSpan > 1) return
            cell.setAttribute('data-label', labels[index] || '')
          })
        })
      })
    }

    enhanceTables()

    const content = document.querySelector('.page-content')
    if (!content) return undefined

    const observer = new MutationObserver(enhanceTables)
    observer.observe(content, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [location.pathname, location.search])

  return (
    <div className="sdb-shell">
      <div className="sdb-app-card">
        <header className="sdb-topbar">
          {/* LEFT — hamburger (mobile) + brand */}
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
              <div className="sdb-brand-sub">Multi-entity accounting &amp; staffing</div>
            </div>
          </div>

          {/* CENTRE — nav pill */}
          <nav className="sdb-nav" aria-label="Primary navigation">
            <div className="sdb-nav-pill" ref={navRef}>
              {groupedNavItems.map((group) => {
                const isActive = group.key === 'home'
                  ? location.pathname.startsWith(homeItem?.path || '/dashboard')
                  : activeGroup === group.key
                const isOpen = openGroup === group.key

                if (group.key === 'home') {
                  return (
                    <div className="sdb-nav-slot" key={group.key}>
                      <button
                        type="button"
                        className={`sdb-nav-item${isActive ? ' is-active' : ''}`}
                        onClick={() => navigateTo(homeItem?.path || '/dashboard')}
                      >
                        <span>{group.label}</span>
                      </button>
                    </div>
                  )
                }

                return (
                  <div className="sdb-nav-slot" key={group.key}>
                    <button
                      type="button"
                      className={`sdb-nav-item${isActive ? ' is-active' : ''}${isOpen ? ' is-open' : ''}`}
                      aria-expanded={isOpen}
                      onClick={() => setOpenGroup((cur) => (cur === group.key ? null : group.key))}
                    >
                      <span>{group.label}</span>
                      <span className="sdb-nav-chev" aria-hidden="true"><ChevronDownIcon /></span>
                    </button>

                    {isOpen ? (
                      <div className="sdb-group-menu" role="menu">
                        <div className="sdb-group-menu-label">{group.label}</div>
                        {group.items.map((item) => (
                          <button
                            key={item.path}
                            type="button"
                            role="menuitem"
                            className={`sdb-group-row${activeItemPath === item.path ? ' is-current' : ''}`}
                            onClick={() => navigateTo(item.path)}
                          >
                            <span className="sdb-group-row-icon">{iconFor(item.icon)}</span>
                            <span className="sdb-group-row-label">{item.label}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )
              })}
            </div>
          </nav>

          {/* RIGHT — region, search, notifications, avatar */}
          <div className="sdb-right">
            <div className="sdb-region" ref={regionRef}>
              <button
                type="button"
                className="sdb-region-pill"
                aria-expanded={regionOpen}
                onClick={() => setRegionOpen((v) => !v)}
              >
                <span className="sdb-region-dot" aria-hidden="true" />
                <span className="sdb-region-name">{activeRegion?.region_name || 'All regions'}</span>
                {activeRegion?.currency ? <span className="sdb-region-cur">{activeRegion.currency}</span> : null}
                <span className="sdb-region-chev" aria-hidden="true"><ChevronDownIcon /></span>
              </button>
              {regionOpen && regions.length ? (
                <div className="sdb-region-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className={`sdb-region-row${!entityId ? ' is-current' : ''}`}
                    onClick={() => selectRegion(null)}
                  >
                    <span className="sdb-region-dot" aria-hidden="true" />
                    <span className="sdb-region-row-name">All regions</span>
                  </button>
                  {regions.map((region) => (
                    <button
                      key={region.id ?? region.region_name}
                      type="button"
                      role="menuitem"
                      className={`sdb-region-row${activeRegion && (activeRegion.id ?? activeRegion.region_name) === (region.id ?? region.region_name) ? ' is-current' : ''}`}
                      onClick={() => selectRegion(region)}
                    >
                      <span className="sdb-region-dot" aria-hidden="true" />
                      <span className="sdb-region-row-name">{region.region_name}</span>
                      {region.currency ? <span className="sdb-region-row-cur">{region.currency}</span> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="sdb-search" ref={searchRef}>
              <button
                type="button"
                className="sdb-icon-btn"
                aria-label="Search"
                aria-expanded={searchOpen}
                onClick={() => setSearchOpen((v) => !v)}
              >
                <SearchIcon />
              </button>
              {searchOpen ? (
                <div className="sdb-search-pop">
                  <form
                    className="sdb-search-field"
                    onSubmit={(event) => {
                      event.preventDefault()
                      if (searchItems[0]) navigateTo(searchItems[0].path)
                    }}
                  >
                    <span className="sdb-search-field-icon"><SearchIcon /></span>
                    <input
                      ref={searchInputRef}
                      className="sdb-search-input"
                      placeholder="Search accounting..."
                      value={searchTerm}
                      onChange={(event) => setSearchTerm(event.target.value)}
                    />
                  </form>
                  <div className="sdb-search-results">
                    {searchItems.length ? searchItems.map((item) => (
                      <button
                        key={`${item.type}-${item.path}`}
                        type="button"
                        className="sdb-search-item"
                        onClick={() => navigateTo(item.path)}
                      >
                        <span className="sdb-search-item-icon">{iconFor(item.icon)}</span>
                        <span className="sdb-search-item-copy">
                          <span>{item.label}</span>
                          <small>{item.hint}</small>
                        </span>
                      </button>
                    )) : <div className="sdb-search-empty">No results found</div>}
                  </div>
                </div>
              ) : null}
            </div>

            <button type="button" className="sdb-icon-btn" aria-label="Notifications">
              <BellIcon />
              <span className="sdb-notif-dot" aria-hidden="true" />
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
                      <span className="sdb-role-chip">{roleName}</span>
                    </div>
                  </div>

                  <div className="sdb-menu-divider" />

                  <button
                    type="button"
                    className="sdb-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setOpenChangePassword(true)
                      setProfileOpen(false)
                    }}
                  >
                    <KeyIcon />
                    <span>Change password</span>
                  </button>

                  <button
                    type="button"
                    className="sdb-menu-item"
                    role="menuitem"
                    onClick={() => {
                      toggle()
                    }}
                  >
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
                      {accent === option.key ? (
                        <span className="sdb-accent-check" aria-hidden="true"><CheckIcon /></span>
                      ) : null}
                    </button>
                  ))}

                  <div className="sdb-menu-divider" />

                  <button
                    type="button"
                    className="sdb-menu-item is-danger"
                    role="menuitem"
                    onClick={handleLogout}
                  >
                    <LogoutIcon />
                    <span>Logout</span>
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        {/* Mobile off-canvas navigation (≤1080px) */}
        {mobileNavOpen ? (
          <div className="sdb-drawer-backdrop" onClick={() => setMobileNavOpen(false)}>
            <nav
              className="sdb-drawer"
              aria-label="Primary navigation"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sdb-drawer-head">
                <div className="sdb-brand-title">SogoDesk Books</div>
                <button
                  type="button"
                  className="sdb-drawer-close"
                  aria-label="Close navigation menu"
                  onClick={() => setMobileNavOpen(false)}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="sdb-drawer-body">
                {groupedNavItems.map((group) => {
                  if (group.key === 'home') {
                    const isActive = location.pathname.startsWith(homeItem?.path || '/dashboard')
                    return (
                      <button
                        key={group.key}
                        type="button"
                        className={`sdb-drawer-item is-solo${isActive ? ' is-current' : ''}`}
                        onClick={() => navigateTo(homeItem?.path || '/dashboard')}
                      >
                        {group.label}
                      </button>
                    )
                  }
                  return (
                    <div className="sdb-drawer-group" key={group.key}>
                      <div className="sdb-drawer-group-label">{group.label}</div>
                      {group.items.map((item) => (
                        <button
                          key={item.path}
                          type="button"
                          className={`sdb-drawer-item${activeItemPath === item.path ? ' is-current' : ''}`}
                          onClick={() => navigateTo(item.path)}
                        >
                          <span className="sdb-drawer-item-icon">{iconFor(item.icon)}</span>
                          <span>{item.label}</span>
                        </button>
                      ))}
                    </div>
                  )
                })}
              </div>
            </nav>
          </div>
        ) : null}

        {/* Keyed on the global region so switching it in the top pill re-mounts
            the current page, re-seeding every page's useDefaultEntityId()-based
            filter from the new region — same effect as a refresh, but instant. */}
        <section key={entityId || 'all'} className="sdb-page page-content">{children}</section>
      </div>

      {openChangePassword ? (
        <div className="modal-overlay">
          <div className="modal-card modal-card-sm">
            <h3>Change Password</h3>
            <p>Update your account password securely.</p>

            <form className="stack-form" onSubmit={handleChangePasswordSubmit}>
              <div className="password-input-wrap">
                <input
                  type={showPasswords.current ? 'text' : 'password'}
                  placeholder="Current password"
                  autoComplete="current-password"
                  value={passwordForm.currentPassword}
                  onChange={(event) => handlePasswordFieldChange('currentPassword', event.target.value)}
                />
                <button
                  type="button"
                  className="password-toggle-btn"
                  onClick={() => setShowPasswords((prev) => ({ ...prev, current: !prev.current }))}
                  aria-label={showPasswords.current ? 'Hide password' : 'Show password'}
                >
                  {showPasswords.current ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>

              <div className="password-input-wrap">
                <input
                  type={showPasswords.next ? 'text' : 'password'}
                  placeholder="New password"
                  autoComplete="new-password"
                  value={passwordForm.newPassword}
                  onChange={(event) => handlePasswordFieldChange('newPassword', event.target.value)}
                />
                <button
                  type="button"
                  className="password-toggle-btn"
                  onClick={() => setShowPasswords((prev) => ({ ...prev, next: !prev.next }))}
                  aria-label={showPasswords.next ? 'Hide password' : 'Show password'}
                >
                  {showPasswords.next ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>

              <div className="password-input-wrap">
                <input
                  type={showPasswords.confirm ? 'text' : 'password'}
                  placeholder="Confirm new password"
                  autoComplete="new-password"
                  value={passwordForm.confirmPassword}
                  onChange={(event) => handlePasswordFieldChange('confirmPassword', event.target.value)}
                />
                <button
                  type="button"
                  className="password-toggle-btn"
                  onClick={() => setShowPasswords((prev) => ({ ...prev, confirm: !prev.confirm }))}
                  aria-label={showPasswords.confirm ? 'Hide password' : 'Show password'}
                >
                  {showPasswords.confirm ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>

              {passwordError ? <div className="error-box">{passwordError}</div> : null}
              {passwordSuccess ? <div className="success-box">{passwordSuccess}</div> : null}

              <div className="modal-actions">
                <button type="button" className="secondary-btn" onClick={closePasswordModal}>
                  Cancel
                </button>
                <button type="submit" className="primary-btn" disabled={isChangingPassword}>
                  {isChangingPassword ? 'Updating...' : 'Update Password'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  )
}

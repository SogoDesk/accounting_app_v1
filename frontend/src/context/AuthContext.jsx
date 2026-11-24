import { createContext, useContext, useEffect, useState } from 'react'

import { clearAppPreferences } from '../utils/appPreferences'//added this today
import api from '../services/api'
import { clearStoredEntity } from './EntityContext'
import {
  getStoredTenant,
  getSubdomainTenant,
  normalizeSlug,
  setStoredTenant,
} from '../utils/tenant' 

const AuthContext = createContext(null)


// Backend contract (multi-tenant):
//   POST /auth/login  { email, password, tenant }  -> data: { token, user, tenant }
//   GET  /auth/me                                   -> data: { ...user, tenant }
//   tenant = { id, slug, name, logoUrl }
export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('user')) } catch { return null }
  })
  const [tenant, setTenant] = useState(() => getStoredTenant())
  const [loading, setLoading] = useState(true)

  const applyTenant = (next) => {
    if (!next?.slug) return
    setStoredTenant(next)
    setTenant(next)
  }

  const clearSession = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    setUser(null)
  }

  useEffect(() => {
    const token = localStorage.getItem('token')
    if (!token) { setLoading(false); return }
    api.get('/auth/me')
     .then(res => {
  const me = res.data.data?.user || null
  const t = res.data.data?.tenant || null

  if (!me) {
    clearSession()
    return
  }
        setUser(me)
        localStorage.setItem('user', JSON.stringify(me))
        applyTenant(t)
      })
      .catch(clearSession)
      .finally(() => setLoading(false))
  }, [])

  const login = async (email, password, tenantSlug) => {
    const slug = normalizeSlug(getSubdomainTenant() || tenantSlug)
    const res = await api.post('/auth/login', { email, password, tenant: slug })
    const { token, user, tenant: t } = res.data.data

    // Switching companies: drop anything cached for the previous tenant.
    const previous = getStoredTenant()
    if (previous?.slug && previous.slug !== t?.slug) clearStoredEntity()

    localStorage.setItem('token', token)
    localStorage.setItem('user', JSON.stringify(user))
    applyTenant(t || { slug })
    setUser(user)
    return user
  }

  const logout = () => {
    clearSession()
    // The next user may not be scoped to this entity.
    clearStoredEntity()
     clearAppPreferences() //added this today
    // Tenant is kept so the login page stays pre-filled for this company.
  }

  const hasRole = (...roles) => {
    if (!roles.length) return true
    return roles.includes(user?.roleName)
  }

  return (
    <AuthContext.Provider value={{ user, tenant, loading, login, logout, hasRole, isLoggedIn: !!user }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)

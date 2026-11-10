import { createContext, useContext, useEffect, useState } from 'react'
import api from '../services/api'
import { clearStoredEntity } from './EntityContext'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('user')) } catch { return null }
  })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const token = localStorage.getItem('token')
    if (!token) { setLoading(false); return }
    api.get('/auth/me')
      .then(res => { setUser(res.data.data); localStorage.setItem('user', JSON.stringify(res.data.data)) })
      .catch(() => { localStorage.removeItem('token'); localStorage.removeItem('user'); setUser(null) })
      .finally(() => setLoading(false))
  }, [])

  const login = async (email, password) => {
    const res = await api.post('/auth/login', { email, password })
    const { token, user } = res.data.data
    localStorage.setItem('token', token)
    localStorage.setItem('user', JSON.stringify(user))
    setUser(user)
    return user
  }

  const logout = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    // The next user may not be scoped to this entity.
    clearStoredEntity()
    setUser(null)
  }

  const hasRole = (...roles) => {
    if (!roles.length) return true
    return roles.includes(user?.roleName)
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, hasRole, isLoggedIn: !!user }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => useContext(AuthContext)

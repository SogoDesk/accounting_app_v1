import { createContext, useContext, useEffect, useState } from 'react'
import platformApi, { PLATFORM_TOKEN_KEY } from '../services/platformApi'

// Session for the single platform operator account. Independent of the
// company (tenant) session in AuthContext — both can exist side by side.
const PlatformAuthContext = createContext(null)

export function PlatformAuthProvider({ children }) {
  const [admin, setAdmin] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!localStorage.getItem(PLATFORM_TOKEN_KEY)) {
      setLoading(false)
      return
    }
    platformApi.get('/auth/me')
      .then((res) => setAdmin(res.data.data?.admin || null))
      .catch(() => {
        localStorage.removeItem(PLATFORM_TOKEN_KEY)
        setAdmin(null)
      })
      .finally(() => setLoading(false))
  }, [])

  const login = async (email, password) => {
    const res = await platformApi.post('/auth/login', { email, password })
    const { token, admin: next } = res.data.data
    localStorage.setItem(PLATFORM_TOKEN_KEY, token)
    setAdmin(next)
    return next
  }

  const logout = () => {
    localStorage.removeItem(PLATFORM_TOKEN_KEY)
    setAdmin(null)
  }

  return (
    <PlatformAuthContext.Provider value={{ admin, loading, login, logout, isLoggedIn: !!admin }}>
      {children}
    </PlatformAuthContext.Provider>
  )
}

export const usePlatformAuth = () => useContext(PlatformAuthContext)

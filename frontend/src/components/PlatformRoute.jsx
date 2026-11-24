import { Navigate } from 'react-router-dom'
import { usePlatformAuth } from '../context/PlatformAuthContext'

const Loading = () => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: 'var(--text2)' }}>
    Loading…
  </div>
)

// Pages that need the platform operator to be signed in.
export function PlatformRoute({ children }) {
  const { isLoggedIn, loading } = usePlatformAuth()
  if (loading) return <Loading />
  if (!isLoggedIn) return <Navigate to="/platform/login" replace />
  return children
}

// The platform login page: skip it when already signed in.
export function PlatformPublicRoute({ children }) {
  const { isLoggedIn, loading } = usePlatformAuth()
  if (loading) return <Loading />
  if (isLoggedIn) return <Navigate to="/platform/dashboard" replace />
  return children
}

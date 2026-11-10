import { Navigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export default function ProtectedRoute({ children, allowedRoles = [] }) {
  const { isLoggedIn, loading, hasRole } = useAuth()

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
      <div style={{ textAlign: 'center', color: 'var(--text2)' }}>
        <div style={{ fontSize: 32, marginBottom: 8 }}>⚙️</div>
        <div>Loading...</div>
      </div>
    </div>
  )

  if (!isLoggedIn) return <Navigate to="/" replace />
  if (allowedRoles.length && !hasRole(...allowedRoles)) return <Navigate to="/dashboard" replace />

  return children
}

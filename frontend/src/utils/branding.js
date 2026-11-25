// The signed-in company's branding (name, logo, colours) from
// GET /api/settings/branding. Fetched once per session and shared; call
// refreshBranding() after the company settings change.
import { useEffect, useState } from 'react'
import api from '../services/api'

let cached = null
let inflight = null
const listeners = new Set()

const load = () => {
  if (!inflight) {
    inflight = api
      .get('/settings/branding')
      .then((res) => {
        cached = res.data?.data || null
        listeners.forEach((fn) => fn(cached))
        return cached
      })
      .catch(() => null)
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

export const refreshBranding = () => load()

// Forget the company's branding (on logout, so the next user loads their own).
export const clearBranding = () => {
  cached = null
  listeners.forEach((fn) => fn(null))
}

export const useBranding = () => {
  const [branding, setBranding] = useState(cached)

  useEffect(() => {
    listeners.add(setBranding)
    if (!cached && localStorage.getItem('token')) load()
    return () => listeners.delete(setBranding)
  }, [])

  return branding
}

import axios from 'axios'

// HTTP client for the platform (operator) console. Kept apart from the tenant
// client in ./api.js: different token, no X-Tenant header, and a 401 sends you
// to the platform login rather than the company login.
export const PLATFORM_TOKEN_KEY = 'platform_token'

const platformApi = axios.create({
  baseURL: `${import.meta.env.VITE_API_BASE_URL || '/api'}/platform`,
  timeout: 30000,
})

platformApi.interceptors.request.use((config) => {
  const token = localStorage.getItem(PLATFORM_TOKEN_KEY)
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

platformApi.interceptors.response.use(
  (res) => res,
  (err) => {
    const isLogin = err.config?.url?.includes('/auth/login')
    if (err.response?.status === 401 && !isLogin) {
      localStorage.removeItem(PLATFORM_TOKEN_KEY)
      if (window.location.pathname !== '/platform/login') {
        window.location.href = '/platform/login'
      }
    }
    return Promise.reject(err)
  }
)

export default platformApi

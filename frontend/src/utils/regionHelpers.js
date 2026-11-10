import { COUNTRY_BY_CURRENCY } from '../data/countries'

export function buildRegionCode(name = '') {
  const normalized = String(name || '').trim().replace(/[^A-Za-z0-9\s]/g, ' ')
  if (!normalized) return ''
  const words = normalized.split(/\s+/).filter(Boolean)
  if (!words.length) return ''
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase()
  const initials = words.map(word => word[0]).join('').toUpperCase()
  return initials.slice(0, 6)
}

export function currencySymbol(currencyCode = '') {
  const code = String(currencyCode || '').toUpperCase()
  if (!code) return ''
  return COUNTRY_BY_CURRENCY[code]?.symbol || code
}

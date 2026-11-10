const STORAGE_KEY = 'app_preferences'

export const APP_PREF_DEFAULTS = {
  date_format: 'MM/DD/YYYY',
  currency_format: 'SYMBOL',
  customer_label: 'Client',
  first_month_fiscal_year: 1,
  first_month_tax_year: 4,
  warn_duplicate_invoice_number: true,
}

const normalizeMonth = (value, fallback) => {
  const num = Number(value)
  if (Number.isInteger(num) && num >= 1 && num <= 12) return num
  return fallback
}

const normalizePrefs = (raw = {}) => ({
  date_format: ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'].includes(String(raw.date_format || '').toUpperCase())
    ? String(raw.date_format).toUpperCase()
    : APP_PREF_DEFAULTS.date_format,
  currency_format: ['SYMBOL', 'CODE'].includes(String(raw.currency_format || '').toUpperCase())
    ? String(raw.currency_format).toUpperCase()
    : APP_PREF_DEFAULTS.currency_format,
  customer_label: String(raw.customer_label || APP_PREF_DEFAULTS.customer_label).trim() || APP_PREF_DEFAULTS.customer_label,
  first_month_fiscal_year: normalizeMonth(raw.first_month_fiscal_year, APP_PREF_DEFAULTS.first_month_fiscal_year),
  first_month_tax_year: normalizeMonth(raw.first_month_tax_year, APP_PREF_DEFAULTS.first_month_tax_year),
  warn_duplicate_invoice_number:
    raw.warn_duplicate_invoice_number === undefined
      ? APP_PREF_DEFAULTS.warn_duplicate_invoice_number
      : raw.warn_duplicate_invoice_number === true || raw.warn_duplicate_invoice_number === 'true' || raw.warn_duplicate_invoice_number === 1 || raw.warn_duplicate_invoice_number === '1',
})

export const getAppPreferences = () => {
  if (typeof window === 'undefined') return APP_PREF_DEFAULTS
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}')
    return normalizePrefs(parsed)
  } catch {
    return APP_PREF_DEFAULTS
  }
}

export const setAppPreferences = (next = {}) => {
  if (typeof window === 'undefined') return APP_PREF_DEFAULTS
  const merged = normalizePrefs({ ...getAppPreferences(), ...next })
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
  return merged
}

export const setAppPreferencesFromRegion = (region) => {
  if (!region) return getAppPreferences()
  return setAppPreferences({
    date_format: region.date_format,
    currency_format: region.currency_format,
    customer_label: region.customer_label,
    first_month_fiscal_year: region.first_month_fiscal_year,
    first_month_tax_year: region.first_month_tax_year,
    warn_duplicate_invoice_number: region.warn_duplicate_invoice_number,
  })
}


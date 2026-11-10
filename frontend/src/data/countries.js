// Full ISO-3166 country dataset, sourced from the `world-countries` package
// (250 countries). We map each country to the compact shape the app already
// uses elsewhere: { name, iso2, currency, symbol }. This keeps every existing
// consumer (SearchableSelect country pickers, region->currency auto-mapping,
// COUNTRY_BY_NAME / COUNTRY_BY_CURRENCY lookups) working — just with the full
// list of countries instead of the previous hand-maintained 12.
import worldCountries from 'world-countries'

export const COUNTRIES = worldCountries
  .map((c) => {
    // A few countries list multiple currencies; take the first as the default.
    const code = Object.keys(c.currencies || {})[0] || ''
    const cur = code ? c.currencies[code] : null
    return {
      name: c.name?.common || '',
      iso2: c.cca2 || '',
      currency: code,
      symbol: (cur && cur.symbol) || '',
    }
  })
  .filter((c) => c.name && c.iso2)
  .sort((a, b) => a.name.localeCompare(b.name))

// Lookups keyed for O(1) access.
export const COUNTRY_BY_NAME = Object.fromEntries(
  COUNTRIES.map((c) => [c.name.toLowerCase(), c]),
)
export const COUNTRY_BY_CURRENCY = COUNTRIES.reduce((acc, c) => {
  // Keep the first country seen for a given currency (stable, alphabetical).
  if (c.currency && !acc[c.currency.toUpperCase()]) acc[c.currency.toUpperCase()] = c
  return acc
}, {})

// Ready-made option list for name-based country pickers (value === label === name).
// Used by the candidate / contact "Country" fields that store a country name.
export const COUNTRY_NAME_OPTIONS = COUNTRIES.map((c) => ({
  value: c.name,
  label: c.name,
  searchText: `${c.name} ${c.iso2} ${c.currency}`,
}))

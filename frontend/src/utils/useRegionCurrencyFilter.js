import { useMemo } from 'react'

/**
 * Cross-filter a Region filter and a Currency filter so they can't contradict.
 * A client/vendor/invoice's currency is its region's currency, so the two are
 * really one axis. This narrows each dropdown's options to what's compatible
 * with the other's current selection, and auto-clears a stale selection.
 *
 * Region filter values are compared as `String(region.id)`. If a page stores
 * region values with a prefix (e.g. Payments uses "id:5"), pass `regionKey`
 * to extract the bare id from the stored value.
 *
 * @returns {{ regionCurrencyById, visibleRegions, visibleCurrencies, selectRegion, selectCurrency }}
 */
export function useRegionCurrencyFilter({
  regions = [],
  currencies = [],
  regionFilter = '',
  currencyFilter = '',
  setRegionFilter,
  setCurrencyFilter,
  regionKey = (v) => String(v || ''),
  onAfterChange,
}) {
  const regionCurrencyById = useMemo(() => {
    const m = {}
    regions.forEach((r) => { if (r?.default_currency) m[String(r.id)] = String(r.default_currency).toUpperCase() })
    return m
  }, [regions])

  const activeCurrency = currencyFilter ? String(currencyFilter).toUpperCase() : ''
  const activeRegionId = regionFilter ? regionKey(regionFilter) : ''

  const visibleRegions = useMemo(() => {
    if (!activeCurrency) return regions
    return regions.filter((r) => regionCurrencyById[String(r.id)] === activeCurrency)
  }, [regions, activeCurrency, regionCurrencyById])

  const visibleCurrencies = useMemo(() => {
    const all = Array.from(new Set(currencies.filter(Boolean).map((c) => String(c).toUpperCase())))
    if (!activeRegionId) return all
    const ccy = regionCurrencyById[activeRegionId]
    return ccy ? all.filter((c) => c === ccy) : all
  }, [currencies, activeRegionId, regionCurrencyById])

  const selectRegion = (v) => {
    setRegionFilter(v)
    const rid = v ? regionKey(v) : ''
    if (rid && activeCurrency && regionCurrencyById[rid] && regionCurrencyById[rid] !== activeCurrency) {
      setCurrencyFilter('')
    }
    onAfterChange?.()
  }

  const selectCurrency = (v) => {
    setCurrencyFilter(v)
    const ccy = v ? String(v).toUpperCase() : ''
    if (ccy && activeRegionId && regionCurrencyById[activeRegionId] && regionCurrencyById[activeRegionId] !== ccy) {
      setRegionFilter('')
    }
    onAfterChange?.()
  }

  return { regionCurrencyById, visibleRegions, visibleCurrencies, selectRegion, selectCurrency }
}

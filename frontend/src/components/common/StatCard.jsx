import { StatCard as UIStatCard } from '../ui'

// Back-compat wrapper: preserves the legacy API { label, value, hint, tone }
// used across the app, and renders the new shared StatCard primitive.
// `hint` maps to `sub`; any non-default `tone` gives the card the accent look.
function StatCard({ label, value, hint, tone = 'default' }) {
  return (
    <UIStatCard
      label={label}
      value={value}
      sub={hint}
      accent={tone !== 'default'}
    />
  )
}

export default StatCard

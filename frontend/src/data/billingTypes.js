// Single source of truth for placement billing types across the app
// (Placement form + Invoice quick-add). Keep in sync with the backend
// VALID_BILLING_TYPE list and the placements_billing_type_check DB constraint.
//
// family drives which amount fields a smart form shows and how invoices price it:
//   RATE   -> per-unit bill_rate x expected units/month (HOURLY/DAILY/WEEKLY)
//   FLAT   -> a fixed monthly amount (MONTHLY)
//   ANNUAL -> annual amount stored in monthly_billing_amount; invoices bill 1/12
//   FEE    -> a one-off fee in one_time_fee_amount (FIXED / PERM_FEE)

export const BILLING_TYPES = [
  { value: 'HOURLY', label: 'Hourly', family: 'RATE', unit: 'hours' },
  { value: 'DAILY', label: 'Daily', family: 'RATE', unit: 'days' },
  { value: 'WEEKLY', label: 'Weekly', family: 'RATE', unit: 'weeks' },
  { value: 'MONTHLY', label: 'Monthly', family: 'FLAT' },
  { value: 'ANNUAL', label: 'Annual Salary', family: 'ANNUAL' },
  { value: 'FIXED', label: 'Fixed / Project Fee', family: 'FEE' },
  { value: 'PERM_FEE', label: 'Permanent Placement Fee', family: 'FEE' },
]

export const BILLING_TYPE_LABELS = Object.fromEntries(
  BILLING_TYPES.map((b) => [b.value, b.label]),
)
// Legacy value still shown sensibly if any old data slips through.
BILLING_TYPE_LABELS.ONE_TIME = 'Fixed / Project Fee'

const byValue = (t) =>
  BILLING_TYPES.find((b) => b.value === String(t || '').toUpperCase())

export const billingFamily = (t) => {
  const v = String(t || '').toUpperCase()
  if (v === 'ONE_TIME') return 'FEE' // legacy
  return byValue(v)?.family || 'RATE'
}

export const billingUnit = (t) => byValue(t)?.unit || 'units'

// ---- Placement economics (margin / profitability) --------------------------
const num = (v) => {
  const n = Number(v || 0)
  return Number.isNaN(n) ? 0 : n
}

// Projected MONTHLY revenue (bill side) for a placement, by billing family.
export const placementMonthlyRevenue = (p) => {
  if (!p) return 0
  const fam = billingFamily(p.billing_type)
  if (fam === 'RATE') return num(p.bill_rate) * num(p.expected_hours_per_month)
  if (fam === 'FLAT') return num(p.monthly_billing_amount)
  if (fam === 'ANNUAL') return num(p.monthly_billing_amount) / 12
  return num(p.one_time_fee_amount) // FEE: a one-off amount
}

// Projected MONTHLY cost (pay side) for a placement.
export const placementMonthlyCost = (p) => {
  if (!p) return 0
  const fam = billingFamily(p.billing_type)
  if (fam === 'RATE') return num(p.pay_rate) * num(p.expected_hours_per_month)
  if (fam === 'FLAT') return num(p.pay_rate)
  if (fam === 'ANNUAL') return num(p.pay_rate) / 12
  return 0 // FEE: fixed/permanent fees carry no ongoing pay cost by default
}

// Margin summary: dollars, %, per-unit spread, and whether it's a one-off fee.
export const placementMargin = (p) => {
  const revenue = Math.round(placementMonthlyRevenue(p) * 100) / 100
  const cost = Math.round(placementMonthlyCost(p) * 100) / 100
  const margin = Math.round((revenue - cost) * 100) / 100
  const pct = revenue > 0 ? Math.round((margin / revenue) * 1000) / 10 : 0
  const unitMargin = Math.round((num(p?.bill_rate) - num(p?.pay_rate)) * 100) / 100
  return { revenue, cost, margin, pct, unitMargin, isFee: billingFamily(p?.billing_type) === 'FEE' }
}

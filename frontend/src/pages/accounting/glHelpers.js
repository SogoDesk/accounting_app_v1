// Shared helpers for the Accounting (GL) pages.

export const TYPE_LABELS = {
  ASSET: 'Assets',
  LIABILITY: 'Liabilities',
  EQUITY: 'Equity',
  INCOME: 'Income',
  EXPENSE: 'Expenses',
};

export const TYPE_ORDER = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];

export const SOURCE_LABELS = {
  MANUAL: 'Manual',
  AR_INVOICE: 'Invoice',
  AR_PAYMENT: 'Customer payment',
  AP_BILL: 'Bill',
  AP_PAYMENT: 'Vendor payment',
  EXPENSE: 'Expense',
  FX_REVAL: 'FX revaluation',
  OPENING: 'Opening balance',
  INTERCOMPANY: 'Intercompany transfer',
  RECOGNITION: 'Recognition',
};

export function formatMoney(value, currency = 'USD') {
  const n = Number(value || 0);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

// Build YYYY-MM-DD from LOCAL date parts (not UTC serialization) so the
// default never lands on the wrong day in negative/positive-UTC timezones.
export function todayISO() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function yearStartISO() {
  return `${new Date().getFullYear()}-01-01`;
}

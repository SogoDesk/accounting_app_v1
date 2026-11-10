import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../../services/api'
import { Modal, Input, Select, StatCard, DataTable, PanelHeader, currencySymbol } from '../../components/ui'
import GlNotReady from './GlNotReady'
import { PageGuide } from './AccountingGuide'
import { TYPE_LABELS, TYPE_ORDER, formatMoney } from './glHelpers'
import './ChartOfAccountsPage.css'

const TYPE_OPTIONS = TYPE_ORDER // ASSET, LIABILITY, EQUITY, INCOME, EXPENSE
const normalBalanceFor = (type) => (type === 'ASSET' || type === 'EXPENSE' ? 'DEBIT' : 'CREDIT')
// TB `balance` is signed debit-minus-credit. Present each account in its normal
// orientation so a debit-normal account shows positive when it carries a debit.
const naturalBalance = (type, signed) => (normalBalanceFor(type) === 'DEBIT' ? signed : -signed)
const blankForm = { id: null, account_code: '', account_name: '', account_type: 'EXPENSE', is_active: true }

const BS_TYPES = ['ASSET', 'LIABILITY', 'EQUITY']
const PL_TYPES = ['INCOME', 'EXPENSE']

// KPI figures read as whole magnitudes (no cents) with the currency symbol
// pulled out as a muted prefix — the table below keeps full 2-dp precision.
const kpiNum = (v) => Math.round(Number(v || 0)).toLocaleString('en-US')

// Derive a tree indent level from the account code so a flat list reads as a
// hierarchy: round-thousand = class, round-hundred = parent, else a leaf.
const levelForCode = (code) => {
  const n = parseInt(String(code), 10)
  if (!Number.isFinite(n)) return 1
  if (n % 1000 === 0) return 0
  if (n % 100 === 0) return 1
  return 2
}

// small stroked icons ------------------------------------------------
const I = (p) => ({ width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', ...p })
const BackIcon = () => (<svg {...I({ width: 18, height: 18 })}><path d="M15 18l-6-6 6-6" /></svg>)
const ReportIcon = () => (<svg {...I()}><path d="M4 4h16v16H4z" /><path d="M8 15v-4" /><path d="M12 15V9" /><path d="M16 15v-6" /></svg>)
const PlusIcon = () => (<svg {...I()}><path d="M12 5v14" /><path d="M5 12h14" /></svg>)
const SearchIcon = () => (<svg {...I({ width: 15, height: 15 })}><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>)
const EditIcon = () => (<svg {...I({ width: 15, height: 15 })}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>)
const AssetsIcon = () => (<svg {...I()}><path d="M3 21h18" /><path d="M5 21V9l7-5 7 5v12" /><path d="M9 21v-6h6v6" /></svg>)
const LiabIcon = () => (<svg {...I()}><rect x="3" y="7" width="18" height="12" rx="2" /><path d="M3 11h18" /></svg>)
const EquityIcon = () => (<svg {...I()}><circle cx="12" cy="12" r="8" /><path d="M12 8v8" /><path d="M9 11h6" /></svg>)
const IncomeIcon = () => (<svg {...I()}><path d="M4 17l6-6 4 4 6-8" /><path d="M20 7h-4" /><path d="M20 7v4" /></svg>)
const ExpenseIcon = () => (<svg {...I()}><path d="M4 7l6 6 4-4 6 8" /><path d="M20 17h-4" /><path d="M20 17v-4" /></svg>)

const CLASS_META = {
  ASSET: { icon: <AssetsIcon />, accent: true },
  LIABILITY: { icon: <LiabIcon /> },
  EQUITY: { icon: <EquityIcon /> },
  INCOME: { icon: <IncomeIcon /> },
  EXPENSE: { icon: <ExpenseIcon /> },
}

export default function ChartOfAccountsPage() {
  const navigate = useNavigate()
  const [accounts, setAccounts] = useState([])
  const [balancesByCode, setBalancesByCode] = useState({}) // account_code -> signed balance (debit - credit)
  const [currency, setCurrency] = useState('USD')
  const [glReady, setGlReady] = useState(true)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  // visual filters (no new endpoints — filter the fetched list client-side)
  const [tab, setTab] = useState('all') // all | bs | pl
  const [classFilter, setClassFilter] = useState('')
  const [search, setSearch] = useState('')

  const [form, setForm] = useState(null) // null = closed; object = create/edit
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  useEffect(() => {
    let active = true
    setLoading(true)
    // Structure comes from chart-of-accounts; real per-account balances come from
    // the trial balance (as-of today). Balances are best-effort: if that call
    // fails the tree still renders with zeroed balances.
    Promise.all([
      api.get('/gl/chart-of-accounts'),
      api.get('/gl/reports/trial-balance').catch(() => null),
    ])
      .then(([coaRes, tbRes]) => {
        if (!active) return
        setGlReady(coaRes.data.glReady !== false)
        setMessage(coaRes.data.message || '')
        setAccounts(coaRes.data.data || [])
        const tb = tbRes?.data?.data
        if (tb) {
          const map = {}
          ;(tb.rows || []).forEach((r) => { map[r.account_code] = Number(r.balance || 0) })
          setBalancesByCode(map)
          setCurrency(tb.currency || 'USD')
        }
      })
      .catch((err) => active && setError(err.response?.data?.message || err.message))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [reloadKey])

  const openCreate = () => { setFormError(''); setForm({ ...blankForm }) }
  const openEdit = (a) => { setFormError(''); setForm({ id: a.id, account_code: a.account_code, account_name: a.account_name, account_type: a.account_type, is_active: a.is_active }) }
  const closeForm = () => { setForm(null); setSaving(false); setFormError('') }

  const save = async () => {
    setFormError('')
    if (!form.account_code.trim()) return setFormError('Account code is required.')
    if (!form.account_name.trim()) return setFormError('Account name is required.')
    setSaving(true)
    try {
      if (form.id) {
        await api.put(`/gl/chart-of-accounts/${form.id}`, {
          account_code: form.account_code.trim(),
          account_name: form.account_name.trim(),
          account_type: form.account_type,
          is_active: form.is_active,
        })
      } else {
        await api.post('/gl/chart-of-accounts', {
          account_code: form.account_code.trim(),
          account_name: form.account_name.trim(),
          account_type: form.account_type,
        })
      }
      setReloadKey((k) => k + 1)
      closeForm()
    } catch (e) {
      setFormError(e.response?.data?.message || e.message || 'Could not save the account.')
      setSaving(false)
    }
  }

  // per-class totals (real balances) for the KPI row — sum each account's
  // natural balance so credit-normal classes read as positive magnitudes.
  const totalsByType = useMemo(() => {
    const map = {}
    TYPE_ORDER.forEach((t) => { map[t] = 0 })
    accounts.forEach((a) => {
      const signed = balancesByCode[a.account_code]
      if (signed == null) return
      map[a.account_type] = (map[a.account_type] || 0) + naturalBalance(a.account_type, signed)
    })
    return map
  }, [accounts, balancesByCode])

  // rows for the current tab + filters, sorted by code so classes interleave
  const treeRows = useMemo(() => {
    const allowedTypes = tab === 'bs' ? BS_TYPES : tab === 'pl' ? PL_TYPES : TYPE_ORDER
    const needle = search.trim().toLowerCase()
    return accounts
      .filter((a) => showInactive || a.is_active)
      .filter((a) => allowedTypes.includes(a.account_type))
      .filter((a) => !classFilter || a.account_type === classFilter)
      .filter((a) => !needle || `${a.account_code} ${a.account_name}`.toLowerCase().includes(needle))
      .slice()
      .sort((x, y) => String(x.account_code).localeCompare(String(y.account_code), undefined, { numeric: true }))
  }, [accounts, tab, classFilter, search, showInactive])

  // active-account counts per class for the KPI sub-line
  const countsByType = useMemo(() => {
    const map = {}
    TYPE_ORDER.forEach((t) => { map[t] = 0 })
    accounts.forEach((a) => { if (a.is_active) map[a.account_type] = (map[a.account_type] || 0) + 1 })
    return map
  }, [accounts])

  const tabCounts = useMemo(() => {
    const active = accounts.filter((a) => a.is_active)
    return {
      all: active.length,
      bs: active.filter((a) => BS_TYPES.includes(a.account_type)).length,
      pl: active.filter((a) => PL_TYPES.includes(a.account_type)).length,
    }
  }, [accounts])

  const columns = [
    { key: 'account_code', header: 'Code', mono: true, width: 110 },
    {
      key: 'account_name',
      header: 'Account',
      render: (a) => {
        const lvl = levelForCode(a.account_code)
        const cls = lvl === 0 ? 'is-class' : lvl === 1 ? 'is-parent' : ''
        return (
          <span className={`coa-acct ${cls}`} style={{ paddingLeft: lvl * 18 }}>
            <span className="coa-acct-name">{a.account_name}</span>
            {a.is_control ? <span className="coa-tag">control</span> : null}
            {!a.is_active ? <span className="coa-tag">inactive</span> : null}
          </span>
        )
      },
    },
    {
      key: 'balance',
      header: 'Balance',
      align: 'right',
      width: 160,
      render: (a) => {
        const signed = balancesByCode[a.account_code]
        if (signed == null) return <span className="coa-normal">—</span>
        return <span className="coa-balance">{formatMoney(naturalBalance(a.account_type, signed), currency)}</span>
      },
    },
    {
      key: '_edit',
      header: '',
      align: 'right',
      width: 60,
      render: (a) => (a.is_control ? (
        <span className="coa-normal">—</span>
      ) : (
        <button
          className="coa-editbtn"
          title="Edit account"
          onClick={(e) => { e.stopPropagation(); openEdit(a) }}
        >
          <EditIcon />
        </button>
      )),
    },
  ]

  return (
    <div className="dashboard-page coa-page">
      <div className="coa-head">
        <button className="coa-back" onClick={() => navigate('/accounting')} title="Back to accounting" aria-label="Back">
          <BackIcon />
        </button>
        <div className="coa-titles">
          <h1 className="coa-title">Chart of accounts</h1>
          <p className="coa-sub">Five account classes, per-region sub-ledgers. Journal entries are hash-chained and immutable once posted.</p>
        </div>
        <div className="coa-actions">
          <button className="coa-btn" onClick={() => navigate('/accounting/reports')}><ReportIcon /> Trial balance</button>
          {glReady && (
            <button className="coa-btn coa-btn-primary" onClick={openCreate}><PlusIcon /> New account</button>
          )}
        </div>
      </div>

      <PageGuide
        id="chart-of-accounts"
        title="What is the Chart of Accounts?"
        lead={'Think of it as the labelled buckets your money is sorted into. Every transaction lands in one of these accounts, and that is what lets the reports group things into Revenue, Expenses, what you own, and what you owe.'}
        points={[
          { term: 'Five families', text: 'Assets (what you own), Liabilities (what you owe), Equity (the owner’s stake), Income (money earned), Expenses (money spent).' },
          { term: 'Account code', text: 'A number for sorting — typically 1000s = assets, 2000s = liabilities, 4000s = income, 5000s+ = expenses.' },
          { term: 'Click any account', text: 'Open its register to see every transaction that hit it, with a running balance.' },
        ]}
      />

      {loading ? (
        <div className="coa-state">Loading…</div>
      ) : error ? (
        <div className="coa-state">{error}</div>
      ) : !glReady ? (
        <GlNotReady message={message} />
      ) : (
        <>
          <div className="coa-kpis">
            {TYPE_ORDER.map((t) => (
              <StatCard
                key={t}
                label={TYPE_LABELS[t]}
                prefix={currencySymbol(currency)}
                value={kpiNum(totalsByType[t])}
                sub={`${countsByType[t]} account${countsByType[t] === 1 ? '' : 's'}${PL_TYPES.includes(t) ? ' · YTD' : ''}`}
                icon={CLASS_META[t].icon}
                accent={CLASS_META[t].accent}
              />
            ))}
          </div>

          <div className="coa-filters">
            <span className={`coa-fpill${classFilter ? ' is-active' : ''}`}>
              <select className="coa-fselect" value={classFilter} onChange={(e) => setClassFilter(e.target.value)} aria-label="Class">
                <option value="">All classes</option>
                {TYPE_ORDER.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
              </select>
            </span>
            <label className="coa-search">
              <SearchIcon />
              <input
                placeholder="Account code or name"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <span className={`coa-fpill${showInactive ? ' is-active' : ''}`}>
              <select className="coa-fselect" value={showInactive ? 'all' : 'active'} onChange={(e) => setShowInactive(e.target.value === 'all')} aria-label="Status">
                <option value="active">Active only</option>
                <option value="all">Include inactive</option>
              </select>
            </span>
          </div>

          <div className="coa-panel">
            <div className="coa-panel-head">
              <PanelHeader
                title="Chart of accounts"
                tabs={[
                  { key: 'all', label: 'All', count: tabCounts.all },
                  { key: 'bs', label: 'B/S', count: tabCounts.bs },
                  { key: 'pl', label: 'P&L', count: tabCounts.pl },
                ]}
                activeTab={tab}
                onTab={setTab}
              />
            </div>
            <DataTable
              columns={columns}
              rows={treeRows}
              getRowId={(a) => a.id}
              onRowSelect={(a) => navigate(`/accounting/accounts/${a.id}`)}
              empty="No accounts match these filters."
            />
          </div>
        </>
      )}

      <Modal
        open={!!form}
        onClose={closeForm}
        title={form?.id ? 'Edit account' : 'New account'}
        maxWidth={460}
        footer={
          <>
            <button className="btn btn-secondary" onClick={closeForm} disabled={saving}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : form?.id ? 'Save changes' : 'Create account'}
            </button>
          </>
        }
      >
        {form && (
          <>
            <Input
              label="Account code"
              required
              placeholder="e.g. 6200"
              value={form.account_code}
              onChange={(e) => setForm((f) => ({ ...f, account_code: e.target.value }))}
            />
            <Input
              label="Account name"
              required
              placeholder="e.g. Software Subscriptions"
              value={form.account_name}
              onChange={(e) => setForm((f) => ({ ...f, account_name: e.target.value }))}
            />
            <Select
              label="Type"
              required
              hint={`Normal balance: ${normalBalanceFor(form.account_type)} (set automatically)`}
              value={form.account_type}
              onChange={(e) => setForm((f) => ({ ...f, account_type: e.target.value }))}
            >
              {TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>{TYPE_LABELS[t]}</option>
              ))}
            </Select>
            {form.id && (
              <label className="text-sm" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 4, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
                />
                Active (uncheck to hide this account from new entries)
              </label>
            )}
            <p className="text-muted text-sm" style={{ marginTop: 10, marginBottom: 0 }}>
              Once an account has transactions, its code and type lock (you can still rename or deactivate).
            </p>
            {formError && <div className="error-box" style={{ marginTop: 12 }}>{formError}</div>}
          </>
        )}
      </Modal>
    </div>
  )
}

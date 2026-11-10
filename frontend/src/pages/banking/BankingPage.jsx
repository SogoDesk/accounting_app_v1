import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import api from '../../services/api'
import { formatMoney, todayISO } from '../accounting/glHelpers'
import { Card, DataTable, StatusChip, PanelHeader, Modal } from '../../components/ui'
import BankTxnViewModal from '../../components/BankTxnViewModal'
import './banking.css'

const STATUS_TABS = [
  { key: '', label: 'All' },
  { key: 'MATCHED', label: 'Matched' },
  { key: 'UNMATCHED', label: 'Unmatched' },
]

/* ---- inline icons (stroked 24x24, currentColor) -------------------- */
const Ico = (p) => ({ width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', ...p })
const BackIcon = () => <svg {...Ico()}><path d="M15 18l-6-6 6-6" /></svg>
const BankIcon = () => <svg {...Ico({ width: 15, height: 15 })}><path d="M3 21h18M4 10h16M5 10V7l7-4 7 4v3M6 10v11M18 10v11M10 10v11M14 10v11" /></svg>
const FilterIcon = () => <svg {...Ico()}><path d="M4 5h16M7 12h10M10 19h4" /></svg>
const PlusIcon = () => <svg {...Ico()}><path d="M12 5v14M5 12h14" /></svg>
const DownloadIcon = () => <svg {...Ico({ width: 15, height: 15 })}><path d="M12 3v12M7 10l5 5 5-5M5 21h14" /></svg>
const BoltIcon = () => <svg {...Ico({ width: 15, height: 15 })}><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" /></svg>
const ClockIcon = () => <svg {...Ico({ width: 15, height: 15 })}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
const CheckIcon = () => <svg {...Ico({ width: 17, height: 17 })}><circle cx="12" cy="12" r="9" /><path d="M8.5 12.5l2.5 2.5 4.5-5" /></svg>
const WarnIcon = () => <svg {...Ico({ width: 17, height: 17 })}><circle cx="12" cy="12" r="9" /><path d="M12 8v4.5M12 16h.01" /></svg>

const dateShort = (d) => {
  const s = String(d).slice(0, 10)
  const dt = new Date(s + 'T00:00:00')
  if (isNaN(dt)) return s
  return dt.toLocaleDateString('en-US', { day: '2-digit', month: 'short' })
}
const monthLabel = (d) =>
  new Date((d ? String(d).slice(0, 10) : todayISO()) + 'T00:00:00')
    .toLocaleDateString('en-US', { month: 'long' })

export default function BankingPage() {
  const navigate = useNavigate()
  const [accounts, setAccounts] = useState([])
  const [regions, setRegions] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [ready, setReady] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showNew, setShowNew] = useState(false)

  const selected = accounts.find((a) => String(a.id) === String(selectedId)) || null

  const loadAccounts = useCallback(async () => {
    try {
      const res = await api.get('/bank/accounts')
      setReady(res.data.ready !== false)
      const list = res.data.data || []
      setAccounts(list)
      setSelectedId((cur) => cur || (list[0] ? String(list[0].id) : ''))
    } catch (e) { setError(e.response?.data?.message || e.message) }
  }, [])

  useEffect(() => {
    loadAccounts()
    api.get('/regions').then((r) => setRegions(r.data.data || [])).catch(() => {})
  }, [loadAccounts])

  const flash = (msg) => { setNotice(msg); setError(''); setTimeout(() => setNotice(''), 4000) }

  const header = (
    <div className="bk-head">
      <button className="bk-back" title="Back" onClick={() => navigate('/accounting')}><BackIcon /></button>
      <div className="bk-head-titles">
        <h1 className="bk-title">Banking &amp; reconciliation</h1>
        <p className="bk-sub">Statement lines matched against the ledger. Unmatched items block the period close.</p>
      </div>
    </div>
  )

  return (
    <div className="dashboard-page bk-page">
      {error && <div className="bk-note err">{error}</div>}
      {notice && <div className="bk-note ok">{notice}</div>}

      {!ready ? (
        <>
          {header}
          <Card><span className="text-muted">Banking is not enabled. Apply migration 010 and restart the backend.</span></Card>
        </>
      ) : accounts.length === 0 ? (
        <>
          <div className="bk-head">
            <button className="bk-back" onClick={() => navigate('/accounting')}><BackIcon /></button>
            <div className="bk-head-titles">
              <h1 className="bk-title">Banking &amp; reconciliation</h1>
              <p className="bk-sub">Statement lines matched against the ledger. Unmatched items block the period close.</p>
            </div>
            <div className="bk-head-actions">
              <button className="bk-btn bk-btn-primary" onClick={() => setShowNew(true)}><PlusIcon /> New bank account</button>
            </div>
          </div>
          <Card><span className="text-muted">No bank accounts yet. Create one to start importing statements.</span></Card>
          <Modal open={showNew} onClose={() => setShowNew(false)} title="New bank account" maxWidth={620}>
            <NewAccountForm regions={regions}
              onCreated={() => { setShowNew(false); loadAccounts(); flash('Bank account created.') }}
              onError={setError} />
          </Modal>
        </>
      ) : selected ? (
        <BankingWorkspace
          accounts={accounts}
          selected={selected}
          selectedId={selectedId}
          onSelectAccount={setSelectedId}
          regions={regions}
          onChange={loadAccounts}
          flash={flash}
          onError={setError}
        />
      ) : null}
    </div>
  )
}

function BankingWorkspace({ accounts, selected, selectedId, onSelectAccount, regions, onChange, flash, onError }) {
  const navigate = useNavigate()
  const account = selected
  const [summary, setSummary] = useState(null)
  const [txns, setTxns] = useState([])
  const [allTxns, setAllTxns] = useState([])
  const [viewTxn, setViewTxn] = useState(null)
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [selTxn, setSelTxn] = useState(null)
  const [suggestions, setSuggestions] = useState(null)
  const [showImport, setShowImport] = useState(false)
  const [showRecon, setShowRecon] = useState(false)
  const [showNew, setShowNew] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const [s, t, all] = await Promise.all([
        api.get(`/bank/accounts/${account.id}/summary`),
        api.get(`/bank/accounts/${account.id}/transactions`, { params: status ? { status } : {} }),
        api.get(`/bank/accounts/${account.id}/transactions`),
      ])
      setSummary(s.data.data)
      setTxns(t.data.data || [])
      setAllTxns(all.data.data || [])
    } catch (e) { onError(e.response?.data?.message || e.message) }
    finally { setLoading(false) }
  }, [account.id, status, onError])

  useEffect(() => { reload() }, [reload])
  // reset the right-rail selection when the account changes
  useEffect(() => { setSelTxn(null); setSuggestions(null) }, [account.id])

  const selectTxn = (t) => {
    setSelTxn(t)
    if (t.status === 'UNMATCHED') {
      setSuggestions(null)
      api.get(`/bank/transactions/${t.id}/suggestions`)
        .then((r) => {
          const list = (r.data.data?.suggestions || []).slice().sort((a, b) => Number(b.score) - Number(a.score))
          setSuggestions(list)
        })
        .catch((e) => { onError(e.response?.data?.message || e.message); setSuggestions([]) })
    } else {
      setSuggestions([])
    }
  }

  const act = async (fn) => { try { await fn(); await reload(); onChange() } catch (e) { onError(e.response?.data?.message || e.message) } }
  const doMatch = (entryId) => act(async () => { await api.post(`/bank/transactions/${selTxn.id}/match`, { entryId }); setSelTxn(null); setSuggestions(null) })
  const book = () => act(async () => { await api.post(`/bank/transactions/${selTxn.id}/book`, {}); setSelTxn(null); setSuggestions(null) })
  const unmatch = () => act(async () => { await api.post(`/bank/transactions/${selTxn.id}/unmatch`); setSelTxn(null); setSuggestions(null) })

  const autoMatch = async () => {
    setBusy('automatch')
    try { const res = await api.post(`/bank/accounts/${account.id}/auto-match`, {}); flash(res.data.message); await reload(); onChange() }
    catch (e) { onError(e.response?.data?.message || e.message) } finally { setBusy('') }
  }

  const cur = account.currency
  const total = summary ? summary.matched + summary.unmatched + summary.reconciled : 0
  const matchedLines = summary ? summary.matched + summary.reconciled : 0
  const pct = total ? Math.round((matchedLines / total) * 100) : 0
  const diff = summary && summary.book_balance != null ? summary.bank_balance - summary.book_balance : null
  const outstandingDeposits = summary ? Number(summary.outstanding_deposits || 0) : 0
  const unclearedPayments = summary ? Number(summary.uncleared_payments || 0) : 0
  const reconMonth = monthLabel(allTxns[0]?.txn_date)
  const importedNote = `${account.bank_name || account.name}${account.account_number_masked ? ` ····${String(account.account_number_masked).slice(-4)}` : ''} · Imported ${allTxns[0] ? dateShort(allTxns[0].txn_date) : todayISO().slice(0, 10)}`

  const columns = [
    { key: 'txn_date', header: 'Date', mono: true, width: 78, render: (r) => dateShort(r.txn_date) },
    { key: 'description', header: 'Description', primary: true, render: (r) => <button type="button" className="cd-linkbtn" title="View transaction" onClick={(e) => { e.stopPropagation(); setViewTxn(r) }}>{r.description}</button> },
    {
      key: 'amount', header: 'Amount', align: 'right', mono: true, width: 130,
      render: (r) => (
        <span className={Number(r.amount) < 0 ? 'bk-amt-debit' : 'bk-amt-credit'}>
          {Number(r.amount) >= 0 ? '+' : ''}{formatMoney(r.amount, r.currency || cur)}
        </span>
      ),
    },
    {
      key: '_icon', header: '', align: 'right', width: 44,
      render: (r) => (r.status === 'UNMATCHED'
        ? <span className="bk-rowicon bk-rowicon-warn"><WarnIcon /></span>
        : <span className="bk-rowicon bk-rowicon-ok"><CheckIcon /></span>),
    },
  ]

  return (
    <>
      <div className="bk-head">
        <button className="bk-back" title="Back" onClick={() => navigate('/accounting')}><BackIcon /></button>
        <div className="bk-head-titles">
          <h1 className="bk-title">Banking &amp; reconciliation</h1>
          <p className="bk-sub">Statement lines matched against the ledger. Unmatched items block the period close.</p>
        </div>
        <div className="bk-head-actions">
          <button className="bk-btn bk-btn-secondary" onClick={() => setShowImport(true)}><DownloadIcon /> Import statement</button>
          <button className={`bk-iconbtn${status === 'UNMATCHED' ? ' is-active' : ''}`} title="Show unmatched only" onClick={() => setStatus((s) => (s === 'UNMATCHED' ? '' : 'UNMATCHED'))}><FilterIcon /></button>
          <button className="bk-btn bk-btn-primary" onClick={() => setShowRecon(true)}><PlusIcon /> Reconcile</button>
        </div>
      </div>

      {/* Account cards + reconciliation card */}
      <div className="bk-accounts">
        {accounts.map((a) => {
          const isSel = String(a.id) === String(selectedId)
          const bal = isSel && summary ? summary.bank_balance : Number(a.opening_balance || 0)
          const sub = `${a.bank_name || 'Bank'}${a.account_number_masked ? ` ····${String(a.account_number_masked).slice(-4)}` : ''} · ${a.entity_name || ''}`
          return (
            <Card key={a.id} selected={isSel} hover className={`bk-acct${isSel ? ' is-sel' : ''}`} onClick={() => onSelectAccount(String(a.id))}>
              <div className="bk-acct-top">
                <span className="bk-acct-label">{a.name} — {a.currency}</span>
                <span className="bk-acct-icon"><BankIcon /></span>
              </div>
              <div className="bk-acct-bal">{formatMoney(bal, a.currency)}</div>
              <div className="bk-acct-sub">{sub}</div>
            </Card>
          )
        })}

        <Card accent className="bk-acct">
          <div className="bk-acct-top">
            <span className="bk-acct-label">Reconciliation — {reconMonth}</span>
            <span className="bk-acct-icon" style={{ color: 'var(--warn-text)' }}><ClockIcon /></span>
          </div>
          <div className="bk-recon-fig"><span className="n">{matchedLines}</span><span className="rest">of {total} lines matched</span></div>
          <div className="bk-progress"><div className="bk-progress-fill" style={{ width: `${pct}%` }} /></div>
          <div className="bk-recon-chips">
            <StatusChip tone="warn">{summary ? summary.unmatched : 0} UNMATCHED</StatusChip>
            {diff != null && Math.abs(diff) > 0.005 && <StatusChip tone="danger">DIFF {formatMoney(diff, cur)}</StatusChip>}
          </div>
        </Card>

        <Card className="bk-acct bk-acct-add" onClick={() => setShowNew(true)}>
          <PlusIcon /> Add account
        </Card>
      </div>

      {/* Two-column content */}
      <div className="bk-grid">
        {/* Left: statement lines */}
        <div className="bk-col">
          <div className="bk-section-head">
            <span className="bk-section-title">Statement lines</span>
            <span className="bk-section-meta">{importedNote}</span>
          </div>
          <Card>
            <PanelHeader
              title="Statement lines"
              tabs={STATUS_TABS.map((t) => ({
                ...t,
                count: !summary ? undefined
                  : t.key === '' ? total
                  : t.key === 'MATCHED' ? matchedLines
                  : summary.unmatched,
              }))}
              activeTab={status}
              onTab={(k) => setStatus(k)}
              actions={
                <button className="bk-iconbtn sm" title="Auto-match" onClick={autoMatch} disabled={busy === 'automatch'}><BoltIcon /></button>
              }
            />
            <DataTable
              columns={columns}
              rows={txns}
              paginate
              pageLabel="transactions"
              getRowId={(r) => r.id}
              selectedId={selTxn?.id}
              onRowSelect={selectTxn}
              loading={loading}
              subLine={(r) => (r.reference ? `ref ${r.reference}` : null)}
              empty="No transactions. Import a statement to begin."
            />
            <BankTxnViewModal txn={viewTxn} account={account} onClose={() => setViewTxn(null)} />
          </Card>
        </div>

        {/* Right: suggested ledger match + summary */}
        <div className="bk-col">
          <div className="bk-section-head">
            <span className="bk-section-title">Suggested ledger match</span>
            {selTxn && selTxn.status === 'UNMATCHED' && suggestions
              ? <span className="bk-section-meta bk-section-meta-accent">{suggestions.length} CANDIDATES</span>
              : null}
          </div>
          <Card>
          {!selTxn ? (
            <div className="bk-empty-note">Select a statement line to see suggested ledger matches.</div>
          ) : (
            <>
              <div className="bk-match-line">
                <div className="bk-match-line-l">
                  <span className="bk-match-amt">{Number(selTxn.amount) >= 0 ? '+ ' : '- '}{formatMoney(Math.abs(Number(selTxn.amount)), selTxn.currency || cur)}</span>
                  <span className="bk-match-meta">{dateShort(selTxn.txn_date)} · {selTxn.description}</span>
                </div>
                {selTxn.status === 'UNMATCHED'
                  ? <StatusChip tone="warn">NEEDS REVIEW</StatusChip>
                  : <StatusChip tone="success">{selTxn.status}</StatusChip>}
              </div>

              {selTxn.status === 'UNMATCHED' ? (
                <>
                  {suggestions == null ? (
                    <div className="bk-empty-note">Finding candidate ledger entries…</div>
                  ) : suggestions.length === 0 ? (
                    <div className="bk-empty-note">No candidate ledger entries within the match window. Create a journal entry instead.</div>
                  ) : (
                    <div className="bk-cands">
                      {suggestions.map((s, i) => {
                        const score = Math.round(Number(s.score))
                        return (
                          <div key={s.entry_id} className={`bk-cand${i === 0 ? ' is-top' : ''}`}>
                            <div className="bk-cand-main">
                              <span className="bk-cand-no">{s.entry_no}</span>
                              <span className="bk-cand-desc">{s.description}</span>
                            </div>
                            <span className="bk-cand-amt">{formatMoney(selTxn.amount, selTxn.currency || cur)}</span>
                            <span className="bk-cand-pct">{score}% match</span>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  <div className="bk-match-actions">
                    <button className="bk-btn bk-btn-primary" disabled={!suggestions || suggestions.length === 0}
                      onClick={() => suggestions?.[0] && doMatch(suggestions[0].entry_id)}>
                      {suggestions?.[0] ? `Match to ${suggestions[0].entry_no}` : 'Match to …'}
                    </button>
                    <button className="bk-btn bk-btn-secondary" onClick={book}>Create journal entry</button>
                  </div>
                </>
              ) : (
                <div className="bk-match-actions">
                  <div className="bk-empty-note" style={{ flex: 1, padding: '12px 0' }}>
                    Matched to <strong style={{ fontFamily: 'var(--font-mono)' }}>{selTxn.matched_entry_no || '—'}</strong>.
                  </div>
                  <button className="bk-btn bk-btn-secondary" onClick={unmatch}>Unmatch</button>
                </div>
              )}
            </>
          )}

          {/* Reconciliation summary */}
          {summary && (
            <>
              <h4 className="bk-summary-title">Reconciliation summary</h4>
              <div className="bk-summary-row"><span className="bk-summary-label">Statement closing balance</span><span className="bk-summary-val">{formatMoney(summary.bank_balance, cur)}</span></div>
              <div className="bk-summary-row"><span className="bk-summary-label">Ledger balance</span><span className="bk-summary-val">{summary.book_balance == null ? '—' : formatMoney(summary.book_balance, cur)}</span></div>
              <div className="bk-summary-row"><span className="bk-summary-label">Unreconciled difference</span><span className="bk-summary-val is-diff">{diff == null ? '—' : formatMoney(diff, cur)}</span></div>
              <div className="bk-summary-row"><span className="bk-summary-label">Outstanding deposits</span><span className="bk-summary-val">{formatMoney(outstandingDeposits, cur)}</span></div>
              <div className="bk-summary-row"><span className="bk-summary-label">Uncleared payments</span><span className="bk-summary-val">{formatMoney(unclearedPayments, cur)}</span></div>
            </>
          )}
          </Card>
        </div>
      </div>

      {/* Modals ------------------------------------------------------ */}
      <Modal open={showImport} onClose={() => setShowImport(false)} title="Import statement" maxWidth={560}>
        <ImportForm account={account} onDone={() => { setShowImport(false); reload(); onChange() }} flash={flash} onError={onError} />
      </Modal>
      <Modal open={showRecon} onClose={() => setShowRecon(false)} title="Reconcile" maxWidth={560}>
        <ReconcileForm account={account} onDone={() => { setShowRecon(false); reload(); onChange() }} flash={flash} onError={onError} />
      </Modal>
      <Modal open={showNew} onClose={() => setShowNew(false)} title="New bank account" maxWidth={640}>
        <NewAccountForm regions={regions} onCreated={() => { setShowNew(false); onChange(); flash('Bank account created.') }} onError={onError} />
      </Modal>
    </>
  )
}

function ImportForm({ account, onDone, flash, onError }) {
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    if (!file) { onError('Choose a statement file (CSV or OFX).'); return }
    setBusy(true)
    try {
      const fd = new FormData(); fd.append('file', file)
      const res = await api.post(`/bank/accounts/${account.id}/import`, fd)
      flash(res.data.message || 'Imported.'); onDone()
    } catch (e2) { onError(e2.response?.data?.message || e2.message) }
    finally { setBusy(false) }
  }
  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p className="text-muted text-sm" style={{ margin: 0 }}>Upload a CSV or OFX/QFX file. Duplicate lines are skipped automatically.</p>
      <input type="file" accept=".csv,.ofx,.qfx,text/csv" onChange={(e) => setFile(e.target.files[0])} />
      <div><button className="bk-btn bk-btn-primary" type="submit" disabled={busy}>{busy ? 'Importing…' : 'Import statement'}</button></div>
    </form>
  )
}

function ReconcileForm({ account, onDone, flash, onError }) {
  const [stmtDate, setStmtDate] = useState(todayISO())
  const [closing, setClosing] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (e) => {
    e.preventDefault()
    if (closing === '') { onError('Enter the statement closing balance.'); return }
    setBusy(true)
    try {
      const rec = await api.post(`/bank/accounts/${account.id}/reconciliations`, {
        statement_date: stmtDate, statement_opening_balance: account.opening_balance, statement_closing_balance: Number(closing),
      })
      const t = await api.get(`/bank/accounts/${account.id}/transactions`)
      const txnIds = (t.data.data || []).filter((x) => x.status !== 'RECONCILED').map((x) => x.id)
      const res = await api.post(`/bank/reconciliations/${rec.data.data.id}/complete`, { txnIds, allowDifference: true })
      const d = res.data.data
      flash(d.balanced ? 'Reconciled — balanced ✓' : `Reconciled with difference ${formatMoney(d.difference, account.currency)}`)
      onDone()
    } catch (e2) { onError(e2.response?.data?.message || e2.message) }
    finally { setBusy(false) }
  }
  return (
    <form onSubmit={run} className="bk-form">
      <label className="bk-field">Statement date
        <input type="date" className="bk-input" value={stmtDate} onChange={(e) => setStmtDate(e.target.value)} />
      </label>
      <label className="bk-field">Closing balance
        <input type="number" step="0.01" className="bk-input" style={{ width: 150 }} value={closing} onChange={(e) => setClosing(e.target.value)} />
      </label>
      <button className="bk-btn bk-btn-primary" type="submit" disabled={busy}>{busy ? 'Reconciling…' : 'Reconcile lines'}</button>
    </form>
  )
}

function NewAccountForm({ regions, onCreated, onError }) {
  const [form, setForm] = useState({ name: '', region_id: '', currency: 'USD', bank_name: '', opening_balance: '0', feed_source: 'CSV' })
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setForm((p) => ({ ...p, [k]: v }))
  const submit = async (e) => {
    e.preventDefault()
    if (!form.name || !form.region_id || !form.currency) { onError('Name, entity and currency are required.'); return }
    setBusy(true)
    try { await api.post('/bank/accounts', form); onCreated() }
    catch (e2) { onError(e2.response?.data?.message || e2.message) }
    finally { setBusy(false) }
  }
  return (
    <form onSubmit={submit} className="bk-form">
      <label className="bk-field">Account name<input className="bk-input" value={form.name} onChange={(e) => set('name', e.target.value)} /></label>
      <label className="bk-field">Entity
        <select className="bk-input" value={form.region_id} onChange={(e) => set('region_id', e.target.value)}>
          <option value="">Select…</option>
          {regions.map((r) => <option key={r.id} value={r.id}>{r.region_name}</option>)}
        </select>
      </label>
      <label className="bk-field">Currency<input className="bk-input" style={{ width: 90 }} value={form.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} /></label>
      <label className="bk-field">Bank name<input className="bk-input" value={form.bank_name} onChange={(e) => set('bank_name', e.target.value)} /></label>
      <label className="bk-field">Opening balance<input type="number" step="0.01" className="bk-input" style={{ width: 140 }} value={form.opening_balance} onChange={(e) => set('opening_balance', e.target.value)} /></label>
      <button className="bk-btn bk-btn-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Create account'}</button>
    </form>
  )
}

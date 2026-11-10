import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import api from '../../services/api'
import { useEntity } from '../../context/EntityContext'
import { DataTable, StatusChip, PanelHeader } from '../../components/ui'
import JournalEntryViewModal from '../../components/JournalEntryViewModal'
import GlNotReady from './GlNotReady'
import { PageGuide } from './AccountingGuide'
import NewJournalEntryModal from './NewJournalEntryModal'
import { SOURCE_LABELS, formatMoney } from './glHelpers'
import './JournalEntriesPage.css'

const I = (p) => ({ width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round', ...p })
const BackIcon = () => (<svg {...I({ width: 18, height: 18 })}><path d="M15 18l-6-6 6-6" /></svg>)
const PlusIcon = () => (<svg {...I()}><path d="M12 5v14" /><path d="M5 12h14" /></svg>)
const LockIcon = () => (<svg {...I({ width: 12, height: 12, strokeWidth: 2.2 })}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>)

const hashBit = (h) => {
  const s = String(h || '')
  if (!s || s === 'GENESIS') return 'genesis'
  return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s
}
const hashHead = (h) => {
  const s = String(h || '')
  if (!s || s === 'GENESIS') return 'genesis'
  return s.length > 8 ? `${s.slice(0, 6)}…` : s
}

const fmtDateShort = (d) => {
  const s = String(d || '').slice(0, 10)
  const t = Date.parse(`${s}T00:00:00Z`)
  if (Number.isNaN(t)) return s
  return new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC' })
}

export default function JournalEntriesPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [entries, setEntries] = useState([])
  const [entities, setEntities] = useState([])
  const [accounts, setAccounts] = useState([])
  const [glReady, setGlReady] = useState(true)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // Entity is driven by the global top-nav switcher (no per-page dropdown).
  const { entityId } = useEntity()
  const [filters, setFilters] = useState({ from: '', to: '', source: '' })
  const [viewEntryId, setViewEntryId] = useState(null)
  const [showCreate, setShowCreate] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  // entity + account lists for the filter and the new-entry form
  useEffect(() => {
    api.get('/regions').then((res) => setEntities(res.data.data || [])).catch(() => {})
    api.get('/gl/chart-of-accounts').then((res) => setAccounts(res.data.data || [])).catch(() => {})
  }, [])

  // Deep-link: /accounting/journal-entries?view=<id> opens that entry (e.g. from
  // the Account Register), then strips the param so a re-render doesn't reopen it.
  useEffect(() => {
    const v = searchParams.get('view')
    if (!v) return
    setViewEntryId(Number(v))
    const next = new URLSearchParams(searchParams)
    next.delete('view')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  useEffect(() => {
    let active = true
    setLoading(true)
    const params = {}
    if (entityId) params.entityId = entityId
    if (filters.from) params.from = filters.from
    if (filters.to) params.to = filters.to
    if (filters.source) params.source = filters.source
    api
      .get('/gl/journal-entries', { params })
      .then((res) => {
        if (!active) return
        setGlReady(res.data.glReady !== false)
        setMessage(res.data.message || '')
        setEntries(res.data.data || [])
      })
      .catch((err) => active && setError(err.response?.data?.message || err.message))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [filters, entityId, reloadKey])

  const set = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }))

  const listColumns = [
    { key: 'entry_no', header: 'Entry #', width: 150, render: (e) => <span className="je-no">{e.entry_no}</span> },
    { key: 'description', header: 'Description', render: (e) => <span className="je-desc">{e.description}</span> },
    { key: 'entry_date', header: 'Date', width: 120, render: (e) => <span className="je-date-cell">{fmtDateShort(e.entry_date)}</span> },
    { key: 'amount', header: 'Amount', align: 'right', width: 150, render: (e) => <span className="je-amt">{formatMoney(e.amount_base, e.entity_currency)}</span> },
  ]

  return (
    <div className="dashboard-page je-page">
      <div className="je-head">
        <button className="je-back" onClick={() => navigate('/accounting')} title="Back to accounting" aria-label="Back">
          <BackIcon />
        </button>
        <div className="je-titles">
          <h1 className="je-title">Journal entries</h1>
          <p className="je-sub">Every posted double-entry transaction is hash-chained and immutable. Invoices and approved bills post here automatically.</p>
        </div>
        <div className="je-actions">
          {glReady && (
            <button className="je-btn je-btn-primary" onClick={() => setShowCreate(true)}><PlusIcon /> New entry</button>
          )}
        </div>
      </div>

      <NewJournalEntryModal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        entities={entities}
        accounts={accounts}
        onPosted={() => setReloadKey((k) => k + 1)}
      />

      {!glReady && !loading ? (
        <GlNotReady message={message} />
      ) : (
        <>
          <PageGuide
            id="journal-entries"
            title="What are Journal Entries?"
            lead={'A journal entry is one transaction recorded in the books. Every entry has two sides that must match — money going into one account (a debit) and out of another (a credit). Click any row to see both sides.'}
            points={[
              { term: 'Auto-posted', text: 'Invoices, bills and payments create these automatically. The "Source" column tells you which one.' },
              { term: 'Debit / Credit', text: 'Two views of the same money. They always add up to the same total — that is the proof the entry is balanced.' },
              { term: 'Read-only by design', text: 'Posted entries are never edited or deleted (for audit safety). Corrections are made with a new reversing entry.' },
            ]}
          />

          <div className="je-filters">
            <span className={`je-fpill${filters.source ? ' is-active' : ''}`}>
              <select className="je-fselect" value={filters.source} onChange={set('source')} aria-label="Source">
                <option value="">All sources</option>
                {Object.entries(SOURCE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </span>
            <input type="date" className="je-date" value={filters.from} onChange={set('from')} aria-label="From date" />
            <input type="date" className="je-date" value={filters.to} onChange={set('to')} aria-label="To date" />
            <button className="je-btn" style={{ height: 42 }} onClick={() => setFilters({ from: '', to: '', source: '' })}>Reset</button>
          </div>

          <div className="je-panel">
            <div className="je-panel-head">
              <PanelHeader
                title="Journal entries"
                badge={<StatusChip tone="neutral"><span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><LockIcon /> Hash-chained</span></StatusChip>}
              />
            </div>
            <DataTable
              columns={listColumns}
              rows={entries}
              paginate
              pageLabel="entries"
              getRowId={(e) => e.id}
              selectedId={viewEntryId}
              onRowSelect={(e) => setViewEntryId(e.id)}
              loading={loading}
              empty="No journal entries yet."
              subLine={(e) => `${SOURCE_LABELS[e.source] || e.source} · ${e.entity_name}`}
            />
          </div>

          <JournalEntryViewModal entryId={viewEntryId} onClose={() => setViewEntryId(null)} />

          {error ? <div className="je-state">{error}</div> : null}
        </>
      )}
    </div>
  )
}

import { useNavigate } from 'react-router-dom'
import { PageGuide } from './AccountingGuide'

// Plain-English "front door" for the Accounting module.
// Owners get a map of what each area answers; finance staff jump straight in.

const SECTIONS = [
  {
    path: '/accounting/reports',
    color: 'var(--sect-reports)',
    title: 'Financial Reports',
    blurb:
      'The big-picture statements: are we profitable, what do we own and owe, and is everything in balance. Consolidates all locations into one currency.',
    answers: ['Am I profitable?', 'What is my net worth?', 'How are all locations doing together?'],
    audience: 'Everyone',
  },
  {
    path: '/accounting/journal-entries',
    color: 'var(--sect-journal)',
    title: 'Journal Entries',
    blurb:
      'The raw transaction log. Every invoice, bill, and payment automatically records itself here as a balanced double-entry. Mostly read-only history.',
    answers: ['What posted to the books?', 'Where did this number come from?'],
    audience: 'Finance',
  },
  {
    path: '/accounting/chart-of-accounts',
    color: 'var(--sect-coa)',
    title: 'Chart of Accounts',
    blurb:
      'The master list of "buckets" money flows into and out of — Bank, Receivables, Revenue, Expenses, and so on. The labels behind every report.',
    answers: ['What accounts do we track?', 'How is the business categorised?'],
    audience: 'Finance',
  },
  {
    path: '/accounting/period-close',
    color: 'var(--sect-period)',
    title: 'Period Close',
    blurb:
      'Month-end housekeeping: update foreign-currency balances, spread prepaid/deferred amounts over time, and lock the month so the numbers stop changing.',
    answers: ['Close the books for the month', 'Revalue foreign currencies'],
    audience: 'Finance',
  },
  {
    path: '/banking',
    color: 'var(--sect-banking)',
    title: 'Banking & Reconciliation',
    blurb:
      'Match what the books say against what the bank statement says, so your cash balance is trustworthy.',
    answers: ['Does my cash match the bank?', 'Reconcile transactions'],
    audience: 'Finance',
  },
]

const QUICK_ANSWERS = [
  { q: 'Am I making money?', to: '/accounting/reports', hint: 'Profit & Loss' },
  { q: 'What do I own and owe?', to: '/accounting/reports', hint: 'Balance Sheet' },
  { q: 'How are all my locations doing together?', to: '/accounting/reports', hint: 'Consolidated' },
  { q: 'Where did a number come from?', to: '/accounting/journal-entries', hint: 'Journal Entries' },
  { q: "It's month-end — close the books", to: '/accounting/period-close', hint: 'Period Close' },
]

export default function AccountingOverviewPage() {
  const navigate = useNavigate()

  return (
    <div className="dashboard-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Accounting</h1>
          <p className="page-subtitle">Your books, in plain English. Pick where you want to go.</p>
        </div>
      </div>

      <PageGuide
        id="overview"
        title="New here? Read this first."
        lead={
          'Accounting works quietly in the background. Every time you create an invoice, a bill, or record a payment elsewhere in the app, it is automatically written into the books here as a balanced entry — so you rarely need to type anything in this section by hand. Most of the time you come here to read the results.'
        }
        points={[
          { term: 'The golden rule', text: 'Every transaction is recorded twice (a debit and a matching credit) so the books always balance. That is what makes the reports trustworthy.' },
          { term: 'You mostly read', text: 'Invoices, bills and payments post themselves. This section is where you check profit, cash, and what is owed.' },
          { term: 'One currency for everything', text: 'Each location keeps its own currency, but reports can roll all locations up into a single reporting currency (USD) so you see the whole company at once.' },
        ]}
      />

      <div className="table-card glass-card" style={{ padding: 18, marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>I just want to know…</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {QUICK_ANSWERS.map((item) => (
            <button
              key={item.q}
              type="button"
              className="secondary-btn"
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, padding: '10px 14px', height: 'auto', textAlign: 'left' }}
              onClick={() => navigate(item.to)}
            >
              <span style={{ fontWeight: 600 }}>{item.q}</span>
              <span className="text-muted text-sm">→ {item.hint}</span>
            </button>
          ))}
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
          gap: 14,
        }}
      >
        {SECTIONS.map((s) => (
          <button
            key={s.path}
            type="button"
            className="table-card glass-card"
            style={{ textAlign: 'left', padding: 18, cursor: 'pointer', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}
            onClick={() => navigate(s.path)}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span
                style={{
                  width: 36, height: 36, borderRadius: 10, flex: '0 0 auto',
                  background: s.color, display: 'inline-flex', alignItems: 'center',
                  justifyContent: 'center', color: 'var(--sect-on)', fontWeight: 700,
                }}
                aria-hidden="true"
              >
                {s.title.slice(0, 1)}
              </span>
              <span style={{ fontWeight: 700, fontSize: 15 }}>{s.title}</span>
              <span className={`badge ${s.audience === 'Everyone' ? 'badge-green' : 'badge-blue'}`} style={{ marginLeft: 'auto' }}>
                {s.audience}
              </span>
            </div>
            <p className="text-muted text-sm" style={{ margin: 0, lineHeight: 1.55 }}>{s.blurb}</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 'auto' }}>
              {s.answers.map((a) => (
                <span key={a} className="badge badge-gray" style={{ fontWeight: 500 }}>{a}</span>
              ))}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

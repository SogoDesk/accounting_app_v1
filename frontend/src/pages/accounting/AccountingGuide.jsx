import { useState } from 'react'

// Shared "plain-English" helpers for the Accounting (GL) pages.
// PageGuide  -> a collapsible explainer banner shown at the top of a page.

const STORE_KEY = 'acctGuideCollapsed'

function readCollapsed() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}')
  } catch {
    return {}
  }
}

function writeCollapsed(next) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next))
  } catch {
    /* ignore */
  }
}

/**
 * Collapsible "What is this page?" banner.
 * Remembers per-page collapsed state so power users only dismiss it once.
 *
 * Props:
 *  - id:    unique key for remembering collapsed state (e.g. 'journal-entries')
 *  - title: short heading (e.g. 'What are Journal Entries?')
 *  - lead:  one or two sentences in plain English
 *  - points: optional array of { term, text } shown as a definition list
 */
export function PageGuide({ id, title, lead, points = [], children }) {
  // Collapsed by default — the banner stays out of the way until someone clicks
  // "Show help". Once a user toggles it, their choice is remembered per page.
  const [collapsed, setCollapsed] = useState(() => {
    const stored = readCollapsed()[id]
    return stored === undefined ? true : !!stored
  })

  const toggle = () => {
    const next = { ...readCollapsed(), [id]: !collapsed }
    writeCollapsed(next)
    setCollapsed(!collapsed)
  }

  return (
    <div className={`acct-guide${collapsed ? ' is-collapsed' : ''}`}>
      <button type="button" className="acct-guide-head" onClick={toggle} aria-expanded={!collapsed}>
        <span className="acct-guide-badge" aria-hidden="true">i</span>
        <span className="acct-guide-title">{title}</span>
        <span className="acct-guide-toggle">{collapsed ? 'Show help' : 'Hide'}</span>
      </button>
      {!collapsed && (
        <div className="acct-guide-body">
          {lead && <p className="acct-guide-lead">{lead}</p>}
          {children}
          {points.length > 0 && (
            <dl className="acct-guide-points">
              {points.map((p) => (
                <div className="acct-guide-point" key={p.term}>
                  <dt>{p.term}</dt>
                  <dd>{p.text}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </div>
  )
}

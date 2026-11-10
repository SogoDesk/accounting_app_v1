import { useEffect, useMemo, useRef, useState } from 'react'
import { COUNTRY_BY_CURRENCY } from '../../data/countries'
import { getAppPreferences } from '../../utils/appPreferences'
import { ACCENTS } from '../../context/ThemeContext'

// Modal
export function Modal({ open, onClose, title, children, footer, maxWidth = 700, modalClassName = '' }) {
  if (!open) return null
  return (
    <div className="modal-overlay">
      <div className={`modal ${modalClassName}`.trim()} style={{ maxWidth }}>
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          <button className="modal-close btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}

export function Drawer({ open, onClose, title, children, footer, width = 520, drawerClassName = '' }) {
  if (!open) return null
  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside
        className={`drawer-panel ${drawerClassName}`.trim()}
        style={{ width, maxWidth: '100%' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="drawer-header">
          <div className="drawer-title">{title}</div>
          <button className="drawer-close btn" onClick={onClose}>x</button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer ? <div className="drawer-footer">{footer}</div> : null}
      </aside>
    </div>
  )
}

// Confirm Dialog
export function ConfirmDialog({ open, onClose, onConfirm, title = 'Confirm', message, loading }) {
  if (!open) return null
  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 420 }}>
        <div className="modal-header">
          <div className="modal-title">{title}</div>
        </div>
        <div className="modal-body">
          <p style={{ color: 'var(--text2)', lineHeight: 1.6 }}>{message}</p>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={loading}>Cancel</button>
          <button className="btn btn-danger" onClick={onConfirm} disabled={loading}>
            {loading ? 'Processing...' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  )
}

// Status Badge
const STATUS_MAP = {
  ACTIVE: 'badge-green', INACTIVE: 'badge-gray',
  DRAFT: 'badge-gray', GENERATED: 'badge-blue', SENT: 'badge-cyan',
  SUBMITTED: 'badge-cyan', APPROVED: 'badge-green', REJECTED: 'badge-red',
  PENDING: 'badge-yellow', NOT_SUBMITTED: 'badge-gray',
  PARTIALLY_PAID: 'badge-yellow', PAID: 'badge-green', DUE: 'badge-red',
  OVERDUE: 'badge-red', CANCELLED: 'badge-gray',
  ON_HOLD: 'badge-yellow', ENDED: 'badge-gray',
  HOURLY: 'badge-blue', MONTHLY: 'badge-cyan', ONE_TIME: 'badge-yellow',
  CONTRACT: 'badge-blue', W2: 'badge-green', C2C: 'badge-yellow',
  FULL_TIME: 'badge-green', PERMANENT: 'badge-cyan',
}

export function Badge({ value }) {
  if (!value) return null
  const cls = STATUS_MAP[value] || 'badge-gray'
  return <span className={`badge ${cls}`}>{value.replace(/_/g, ' ')}</span>
}

// Skeleton rows
export function SkeletonRows({ cols = 5, rows = 6 }) {
  return Array.from({ length: rows }).map((_, i) => (
    <tr key={i} style={{ height: 52, borderBottom: '1px solid var(--border-hair-row)' }}>
      {Array.from({ length: cols }).map((_, j) => (
        <td key={j}><div className="skeleton" style={{ height: 12, width: j === 0 ? 120 : '70%', borderRadius: 5 }} /></td>
      ))}
    </tr>
  ))
}

/* ------------------------------------------------------------------ *
 *  Step 3 — shared UI primitives (SogoDesk Books redesign)
 *  Class names prefixed `sg-`; colours come only from CSS tokens.
 * ------------------------------------------------------------------ */

// Small inline icons ------------------------------------------------
function ArrowUpIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 19V5" /><path d="m6 11 6-6 6 6" />
    </svg>
  )
}
function ArrowDownIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14" /><path d="m6 13 6 6 6-6" />
    </svg>
  )
}
function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

// Card --------------------------------------------------------------
export function Card({ accent, hover, selected, pad = true, as = 'div', className = '', style, children, ...rest }) {
  const Tag = as
  const cls = [
    'sg-card',
    pad ? 'sg-card-pad' : '',
    accent ? 'is-accent' : '',
    hover ? 'is-hover' : '',
    selected ? 'is-selected' : '',
    className,
  ].filter(Boolean).join(' ')
  return (
    <Tag className={cls} style={style} {...rest}>{children}</Tag>
  )
}

// StatCard (KPI cell) ----------------------------------------------
export function StatCard({ label, value, prefix, unit, delta, sub, icon, accent }) {
  const dir = delta?.dir
  const tone = delta?.tone || (dir === 'down' ? 'danger' : 'success')
  return (
    <Card accent={accent} className="sg-statcard">
      <div className="sg-statcard-top">
        <span className="sg-statcard-label">{label}</span>
        {icon ? <span className="sg-statcard-icon">{icon}</span> : null}
      </div>
      <div className="sg-statcard-value">
        {prefix ? <span className="sg-statcard-prefix">{prefix}</span> : null}
        <span className="sg-statcard-num">{value}</span>
        {unit ? <span className="sg-statcard-unit">{unit}</span> : null}
      </div>
      {delta ? (
        <div className="sg-statcard-delta">
          <span className={`sg-delta-fig sg-delta-${tone}`}>
            {dir === 'down' ? <ArrowDownIcon /> : <ArrowUpIcon />}
            {delta.value}
          </span>
          {delta.text ? <span className="sg-delta-text">{delta.text}</span> : null}
        </div>
      ) : null}
      {sub ? <div className="sg-statcard-sub">{sub}</div> : null}
    </Card>
  )
}

// StatusChip --------------------------------------------------------
export function StatusChip({ tone = 'neutral', children }) {
  return <span className={`sg-chip sg-chip-${tone}`}>{children}</span>
}

// FilterPill --------------------------------------------------------
export function FilterPill({ active, icon, children, value, dropdown, onClick }) {
  return (
    <button
      type="button"
      className={`sg-filter${active ? ' is-active' : ''}`}
      onClick={onClick}
    >
      {icon ? <span className="sg-filter-icon">{icon}</span> : null}
      <span className="sg-filter-label">{children}{value != null && value !== '' ? ':' : ''}</span>
      {value != null && value !== '' ? <span className="sg-filter-value">{value}</span> : null}
      {dropdown ? <span className="sg-filter-chev"><ChevronDownIcon /></span> : null}
    </button>
  )
}

// PanelHeader -------------------------------------------------------
export function PanelHeader({ title, tabs, activeTab, onTab, actions, badge }) {
  return (
    <div className="sg-panelhead">
      <div className="sg-panelhead-title">
        {title}
        {badge ? <span className="sg-panelhead-badge">{badge}</span> : null}
      </div>
      {Array.isArray(tabs) && tabs.length ? (
        <div className="sg-seg" role="tablist">
          {tabs.map((t) => {
            const on = t.key === activeTab
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={on}
                className={`sg-seg-btn${on ? ' is-active' : ''}`}
                onClick={() => onTab?.(t.key)}
              >
                <span>{t.label}</span>
                {t.count != null ? <span className="sg-seg-count">{t.count}</span> : null}
              </button>
            )
          })}
        </div>
      ) : null}
      {actions ? <div className="sg-panelhead-actions">{actions}</div> : null}
    </div>
  )
}

// DataTable ---------------------------------------------------------
// --- DataTable sorting helpers -------------------------------------------
// Columns are sortable by default; opt out with `sortable: false` (used for
// action/kebab columns). A column sorts by `row[key]` unless it supplies a
// `sortAccessor: (row) => value` (needed when the cell is a composite, e.g. an
// avatar + name, or when the sort value differs from what's displayed).
const SG_NOSORT = new Set(['actions', 'action', 'menu', 'kebab', 'select', ''])

const sgToNum = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const s = v.replace(/[$£€₹,\s]/g, '')
  if (s === '' || !/^-?\d*\.?\d+%?$/.test(s)) return null
  return Number(s.replace('%', ''))
}
const sgToDate = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}
const sgCompare = (a, b) => {
  const ea = a === null || a === undefined || a === ''
  const eb = b === null || b === undefined || b === ''
  if (ea && eb) return 0
  if (ea) return 1
  if (eb) return -1
  const na = sgToNum(a); const nb = sgToNum(b)
  if (na !== null && nb !== null) return na - nb
  const da = sgToDate(a); const db = sgToDate(b)
  if (da !== null && db !== null) return da - db
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}
const sgIsSortable = (c) =>
  c.sortable !== false &&
  (typeof c.sortAccessor === 'function' ||
    (!!c.key && !c.key.startsWith('_') && !SG_NOSORT.has(c.key)))
const sgAccessor = (c) => c.sortAccessor || ((row) => row[c.key])

function SgSortIcon({ state }) {
  return (
    <span className={`sg-sort-ico${state ? ' is-active' : ''}`} aria-hidden="true">
      <svg width="9" height="12" viewBox="0 0 9 12">
        <path d="M4.5 1 7 4.4H2L4.5 1Z" fill="currentColor" opacity={state === 'asc' ? 1 : 0.34} />
        <path d="M4.5 11 2 7.6h5L4.5 11Z" fill="currentColor" opacity={state === 'desc' ? 1 : 0.34} />
      </svg>
    </span>
  )
}

const loadColWidths = (key) => {
  try { const v = JSON.parse(localStorage.getItem(key) || '{}'); return v && typeof v === 'object' ? v : {} } catch { return {} }
}
const saveColWidths = (key, widths) => {
  try { localStorage.setItem(key, JSON.stringify(widths)) } catch { /* storage unavailable */ }
}

export function DataTable({ columns = [], rows = [], getRowId, selectedId, onRowSelect, footer, empty, loading, subLine, defaultSort, paginate = false, initialPageSize = 10, pageLabel = 'records', resizable = true, tableId }) {
  const selectable = typeof onRowSelect === 'function'
  const colCount = columns.length
  const [sort, setSort] = useState(defaultSort || null)

  // Resizable columns: widths (px) keyed by column key, persisted per table.
  // Non-destructive — until a column is dragged (or saved widths exist) the
  // table renders with its normal auto layout.
  const tableRef = useRef(null)
  const persistKey = tableId || `dt:${pageLabel}:${columns.map((c) => c.key).join('|')}`
  const [colWidths, setColWidths] = useState(() => (resizable ? loadColWidths(persistKey) : {}))
  const resizeRef = useRef(null)
  const allHaveWidths = resizable && columns.length > 0 && columns.every((c) => colWidths[c.key] != null)
  const totalWidth = allHaveWidths ? columns.reduce((s, c) => s + Number(colWidths[c.key] || 0), 0) : null

  const beginResize = (e, key) => {
    e.preventDefault()
    e.stopPropagation()
    const ths = tableRef.current ? Array.from(tableRef.current.querySelectorAll('thead th')) : []
    let widths = colWidths
    if (Object.keys(widths).length < columns.length) {
      // Seed from the live rendered widths so switching to fixed layout doesn't jump.
      widths = { ...widths }
      ths.forEach((th, i) => { const c = columns[i]; if (c) widths[c.key] = Math.round(th.getBoundingClientRect().width) })
      setColWidths(widths)
    }
    const idx = columns.findIndex((c) => c.key === key)
    const startW = widths[key] || (ths[idx] ? Math.round(ths[idx].getBoundingClientRect().width) : 120)
    resizeRef.current = { key, startX: e.clientX, startW }
    const onMove = (ev) => {
      const r = resizeRef.current
      if (!r) return
      const w = Math.max(60, Math.round(r.startW + (ev.clientX - r.startX)))
      setColWidths((prev) => ({ ...prev, [r.key]: w }))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('sg-col-resizing')
      resizeRef.current = null
      setColWidths((prev) => { saveColWidths(persistKey, prev); return prev })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.classList.add('sg-col-resizing')
  }

  const sortedRows = useMemo(() => {
    if (!sort || !sort.key) return rows
    const col = columns.find((c) => c.key === sort.key)
    if (!col) return rows
    const acc = sgAccessor(col)
    const dir = sort.dir === 'desc' ? -1 : 1
    return [...rows].sort((r1, r2) => dir * sgCompare(acc(r1), acc(r2)))
  }, [rows, sort, columns])

  // Pagination is applied AFTER sorting so column-sort orders the whole set,
  // not just the visible page. Reset to page 1 when the row count changes
  // (e.g. a filter narrows the set); usePagination clamps otherwise.
  const pager = usePagination(sortedRows, { initialSize: initialPageSize, resetKey: sortedRows.length })
  const displayRows = paginate ? pager.pageRows : sortedRows

  const onHeaderSort = (c) => {
    if (!sgIsSortable(c)) return
    setSort((prev) => {
      if (!prev || prev.key !== c.key) return { key: c.key, dir: 'asc' }
      return { key: c.key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
    })
  }

  const renderFooter = () => {
    if (!footer) return null
    if (Array.isArray(footer)) {
      return (
        <tfoot>
          <tr className="sg-tr-foot">
            {footer.map((cell, i) => (
              <td
                key={i}
                colSpan={cell.colSpan || 1}
                className={`sg-td-foot${cell.mono ? ' sg-mono' : ''}`}
                style={{ textAlign: cell.align || 'left' }}
              >
                {cell.render ? cell.render() : cell.children}
              </td>
            ))}
          </tr>
        </tfoot>
      )
    }
    return (
      <tfoot>
        <tr className="sg-tr-foot">
          <td className="sg-td-foot" colSpan={colCount}>{footer}</td>
        </tr>
      </tfoot>
    )
  }

  return (
    <>
    <div className="sg-table">
      <table ref={tableRef} style={allHaveWidths ? { tableLayout: 'fixed', width: totalWidth } : undefined}>
        {allHaveWidths ? (
          <colgroup>
            {columns.map((c) => <col key={c.key} style={{ width: colWidths[c.key] }} />)}
          </colgroup>
        ) : null}
        <thead>
          <tr>
            {columns.map((c, ci) => {
              const sortable = sgIsSortable(c)
              const active = sort && sort.key === c.key ? sort.dir : null
              return (
                <th
                  key={c.key}
                  className={`sg-th${sortable ? ' sg-th-sortable' : ''}${active ? ' is-sorted' : ''}`}
                  style={{ textAlign: c.align || 'left', width: allHaveWidths ? undefined : c.width }}
                  onClick={sortable ? () => onHeaderSort(c) : undefined}
                  aria-sort={active ? (active === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  <span className="sg-th-inner">
                    {c.header}
                    {sortable ? <SgSortIcon state={active} /> : null}
                  </span>
                  {resizable && ci < columns.length - 1 ? (
                    <span
                      className="sg-col-resize"
                      onMouseDown={(e) => beginResize(e, c.key)}
                      onClick={(e) => e.stopPropagation()}
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${typeof c.header === 'string' ? c.header : 'column'}`}
                    />
                  ) : null}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <SkeletonRows cols={colCount} rows={6} />
          ) : sortedRows.length === 0 ? (
            <tr className="sg-tr-empty">
              <td colSpan={colCount}>
                <div className="sg-empty">{empty || 'No records found'}</div>
              </td>
            </tr>
          ) : (
            displayRows.map((row) => {
              const id = getRowId ? getRowId(row) : undefined
              const isSel = selectable && id != null && id === selectedId
              const hasSub = typeof subLine === 'function'
              const sub = hasSub ? subLine(row) : null
              return (
                <tr
                  key={id ?? Math.random()}
                  className={[
                    selectable ? 'sg-tr-clickable' : '',
                    isSel ? 'is-selected' : '',
                    sub ? 'has-sub' : '',
                  ].filter(Boolean).join(' ')}
                  onClick={selectable ? () => onRowSelect(row) : undefined}
                >
                  {columns.map((c, ci) => {
                    const content = c.render ? c.render(row) : row[c.key]
                    const cls = [
                      'sg-td',
                      c.primary ? 'sg-td-primary' : '',
                      c.mono ? 'sg-mono' : '',
                    ].filter(Boolean).join(' ')
                    return (
                      <td key={c.key} className={cls} style={{ textAlign: c.align || 'left' }}>
                        {ci === 0 && sub ? (
                          <div className="sg-cell-stack">
                            <span className="sg-cell-main">{content}</span>
                            <span className="sg-cell-sub">{sub}</span>
                          </div>
                        ) : content}
                      </td>
                    )
                  })}
                </tr>
              )
            })
          )}
        </tbody>
        {renderFooter()}
      </table>
    </div>
    {paginate && !loading && sortedRows.length > 0 && (
      <Pagination {...pager.paginationProps} label={pageLabel} />
    )}
    </>
  )
}

// Pagination -------------------------------------------------------
// Presentational pager shared across every list page: a rows-per-page
// dropdown (10 default; 25/50/100) plus a compact page selector. Works for
// both server-paginated pages (wire page/pageSize straight to the API) and
// client-paginated ones (drive it with the usePagination hook below).
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100]

function sgPageWindow(current, totalPages) {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1)
  const out = [1]
  const start = Math.max(2, current - 1)
  const end = Math.min(totalPages - 1, current + 1)
  if (start > 2) out.push('…')
  for (let p = start; p <= end; p += 1) out.push(p)
  if (end < totalPages - 1) out.push('…')
  out.push(totalPages)
  return out
}

export function Pagination({
  page = 1,
  pageSize = 10,
  total = 0,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = PAGE_SIZE_OPTIONS,
  label = 'records',
}) {
  const count = Number(total) || 0
  const size = Number(pageSize) || 1
  const totalPages = Math.max(1, Math.ceil(count / size))
  const current = Math.min(Math.max(1, page), totalPages)
  const from = count === 0 ? 0 : (current - 1) * size + 1
  const to = Math.min(count, current * size)
  const go = (p) => { if (onPageChange) onPageChange(Math.min(Math.max(1, p), totalPages)) }
  const pages = sgPageWindow(current, totalPages)

  return (
    <div className="sg-pagination">
      <div className="sg-pagination-size">
        <span className="sg-pagination-label">Rows</span>
        <select
          className="form-control sg-pagination-select"
          value={pageSize}
          onChange={(e) => onPageSizeChange && onPageSizeChange(Number(e.target.value))}
          aria-label="Rows per page"
        >
          {pageSizeOptions.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div className="sg-pagination-info">
        {from}&ndash;{to} of {count} {label}
      </div>
      <div className="sg-pagination-pages">
        <button
          type="button"
          className="sg-pagination-btn"
          disabled={current <= 1}
          onClick={() => go(current - 1)}
          aria-label="Previous page"
        >&lsaquo;</button>
        {pages.map((p, i) => (p === '…'
          ? <span key={`e${i}`} className="sg-pagination-ellipsis">&hellip;</span>
          : (
            <button
              key={p}
              type="button"
              className={`sg-pagination-btn${p === current ? ' is-active' : ''}`}
              onClick={() => go(p)}
              aria-current={p === current ? 'page' : undefined}
            >{p}</button>
          )
        ))}
        <button
          type="button"
          className="sg-pagination-btn"
          disabled={current >= totalPages}
          onClick={() => go(current + 1)}
          aria-label="Next page"
        >&rsaquo;</button>
      </div>
    </div>
  )
}

// usePagination — client-side pager over an in-memory array. Returns the
// current window plus a spreadable `paginationProps` for <Pagination/>.
// Pass a `resetKey` (e.g. a filters signature) to snap back to page 1 when
// the underlying query changes; changing page size also resets to page 1.
export function usePagination(rows, { initialSize = 10, resetKey } = {}) {
  const list = Array.isArray(rows) ? rows : []
  const total = list.length
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(initialSize)

  useEffect(() => { setPage(1) }, [resetKey, pageSize])

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const current = Math.min(Math.max(1, page), totalPages)
  useEffect(() => { if (page > totalPages) setPage(totalPages) }, [page, totalPages])

  const pageRows = useMemo(() => {
    const start = (current - 1) * pageSize
    return list.slice(start, start + pageSize)
  }, [rows, current, pageSize])

  return {
    page: current,
    pageSize,
    total,
    pageRows,
    setPage,
    setPageSize,
    paginationProps: {
      page: current,
      pageSize,
      total,
      onPageChange: setPage,
      onPageSizeChange: setPageSize,
    },
  }
}

// chartColors -------------------------------------------------------
// recharts needs real hex strings (not css vars). Derive a palette in
// plain JS that mirrors the --chart-* token intent for the given accent.
const _accentHex = (key) => (ACCENTS.find((a) => a.key === key) || ACCENTS[0]).hex

function _clampByte(n) { return Math.max(0, Math.min(255, Math.round(n))) }
function _h2r(hex) {
  let h = String(hex).replace('#', '')
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  const n = parseInt(h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function _r2h(r, g, b) {
  return '#' + [r, g, b].map((v) => _clampByte(v).toString(16).padStart(2, '0')).join('')
}
// mix `hex` toward `target` by `pct` (0..1 of target).
function mix(hex, target, pct) {
  const a = _h2r(hex)
  const b = _h2r(target)
  const p = Math.max(0, Math.min(1, pct))
  return _r2h(
    a[0] + (b[0] - a[0]) * p,
    a[1] + (b[1] - a[1]) * p,
    a[2] + (b[2] - a[2]) * p,
  )
}

export function chartColors(accentKey, dark) {
  const accent = _accentHex(accentKey)
  const WHITE = '#ffffff'
  const CHART6 = '#f0a05a' // warm orange, accent-independent
  if (dark) {
    const dSurfA = '#2a2740'
    const dSurfB = '#211f36'
    const series = [
      accent,                    // chart-1
      mix(accent, WHITE, 0.18),  // chart-1b (accent lightened ~18%)
      mix(accent, dSurfA, 0.66), // chart-2 faded secondary
      mix(accent, WHITE, 0.12),  // chart-3
      mix(accent, dSurfA, 0.45), // chart-4
      CHART6,                    // chart-6
    ]
    return {
      series,
      gradientFrom: mix(accent, WHITE, 0.18),
      gradientTo: accent,
      grid: '#2a2740',
      axis: '#8b89a3',
    }
  }
  const series = [
    accent,                    // chart-1
    mix(accent, WHITE, 0.18),  // chart-1b (accent lightened ~18%)
    mix(accent, WHITE, 0.78),  // chart-2 faded secondary
    mix(accent, WHITE, 0.15),  // chart-3
    mix(accent, WHITE, 0.6),   // chart-4
    CHART6,                    // chart-6
  ]
  return {
    series,
    gradientFrom: mix(accent, WHITE, 0.18),
    gradientTo: accent,
    grid: '#eceaf6',
    axis: '#8b8a9c',
  }
}

// Form field helpers
export function FormGroup({ label, required, hint, children }) {
  return (
    <div className="form-group">
      {label && <label className={`form-label${required ? ' required' : ''}`}>{label}</label>}
      {children}
      {hint && <div className="form-hint">{hint}</div>}
    </div>
  )
}

export function Input({ label, required, hint, ...props }) {
  return (
    <FormGroup label={label} required={required} hint={hint}>
      <input className="form-control" {...props} />
    </FormGroup>
  )
}

export function Select({ label, required, hint, children, ...props }) {
  return (
    <FormGroup label={label} required={required} hint={hint}>
      <select className="form-control" {...props}>{children}</select>
    </FormGroup>
  )
}

// Password field with a show/hide eye toggle. Same API as Input.
export function PasswordInput({ label, required, hint, ...props }) {
  const [show, setShow] = useState(false)
  return (
    <FormGroup label={label} required={required} hint={hint}>
      <div className="password-input-wrap">
        <input className="form-control" {...props} type={show ? 'text' : 'password'} />
        <button
          type="button"
          className="password-toggle-btn"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? 'Hide password' : 'Show password'}
          title={show ? 'Hide password' : 'Show password'}
        >
          {show ? (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" width="18" height="18">
              <path d="m3 3 18 18" />
              <path d="M10.6 10.6A3 3 0 0 0 12 15a3 3 0 0 0 2.4-1.2" />
              <path d="M9.9 4.3A10.8 10.8 0 0 1 12 4c6.5 0 10 8 10 8a18.5 18.5 0 0 1-3.1 4.3" />
              <path d="M6.6 6.6C3.7 8.6 2 12 2 12s3.5 8 10 8a10.8 10.8 0 0 0 4.4-.9" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" width="18" height="18">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          )}
        </button>
      </div>
    </FormGroup>
  )
}

export function SearchableSelect({
  label,
  required,
  hint,
  value,
  options = [],
  placeholder = 'Search...',
  emptyMessage = 'No results found',
  createLabel = '',
  disabled = false,
  onChange,
  onCreate,
}) {
  const wrapRef = useRef(null)
  const activeItemRef = useRef(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  const selectedOption = useMemo(
    () => options.find((option) => String(option.value) === String(value || '')) || null,
    [options, value],
  )

  useEffect(() => {
    setQuery(selectedOption?.label || '')
  }, [selectedOption])

  const closeDropdown = () => {
    setOpen(false)
    // If the user typed a term that exactly matches an option's label but never
    // clicked the row, commit it instead of silently discarding the text. This
    // prevents the "looks filled but value is empty -> required" footgun.
    const needle = String(query || '').trim().toLowerCase()
    if (needle && (!selectedOption || String(selectedOption.label).trim().toLowerCase() !== needle)) {
      const exact = options.find(
        (option) => String(option.label).trim().toLowerCase() === needle,
      )
      if (exact) {
        onChange?.({ target: { value: String(exact.value) } })
        return
      }
    }
    setQuery(selectedOption?.label || '')
  }

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target)) closeDropdown()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open, selectedOption])

  const filteredOptions = useMemo(() => {
    const needle = String(query || '').trim().toLowerCase()
    if (!needle) return options
    return options.filter((option) => {
      const haystack = [option.label, option.meta, option.searchText]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return haystack.includes(needle)
    })
  }, [options, query])

  // Reset the keyboard highlight to the top whenever the list opens or the
  // query changes (so Enter picks the most relevant match).
  useEffect(() => {
    if (open) setActiveIndex(0)
  }, [open, query])

  // Keep the highlighted row scrolled into view as the user arrows through.
  useEffect(() => {
    if (open) activeItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  const handleSelect = (nextValue) => {
    onChange?.({ target: { value: String(nextValue) } })
    setOpen(false)
  }

  return (
    <FormGroup label={label} required={required} hint={hint}>
      <div ref={wrapRef} className={`autocomplete-wrap searchable-select ${disabled ? 'is-disabled' : ''}`.trim()}>
        <input
          className="form-control searchable-select-input"
          value={query}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={() => !disabled && setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
            if (!event.target.value) onChange?.({ target: { value: '' } })
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              if (!open) { setOpen(true); return }
              setActiveIndex((i) => Math.min(i + 1, filteredOptions.length - 1))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              if (!open) { setOpen(true); return }
              setActiveIndex((i) => Math.max(i - 1, 0))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              if (open && filteredOptions.length > 0) {
                const pick = filteredOptions[activeIndex] || filteredOptions[0]
                handleSelect(pick.value)
              }
            } else if (event.key === 'Escape') {
              closeDropdown()
            } else if (event.key === 'Tab') {
              if (open) closeDropdown()
            }
          }}
        />
        <button
          type="button"
          className="searchable-select-toggle"
          disabled={disabled}
          aria-label={`Toggle ${label || 'options'}`}
          onClick={() => {
            if (open) closeDropdown()
            else setOpen(true)
          }}
        >
          v
        </button>
        {open ? (
          <div className="autocomplete-dropdown searchable-select-dropdown">
            {filteredOptions.length > 0 ? (
              filteredOptions.map((option, index) => (
                <button
                  key={String(option.value)}
                  ref={index === activeIndex ? activeItemRef : null}
                  type="button"
                  className={`autocomplete-item searchable-select-item ${String(option.value) === String(value || '') ? 'is-selected' : ''} ${index === activeIndex ? 'is-active' : ''}`.trim()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => handleSelect(option.value)}
                >
                  <span>{option.label}</span>
                  {option.meta ? <span className="text-muted text-sm">{option.meta}</span> : null}
                </button>
              ))
            ) : (
              <div className="searchable-select-empty">
                <div className="autocomplete-empty">{emptyMessage}</div>
                {onCreate ? (
                  <button
                    type="button"
                    className="searchable-select-create"
                    onClick={() => {
                      onCreate(query)
                      setOpen(false)
                    }}
                  >
                    {createLabel || `+ Add "${query.trim()}"`}
                  </button>
                ) : null}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </FormGroup>
  )
}

export function Textarea({ label, required, hint, ...props }) {
  return (
    <FormGroup label={label} required={required} hint={hint}>
      <textarea className="form-control" {...props} />
    </FormGroup>
  )
}

export const currencySymbol = (currencyCode = '') => {
  const code = String(currencyCode || '').toUpperCase()
  return COUNTRY_BY_CURRENCY[code]?.symbol || code
}

// Money formatter
export const fmt = (v, currency = '') => {
  const prefs = getAppPreferences()
  const n = Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (!currency) return n
  const code = String(currency).toUpperCase()
  if (prefs.currency_format === 'CODE') return `${code} ${n}`
  return `${currencySymbol(code)} ${n}`
}

export const fmtDate = (d) => {
  if (!d) return '—'
  if (typeof d === 'string') {
    const raw = d.trim()
    if (!raw) return '—'
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw
  }

  const parsed = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(parsed.getTime())) return String(d).substring(0, 10)

  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export const fmtDateDisplay = (d) => {
  if (!d) return '—'
  const safe = fmtDate(d)
  const parts = safe.split('-')
  if (parts.length !== 3) return safe

  const [yyyy, mm, dd] = parts
  const prefs = getAppPreferences()

  if (prefs.date_format === 'DD/MM/YYYY') return `${dd}/${mm}/${yyyy}`
  if (prefs.date_format === 'YYYY-MM-DD') return `${yyyy}-${mm}-${dd}`
  return `${mm}/${dd}/${yyyy}`
}

export const customerLabel = () => getAppPreferences().customer_label || 'Client'

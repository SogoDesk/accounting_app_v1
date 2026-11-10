import { useRef, useState } from 'react'

const load = (k) => { try { const v = JSON.parse(localStorage.getItem(k) || '{}'); return v && typeof v === 'object' ? v : {} } catch { return {} } }
const save = (k, w) => { try { localStorage.setItem(k, JSON.stringify(w)) } catch { /* storage unavailable */ } }

/**
 * Make a hand-rolled <table> (e.g. the app's `.saas-table`) column-resizable.
 * Widths are keyed by column index and persisted per table in localStorage.
 * Non-destructive: until a column is dragged (or saved widths exist) the table
 * keeps its normal auto layout.
 *
 * Usage:
 *   const rz = useResizableColumns(colCount, 'rz:candidates')
 *   <table ref={rz.tableRef} style={rz.tableStyle}>{rz.colgroup}<thead><tr>
 *     <th>Name{rz.handle(0)}</th> ...
 */
export function useResizableColumns(count, storageKey) {
  const tableRef = useRef(null)
  const [widths, setWidths] = useState(() => load(storageKey))
  const resizeRef = useRef(null)
  const idx = Array.from({ length: count }, (_, i) => i)
  const allSet = count > 0 && idx.every((i) => widths[i] != null)
  const total = allSet ? idx.reduce((s, i) => s + Number(widths[i] || 0), 0) : null

  const begin = (e, i) => {
    e.preventDefault()
    e.stopPropagation()
    const ths = tableRef.current ? Array.from(tableRef.current.querySelectorAll('thead th')) : []
    let w = widths
    if (Object.keys(w).length < count) {
      w = { ...w }
      ths.forEach((th, j) => { if (j < count) w[j] = Math.round(th.getBoundingClientRect().width) })
      setWidths(w)
    }
    const startW = w[i] || (ths[i] ? Math.round(ths[i].getBoundingClientRect().width) : 120)
    resizeRef.current = { i, startX: e.clientX, startW }
    const onMove = (ev) => {
      const r = resizeRef.current
      if (!r) return
      const nw = Math.max(60, Math.round(r.startW + (ev.clientX - r.startX)))
      setWidths((prev) => ({ ...prev, [r.i]: nw }))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('sg-col-resizing')
      resizeRef.current = null
      setWidths((prev) => { save(storageKey, prev); return prev })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.classList.add('sg-col-resizing')
  }

  const colgroup = allSet ? (
    <colgroup>{idx.map((i) => <col key={i} style={{ width: widths[i] }} />)}</colgroup>
  ) : null

  const handle = (i) => (i < count - 1 ? (
    <span
      className="sg-col-resize"
      onMouseDown={(e) => begin(e, i)}
      onClick={(e) => e.stopPropagation()}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column"
    />
  ) : null)

  return { tableRef, tableStyle: allSet ? { tableLayout: 'fixed', width: total } : undefined, colgroup, handle }
}

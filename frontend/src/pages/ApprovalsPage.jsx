import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import api from '../services/api'
import { Badge, Modal, SkeletonRows, StatCard, Input, Textarea, Pagination, usePagination, fmt, fmtDateDisplay, currencySymbol } from '../components/ui/index.jsx'
import { useResizableColumns } from '../utils/useResizableColumns'
import { useEntity } from '../context/EntityContext'
import BillViewModal from '../components/BillViewModal'
import AttachmentsViewer from '../components/AttachmentsViewer'
import { useToast } from '../context/ToastContext'

export default function ApprovalsPage() {
  const toast = useToast()
  const navigate = useNavigate()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [viewBillId, setViewBillId] = useState(null)
  const [reportingCurrency, setReportingCurrency] = useState('USD')
  // Region from the global top-nav switcher: scopes the queue and the KPI currency.
  const { entityId } = useEntity()
  const consolidated = !entityId
  const { pageRows, paginationProps } = usePagination(rows)
  const rz = useResizableColumns(8, 'rz:approvals')

  const load = async () => {
    try {
      setLoading(true)
      const params = { approval_status: 'PENDING' }
      if (entityId) params.region_id = entityId
      const res = await api.get('/bills', { params })
      setRows(res.data?.data || [])
      setReportingCurrency(res.data?.reporting_currency || 'USD')
    } catch (error) {
      toast.error(error.response?.data?.message || 'Failed to load approvals')
    } finally {
      setLoading(false)
    }
  }

  // Queue summary. Across all regions, sum the group-currency *_reporting fields
  // (never raw native); for a single region the queue is one currency, so use
  // native amounts shown in that region's currency.
  const summary = useMemo(() => {
    const num = (v) => { const n = Number(v || 0); return Number.isNaN(n) ? 0 : n }
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const vendors = new Set()
    let value = 0; let pastDue = 0; let oldest = 0
    rows.forEach((r) => {
      value += num(consolidated ? (r.total_amount_reporting ?? r.total_amount) : r.total_amount)
      if (r.vendor_id != null) vendors.add(String(r.vendor_id))
      const due = new Date(String(r.due_date || '').slice(0, 10))
      if (!Number.isNaN(due.getTime()) && due < today) pastDue += 1
      const d = new Date(String(r.bill_date || '').slice(0, 10))
      if (!Number.isNaN(d.getTime())) {
        const days = Math.floor((today - d) / 86400000)
        if (days > oldest) oldest = days
      }
    })
    return { value, pastDue, vendors: vendors.size, oldest }
  }, [rows, consolidated])

  // KPI currency: group currency when consolidated, else the queue's native currency.
  const kpiCcy = consolidated ? reportingCurrency : (rows[0]?.currency || reportingCurrency)

  useEffect(() => {
    load()
  }, [entityId])

  const openView = (row) => {
    setViewBillId(row?.id ?? null)
  }

  const changeStatus = async (row, status) => {
    const comments = status === 'REJECTED' ? (window.prompt('Rejection reason', '') || '') : ''
    try {
      await api.patch(`/bills/${row.id}/status`, { status, comments })
      toast.success(`Bill ${status === 'APPROVED' ? 'approved' : 'rejected'} successfully`)
      load()
      if (viewBillId === row.id) setViewBillId(null)
    } catch (error) {
      toast.error(error.response?.data?.message || 'Approval update failed')
    }
  }

  return (
    <div className="dashboard-page approvals-page">
      <div className="page-header">
        <div className="page-head-left">
          <button type="button" className="page-back" onClick={() => navigate('/dashboard')} aria-label="Back to dashboard">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5" /><path d="M12 19l-7-7 7-7" /></svg>
          </button>
          <div>
            <div className="page-title">Approvals</div>
            <div className="page-subtitle">Review submitted bills and approve or reject them quickly</div>
          </div>
        </div>
      </div>

      <div className="sg-kpigrid" style={{ marginBottom: 16 }}>
        <StatCard
          label="Pending approvals"
          value={rows.length.toLocaleString()}
          accent
          sub={summary.vendors ? `${summary.vendors} vendor${summary.vendors === 1 ? '' : 's'}` : 'Queue is clear'}
        />
        <StatCard
          label="Total value"
          prefix={currencySymbol(kpiCcy)}
          value={Math.round(summary.value).toLocaleString('en-US')}
          sub={consolidated ? `Consolidated ${kpiCcy}` : `In ${kpiCcy}`}
        />
        <StatCard
          label="Past due"
          value={summary.pastDue.toLocaleString()}
          sub={summary.pastDue > 0 ? 'Awaiting approval past due date' : 'None past due'}
        />
        <StatCard
          label="Longest waiting"
          value={summary.oldest.toLocaleString()}
          unit={summary.oldest === 1 ? 'day' : 'days'}
          sub={summary.oldest > 0 ? 'Since oldest bill date' : 'Nothing waiting'}
        />
      </div>

      <div className="table-card glass-card">
        <div className="table-toolbar">
          <span className="text-muted text-sm">{rows.length} pending bill approvals</span>
        </div>

        <div className="table-wrap">
          <table className="saas-table" ref={rz.tableRef} style={rz.tableStyle}>
            {rz.colgroup}
            <thead>
              <tr>
                <th>Bill #{rz.handle(0)}</th>
                <th>Vendor{rz.handle(1)}</th>
                <th>Date{rz.handle(2)}</th>
                <th>Due Date{rz.handle(3)}</th>
                <th className="text-right">Total{rz.handle(4)}</th>
                <th className="text-right">Outstanding{rz.handle(5)}</th>
                <th>Status{rz.handle(6)}</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonRows cols={8} />
              ) : rows.length === 0 ? (
                <tr className="empty-row">
                  <td colSpan={8}>
                    No bills are awaiting approval. A bill shows up here once it’s submitted for approval —
                    open its ••• menu on the <Link to="/bills" className="db-link">Bills page</Link> and choose “Submit”.
                  </td>
                </tr>
              ) : pageRows.map((row) => (
                <tr key={row.id}>
                  <td className="fw-bold">
                    <button type="button" className="cd-linkbtn" onClick={() => openView(row)}>{row.bill_number}</button>
                  </td>
                  <td>{row.vendor_name}</td>
                  <td>{fmtDateDisplay(row.bill_date)}</td>
                  <td>{fmtDateDisplay(row.due_date)}</td>
                  <td className="text-right td-mono">{fmt(row.total_amount, row.currency)}</td>
                  <td className="text-right td-mono">{fmt(row.balance_outstanding, row.currency)}</td>
                  <td><Badge value={row.bill_status} /></td>
                  <td>
                    <div className="td-actions">
                      <button className="secondary-btn" onClick={() => openView(row)}>Review</button>
                      <button className="primary-btn" onClick={() => changeStatus(row, 'APPROVED')}>Approve</button>
                      <button className="secondary-btn" onClick={() => changeStatus(row, 'REJECTED')}>Reject</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && rows.length > 0 && (
            <Pagination {...paginationProps} label="pending bills" />
          )}
        </div>
      </div>

      <BillViewModal
        billId={viewBillId}
        onClose={() => setViewBillId(null)}
        onApprove={(b) => changeStatus(b, 'APPROVED')}
        onReject={(b) => changeStatus(b, 'REJECTED')}
      />
    </div>
  )
}

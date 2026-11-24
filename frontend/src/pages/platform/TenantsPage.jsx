import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ConfirmDialog, DataTable, PanelHeader, StatCard, StatusChip } from '../../components/ui/index.jsx'
import { useToast } from '../../context/ToastContext'
import platformApi from '../../services/platformApi'
import { Icon, ICONS, initialsOf } from './platformUi'
import '../ClientsPage.css'

// Platform clients list — same layout pieces as the company Clients page.
export default function TenantsPage() {
  const toast = useToast()
  const navigate = useNavigate()

  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState('all')
  const [confirm, setConfirm] = useState(null)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    try {
      const res = await platformApi.get('/tenants')
      setRows(res.data.data || [])
    } catch (error) {
      toast.error(error.response?.data?.message || 'Unable to load clients')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const stats = useMemo(() => {
    const now = new Date()
    const active = rows.filter((r) => r.status === 'ACTIVE').length
    return {
      total: rows.length,
      active,
      suspended: rows.length - active,
      pending: rows.filter((r) => r.pending_invites > 0 || r.expired_invites > 0).length,
      thisMonth: rows.filter((r) => {
        const d = new Date(r.created_at)
        return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
      }).length,
    }
  }, [rows])

  const visibleRows = rows.filter((r) => {
    const q = search.trim().toLowerCase()
    if (q && !r.tenant_name.toLowerCase().includes(q) && !r.tenant_code.toLowerCase().includes(q)) return false
    if (tab === 'active') return r.status === 'ACTIVE'
    if (tab === 'suspended') return r.status === 'SUSPENDED'
    if (tab === 'invites') return r.pending_invites > 0 || r.expired_invites > 0
    return true
  })

  const applyStatus = async () => {
    if (!confirm) return
    const next = confirm.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE'
    try {
      setSaving(true)
      const res = await platformApi.patch(`/tenants/${confirm.id}`, { status: next })
      toast.success(res.data.message || 'Client updated')
      setConfirm(null)
      await load()
    } catch (error) {
      toast.error(error.response?.data?.message || 'Unable to update client')
    } finally {
      setSaving(false)
    }
  }

  const columns = [
    {
      key: 'tenant_name',
      header: 'COMPANY',
      primary: true,
      render: (r) => (
        <span className="cl-client">
          <span className="cl-avatar">{initialsOf(r.tenant_name)}</span>
          <span>{r.tenant_name}</span>
        </span>
      ),
    },
    { key: 'tenant_code', header: 'CODE', mono: true, render: (r) => r.tenant_code.toLowerCase() },
    {
      key: 'invites',
      header: 'ADMIN',
      render: (r) => (
        r.expired_invites > 0 ? <StatusChip tone="danger">INVITE EXPIRED</StatusChip>
          : r.pending_invites > 0 ? <StatusChip tone="warn">INVITE PENDING</StatusChip>
            : <StatusChip tone="neutral">ACTIVATED</StatusChip>
      ),
    },
    {
      key: 'created_at',
      header: 'ONBOARDED',
      mono: true,
      render: (r) => (r.created_at ? new Date(r.created_at).toLocaleDateString() : '—'),
    },
    {
      key: 'status',
      header: 'STATUS',
      render: (r) => <StatusChip tone={r.status === 'ACTIVE' ? 'success' : 'danger'}>{r.status}</StatusChip>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) => (
        <button
          type="button"
          className="cl-btn cl-btn-secondary plat-btn-sm"
          onClick={(e) => { e.stopPropagation(); setConfirm(r) }}
        >
          {r.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
        </button>
      ),
    },
  ]

  return (
    <div className="dashboard-page clients-page cl-page">
      <div className="cl-head">
        <div className="cl-head-left">
          <button type="button" className="cl-back" onClick={() => navigate('/platform/dashboard')} aria-label="Back to dashboard">
            <Icon d={ICONS.back} />
          </button>
          <div>
            <div className="cl-title">Clients</div>
            <div className="cl-subtitle">
              {rows.length} compan{rows.length === 1 ? 'y' : 'ies'} on the platform. Status, admin activation and onboarding date at a glance.
            </div>
          </div>
        </div>
        <div className="cl-head-actions">
          <button type="button" className="cl-btn cl-btn-primary" onClick={() => navigate('/platform/tenants/new')}>
            <Icon d={ICONS.plus} size={16} /> Onboard client
          </button>
        </div>
      </div>

      <div className="cl-kpis">
        <StatCard label="Total clients" value={stats.total} sub={`${stats.thisMonth} new this month`} icon={<Icon d={ICONS.building} size={16} />} />
        <StatCard label="Active" value={stats.active} sub="Users can sign in" icon={<Icon d={ICONS.check} size={16} />} />
        <StatCard label="Suspended" value={stats.suspended} sub="Sign-in blocked" icon={<Icon d={ICONS.pause} size={16} />} accent={stats.suspended > 0} />
        <StatCard label="Awaiting admin" value={stats.pending} sub="Invitation not accepted" icon={<Icon d={ICONS.mail} size={16} />} accent={stats.pending > 0} />
      </div>

      <div className="cl-filters">
        <div className="cl-search">
          <input
            placeholder="Search company or code"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Icon d={ICONS.search} size={16} />
        </div>
      </div>

      <div className="cl-panel">
        <PanelHeader
          title="All clients"
          tabs={[
            { key: 'all', label: 'All', count: stats.total },
            { key: 'active', label: 'Active', count: stats.active },
            { key: 'suspended', label: 'Suspended', count: stats.suspended },
            { key: 'invites', label: 'Awaiting admin', count: stats.pending },
          ]}
          activeTab={tab}
          onTab={setTab}
        />
        <DataTable
          columns={columns}
          rows={visibleRows}
          paginate
          pageLabel="clients"
          tableId="platform-clients"
          loading={loading}
          getRowId={(r) => r.id}
          onRowSelect={(r) => navigate(`/platform/tenants/${r.id}`)}
          empty="No clients found"
        />
      </div>

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={applyStatus}
        loading={saving}
        title={confirm?.status === 'ACTIVE' ? 'Suspend client?' : 'Reactivate client?'}
        message={
          confirm?.status === 'ACTIVE'
            ? `Users of ${confirm?.tenant_name} will be unable to sign in until it is reactivated.`
            : `Users of ${confirm?.tenant_name} will be able to sign in again.`
        }
      />
    </div>
  )
}

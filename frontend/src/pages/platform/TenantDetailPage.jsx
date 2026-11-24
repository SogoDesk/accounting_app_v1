import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Card, ConfirmDialog, DataTable, PanelHeader, StatCard, StatusChip } from '../../components/ui/index.jsx'
import { useToast } from '../../context/ToastContext'
import platformApi from '../../services/platformApi'
import InviteLinkBox from './InviteLinkBox'
import { Icon, ICONS, initialsOf } from './platformUi'
import '../ClientsPage.css'

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—')
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString() : 'Never')

const INVITE_TONE = { PENDING: 'warn', EXPIRED: 'danger', ACCEPTED: 'success' }

export default function TenantDetailPage() {
  const { id } = useParams()
  const toast = useToast()
  const navigate = useNavigate()

  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [resending, setResending] = useState(null)
  const [inviteLink, setInviteLink] = useState(null)

  const load = useCallback(async () => {
    try {
      const res = await platformApi.get(`/tenants/${id}`)
      setData(res.data.data)
      setError('')
    } catch (err) {
      setError(err.response?.data?.message || 'Unable to load client.')
    }
  }, [id])

  useEffect(() => { load() }, [load])

  const toggleStatus = async () => {
    const next = data.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE'
    try {
      setSaving(true)
      const res = await platformApi.patch(`/tenants/${id}`, { status: next })
      toast.success(res.data.message)
      setConfirm(false)
      await load()
    } catch (err) {
      toast.error(err.response?.data?.message || 'Unable to update client')
    } finally {
      setSaving(false)
    }
  }

  const resend = async (admin) => {
    try {
      setResending(admin.id)
      const res = await platformApi.post(`/tenants/${id}/admins/${admin.id}/resend-invite`)
      const d = res.data.data
      if (d.email_sent && d.email_driver !== 'console') toast.success(`Invitation sent to ${admin.email}`)
      else toast.success('New invitation link created — share it with the administrator')
      setInviteLink({ url: d.url, days: d.expires_in_days })
      await load()
    } catch (err) {
      toast.error(err.response?.data?.message || 'Unable to resend invitation')
    } finally {
      setResending(null)
    }
  }

  const back = (
    <button type="button" className="cl-back" onClick={() => navigate('/platform/tenants')} aria-label="Back to clients">
      <Icon d={ICONS.back} />
    </button>
  )

  if (error) {
    return (
      <div className="dashboard-page cl-page">
        <div className="cl-head"><div className="cl-head-left">{back}<div className="cl-title">Client</div></div></div>
        <div className="login-error" role="alert">{error}</div>
      </div>
    )
  }
  if (!data) return <div className="dashboard-page cl-page td-muted">Loading…</div>

  const active = data.status === 'ACTIVE'

  const columns = [
    {
      key: 'full_name',
      header: 'ADMINISTRATOR',
      primary: true,
      render: (a) => (
        <span className="cl-client">
          <span className="cl-avatar">{initialsOf(a.full_name)}</span>
          <span>{a.full_name}</span>
        </span>
      ),
    },
    { key: 'email', header: 'EMAIL', render: (a) => a.email },
    {
      key: 'status',
      header: 'ACCOUNT',
      render: (a) => <StatusChip tone={a.status === 'ACTIVE' ? 'success' : 'neutral'}>{a.status}</StatusChip>,
    },
    {
      key: 'invite_status',
      header: 'INVITATION',
      render: (a) => (a.invite_status === 'NONE' ? '—' : (
        <span>
          <StatusChip tone={INVITE_TONE[a.invite_status] || 'neutral'}>{a.invite_status}</StatusChip>
          {a.invite_status === 'PENDING' ? <span className="plat-muted-sm"> until {fmtDate(a.invite_expires_at)}</span> : null}
        </span>
      )),
    },
    { key: 'last_login_at', header: 'LAST SIGN-IN', mono: true, render: (a) => fmtDateTime(a.last_login_at) },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (a) => (a.status !== 'ACTIVE' ? (
        <button
          type="button"
          className="cl-btn cl-btn-secondary plat-btn-sm"
          disabled={!active || resending === a.id}
          title={active ? '' : 'Reactivate the client first'}
          onClick={() => resend(a)}
        >
          {resending === a.id ? 'Sending…' : 'Resend invite'}
        </button>
      ) : null),
    },
  ]

  return (
    <div className="dashboard-page clients-page cl-page">
      <div className="cl-head">
        <div className="cl-head-left">
          {back}
          <div>
            <div className="cl-title plat-title-row">
              {data.tenant_name}
              <StatusChip tone={active ? 'success' : 'danger'}>{data.status}</StatusChip>
            </div>
            <div className="cl-subtitle">
              Company code <strong>{data.tenant_code.toLowerCase()}</strong> · onboarded {fmtDate(data.created_at)}
            </div>
          </div>
        </div>
        <div className="cl-head-actions">
          <button
            type="button"
            className={`cl-btn ${active ? 'cl-btn-secondary plat-danger-text' : 'cl-btn-primary'}`}
            onClick={() => setConfirm(true)}
          >
            <Icon d={active ? ICONS.pause : ICONS.check} size={16} />
            {active ? 'Suspend client' : 'Reactivate client'}
          </button>
        </div>
      </div>

      <div className="cl-kpis">
        <StatCard label="Users" value={data.users?.total ?? 0} sub={`${data.users?.active ?? 0} active`} icon={<Icon d={ICONS.users} size={16} />} />
        <StatCard label="Base currency" value={data.currency || '—'} sub="Group reporting currency" icon={<Icon d={ICONS.coin} size={16} />} />
        <StatCard
          label="Fiscal year"
          value={data.fiscal_year?.year_label || '—'}
          sub={data.fiscal_year ? `${fmtDate(data.fiscal_year.start_date)} – ${fmtDate(data.fiscal_year.end_date)}` : 'Not set up'}
          icon={<Icon d={ICONS.calendar} size={16} />}
        />
        <StatCard
          label="Last sign-in"
          value={data.users?.last_login_at ? fmtDate(data.users.last_login_at) : 'Never'}
          sub="Any user of this company"
          icon={<Icon d={ICONS.clock} size={16} />}
        />
      </div>

      <div className="cl-panel">
        <PanelHeader title="Administrators" badge={String(data.admins.length)} />
        <DataTable
          columns={columns}
          rows={data.admins}
          pageLabel="administrators"
          tableId="platform-client-admins"
          getRowId={(a) => a.id}
          empty="No administrators found"
        />
      </div>

      {inviteLink ? (
        <Card className="plat-invite-card">
          <PanelHeader title="New invitation link" />
          <InviteLinkBox url={inviteLink.url} days={inviteLink.days} />
        </Card>
      ) : null}

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={toggleStatus}
        loading={saving}
        title={active ? 'Suspend client?' : 'Reactivate client?'}
        message={active
          ? `Users of ${data.tenant_name} will be unable to sign in until it is reactivated.`
          : `Users of ${data.tenant_name} will be able to sign in again.`}
      />
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, XAxis, Tooltip, CartesianGrid,
} from 'recharts'
import { Card, StatCard, PanelHeader, StatusChip, chartColors } from '../../components/ui'
import { usePlatformAuth } from '../../context/PlatformAuthContext'
import { useTheme } from '../../context/ThemeContext'
import platformApi from '../../services/platformApi'
import '../DashboardPage.css'

// Same building blocks and CSS as the company dashboard (dash-* classes).
const Ico = ({ d, size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
)
const ICONS = {
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  building: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>,
  alert: <><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9 2.4 18a1.9 1.9 0 0 0 1.7 2.9h15.8a1.9 1.9 0 0 0 1.7-2.9L13.7 3.9a1.9 1.9 0 0 0-3.4 0Z" /></>,
  pause: <><circle cx="12" cy="12" r="9" /><path d="M10 9v6M14 9v6" /></>,
  check: <><path d="M20 6 9 17l-5-5" /></>,
  chevron: <><path d="m9 6 6 6-6 6" /></>,
  list: <><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></>,
}

const initialsOf = (name) =>
  String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '—'

const monthsBack = (n) => {
  const out = []
  const now = new Date()
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    out.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleString('en-US', { month: 'short' }),
      count: 0,
    })
  }
  return out
}

export default function PlatformDashboardPage() {
  const { admin } = usePlatformAuth()
  const { accent, dark } = useTheme()
  const navigate = useNavigate()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    platformApi.get('/tenants')
      .then((res) => setRows(res.data.data || []))
      .catch((err) => setError(err.response?.data?.message || 'Unable to load clients.'))
      .finally(() => setLoading(false))
  }, [])

  const cc = useMemo(() => chartColors(accent, dark), [accent, dark])

  const m = useMemo(() => {
    const now = new Date()
    const active = rows.filter((r) => r.status === 'ACTIVE').length
    const suspended = rows.length - active
    const thisMonth = rows.filter((r) => {
      const d = new Date(r.created_at)
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
    }).length
    const thisYear = rows.filter((r) => new Date(r.created_at).getFullYear() === now.getFullYear()).length
    const pending = rows.reduce((s, r) => s + (r.pending_invites || 0), 0)
    const expired = rows.reduce((s, r) => s + (r.expired_invites || 0), 0)

    const trend = monthsBack(12)
    const byKey = Object.fromEntries(trend.map((t) => [t.key, t]))
    rows.forEach((r) => {
      const k = String(r.created_at || '').slice(0, 7)
      if (byKey[k]) byKey[k].count += 1
    })

    return { total: rows.length, active, suspended, thisMonth, thisYear, pending, expired, trend }
  }, [rows])

  const donut = [
    { name: 'Active', value: m.active, color: cc.series[0] },
    { name: 'Suspended', value: m.suspended, color: cc.series[5] },
  ]

  const attention = useMemo(() => {
    const out = []
    rows.filter((r) => r.expired_invites > 0).forEach((r) => out.push({
      id: `ex-${r.id}`, icon: 'alert', tone: 'danger',
      title: `${r.tenant_name}: invitation expired`, sub: 'Resend so the admin can set a password', to: `/platform/tenants/${r.id}`,
    }))
    rows.filter((r) => r.pending_invites > 0).forEach((r) => out.push({
      id: `pe-${r.id}`, icon: 'mail', tone: 'warn',
      title: `${r.tenant_name}: admin not activated`, sub: 'Invitation sent, waiting for the admin', to: `/platform/tenants/${r.id}`,
    }))
    rows.filter((r) => r.status === 'SUSPENDED').forEach((r) => out.push({
      id: `su-${r.id}`, icon: 'pause', tone: 'neutral',
      title: `${r.tenant_name} is suspended`, sub: 'Its users cannot sign in', to: `/platform/tenants/${r.id}`,
    }))
    return out.slice(0, 5)
  }, [rows])

  const recent = rows.slice(0, 5) // API returns newest first

  const hour = new Date().getHours()
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const firstName = (admin?.fullName || 'there').trim().split(/\s+/)[0]
  const tip = { borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12, fontFamily: 'var(--font-mono)' }
  const show = (v) => (loading ? '…' : v)

  return (
    <div className="dash">
      <header className="dash-head">
        <div className="dash-head-l">
          <h1 className="dash-title">{greet}, {firstName}</h1>
          <p className="dash-sub">
            {loading ? 'Loading clients…' : `${m.total} client compan${m.total === 1 ? 'y' : 'ies'} on SogoDesk Books · ${m.active} active`}
          </p>
        </div>
        <div className="dash-head-r">
          <Link to="/platform/tenants" className="dash-btn dash-btn-ghost">
            <Ico d={ICONS.list} size={15} /> All clients
          </Link>
          <Link to="/platform/tenants/new" className="dash-btn dash-btn-primary">
            <Ico d={ICONS.plus} size={15} /> Onboard client
          </Link>
        </div>
      </header>

      {error ? <div className="login-error" role="alert">{error}</div> : null}

      <section className="dash-kpis">
        <StatCard label="Total clients" value={show(m.total)} sub={`${m.thisYear} onboarded this year`} />
        <StatCard label="Active" value={show(m.active)} sub={m.total ? `${Math.round((m.active / m.total) * 100)}% of clients` : '—'} />
        <StatCard label="Suspended" value={show(m.suspended)} sub="Users blocked from sign-in" />
        <StatCard label="New this month" value={show(m.thisMonth)} sub={new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' })} />
        <StatCard label="Pending invites" value={show(m.pending)} sub={m.expired ? `${m.expired} expired` : 'Admins yet to activate'} />
      </section>

      <section className="dash-r2">
        <Card className="dash-card">
          <PanelHeader title="Client onboarding" actions={<span className="dash-meta">Last 12 months</span>} />
          <div className="dash-legend">
            <span className="dash-sw" style={{ background: cc.gradientTo }} />New clients
          </div>
          <div className="dash-chart" style={{ height: 150 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={m.trend} barCategoryGap="28%" margin={{ top: 6, right: 4, left: 4, bottom: 0 }}>
                <defs>
                  <linearGradient id="platGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={cc.gradientFrom} />
                    <stop offset="100%" stopColor={cc.gradientTo} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={cc.grid} vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: cc.axis, fontFamily: 'var(--font-mono)' }} axisLine={false} tickLine={false} interval={0} />
                <Tooltip cursor={{ fill: 'var(--surface-sunken)' }} formatter={(v) => [v, 'New clients']} contentStyle={tip} />
                <Bar dataKey="count" fill="url(#platGrad)" radius={[5, 5, 2, 2]} maxBarSize={18} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="dash-sumrow">
            <div className="dash-sum"><span className="dash-sum-k">This month</span><span className="dash-sum-v">{m.thisMonth}</span></div>
            <div className="dash-sum"><span className="dash-sum-k">This year</span><span className="dash-sum-v">{m.thisYear}</span></div>
            <div className="dash-sum"><span className="dash-sum-k">All time</span><span className="dash-sum-v">{m.total}</span></div>
          </div>
        </Card>

        <Card className="dash-card">
          <PanelHeader title="Client status" actions={<Link to="/platform/tenants" className="dash-meta dash-link">View all</Link>} />
          <div className="dash-donut-wrap">
            <div className="dash-donut">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={donut.filter((d) => d.value > 0).length ? donut.filter((d) => d.value > 0) : [{ name: 'None', value: 1, color: cc.grid }]}
                    dataKey="value" nameKey="name" innerRadius={48} outerRadius={70} paddingAngle={2} stroke="none"
                  >
                    {(donut.filter((d) => d.value > 0).length ? donut.filter((d) => d.value > 0) : [{ name: 'None', color: cc.grid }])
                      .map((d) => <Cell key={d.name} fill={d.color} />)}
                  </Pie>
                  <Tooltip contentStyle={tip} />
                </PieChart>
              </ResponsiveContainer>
              <div className="dash-donut-center"><span className="dash-donut-total">{m.total}</span><span className="dash-donut-cap">Clients</span></div>
            </div>
            <div className="dash-donut-legend">
              {donut.map((d) => (
                <div key={d.name} className="dash-lg-row">
                  <span className="dash-lg-dot" style={{ background: d.color }} />
                  <span className="dash-lg-k">{d.name}</span>
                  <span className="dash-lg-v">{d.value}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="dash-stat3">
            <div><span className="dash-s3-k">Active rate</span><span className="dash-s3-v">{m.total ? Math.round((m.active / m.total) * 100) : 0}<em>%</em></span></div>
            <div><span className="dash-s3-k">Pending invites</span><span className="dash-s3-v">{m.pending}</span></div>
            <div><span className="dash-s3-k">Expired invites</span><span className="dash-s3-v">{m.expired}</span></div>
          </div>
        </Card>
      </section>

      <section className="dash-r3">
        <Card className="dash-card">
          <PanelHeader title="Recently onboarded" actions={<Link to="/platform/tenants" className="dash-meta dash-link">View all</Link>} />
          <div className="dash-clients">
            {!loading && recent.length === 0 ? <div className="dash-empty">No clients yet.</div> : recent.map((r) => (
              <div
                key={r.id}
                className="dash-client plat-click"
                role="link"
                tabIndex={0}
                onClick={() => navigate(`/platform/tenants/${r.id}`)}
                onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/platform/tenants/${r.id}`) }}
              >
                <span className="dash-avatar">{initialsOf(r.tenant_name)}</span>
                <span className="dash-client-main">
                  <span className="dash-client-name">{r.tenant_name}</span>
                  <span className="dash-client-sub">{r.tenant_code.toLowerCase()} · {new Date(r.created_at).toLocaleDateString()}</span>
                </span>
                <StatusChip tone={r.status === 'ACTIVE' ? 'success' : 'danger'}>{r.status}</StatusChip>
              </div>
            ))}
          </div>
        </Card>

        <Card className="dash-card">
          <PanelHeader title="Needs attention" />
          <div className="dash-attn">
            {attention.length === 0 ? (
              <div className="dash-attn-row">
                <span className="dash-attn-ico tone-accent"><Ico d={ICONS.check} size={16} /></span>
                <span className="dash-attn-main"><span className="dash-attn-t">All clear</span><span className="dash-attn-s">No pending invites or suspended clients</span></span>
              </div>
            ) : attention.map((a) => (
              <Link key={a.id} to={a.to} className="dash-attn-row">
                <span className={`dash-attn-ico tone-${a.tone}`}><Ico d={ICONS[a.icon]} size={16} /></span>
                <span className="dash-attn-main"><span className="dash-attn-t">{a.title}</span><span className="dash-attn-s">{a.sub}</span></span>
                <span className="dash-attn-chev"><Ico d={ICONS.chevron} size={16} /></span>
              </Link>
            ))}
          </div>
        </Card>

        <Card className="dash-card-button">
          <PanelHeader title="Quick actions" />
          <div className="dash-qa">
            <Link to="/platform/tenants/new" className="dash-qa-tile is-filled">
              <span className="dash-qa-ico"><Ico d={ICONS.plus} size={16} /></span>
              <span className="dash-qa-label">Onboard client</span>
            </Link>
            <Link to="/platform/tenants" className="dash-qa-tile">
              <span className="dash-qa-ico"><Ico d={ICONS.building} size={16} /></span>
              <span className="dash-qa-label">All clients</span>
            </Link>
          </div>
          <div className="dash-qa-foot">
            <span className="dash-qa-foot-l">Signed in as <strong>{admin?.fullName || admin?.email || '—'}</strong></span>
            <StatusChip tone="accent">PLATFORM ADMIN</StatusChip>
          </div>
        </Card>
      </section>
    </div>
  )
}

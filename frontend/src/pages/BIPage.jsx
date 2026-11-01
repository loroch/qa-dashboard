import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import axios from 'axios'
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import { Header } from '../components/layout/Header'
import { BASE_URL } from '../services/api'
import {
  BarChart3, Database, Search, Loader2, Sparkles, Table2, LineChart as LineIcon, CheckCircle2, AlertTriangle,
  XCircle, Clock, Server, RefreshCw,
} from 'lucide-react'

// Reports run many queries on SQL Server + Elastic
const api = axios.create({ baseURL: BASE_URL, timeout: 300000 })
const apiErr = (e) => e?.response?.data?.detail || e.message

// dataviz reference palette — first three categorical slots (validated all-pairs, light + dark)
const SERIES = {
  light: ['#2a78d6', '#eb6834', '#1baf7a'],
  dark: ['#3987e5', '#d95926', '#199e70'],
}
const STATUS = { good: '#0ca30c', warning: '#fab219', critical: '#d03b3b' }

function useIsDark() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')))
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  return dark
}

const fmtN = (n) => (n == null ? '—' : Number(n).toLocaleString())
const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '—')
function fmtDur(s) {
  if (s == null) return '—'
  const v = Math.abs(s)
  if (v < 60) return `${Math.round(s)}s`
  if (v < 3600) return `${Math.round(s / 6) / 10}m`
  if (v < 86400) return `${Math.round(s / 360) / 10}h`
  return `${Math.round(s / 8640) / 10}d`
}

const RANGES = [['1d', '24 hours'], ['7d', '1 week'], ['30d', '1 month'], ['90d', '3 months'], ['custom', 'Custom']]

function Card({ title, icon: Icon, right, children, className = '' }) {
  return (
    <div className={`card p-4 ${className}`}>
      {title && (
        <div className="flex items-center gap-2 mb-3">
          {Icon && <Icon className="h-4 w-4 text-brand-600 dark:text-brand-300" />}
          <h3 className="font-semibold text-sm flex-1">{title}</h3>
          {right}
        </div>
      )}
      {children}
    </div>
  )
}

function Stat({ label, value, sub }) {
  return (
    <div className="card px-4 py-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="text-2xl font-semibold mt-0.5">{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
    </div>
  )
}

function Table({ columns, rows, max = 400 }) {
  return (
    <div className="overflow-auto border border-gray-200 dark:border-slate-700 rounded" style={{ maxHeight: max }}>
      <table className="text-xs w-full">
        <thead className="bg-gray-50 dark:bg-slate-800 sticky top-0">
          <tr>{columns.map(c => <th key={c} className="text-left px-2 py-1.5 font-medium whitespace-nowrap">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-gray-100 dark:border-slate-700 align-top">
              {r.map((v, j) => <td key={j} className="px-2 py-1">{v}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// Inline magnitude bar for tables (single hue, text stays in text ink)
function MiniBar({ value, max, color }) {
  return (
    <div className="flex items-center gap-2 min-w-[8rem]">
      <div className="h-2 rounded-sm" style={{ width: `${max ? Math.max(2, (value / max) * 100) : 0}%`, background: color, maxWidth: '7rem' }} />
      <span>{fmtN(value)}</span>
    </div>
  )
}

function chartTheme(dark) {
  return {
    grid: dark ? '#334155' : '#e5e7eb',
    axis: dark ? '#94a3b8' : '#6b7280',
    tooltip: {
      contentStyle: { background: dark ? '#1e293b' : '#ffffff', border: `1px solid ${dark ? '#334155' : '#e5e7eb'}`, borderRadius: 6, fontSize: 12 },
      labelStyle: { color: dark ? '#f1f5f9' : '#0f172a', fontWeight: 600 },
      itemStyle: { color: dark ? '#e2e8f0' : '#334155' },
    },
  }
}

function SimpleBars({ data, x, y, color, height = 200, layout = 'horizontal', dark, yWidth = 120, valueLabel }) {
  const th = chartTheme(dark)
  const vertical = layout === 'vertical'
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout={layout} margin={{ top: 4, right: 12, left: 0, bottom: 0 }} barCategoryGap={2}>
        <CartesianGrid stroke={th.grid} vertical={vertical} horizontal={!vertical} />
        {vertical ? (
          <>
            <XAxis type="number" tick={{ fontSize: 11, fill: th.axis }} axisLine={false} tickLine={false} />
            <YAxis type="category" dataKey={x} width={yWidth} interval={0} tick={{ fontSize: 11, fill: th.axis }} axisLine={false} tickLine={false} />
          </>
        ) : (
          <>
            <XAxis dataKey={x} tick={{ fontSize: 11, fill: th.axis }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 11, fill: th.axis }} axisLine={false} tickLine={false} width={44} />
          </>
        )}
        <Tooltip {...th.tooltip} cursor={{ fill: dark ? '#33415555' : '#e5e7eb88' }} formatter={(v) => [fmtN(v), valueLabel || y]} />
        <Bar dataKey={y} fill={color} radius={vertical ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={28} />
      </BarChart>
    </ResponsiveContainer>
  )
}

function DailyChart({ daily, dark }) {
  const [asTable, setAsTable] = useState(false)
  const colors = SERIES[dark ? 'dark' : 'light']
  const th = chartTheme(dark)
  const keys = [['created', 'Created'], ['closed', 'Closed'], ['updates', 'Updates']]
  return (
    <Card title="Events per day (UTC)" icon={LineIcon} right={
      <button className="btn-secondary text-xs flex items-center gap-1" onClick={() => setAsTable(t => !t)}>
        {asTable ? <LineIcon className="h-3.5 w-3.5" /> : <Table2 className="h-3.5 w-3.5" />}{asTable ? 'Chart' : 'Table'}
      </button>
    }>
      {asTable ? (
        <Table columns={['Day', 'Created', 'Closed', 'Updates', 'Dispatched']}
          rows={daily.map(d => [d.day, fmtN(d.created), fmtN(d.closed), fmtN(d.updates), fmtN(d.dispatched)])} max={300} />
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={daily} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={th.grid} vertical={false} />
            <XAxis dataKey="day" tick={{ fontSize: 11, fill: th.axis }} tickFormatter={d => d.slice(5)} axisLine={false} tickLine={false} minTickGap={16} />
            <YAxis tick={{ fontSize: 11, fill: th.axis }} axisLine={false} tickLine={false} width={44} />
            <Tooltip {...th.tooltip} cursor={{ stroke: th.axis, strokeDasharray: '3 3' }} />
            <Legend wrapperStyle={{ fontSize: 12 }} iconType="plainline" />
            {keys.map(([k, label], i) => (
              <Line key={k} type="monotone" dataKey={k} name={label} stroke={colors[i]} strokeWidth={2}
                dot={daily.length <= 14 ? { r: 4, strokeWidth: 2, stroke: dark ? '#1e293b' : '#fff', fill: colors[i] } : false}
                activeDot={{ r: 5, strokeWidth: 2, stroke: dark ? '#1e293b' : '#fff' }} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
    </Card>
  )
}

function QualityList({ quality, created }) {
  const items = [
    ['closed_without_reason', 'Closed without a closing reason'],
    ['open_older_than_7d', 'Still open after 7+ days'],
    ['closed_without_close_time', 'Closed state but no close time'],
    ['close_time_but_not_closed', 'Close time set but not closed'],
    ['closed_before_created', 'Closed before created'],
    ['modified_before_created', 'Modified before created'],
    ['invalid_severity', 'Missing / invalid severity'],
    ['dispatch_arrived_before_dispatched', 'Dispatch "Arrived" before "Dispatch"'],
  ]
  return (
    <ul className="space-y-1.5 text-sm">
      {items.map(([k, label]) => {
        const v = quality?.[k] ?? 0
        const share = created ? v / created : 0
        const level = v === 0 ? 'good' : share > 0.2 ? 'critical' : 'warning'
        const Icon = level === 'good' ? CheckCircle2 : level === 'critical' ? XCircle : AlertTriangle
        return (
          <li key={k} className="flex items-center gap-2">
            <Icon className="h-4 w-4 shrink-0" style={{ color: STATUS[level] }} />
            <span className="flex-1">{label}</span>
            <span className="text-xs text-gray-500 w-20 text-right">{level === 'good' ? 'OK' : level === 'critical' ? 'Problem' : 'Check'}</span>
            <span className="font-medium w-24 text-right">{fmtN(v)}{created && v ? <span className="text-xs text-gray-500"> ({pct(v, created)})</span> : ''}</span>
          </li>
        )
      })}
    </ul>
  )
}

function Insights({ data, loading, error, onRun }) {
  const sevColor = { high: STATUS.critical, medium: STATUS.warning, low: '#94a3b8' }
  return (
    <Card title="AI insights" icon={Sparkles} right={
      <button className="btn-secondary text-xs flex items-center gap-1" onClick={onRun} disabled={loading}>
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}{data ? 'Regenerate' : 'Generate'}
      </button>
    }>
      {loading && !data && <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Analysing the numbers… (20–40 s)</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      {data && (
        <div className="space-y-3 text-sm">
          <p className="font-medium">{data.headline}</p>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div><p className="text-xs font-semibold uppercase text-gray-500 mb-1">Highlights</p>
              <ul className="list-disc pl-4 space-y-1 text-xs">{(data.highlights || []).map((h, i) => <li key={i}>{h}</li>)}</ul></div>
            <div><p className="text-xs font-semibold uppercase text-gray-500 mb-1">Anomalies</p>
              <ul className="space-y-1.5 text-xs">{(data.anomalies || []).map((a, i) => (
                <li key={i} className="flex gap-2"><AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" style={{ color: sevColor[a.severity] || sevColor.low }} />
                  <span><b>{a.title}</b> <span className="text-gray-500">({a.severity})</span><br />{a.detail}</span></li>
              ))}</ul></div>
            <div><p className="text-xs font-semibold uppercase text-gray-500 mb-1">Recommendations</p>
              <ul className="list-disc pl-4 space-y-1 text-xs">{(data.recommendations || []).map((r, i) => <li key={i}>{r}</li>)}</ul></div>
          </div>
        </div>
      )}
    </Card>
  )
}

function DbSection({ db, dark }) {
  const blue = SERIES[dark ? 'dark' : 'light'][0]
  const k = db.kpi
  const sevMax = Math.max(1, ...db.severity.map(s => s.count))
  const typeMax = Math.max(1, ...db.types.map(s => s.count))
  const times = db.times
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
        <Stat label="Events created" value={fmtN(k.created)} sub={`${pct(k.manual, k.created)} manual · ${fmtN(k.created - k.manual)} automatic`} />
        <Stat label="Closed" value={pct(k.closed, k.created)} sub={`${fmtN(k.closed)} closed · ${fmtN(k.still_open)} still open`} />
        <Stat label="With images / files" value={pct(k.with_files, k.created)} sub={`${fmtN(k.with_files)} events · ${fmtN(k.files)} files`} />
        <Stat label="With dispatch" value={pct(k.with_dispatch, k.created)} sub={`${fmtN(k.dispatch_requests)} unit requests`} />
        <Stat label="With detections" value={pct(k.with_detections, k.created)} sub={`${fmtN(k.detections)} detections · ${fmtN(k.with_cameras)} with cameras`} />
        <Stat label="Updates per event" value={k.avg_updates_per_event ?? '—'} sub={`${fmtN(k.updates)} updates · max ${fmtN(k.max_updates_per_event)} · ${fmtN(k.never_updated)} never updated`} />
        <Stat label="Create → close (median)" value={fmtDur(times.create_to_close.p50)} sub={`p90 ${fmtDur(times.create_to_close.p90)} · avg ${fmtDur(times.create_to_close.avg)}`} />
        <Stat label="Create → first update (median)" value={fmtDur(times.create_to_first_update.p50)} sub={`p90 ${fmtDur(times.create_to_first_update.p90)} · ${fmtN(times.create_to_first_update.count)} events`} />
        <Stat label="Severity overridden" value={pct(k.severity_overridden, k.created)} sub={`${fmtN(k.severity_overridden)} events`} />
        <Stat label="Linked / related" value={fmtN(k.with_linked_events)} sub={`${fmtN(k.with_objects)} with objects`} />
      </div>

      <DailyChart daily={db.daily} dark={dark} />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card title="By severity" icon={BarChart3}>
          <Table columns={['Severity', 'Events', 'Closed', 'Close p50', 'Close p90', 'Close max']}
            rows={db.severity.map(s => [s.name, <MiniBar value={s.count} max={sevMax} color={blue} />, pct(s.closed, s.count),
              fmtDur(s.close_time.p50), fmtDur(s.close_time.p90), fmtDur(s.close_time.max)])} />
        </Card>
        <Card title="End-to-end times" icon={Clock}>
          <Table columns={['Step (from event creation)', 'Events', 'Median', 'p90', 'Average', 'Max']}
            rows={[
              ['First update', times.create_to_first_update],
              ['Closed', times.create_to_close],
              ...times.dispatch_funnel.map(f => [`Dispatch: ${f.step}`, f]),
            ].map(([label, t]) => [label, fmtN(t.count), fmtDur(t.p50), fmtDur(t.p90), fmtDur(t.avg), fmtDur(t.max)])} />
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card title="Updates per event" icon={BarChart3}>
          <SimpleBars data={db.updates.distribution} x="bucket" y="events" color={blue} dark={dark} valueLabel="Events" />
          <p className="text-xs text-gray-500 mt-1">Number of updates (audit "U" rows) per event created in the period.</p>
        </Card>
        <Card title="What changes in an update" icon={BarChart3}>
          <SimpleBars data={db.updates.changed_fields.filter(f => f.count)} x="field" y="count" color={blue} dark={dark}
            layout="vertical" height={Math.max(160, db.updates.changed_fields.filter(f => f.count).length * 24)} yWidth={100} valueLabel="Updates" />
        </Card>
        <Card title="Data quality" icon={CheckCircle2}>
          <QualityList quality={db.quality} created={k.created} />
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card title="Created by hour of day (UTC)" icon={Clock}>
          <SimpleBars data={db.hours} x="hour" y="count" color={blue} dark={dark} valueLabel="Events" />
        </Card>
        <Card title="Created by weekday" icon={BarChart3}>
          <SimpleBars data={db.weekdays} x="day" y="count" color={blue} dark={dark} valueLabel="Events" />
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card title="Top event types" icon={BarChart3}>
          <Table columns={['Type', 'Events', 'Closed']} rows={db.types.map(t => [<span title={`id ${t.id}`}>{t.name}</span>, <MiniBar value={t.count} max={typeMax} color={blue} />, pct(t.closed, t.count)])} />
        </Card>
        <Card title="Source & state" icon={BarChart3}>
          <Table columns={['Source', 'Events', 'Share']} rows={db.source.map(s => [s.name, fmtN(s.count), pct(s.count, k.created)])} max={200} />
          <div className="mt-3"><Table columns={['State', 'Events', 'Share']} rows={db.state.map(s => [s.name, fmtN(s.count), pct(s.count, k.created)])} max={200} /></div>
        </Card>
        <Card title="Top creators & most-updated events" icon={BarChart3}>
          <Table columns={['Created by', 'Events']} rows={db.creators.map(c => [c.name, fmtN(c.count)])} max={200} />
          <div className="mt-3"><Table columns={['Event', 'Updates', 'Severity', 'Type']}
            rows={db.updates.most_updated.map(m => [m.id, m.updates, m.severity, m.type])} max={200} /></div>
        </Card>
      </div>
      {Object.keys(db.errors || {}).length > 0 && <p className="text-xs text-red-600">Some queries failed: {Object.entries(db.errors).map(([n, e]) => `${n}: ${e}`).join(' · ')}</p>}
    </>
  )
}

function EsSection({ es, range, dark }) {
  const blue = SERIES[dark ? 'dark' : 'light'][0]
  const cov = es.coverage || {}
  const clipped = cov.first && new Date(cov.first) > new Date(range.from)
  const totals = (es.services || []).reduce((a, s) => {
    const l = s.levels || {}
    a.errors += (l.error || 0) + (l.fatal || 0) + (l.critical || 0)
    a.warnings += (l.warning || 0) + (l.warn || 0)
    return a
  }, { errors: 0, warnings: 0 })
  const web5xx = (es.web?.status_codes || []).filter(c => c.code >= 500).reduce((a, c) => a + c.count, 0)
  const webAll = (es.web?.status_codes || []).reduce((a, c) => a + c.count, 0)
  return (
    <>
      {clipped && (
        <div className="card px-4 py-2 text-xs flex items-center gap-2" style={{ borderLeft: `3px solid ${STATUS.warning}` }}>
          <AlertTriangle className="h-4 w-4" style={{ color: STATUS.warning }} />
          Elastic only keeps logs from {cov.first?.slice(0, 16).replace('T', ' ')} — log figures cover {Math.round((new Date(cov.last) - new Date(cov.first)) / 86400000 * 10) / 10} days, not the whole selected period. Detections go further back.
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Stat label="Log lines" value={fmtN(cov.lines)} sub={`${(es.services || []).map(s => `${s.service} ${fmtN(s.lines)}`).join(' · ')}`} />
        <Stat label="Errors" value={fmtN(totals.errors)} sub={`${pct(totals.errors, cov.lines)} of lines`} />
        <Stat label="Warnings" value={fmtN(totals.warnings)} />
        <Stat label="Web 5xx" value={fmtN(web5xx)} sub={`${pct(web5xx, webAll)} of ${fmtN(webAll)} requests`} />
        <Stat label="BFF API calls analysed" value={fmtN(es.bff?.lines_analyzed)} sub={es.bff?.capped ? 'newest 100K only' : 'all in range'} />
        <Stat label="Detections" value={fmtN(es.detections?.total)} sub={`${fmtN(es.detections?.sensors)} sensors · ${pct(es.detections?.with_files, es.detections?.total)} with files`} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card title="Error log lines per day" icon={BarChart3}>
          <SimpleBars data={es.daily || []} x="day" y="errors" color={blue} dark={dark} valueLabel="Errors" />
        </Card>
        <Card title="Detections per day" icon={BarChart3}>
          <SimpleBars data={es.detections?.daily || []} x="day" y="count" color={blue} dark={dark} valueLabel="Detections" />
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card title="BFF API — slowest endpoints (p95)" icon={Server}>
          <Table columns={['Endpoint', 'Calls', 'Avg', 'p95', 'Max', '5xx', '4xx']}
            rows={(es.bff?.slowest || []).map(e => [e.endpoint, fmtN(e.calls), `${fmtN(e.avg_ms)} ms`, `${fmtN(e.p95_ms)} ms`, `${fmtN(e.max_ms)} ms`, e.errors_5xx, e.errors_4xx])} />
        </Card>
        <Card title="C-Insight — slowest operations (p95)" icon={Server}>
          <Table columns={['Operation', 'Logger', 'Calls', 'Avg', 'p95', 'Max']}
            rows={(es.cinsight_ops?.slowest || []).map(o => [o.operation, o.logger, fmtN(o.calls), `${o.avg_s}s`, `${o.p95_s}s`, `${o.max_s}s`])} />
        </Card>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <Card title="Event-related API endpoints" icon={Server}>
          <Table columns={['Endpoint', 'Calls', 'p95']} rows={(es.bff?.event_endpoints || []).map(e => [e.endpoint, fmtN(e.calls), `${fmtN(e.p95_ms)} ms`])} />
        </Card>
        <Card title="Components with errors" icon={AlertTriangle}>
          <Table columns={['Logger', 'Errors']} rows={(es.error_components || []).map(e => [e.logger, fmtN(e.errors)])} max={220} />
          <div className="mt-3"><Table columns={['Log file', 'Errors']} rows={(es.error_files || []).map(e => [e.file, fmtN(e.errors)])} max={220} /></div>
        </Card>
        <Card title="Web status codes & failing URLs" icon={Server}>
          <Table columns={['Status', 'Requests']} rows={(es.web?.status_codes || []).map(c => [c.code, fmtN(c.count)])} max={220} />
          <div className="mt-3"><Table columns={['URL (4xx/5xx)', 'Count']} rows={(es.web?.bad_urls || []).map(u => [u.url, fmtN(u.count)])} max={220} /></div>
        </Card>
      </div>

      <Card title="Most frequent error messages" icon={AlertTriangle} right={<span className="text-xs text-gray-500">grouped from the newest 400 error lines</span>}>
        <Table columns={['Count', 'Logger', 'Latest', 'Message']}
          rows={(es.top_errors || []).map(g => [g.count, g.logger, g.latest?.slice(0, 16).replace('T', ' '), <span className="break-all">{g.sample}</span>])} />
      </Card>
      {Object.keys(es.errors || {}).length > 0 && <p className="text-xs text-red-600">Some Elastic queries failed: {Object.entries(es.errors).map(([n, e]) => `${n}: ${e}`).join(' · ')}</p>}
    </>
  )
}

export default function BIPage() {
  const dark = useIsDark()
  const [range, setRange] = useState('7d')
  const today = new Date().toISOString().slice(0, 10)
  const [from, setFrom] = useState(new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10))
  const [to, setTo] = useState(today)
  const [sources, setSources] = useState({ db: true, elastic: true })
  const [database, setDatabase] = useState('')
  const [auditDb, setAuditDb] = useState('VulcanAuditDB')
  const [tab, setTab] = useState('db')
  const [report, setReport] = useState(null)

  const profileQ = useQuery({ queryKey: ['validation-profile'], queryFn: () => api.get('/validation/profile').then(r => r.data) })
  const dbsQ = useQuery({ queryKey: ['bi-databases'], queryFn: () => api.get('/bi/databases').then(r => r.data.databases), retry: false })
  const lastQ = useQuery({ queryKey: ['bi-last'], queryFn: () => api.get('/bi/last').then(r => r.data.report) })
  useEffect(() => { if (!report && lastQ.data) setReport(lastQ.data) }, [lastQ.data])
  useEffect(() => { if (!database && profileQ.data) setDatabase(profileQ.data.db?.database || 'Vulcan') }, [profileQ.data])

  const insights = useMutation({ mutationFn: (r) => api.post('/bi/insights', { report: r }).then(x => x.data) })
  const gen = useMutation({
    mutationFn: () => api.post('/bi/report', {
      range, date_from: range === 'custom' ? from : null, date_to: range === 'custom' ? to : null,
      sources, database, audit_database: auditDb,
    }).then(r => r.data),
    onSuccess: (r) => { setReport(r); insights.reset(); insights.mutate(r) },
  })

  const env = profileQ.data
  const hasDb = report?.db && !report.db.error
  const hasEs = report?.elastic && !report.elastic.error
  useEffect(() => { if (report && !hasDb && hasEs) setTab('elastic') }, [report])
  const rangeLabel = useMemo(() => report ? `${report.range.from.slice(0, 16).replace('T', ' ')} → ${report.range.to.slice(0, 16).replace('T', ' ')} UTC` : '', [report])

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <Header title="BI Analytics" />
      <div className="flex-1 p-6 space-y-4 overflow-auto">
        <div className="card p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-500 mr-1">Period</span>
            {RANGES.map(([id, label]) => (
              <button key={id} onClick={() => setRange(id)}
                className={`text-sm px-3 py-1 rounded-full border ${range === id ? 'border-brand-500 bg-brand-50 dark:bg-slate-700 font-medium' : 'border-gray-200 dark:border-slate-600'}`}>{label}</button>
            ))}
            {range === 'custom' && (
              <span className="flex items-center gap-1 text-sm">
                <input type="date" className="rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1" value={from} max={to} onChange={e => setFrom(e.target.value)} />
                <span className="text-gray-500">to</span>
                <input type="date" className="rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1" value={to} min={from} max={today} onChange={e => setTo(e.target.value)} />
              </span>
            )}
            <div className="flex-1" />
            <button className="btn-primary flex items-center gap-1" onClick={() => gen.mutate()} disabled={gen.isPending || (!sources.db && !sources.elastic)}>
              {gen.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <BarChart3 className="h-4 w-4" />}Generate report
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <span className="text-xs text-gray-500">Environment: <b>{env?.name || '…'}</b> — <a href="/validation" className="text-brand-600 dark:text-brand-300 hover:underline">edit in Validation Portal</a></span>
            <label className="flex items-center gap-1"><input type="checkbox" checked={sources.db} onChange={e => setSources(s => ({ ...s, db: e.target.checked }))} />
              <Database className="h-4 w-4 text-gray-500" />SQL Server {env?.db?.server}</label>
            {sources.db && (
              <>
                <label className="flex items-center gap-1 text-xs text-gray-500">Database
                  <select className="rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm text-gray-900 dark:text-gray-100" value={database} onChange={e => setDatabase(e.target.value)}>
                    {(dbsQ.data || [database]).map(d => <option key={d}>{d}</option>)}
                  </select></label>
                <label className="flex items-center gap-1 text-xs text-gray-500">Audit DB
                  <select className="rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2 py-1 text-sm text-gray-900 dark:text-gray-100" value={auditDb} onChange={e => setAuditDb(e.target.value)}>
                    {(dbsQ.data || [auditDb]).map(d => <option key={d}>{d}</option>)}
                  </select></label>
              </>
            )}
            <label className="flex items-center gap-1"><input type="checkbox" checked={sources.elastic} onChange={e => setSources(s => ({ ...s, elastic: e.target.checked }))} />
              <Search className="h-4 w-4 text-gray-500" />Elastic {env?.elastic?.url}</label>
            {dbsQ.isError && <span className="text-xs text-red-600">DB list: {apiErr(dbsQ.error)}</span>}
          </div>
          {gen.isPending && <p className="text-xs text-gray-500">Querying {sources.db ? 'SQL Server' : ''}{sources.db && sources.elastic ? ' and ' : ''}{sources.elastic ? 'Elastic' : ''}… usually 15–60 s depending on the period.</p>}
          {gen.isError && <p className="text-sm text-red-600">{apiErr(gen.error)}</p>}
        </div>

        {report && (
          <>
            <p className="text-xs text-gray-500">
              Report for <b>{rangeLabel}</b> ({report.range.days} days) · {report.environment.database} on {report.environment.db_server} · generated {new Date(report.generated_at).toLocaleString()} in {Math.round(report.took_ms / 100) / 10}s
            </p>
            <Insights data={insights.data || report.insights} loading={insights.isPending} error={insights.isError ? apiErr(insights.error) : null} onRun={() => insights.mutate(report)} />
            <div className="flex gap-1 border-b border-gray-200 dark:border-slate-700">
              {[['db', 'Events (Vulcan DB)', Database, report.db], ['elastic', 'Logs & detections (Elastic)', Search, report.elastic]].map(([id, label, Icon, data]) => data && (
                <button key={id} onClick={() => setTab(id)}
                  className={`text-sm px-3 py-2 -mb-px border-b-2 flex items-center gap-1.5 ${tab === id ? 'border-brand-500 font-medium' : 'border-transparent text-gray-500'}`}>
                  <Icon className="h-4 w-4" />{label}
                </button>
              ))}
            </div>
            {tab === 'db' && report.db && (report.db.error ? <p className="text-sm text-red-600">Database section failed: {report.db.error}</p> : <DbSection db={report.db} dark={dark} />)}
            {tab === 'elastic' && report.elastic && (report.elastic.error ? <p className="text-sm text-red-600">Elastic section failed: {report.elastic.error}</p> : <EsSection es={report.elastic} range={report.range} dark={dark} />)}
          </>
        )}
        {!report && !gen.isPending && <div className="card p-8 text-center text-sm text-gray-500">Pick a period and click <b>Generate report</b>.</div>}
      </div>
    </div>
  )
}

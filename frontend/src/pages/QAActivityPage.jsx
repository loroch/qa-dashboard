import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../services/api'
import {
  Activity, Bug, FlaskConical, BookOpen, RefreshCw, ExternalLink,
  ChevronDown, ChevronRight, ArrowRight, User, Clock, TrendingUp,
  CheckCircle2, PlusCircle, Play
} from 'lucide-react'
import { ActivityTrendChart } from '../components/charts/TrendChart'

const getVersions     = () => api.get('/coverage/versions')
const getReport       = (p) => api.get('/activity/report', { params: p })

const PRESET_DAYS = [
  { label: 'Last 24 h', days: 1 },
  { label: 'Last 7 d',  days: 7 },
  { label: 'Last 14 d', days: 14 },
  { label: 'Last 30 d', days: 30 },
]

function jiraBase(url) {
  if (!url) return 'https://avite.atlassian.net'
  try { return new URL(url).origin } catch { return 'https://avite.atlassian.net' }
}

function jiraLink(base, jql) {
  return `${base}/issues/?jql=${encodeURIComponent(jql)}`
}

function fmtDate(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  } catch { return iso }
}

// ── Status pill ───────────────────────────────────────────────────────────────
const STATUS_COLORS = {
  'Done':                'bg-green-100 text-green-700',
  'DONE':                'bg-green-100 text-green-700',
  'Closed':              'bg-green-100 text-green-700',
  'Passed':              'bg-green-100 text-green-700',
  'Failed':              'bg-red-100 text-red-700',
  'Blocked':             'bg-red-100 text-red-700',
  'In Progress':         'bg-blue-100 text-blue-700',
  'In Review':           'bg-indigo-100 text-indigo-700',
  'Ready for Testing':   'bg-purple-100 text-purple-700',
  'Ready For Deployment':'bg-teal-100 text-teal-700',
  'ToDo':                'bg-gray-100 text-gray-600',
  'Open':                'bg-orange-100 text-orange-700',
  'Reopened':            'bg-orange-100 text-orange-700',
}
function StatusPill({ label }) {
  const cls = STATUS_COLORS[label] || 'bg-gray-100 text-gray-600'
  return <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{label || '—'}</span>
}

// ── Summary tile ──────────────────────────────────────────────────────────────
function Tile({ label, value, sub, icon: Icon, color = 'gray' }) {
  const colors = {
    red:    'text-red-600',
    orange: 'text-orange-500',
    green:  'text-green-600',
    blue:   'text-blue-600',
    purple: 'text-purple-600',
    teal:   'text-teal-600',
    gray:   'text-gray-700',
  }
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-4 py-3 flex flex-col items-center text-center">
      {Icon && <Icon className={`h-4 w-4 mb-1 ${colors[color]}`} />}
      <p className="text-xs text-gray-400 uppercase tracking-wide font-medium leading-tight">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${colors[color]}`}>{value ?? '—'}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )
}

// ── Transition table ──────────────────────────────────────────────────────────
function TransitionTable({ transitions, jiraBase: base, version, label, color }) {
  const [open, setOpen] = useState(true)
  const [expanded, setExpanded] = useState(null)
  if (!transitions?.length) return null
  const total = transitions.reduce((a, t) => a + t.count, 0)
  const maxCount = Math.max(...transitions.map(t => t.count))

  const headerCls = {
    bug:   'bg-red-50 border-red-100',
    story: 'bg-purple-50 border-purple-100',
    test:  'bg-green-50 border-green-100',
  }[color] || 'bg-gray-50 border-gray-100'

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center gap-2 px-4 py-3 border-b text-left ${headerCls}`}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
               : <ChevronRight className="h-3.5 w-3.5 text-gray-400" />}
        <span className="text-sm font-semibold text-gray-700 flex-1">{label}</span>
        <span className="text-xs text-gray-400">{transitions.length} transition types · {total} moves</span>
      </button>

      {open && (
        <div className="divide-y divide-gray-50">
          {transitions.map((tr, i) => {
            const barW = Math.round(tr.count / maxCount * 100)
            const isExp = expanded === i
            return (
              <div key={i}>
                <button
                  onClick={() => setExpanded(isExp ? null : i)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 text-left"
                >
                  <StatusPill label={tr.from} />
                  <ArrowRight className="h-3 w-3 text-gray-300 flex-shrink-0" />
                  <StatusPill label={tr.to} />
                  <div className="flex-1 mx-2">
                    <div className="bg-gray-100 rounded-full h-1.5">
                      <div
                        className={`h-1.5 rounded-full ${color === 'bug' ? 'bg-red-400' : color === 'story' ? 'bg-purple-400' : 'bg-green-400'}`}
                        style={{ width: `${barW}%` }}
                      />
                    </div>
                  </div>
                  <span className="text-sm font-bold text-gray-700 tabular-nums w-6 text-right">{tr.count}</span>
                  {isExp ? <ChevronDown className="h-3 w-3 text-gray-300 flex-shrink-0" />
                          : <ChevronRight className="h-3 w-3 text-gray-300 flex-shrink-0" />}
                </button>
                {isExp && tr.issues?.length > 0 && (
                  <div className="bg-gray-50 px-8 pb-2">
                    {tr.issues.map(iss => (
                      <a key={iss.key} href={iss.url} target="_blank" rel="noopener noreferrer"
                         className="flex items-center gap-2 py-1 text-xs hover:opacity-80">
                        <span className="font-mono text-brand-600 flex-shrink-0">{iss.key}</span>
                        <span className="text-gray-600 truncate">{iss.summary}</span>
                        <ExternalLink className="h-2.5 w-2.5 text-gray-300 flex-shrink-0" />
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Activity feed ─────────────────────────────────────────────────────────────
function ActivityFeed({ bugs, stories, tests }) {
  const [open, setOpen] = useState(true)
  const merged = useMemo(() => {
    const all = [
      ...(bugs?.activity_feed  || []).map(x => ({ ...x, type: 'Bug' })),
      ...(stories?.activity_feed || []).map(x => ({ ...x, type: 'Story' })),
      ...(tests?.activity_feed || []).map(x => ({ ...x, type: 'Test' })),
    ]
    all.sort((a, b) => (b.changed_at || '').localeCompare(a.changed_at || ''))
    return all.slice(0, 60)
  }, [bugs, stories, tests])

  const typeColor = { Bug: 'text-red-500', Story: 'text-purple-500', Test: 'text-green-500' }
  const typeBg    = { Bug: 'bg-red-50',    Story: 'bg-purple-50',    Test: 'bg-green-50' }

  if (!merged.length) return null

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-4 py-3 border-b border-gray-100 bg-gray-50 text-left"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
               : <ChevronRight className="h-3.5 w-3.5 text-gray-400" />}
        <Clock className="h-3.5 w-3.5 text-gray-400" />
        <span className="text-sm font-semibold text-gray-700 flex-1">Activity Feed</span>
        <span className="text-xs text-gray-400">{merged.length} recent moves</span>
      </button>

      {open && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-400 uppercase tracking-wide border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-2 font-semibold">When</th>
                <th className="text-left px-3 py-2 font-semibold">Type</th>
                <th className="text-left px-3 py-2 font-semibold">Key</th>
                <th className="text-left px-3 py-2 font-semibold min-w-[200px]">Summary</th>
                <th className="text-left px-3 py-2 font-semibold">Transition</th>
                <th className="text-left px-3 py-2 font-semibold">By</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {merged.map((item, i) => (
                <tr key={i} className="hover:bg-gray-50">
                  <td className="px-4 py-2 text-gray-400 whitespace-nowrap">{fmtDate(item.changed_at)}</td>
                  <td className="px-3 py-2">
                    <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${typeBg[item.type]} ${typeColor[item.type]}`}>
                      {item.type}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <a href={item.url} target="_blank" rel="noopener noreferrer"
                       className="font-mono text-brand-600 hover:underline flex items-center gap-0.5 whitespace-nowrap">
                      {item.key} <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  </td>
                  <td className="px-3 py-2 text-gray-600 max-w-[300px]">
                    <span className="line-clamp-1">{item.summary}</span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <div className="flex items-center gap-1">
                      <StatusPill label={item.from} />
                      <ArrowRight className="h-3 w-3 text-gray-300" />
                      <StatusPill label={item.to} />
                    </div>
                  </td>
                  <td className="px-3 py-2 text-gray-500 whitespace-nowrap flex items-center gap-1">
                    <User className="h-3 w-3 text-gray-300" />
                    {item.changed_by}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Created-issues list ───────────────────────────────────────────────────────
function CreatedList({ items, label, color }) {
  const [open, setOpen] = useState(false)
  if (!items?.length) return null

  const headerCls = {
    test: 'bg-green-50 border-green-100',
    bug:  'bg-orange-50 border-orange-100',
  }[color] || 'bg-gray-50 border-gray-100'

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className={`w-full flex items-center gap-2 px-4 py-3 border-b text-left ${headerCls}`}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
               : <ChevronRight className="h-3.5 w-3.5 text-gray-400" />}
        <span className="text-sm font-semibold text-gray-700 flex-1">{label}</span>
        <span className="text-xs text-gray-400">{items.length} items</span>
      </button>

      {open && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-400 uppercase tracking-wide border-b border-gray-100 bg-gray-50">
                <th className="text-left px-4 py-2 font-semibold">Key</th>
                <th className="text-left px-3 py-2 font-semibold min-w-[220px]">Summary</th>
                <th className="text-left px-3 py-2 font-semibold min-w-[180px]">Epic</th>
                <th className="text-left px-3 py-2 font-semibold">Status</th>
                <th className="text-left px-3 py-2 font-semibold">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {items.map(item => (
                <tr key={item.key} className="hover:bg-gray-50">
                  <td className="px-4 py-2">
                    <a href={item.url} target="_blank" rel="noopener noreferrer"
                       className="font-mono text-brand-600 hover:underline flex items-center gap-0.5 whitespace-nowrap">
                      {item.key} <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  </td>
                  <td className="px-3 py-2 text-gray-600 max-w-[260px]">
                    <span className="line-clamp-1">{item.summary}</span>
                  </td>
                  <td className="px-3 py-2 max-w-[220px]">
                    {item.epic_key ? (
                      <a href={item.epic_url} target="_blank" rel="noopener noreferrer"
                         className="flex flex-col gap-0.5 hover:opacity-80">
                        <span className="font-mono text-xs text-indigo-600 flex items-center gap-0.5 whitespace-nowrap">
                          {item.epic_key} <ExternalLink className="h-2.5 w-2.5" />
                        </span>
                        <span className="text-gray-500 line-clamp-1 text-xs">{item.epic_summary}</span>
                      </a>
                    ) : (
                      <span className="text-gray-300 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2"><StatusPill label={item.status} /></td>
                  <td className="px-3 py-2 text-gray-400 whitespace-nowrap">{fmtDate(item.created)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── By-author breakdown ───────────────────────────────────────────────────────
function AuthorBreakdown({ bugs, stories, tests }) {
  const [open, setOpen] = useState(false)
  const combined = useMemo(() => {
    const m = {}
    const add = (list) => (list || []).forEach(([name, n]) => { m[name] = (m[name] || 0) + n })
    add(bugs?.by_author)
    add(stories?.by_author)
    add(tests?.by_author)
    return Object.entries(m).sort((a, b) => b[1] - a[1])
  }, [bugs, stories, tests])

  if (!combined.length) return null
  const max = combined[0]?.[1] || 1

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-4 py-3 border-b border-gray-100 bg-indigo-50 text-left"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
               : <ChevronRight className="h-3.5 w-3.5 text-gray-400" />}
        <User className="h-3.5 w-3.5 text-indigo-400" />
        <span className="text-sm font-semibold text-indigo-800 flex-1">Activity by Team Member</span>
        <span className="text-xs text-gray-400">{combined.length} contributors</span>
      </button>

      {open && (
        <div className="p-4 space-y-2">
          {combined.map(([name, count]) => (
            <div key={name} className="flex items-center gap-2">
              <span className="text-xs text-gray-600 w-40 truncate">{name}</span>
              <div className="flex-1 bg-gray-100 rounded-full h-2">
                <div className="bg-indigo-400 h-2 rounded-full"
                     style={{ width: `${Math.round(count / max * 100)}%` }} />
              </div>
              <span className="text-xs font-bold text-gray-700 tabular-nums w-8 text-right">{count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function QAActivityPage() {
  const [days,       setDays]       = useState(7)
  const [customDays, setCustomDays] = useState('')
  const [version,    setVersion]    = useState('')
  const [scopeKey,   setScopeKey]   = useState('')
  const [refreshKey, setRefresh]    = useState(0)

  const activeDays = customDays ? parseInt(customDays, 10) || days : days

  const versionsQ = useQuery({ queryKey: ['activity-versions'], queryFn: getVersions, staleTime: 10*60*1000 })
  const versions  = Array.isArray(versionsQ.data) ? versionsQ.data : []

  const params = {
    days:      activeDays,
    ...(version  ? { version }   : {}),
    ...(scopeKey ? { scope_key: scopeKey } : {}),
    ...(refreshKey ? { _r: refreshKey } : {}),
  }

  const reportQ = useQuery({
    queryKey:  ['qa-activity', activeDays, version, scopeKey, refreshKey],
    queryFn:   () => getReport(params),
    staleTime: 5*60*1000,
    enabled:   true,
  })

  const report   = reportQ.data
  const summary  = report?.summary || {}
  const isLoading = reportQ.isLoading

  const jiraBaseUrl = 'https://avite.atlassian.net'
  const versionJql  = version ? ` AND fixVersion = "${version}"` : ''
  const scopeJql    = scopeKey ? ` AND (issueKey = "${scopeKey}" OR parent = "${scopeKey}" OR "Epic Link" = "${scopeKey}")` : ''
  const timeJql     = `updated >= "-${activeDays}d"`

  return (
    <div className="flex flex-col min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <Activity className="h-5 w-5 text-brand-500" /> QA Activity Report
          </h1>
          <p className="text-xs text-gray-400 mt-0.5">
            Status transitions, bugs opened/closed, stories & tests — per time window
          </p>
        </div>
        <button onClick={() => setRefresh(k => k + 1)} disabled={isLoading}
          className="flex items-center gap-2 px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      <div className="flex-1 p-6 space-y-5 max-w-7xl mx-auto w-full">

        {/* ── Filters ── */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <div className="flex flex-wrap gap-4 items-end">

            {/* Time preset */}
            <div>
              <label className="block text-xs text-gray-500 font-medium mb-1.5">Time Range</label>
              <div className="flex gap-1.5">
                {PRESET_DAYS.map(p => (
                  <button key={p.days}
                    onClick={() => { setDays(p.days); setCustomDays('') }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                      activeDays === p.days && !customDays
                        ? 'bg-brand-600 text-white border-brand-600'
                        : 'bg-white text-gray-600 border-gray-200 hover:border-brand-300'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
                <div className="flex items-center gap-1">
                  <input
                    type="number" min="1" max="365"
                    value={customDays}
                    onChange={e => setCustomDays(e.target.value)}
                    placeholder="Custom"
                    className="w-20 border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-400"
                  />
                  {customDays && <span className="text-xs text-gray-400">days</span>}
                </div>
              </div>
            </div>

            {/* Version filter */}
            <div>
              <label className="block text-xs text-gray-500 font-medium mb-1.5">Fix Version</label>
              <select value={version} onChange={e => setVersion(e.target.value)}
                className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400">
                <option value="">All versions</option>
                {versions.map(v => (
                  <option key={v.id} value={v.name}>{v.name}{v.released ? ' (released)' : ''}</option>
                ))}
              </select>
            </div>

            {/* Epic / Story filter */}
            <div>
              <label className="block text-xs text-gray-500 font-medium mb-1.5">Epic or Story (key)</label>
              <input
                type="text"
                value={scopeKey}
                onChange={e => setScopeKey(e.target.value.trim().toUpperCase())}
                placeholder="e.g. TMT0-40037"
                className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm w-40 focus:outline-none focus:ring-2 focus:ring-brand-400"
              />
            </div>

            {/* Active filter summary */}
            <div className="flex-1 text-xs text-gray-400 self-end pb-1.5">
              {isLoading
                ? 'Loading…'
                : report
                  ? `Last ${activeDays} day${activeDays > 1 ? 's' : ''}${version ? ` · ${version}` : ''}${scopeKey ? ` · ${scopeKey}` : ''}`
                  : ''}
            </div>
          </div>
        </div>

        {reportQ.isError && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600">
            {reportQ.error?.message || 'Error loading activity report'}
          </div>
        )}

        {/* ── Summary tiles ── */}
        {(isLoading || report) && (
          <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Tile label="Bugs Opened"    value={isLoading ? '…' : summary.bugs_opened}
                  icon={PlusCircle}      color="orange" sub={`of ${summary.bugs_active ?? '…'} updated`} />
            <Tile label="Bugs Closed"    value={isLoading ? '…' : summary.bugs_closed}
                  icon={CheckCircle2}    color="green" />
            <Tile label="Stories → RFT"  value={isLoading ? '…' : summary.stories_rft}
                  icon={BookOpen}        color="purple" sub="Ready for Testing" />
            <Tile label="Stories Done"   value={isLoading ? '…' : summary.stories_done}
                  icon={CheckCircle2}    color="teal" />
          </div>
        )}

        {/* ── Jira quick links ── */}
        {report && (
          <div className="flex flex-wrap gap-2">
            {[
              { label: 'Bugs opened', jql: `issuetype = Bug AND created >= "-${activeDays}d"${versionJql}${scopeJql} ORDER BY created DESC` },
              { label: 'Bugs closed', jql: `issuetype = Bug AND status changed TO ("Done","DONE","Closed") AFTER "-${activeDays}d"${versionJql}${scopeJql} ORDER BY updated DESC` },
              { label: 'Stories → RFT', jql: `issuetype = Story AND status changed TO "Ready for Testing" AFTER "-${activeDays}d"${versionJql}${scopeJql}` },
              { label: 'Tests added',  jql: `issuetype = Test AND created >= "-${activeDays}d"${versionJql}${scopeJql} ORDER BY created DESC` },
            ].map(({ label, jql }) => (
              <a key={label}
                 href={jiraLink(jiraBaseUrl, jql)}
                 target="_blank" rel="noopener noreferrer"
                 className="inline-flex items-center gap-1 px-2.5 py-1 bg-white border border-gray-200 rounded-full text-xs text-brand-600 hover:border-brand-300 hover:shadow-sm">
                <ExternalLink className="h-3 w-3" /> {label} in Jira
              </a>
            ))}
          </div>
        )}

        {/* ── Activity trend chart ── */}
        {report?.trend_data?.length > 0 && (
          <ActivityTrendChart data={report.trend_data} days={activeDays} />
        )}

        {/* ── Transition sections ── */}
        {report && (
          <div className="space-y-4">

            {/* Bugs opened list */}
            <CreatedList
              items={report.bugs_opened_list}
              label={`Bugs Opened (${report.bugs_opened_list?.length ?? 0} new)`}
              color="bug"
            />

            {/* Bug transitions */}
            <TransitionTable
              transitions={report.bugs?.transitions}
              jiraBase={jiraBaseUrl} version={version}
              label={`Bug Status Transitions  ·  ${report.bugs?.total_transitions ?? 0} total moves`}
              color="bug"
            />

            {/* Story transitions */}
            <TransitionTable
              transitions={report.stories?.transitions}
              jiraBase={jiraBaseUrl} version={version}
              label={`Story Status Transitions  ·  ${report.stories?.total_transitions ?? 0} total moves`}
              color="story"
            />

            {/* Test transitions */}
            <TransitionTable
              transitions={report.tests?.transitions}
              jiraBase={jiraBaseUrl} version={version}
              label={`Test Status Transitions  ·  ${report.tests?.total_transitions ?? 0} total moves`}
              color="test"
            />

            {/* Tests created list */}
            <CreatedList
              items={report.tests_created}
              label={`Tests Added (${report.tests_created?.length ?? 0} new)`}
              color="test"
            />

            {/* By author */}
            <AuthorBreakdown
              bugs={report.bugs}
              stories={report.stories}
              tests={report.tests}
            />

            {/* Activity feed */}
            <ActivityFeed
              bugs={report.bugs}
              stories={report.stories}
              tests={report.tests}
            />

          </div>
        )}

        {!isLoading && !report && !reportQ.isError && (
          <div className="text-center py-16 text-gray-400 text-sm">Select a time range to load the activity report.</div>
        )}
      </div>
    </div>
  )
}

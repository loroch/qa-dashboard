import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../services/api'
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from 'recharts'
import {
  FlaskConical, Bug, CheckCircle2, ChevronDown, ChevronUp, ChevronRight,
  ExternalLink, RefreshCw, ShieldCheck, BarChart2, ArrowUpDown, X,
  AlertTriangle, Activity, PlayCircle, Search, Plus, Trash2, GripVertical
} from 'lucide-react'

const getVersions      = ()  => api.get('/coverage/versions')
const getCoverage      = (v) => api.get('/coverage/by-version',           { params: { version: v } })
const getBugs          = (v) => api.get('/dashboard/bugs-by-version',     { params: { version: v } })
const getRegression    = (v) => api.get('/coverage/regression-tests',     { params: { version: v } })
const getBugsByEpic    = (v) => api.get('/dashboard/bugs-grouped-by-epic',{ params: { version: v } })
const getRecentBugs    = (d) => api.get('/dashboard/recent-bugs',         { params: { days: d } })
const getSprints       = (v) => api.get('/dashboard/sprints',             { params: { version: v } })
const getQAActivity    = (v, s, d, e) => api.get('/dashboard/qa-activity', { params: { version: v, sprint: s || undefined, days: d, epic_key: e || undefined } })
const getEpics         = ()          => api.get('/dashboard/epics')
const getHandoverItems = (v)         => api.get('/dashboard/handover-items', { params: { version: v } })
const getTransitions   = (k)         => api.get(`/coverage/test-transitions/${k}`)
const applyTransition  = (body)      => api.post('/coverage/test-transition', body)
const getAllocation     = (v, s)      => api.get('/dashboard/allocation', { params: { version: v || undefined, sprint: s || undefined } })
const reassignIssue    = (key, id)   => api.post(`/dashboard/issue/${key}/qa-owner`, { account_id: id })

function pct(n, d) { return d ? Math.round(n / d * 100) : 0 }

// Derive Jira base URL from any browse URL: https://host/browse/KEY → https://host
function jiraBase(url) {
  if (!url) return 'https://kabatone.atlassian.net'
  try { return new URL(url).origin } catch { return 'https://kabatone.atlassian.net' }
}

function jiraFilter(base, jql) {
  return `${base}/issues/?jql=${encodeURIComponent(jql)}`
}

const PRIORITY_COLORS = {
  Highest: 'bg-red-500',   High: 'bg-orange-400',
  Medium:  'bg-yellow-400', Low:  'bg-green-400', Lowest: 'bg-gray-300',
}

const DONE_STATUSES    = new Set(['Done', 'DONE', 'Passed', 'PASSED'])
const BLOCKED_STATUSES = new Set(['Blocked', 'Reopened'])
const IP_STATUSES      = new Set(['In Progress', 'In Review', 'Validation'])

// Story workflow status → color tokens
const STATUS_TOKEN = {
  'ToDo':                 { bg: 'bg-gray-200',    text: 'text-gray-700',    bar: 'bg-gray-400'    },
  'In Progress':          { bg: 'bg-blue-100',    text: 'text-blue-700',    bar: 'bg-blue-500'    },
  'In Review':            { bg: 'bg-indigo-100',  text: 'text-indigo-700',  bar: 'bg-indigo-500'  },
  'Ready for Testing':    { bg: 'bg-purple-100',  text: 'text-purple-700',  bar: 'bg-purple-500'  },
  'Ready For Deployment': { bg: 'bg-teal-100',    text: 'text-teal-700',    bar: 'bg-teal-500'    },
  'HandoffOK':            { bg: 'bg-cyan-100',    text: 'text-cyan-700',    bar: 'bg-cyan-500'    },
  'DONE':                 { bg: 'bg-green-100',   text: 'text-green-700',   bar: 'bg-green-500'   },
  'QA Monitoring':        { bg: 'bg-amber-100',   text: 'text-amber-700',   bar: 'bg-amber-500'   },
  'Known Issue':          { bg: 'bg-rose-100',    text: 'text-rose-700',    bar: 'bg-rose-400'    },
}
function statusToken(s) { return STATUS_TOKEN[s] || { bg: 'bg-gray-100', text: 'text-gray-500', bar: 'bg-gray-300' } }

// ── Tile ──────────────────────────────────────────────────────────────────────
function Tile({ label, value, sub, color = 'gray', href }) {
  const cls = { red:'text-red-600', orange:'text-orange-500', green:'text-green-600',
                purple:'text-purple-600', indigo:'text-indigo-600', blue:'text-blue-600', gray:'text-gray-700' }
  const inner = (
    <>
      <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-1 flex items-center justify-center gap-1">
        {label}
        {href && <ExternalLink className="h-2.5 w-2.5 opacity-0 group-hover:opacity-60 transition-opacity" />}
      </p>
      <p className={`text-2xl font-bold ${cls[color]}`}>{value ?? '—'}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </>
  )
  if (href) return (
    <a href={href} target="_blank" rel="noopener noreferrer"
       className="group bg-white border border-gray-100 rounded-xl px-4 py-3 text-center shadow-sm hover:border-brand-300 hover:shadow-md transition-all block">
      {inner}
    </a>
  )
  return (
    <div className="bg-white border border-gray-100 rounded-xl px-4 py-3 text-center shadow-sm">{inner}</div>
  )
}

// ── Story Resolution Bar with colored pills + Jira links ──────────────────────
function StoryBar({ stats, version, jiraBaseUrl }) {
  const byStatus = stats?.stories_by_status || []
  const total    = stats?.stories_total ?? 0
  if (!total) return null
  const done = stats?.stories_done ?? 0
  const p = pct(done, total)

  return (
    <div className="bg-white border border-gray-100 rounded-xl p-4 shadow-sm space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-700 flex items-center gap-2">
          <BarChart2 className="h-4 w-4 text-gray-400" /> Story Resolution Status
        </span>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-400">{total} stories · {p}% done</span>
          <a
            href={jiraFilter(jiraBaseUrl, `issuetype = Story AND fixVersion = "${version}" ORDER BY status ASC`)}
            target="_blank" rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline"
          >
            <ExternalLink className="h-3 w-3" /> All stories in Jira
          </a>
        </div>
      </div>

      {/* Segmented progress bar */}
      <div className="flex h-4 rounded-full overflow-hidden gap-px">
        {byStatus.map(({ status, count }) => {
          const tok = statusToken(status)
          const w = pct(count, total)
          if (!w) return null
          return (
            <div key={status}
              className={`${tok.bar} h-4 transition-all`}
              style={{ width: `${w}%` }}
              title={`${status}: ${count}`}
            />
          )
        })}
      </div>

      {/* Breakdown table: Status | Count | % | Jira */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-400 uppercase tracking-wide border-b border-gray-100">
              <th className="text-left py-1.5 font-semibold">Status</th>
              <th className="text-right py-1.5 font-semibold w-12">Count</th>
              <th className="text-right py-1.5 font-semibold w-12">%</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {byStatus.map(({ status, count }) => {
              const tok = statusToken(status)
              const filterUrl = jiraFilter(jiraBaseUrl,
                `issuetype = Story AND fixVersion = "${version}" AND status = "${status}" ORDER BY priority DESC`
              )
              return (
                <tr key={status} className="hover:bg-gray-50">
                  <td className="py-1.5">
                    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${tok.bg} ${tok.text}`}>
                      {status}
                    </span>
                  </td>
                  <td className="py-1.5 text-right font-semibold text-gray-700 tabular-nums">{count}</td>
                  <td className="py-1.5 text-right text-gray-400 tabular-nums">{pct(count, total)}%</td>
                  <td className="py-1.5 text-center">
                    <a href={filterUrl} target="_blank" rel="noopener noreferrer"
                       className="text-gray-300 hover:text-brand-500">
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </td>
                </tr>
              )
            })}
            <tr className="border-t border-gray-200 font-semibold">
              <td className="py-1.5 text-gray-600">Total</td>
              <td className="py-1.5 text-right text-gray-700 tabular-nums">{total}</td>
              <td className="py-1.5 text-right text-gray-400">100%</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Coverage Epic Row ─────────────────────────────────────────────────────────
function CoverageEpicRow({ epic, jiraBaseUrl, version }) {
  const [open, setOpen] = useState(true)
  const stories  = epic.stories || []
  const covered  = epic.covered_stories
  const total    = epic.total_stories
  const tests    = epic.total_tests
  const p        = pct(covered, total)
  const barColor = p === 100 ? 'bg-green-500' : p >= 50 ? 'bg-yellow-400' : 'bg-red-400'

  const epicJql = jiraFilter(jiraBaseUrl,
    `issuetype = Story AND fixVersion = "${version}" AND "Epic Link" = "${epic.epic_key}" ORDER BY status ASC`
  )

  return (
    <div className="border border-gray-100 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
               : <ChevronRight className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <a href={epic.epic_url || `${jiraBaseUrl}/browse/${epic.epic_key}`}
               target="_blank" rel="noopener noreferrer"
               onClick={e => e.stopPropagation()}
               className="text-xs font-mono text-brand-600 hover:underline flex-shrink-0 flex items-center gap-0.5">
              {epic.epic_key} <ExternalLink className="h-2.5 w-2.5" />
            </a>
            <span className="text-xs text-gray-600 truncate">{epic.epic_summary}</span>
            {epic.epic_status && (
              <span className={`flex-shrink-0 text-xs px-1.5 py-0.5 rounded-full ${statusToken(epic.epic_status).bg} ${statusToken(epic.epic_status).text}`}>
                {epic.epic_status}
              </span>
            )}
            <a href={epicJql} target="_blank" rel="noopener noreferrer"
               onClick={e => e.stopPropagation()}
               className="flex-shrink-0 text-xs text-gray-400 hover:text-brand-600">
              <ExternalLink className="h-2.5 w-2.5" />
            </a>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1 bg-gray-200 rounded-full h-1.5">
              <div className={`${barColor} h-1.5 rounded-full`} style={{ width: `${p}%` }} />
            </div>
            <span className="text-xs text-gray-400 flex-shrink-0">{covered}/{total} covered · {tests} tests</span>
          </div>
        </div>
        <span className={`text-xs font-bold flex-shrink-0 ${p === 100 ? 'text-green-600' : p >= 50 ? 'text-yellow-600' : 'text-red-500'}`}>{p}%</span>
      </button>

      {open && stories.length > 0 && (
        <div className="divide-y divide-gray-50 bg-white">
          <div className="grid grid-cols-[130px_1fr_100px_80px] gap-2 px-6 py-1.5 bg-gray-50 text-xs font-semibold text-gray-400 uppercase tracking-wide">
            <span>Story</span><span>Summary</span><span>Status</span><span className="text-right">Tests</span>
          </div>
          {stories.map(s => {
            const tok = statusToken(s.status)
            const testsJql = s.test_keys?.length
              ? jiraFilter(jiraBaseUrl, `issueKey in (${s.test_keys.join(',')})`)
              : null
            return (
              <div key={s.key} className="grid grid-cols-[130px_1fr_100px_80px] gap-2 items-center px-6 py-2 hover:bg-gray-50">
                <a href={s.url} target="_blank" rel="noopener noreferrer"
                   className="text-xs font-mono text-brand-600 hover:underline flex items-center gap-0.5">
                  {s.key} <ExternalLink className="h-2.5 w-2.5" />
                </a>
                <span className="text-xs text-gray-600 truncate">{s.summary}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${tok.bg} ${tok.text} text-center truncate`}>
                  {s.status}
                </span>
                <div className="text-right">
                  {s.test_count > 0 ? (
                    <a href={testsJql} target="_blank" rel="noopener noreferrer"
                       className="text-xs font-semibold text-green-600 hover:underline flex items-center justify-end gap-0.5">
                      {s.test_count} <ExternalLink className="h-2.5 w-2.5" />
                    </a>
                  ) : (
                    <span className="text-xs text-red-400">No tests</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Bug Breakdown ─────────────────────────────────────────────────────────────
function BugBreakdown({ bugs, version, jiraBaseUrl }) {
  const total = bugs.length

  const byPriority = useMemo(() => {
    const m = {}
    for (const b of bugs) { const p = b.priority || 'Unknown'; m[p] = (m[p]||0)+1 }
    return Object.entries(m).sort((a,b) => b[1]-a[1])
  }, [bugs])

  const byStatus = useMemo(() => {
    const m = {}
    for (const b of bugs) { const s = b.status || 'Unknown'; m[s] = (m[s]||0)+1 }
    return Object.entries(m).sort((a,b) => b[1]-a[1])
  }, [bugs])

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">By Priority</p>
        <div className="space-y-1.5">
          {byPriority.map(([p, n]) => (
            <a key={p} href={jiraFilter(jiraBaseUrl, `issuetype = Bug AND fixVersion = "${version}" AND priority = "${p}" ORDER BY created DESC`)}
               target="_blank" rel="noopener noreferrer"
               className="flex items-center gap-2 hover:opacity-80 group">
              <span className="text-xs text-gray-600 w-16 flex-shrink-0">{p}</span>
              <div className="flex-1 bg-gray-100 rounded-full h-2.5">
                <div className={`${PRIORITY_COLORS[p]||'bg-gray-400'} h-2.5 rounded-full`} style={{ width: `${pct(n,total)}%` }} />
              </div>
              <span className="text-xs text-gray-500 w-5 text-right">{n}</span>
              <ExternalLink className="h-2.5 w-2.5 text-gray-300 group-hover:text-brand-500 flex-shrink-0" />
            </a>
          ))}
        </div>
      </div>
      <div>
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">By Status</p>
        <div className="space-y-1.5">
          {byStatus.map(([s, n]) => (
            <a key={s} href={jiraFilter(jiraBaseUrl, `issuetype = Bug AND fixVersion = "${version}" AND status = "${s}" ORDER BY priority DESC`)}
               target="_blank" rel="noopener noreferrer"
               className="flex items-center gap-2 hover:opacity-80 group">
              <span className="text-xs text-gray-600 w-28 flex-shrink-0 truncate">{s}</span>
              <div className="flex-1 bg-gray-100 rounded-full h-2.5">
                <div className="bg-blue-400 h-2.5 rounded-full" style={{ width: `${pct(n,total)}%` }} />
              </div>
              <span className="text-xs text-gray-500 w-5 text-right">{n}</span>
              <ExternalLink className="h-2.5 w-2.5 text-gray-300 group-hover:text-brand-500 flex-shrink-0" />
            </a>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Bugs by Epic ──────────────────────────────────────────────────────────────
function BugsByEpic({ data, version, jiraBaseUrl }) {
  const epics            = data?.epics || []
  const unlinked         = data?.unlinked_count ?? 0
  const unlinkedKeys     = data?.unlinked_keys || []
  const unlinkedAssignees= data?.unlinked_assignees || []
  const total            = data?.total_bugs ?? 0
  const maxCount         = Math.max(...epics.map(e => e.bug_count), unlinked, 1)

  if (!epics.length && !unlinked) return (
    <p className="text-sm text-gray-400 text-center py-6">No bug→epic links found</p>
  )

  return (
    <div className="space-y-2">
      {epics.map(epic => {
        const jql = `issuetype = Bug AND fixVersion = "${version}" AND issue in linkedIssues("${epic.key}")`
        const barW = Math.round(epic.bug_count / maxCount * 100)
        return (
          <div key={epic.key} className="group">
            <div className="flex items-center gap-2">
              <a href={epic.url} target="_blank" rel="noopener noreferrer"
                 className="text-xs font-mono text-brand-600 hover:underline flex-shrink-0 w-28 truncate">
                {epic.key}
              </a>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-gray-600 truncate leading-tight">{epic.summary}</p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <div className="flex-1 bg-gray-100 rounded-full h-1.5">
                    <div className="bg-red-400 h-1.5 rounded-full" style={{ width: `${barW}%` }} />
                  </div>
                </div>
              </div>
              <div className="flex-shrink-0 text-right">
                <span className="text-xs font-bold text-gray-700 tabular-nums">{epic.bug_count}</span>
                {epic.open_count > 0 && (
                  <span className="text-xs text-orange-500 ml-1 tabular-nums">({epic.open_count} open)</span>
                )}
              </div>
              <a href={jiraFilter(jiraBaseUrl, jql)} target="_blank" rel="noopener noreferrer"
                 className="text-gray-300 hover:text-brand-500 flex-shrink-0">
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>
        )
      })}

      {unlinked > 0 && (
        <div className="pt-1 border-t border-gray-100">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400 w-28 flex-shrink-0 font-medium italic">Other</span>
            <div className="flex-1">
              <div className="flex items-center gap-1.5">
                <div className="flex-1 bg-gray-100 rounded-full h-1.5">
                  <div className="bg-gray-300 h-1.5 rounded-full"
                       style={{ width: `${Math.round(unlinked / maxCount * 100)}%` }} />
                </div>
              </div>
            </div>
            <span className="text-xs text-gray-500 tabular-nums font-semibold">{unlinked}</span>
            {unlinkedKeys.length > 0 && (
              <a href={jiraFilter(jiraBaseUrl,
                  `issueKey in (${unlinkedKeys.join(',')}) ORDER BY priority DESC`
                )} target="_blank" rel="noopener noreferrer"
                 className="text-gray-300 hover:text-brand-500 flex-shrink-0">
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </div>
      )}

      <p className="text-xs text-gray-400 text-right pt-1">{total} total bugs across {epics.length} epics</p>
    </div>
  )
}

// ── Regression Panel ──────────────────────────────────────────────────────────
function RegressionPanel({ data }) {
  if (!data?.total) return <p className="text-sm text-gray-400 text-center py-6">No regression tests</p>
  const counts = data.status_counts || {}
  const done    = Object.entries(counts).filter(([s]) => DONE_STATUSES.has(s)).reduce((a,[,n])=>a+n,0)
  const blocked = Object.entries(counts).filter(([s]) => BLOCKED_STATUSES.has(s)).reduce((a,[,n])=>a+n,0)
  const ip      = Object.entries(counts).filter(([s]) => IP_STATUSES.has(s)).reduce((a,[,n])=>a+n,0)
  const notRun  = Math.max(0, data.total - done - ip - blocked)
  const p       = pct(done, data.total)
  const barColor = p===100 ? 'bg-green-500' : p>=50 ? 'bg-yellow-400' : 'bg-red-400'

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-500">Pass rate</span>
        <span className={`text-sm font-bold ${p>=80?'text-green-600':p>=50?'text-yellow-600':'text-red-500'}`}>{p}%</span>
      </div>
      <div className="bg-gray-200 rounded-full h-3">
        <div className={`${barColor} h-3 rounded-full`} style={{ width: `${p}%` }} />
      </div>
      <div className="grid grid-cols-4 gap-2 text-center">
        {[['Passed',done,'text-green-600'],['In Progress',ip,'text-blue-600'],['Blocked',blocked,'text-red-500'],['Not Run',notRun,'text-gray-400']].map(([label,val,cls])=>(
          <div key={label} className="bg-gray-50 rounded-lg py-2">
            <p className={`text-lg font-bold ${cls}`}>{val}</p>
            <p className="text-xs text-gray-400">{label}</p>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([status,count])=>(
          <span key={status} className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 text-gray-600 text-xs rounded-full">
            <span className="font-bold">{count}</span> {status}
          </span>
        ))}
      </div>
      {data.jira_search_url && (
        <a href={data.jira_search_url} target="_blank" rel="noopener noreferrer"
           className="inline-flex items-center gap-1 text-xs text-purple-600 hover:underline">
          <ExternalLink className="h-3 w-3" /> View all {data.total} regression tests in Jira
        </a>
      )}
    </div>
  )
}

// ── Recently Opened Bugs ─────────────────────────────────────────────────────
const PRIORITY_BADGE = {
  Highest:  'bg-red-100 text-red-700',
  Critical: 'bg-red-100 text-red-700',
  High:     'bg-orange-100 text-orange-700',
  Medium:   'bg-yellow-100 text-yellow-700',
  Low:      'bg-green-100 text-green-700',
  Lowest:   'bg-gray-100 text-gray-500',
}

function SortTh({ label, col, sortCol, sortDir, onSort, className = '' }) {
  const active = sortCol === col
  return (
    <th className={`py-2 font-semibold cursor-pointer select-none group ${className}`}
        onClick={() => onSort(col)}>
      <span className="inline-flex items-center gap-1">
        {label}
        {active
          ? (sortDir === 'asc'
              ? <ChevronUp className="h-3 w-3 text-blue-500" />
              : <ChevronDown className="h-3 w-3 text-blue-500" />)
          : <ArrowUpDown className="h-3 w-3 opacity-0 group-hover:opacity-40 transition-opacity" />}
      </span>
    </th>
  )
}

function RecentBugsPanel({ bugs: versionBugs, version, jiraBaseUrl }) {
  const [days, setDays]         = useState(7)
  const [scope, setScope]       = useState('version')
  const [search, setSearch]     = useState('')
  const [filterParent, setFP]   = useState('')
  const [filterPriority, setFPr]= useState('')
  const [filterReporter, setFR] = useState('')
  const [sortCol, setSortCol]   = useState('created')
  const [sortDir, setSortDir]   = useState('desc')

  const allBugsQ = useQuery({
    queryKey: ['recent-bugs-all', days],
    queryFn:  () => getRecentBugs(days),
    enabled:  scope === 'all',
    staleTime: 5 * 60 * 1000,
  })

  const baseBugs = useMemo(() => {
    if (scope === 'all') return allBugsQ.data?.bugs || []
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - days)
    return (versionBugs || [])
      .filter(b => b.created && new Date(b.created) >= cutoff)
      .sort((a, b) => new Date(b.created) - new Date(a.created))
  }, [scope, days, versionBugs, allBugsQ.data])

  // Unique option lists
  const parentOptions   = useMemo(() => {
    const m = new Map()
    baseBugs.forEach(b => { if (b.parent_key) m.set(b.parent_key, b.parent_summary || b.parent_key) })
    return [...m.entries()].sort((a,b) => a[1].localeCompare(b[1]))
  }, [baseBugs])
  const priorityOptions = useMemo(() => [...new Set(baseBugs.map(b => b.priority).filter(Boolean))], [baseBugs])
  const reporterOptions = useMemo(() => {
    const s = new Set(baseBugs.map(b => b.reporter?.display_name || b.reporter?.name).filter(Boolean))
    return [...s].sort()
  }, [baseBugs])

  const handleSort = col => {
    setSortDir(prev => sortCol === col ? (prev === 'asc' ? 'desc' : 'asc') : 'desc')
    setSortCol(col)
  }

  const SORT_FN = {
    key:      (a, b) => a.key.localeCompare(b.key),
    summary:  (a, b) => (a.summary||'').localeCompare(b.summary||''),
    parent:   (a, b) => (a.parent_key||'').localeCompare(b.parent_key||''),
    priority: (a, b) => {
      const order = ['Highest','Critical','High','Medium','Low','Lowest']
      return order.indexOf(a.priority||'') - order.indexOf(b.priority||'')
    },
    status:   (a, b) => (a.status||'').localeCompare(b.status||''),
    reporter: (a, b) => (a.reporter?.display_name||'').localeCompare(b.reporter?.display_name||''),
    created:  (a, b) => new Date(a.created) - new Date(b.created),
  }

  const filtered = useMemo(() => {
    let out = baseBugs
    if (filterParent)   out = out.filter(b => b.parent_key === filterParent)
    if (filterPriority) out = out.filter(b => b.priority === filterPriority)
    if (filterReporter) out = out.filter(b => (b.reporter?.display_name || b.reporter?.name) === filterReporter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      out = out.filter(b =>
        (b.key||'').toLowerCase().includes(q) ||
        (b.summary||'').toLowerCase().includes(q) ||
        (b.parent_summary||'').toLowerCase().includes(q)
      )
    }
    const fn = SORT_FN[sortCol] || SORT_FN.created
    out = [...out].sort((a, b) => sortDir === 'asc' ? fn(a,b) : fn(b,a))
    return out
  }, [baseBugs, filterParent, filterPriority, filterReporter, search, sortCol, sortDir])

  const hasFilters = filterParent || filterPriority || filterReporter || search
  const clearFilters = () => { setFP(''); setFPr(''); setFR(''); setSearch('') }

  const jqlUrl = scope === 'all'
    ? jiraFilter(jiraBaseUrl, `issuetype = Bug AND created >= -${days}d ORDER BY created DESC`)
    : jiraFilter(jiraBaseUrl, `issuetype = Bug AND fixVersion = "${version}" AND created >= -${days}d ORDER BY created DESC`)

  const isLoading = scope === 'all' && allBugsQ.isLoading

  const selClass = 'text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-300 min-w-0'

  return (
    <div className="bg-white border border-gray-100 rounded-xl shadow-sm overflow-hidden">
      {/* ── Header bar ── */}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-100 bg-blue-50">
        <Bug className="h-4 w-4 text-blue-500" />
        <span className="text-sm font-semibold text-blue-800">Recently Opened Bugs</span>
        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-full p-0.5">
            {[['version','This version'],['all','All bugs']].map(([val, label]) => (
              <button key={val} onClick={() => setScope(val)}
                className={`text-xs px-2.5 py-1 rounded-full font-medium transition-colors ${
                  scope === val ? 'bg-blue-600 text-white' : 'text-gray-500 hover:text-gray-700'
                }`}>{label}</button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            {[7, 30].map(d => (
              <button key={d} onClick={() => setDays(d)}
                className={`text-xs px-2.5 py-1 rounded-full font-medium transition-colors ${
                  days === d ? 'bg-blue-600 text-white' : 'bg-white text-gray-500 border border-gray-200 hover:bg-gray-50'
                }`}>{d} days</button>
            ))}
          </div>
          <span className="text-xs text-gray-400">
            {hasFilters ? `${filtered.length} / ${baseBugs.length}` : baseBugs.length} bug{baseBugs.length !== 1 ? 's' : ''}
          </span>
          <a href={jqlUrl} target="_blank" rel="noopener noreferrer"
             className="text-xs text-blue-600 hover:underline flex items-center gap-0.5">
            <ExternalLink className="h-3 w-3" /> Jira
          </a>
        </div>
      </div>

      {/* ── Filter bar ── */}
      <div className="flex flex-wrap items-center gap-2 px-5 py-2.5 bg-gray-50 border-b border-gray-100">
        {/* Search */}
        <input
          type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search key / summary…"
          className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white text-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-300 w-44"
        />
        {/* Parent filter */}
        <select value={filterParent} onChange={e => setFP(e.target.value)} className={selClass}>
          <option value="">All parents</option>
          {parentOptions.map(([key, label]) => (
            <option key={key} value={key}>{key} — {label.length > 40 ? label.slice(0,40)+'…' : label}</option>
          ))}
        </select>
        {/* Priority filter */}
        <select value={filterPriority} onChange={e => setFPr(e.target.value)} className={selClass}>
          <option value="">All priorities</option>
          {['Highest','High','Medium','Low','Lowest'].filter(p => priorityOptions.includes(p)).map(p => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        {/* Reporter filter */}
        <select value={filterReporter} onChange={e => setFR(e.target.value)} className={selClass}>
          <option value="">All reporters</option>
          {reporterOptions.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        {/* Clear */}
        {hasFilters && (
          <button onClick={clearFilters}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-red-500 transition-colors">
            <X className="h-3 w-3" /> Clear
          </button>
        )}
      </div>

      {/* ── Table ── */}
      <div className="p-4">
        {isLoading && <Spinner label="Loading bugs…" />}
        {!isLoading && filtered.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-6 flex items-center justify-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            {hasFilters ? 'No bugs match the current filters' : `No bugs opened in the last ${days} days`}
          </p>
        )}
        {!isLoading && filtered.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" style={{ minWidth: '980px' }}>
              <thead>
                <tr className="text-gray-400 uppercase tracking-wide border-b border-gray-100">
                  <SortTh label="Key"           col="key"      sortCol={sortCol} sortDir={sortDir} onSort={handleSort} className="text-left w-28" />
                  <SortTh label="Summary"       col="summary"  sortCol={sortCol} sortDir={sortDir} onSort={handleSort} className="text-left w-44" />
                  <SortTh label="Parent"        col="parent"   sortCol={sortCol} sortDir={sortDir} onSort={handleSort} className="text-left w-24" />
                  <th className="text-left py-2 font-semibold">Parent Summary</th>
                  <SortTh label="Priority"      col="priority" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} className="text-center w-20" />
                  <SortTh label="Status"        col="status"   sortCol={sortCol} sortDir={sortDir} onSort={handleSort} className="text-left w-32" />
                  <SortTh label="Reporter"      col="reporter" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} className="text-left w-28" />
                  <SortTh label="Opened"        col="created"  sortCol={sortCol} sortDir={sortDir} onSort={handleSort} className="text-right w-20" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {filtered.map(b => {
                  const pBadge = PRIORITY_BADGE[b.priority] || 'bg-gray-100 text-gray-500'
                  const tok = statusToken(b.status)
                  const daysAgo = Math.floor((Date.now() - new Date(b.created)) / 86_400_000)
                  const reporterName = b.reporter?.display_name || b.reporter?.name || '—'
                  return (
                    <tr key={b.key} className="hover:bg-gray-50 align-top">
                      <td className="py-2 pr-2">
                        <a href={b.url} target="_blank" rel="noopener noreferrer"
                           className="font-mono text-brand-600 hover:underline flex items-center gap-0.5">
                          {b.key} <ExternalLink className="h-2.5 w-2.5 flex-shrink-0" />
                        </a>
                      </td>
                      <td className="py-2 pr-2 text-gray-700">
                        <span className="block line-clamp-2 leading-relaxed" title={b.summary}>{b.summary}</span>
                      </td>
                      <td className="py-2 pr-2">
                        {b.parent_key
                          ? <a href={b.parent_url} target="_blank" rel="noopener noreferrer"
                               className="font-mono text-brand-600 hover:underline flex items-center gap-0.5">
                              {b.parent_key} <ExternalLink className="h-2.5 w-2.5 flex-shrink-0" />
                            </a>
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="py-2 pr-2 text-gray-500">
                        {b.parent_summary
                          ? <span className="block line-clamp-2 leading-relaxed" title={b.parent_summary}>{b.parent_summary}</span>
                          : <span className="text-gray-300 italic">—</span>}
                      </td>
                      <td className="py-2 pr-2 text-center">
                        <span className={`px-1.5 py-0.5 rounded-full font-medium ${pBadge}`}>
                          {b.priority || '—'}
                        </span>
                      </td>
                      <td className="py-2 pr-2">
                        <span className={`px-1.5 py-0.5 rounded-full font-medium ${tok.bg} ${tok.text}`}>
                          {b.status}
                        </span>
                      </td>
                      <td className="py-2 pr-2 text-gray-500 whitespace-nowrap">{reporterName}</td>
                      <td className="py-2 text-right text-gray-400 whitespace-nowrap">
                        {daysAgo === 0 ? 'Today' : daysAgo === 1 ? '1d ago' : `${daysAgo}d ago`}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Loading / Error helpers ───────────────────────────────────────────────────
function Spinner({ label }) {
  return (
    <div className="flex items-center gap-3 py-8 justify-center">
      <div className="h-5 w-5 border-2 border-gray-200 border-t-gray-500 rounded-full animate-spin" />
      <span className="text-sm text-gray-400">{label}</span>
    </div>
  )
}
function ErrMsg({ msg }) {
  return <p className="text-sm text-red-500 text-center py-4">{msg || 'Error loading data'}</p>
}

// ── Daily QA Summary Panel ───────────────────────────────────────────────────

const RISK_LEVELS = ['Critical', 'High', 'Medium', 'Low']
const RISK_COLORS = {
  Critical: 'bg-red-100 text-red-700 border-red-300',
  High:     'bg-orange-100 text-orange-700 border-orange-300',
  Medium:   'bg-yellow-100 text-yellow-700 border-yellow-300',
  Low:      'bg-slate-100 text-slate-600 border-slate-300',
}

function ActivityTile({ label, count, color, icon: Icon, onClick, active }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 min-w-[110px] rounded-xl border px-3 py-3 text-left transition-all ${
        active ? 'ring-2 ring-offset-1' : 'hover:shadow-sm'
      } ${color}`}
    >
      <div className="flex items-center gap-2 mb-1">
        {Icon && <Icon className="h-3.5 w-3.5 opacity-70" />}
        <span className="text-[11px] font-semibold uppercase tracking-wide opacity-80">{label}</span>
      </div>
      <span className="text-2xl font-bold">{count ?? '—'}</span>
    </button>
  )
}

function ActivityTable({ items, emptyMsg, cols = ['Key', 'Summary', 'Type', 'Priority', 'Assignee', 'When'], onAddToRisk, addedKeys }) {
  if (!items?.length) return <p className="text-xs text-slate-400 py-3 text-center">{emptyMsg}</p>
  const fmtDate = s => s ? new Date(s).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'2-digit' }) : '—'
  const withRisk = !!onAddToRisk
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-100 text-slate-400 uppercase tracking-wide text-[10px] sticky top-0 bg-white z-10">
            {withRisk && <th className="py-1.5 px-1 w-6" />}
            {cols.map(c => <th key={c} className="py-1.5 px-2 text-left font-medium">{c}</th>)}
            {withRisk && <th className="py-1.5 px-2 text-left font-medium w-16">Risk</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {items.map(item => {
            const alreadyAdded = addedKeys?.has(item.key)
            return (
              <tr
                key={item.key}
                className={`hover:bg-slate-50 ${withRisk ? 'cursor-grab active:cursor-grabbing' : ''}`}
                draggable={withRisk}
                onDragStart={withRisk ? e => {
                  e.dataTransfer.effectAllowed = 'copy'
                  e.dataTransfer.setData('text/plain', JSON.stringify({ key: item.key, url: item.url, summary: item.summary, priority: item.priority }))
                } : undefined}
              >
                {withRisk && (
                  <td className="py-1.5 px-1 text-slate-300">
                    <GripVertical className="h-3.5 w-3.5" />
                  </td>
                )}
                <td className="py-1.5 px-2 font-mono">
                  <a href={item.url} target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline">{item.key}</a>
                </td>
                <td className="py-1.5 px-2 max-w-xs truncate text-slate-700">{item.summary}</td>
                {cols.includes('Type') && <td className="py-1.5 px-2 text-slate-500">{item.type}</td>}
                {cols.includes('Priority') && (
                  <td className="py-1.5 px-2">
                    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${PRIORITY_BADGE[item.priority] || 'bg-slate-100 text-slate-500'}`}>
                      {item.priority}
                    </span>
                  </td>
                )}
                {cols.includes('Parent') && (
                  <td className="py-1.5 px-2">
                    {item.parent_key
                      ? <a href={item.parent_url} target="_blank" rel="noreferrer" className="font-mono text-[11px] text-indigo-500 hover:underline" title={item.parent_name}>{item.parent_key}</a>
                      : <span className="text-slate-300">—</span>}
                  </td>
                )}
                {cols.includes('Status') && (
                  <td className="py-1.5 px-2">
                    {(() => {
                      const s = item.status || ''
                      const sl = s.toLowerCase()
                      const cls = sl.includes('done') || sl.includes('closed') || sl.includes('resolved')
                        ? 'bg-green-100 text-green-700'
                        : sl.includes('progress') || sl.includes('started')
                        ? 'bg-blue-100 text-blue-700'
                        : sl.includes('testing') || sl.includes('rft')
                        ? 'bg-purple-100 text-purple-700'
                        : sl.includes('reopen')
                        ? 'bg-orange-100 text-orange-700'
                        : sl.includes('deploy') || sl.includes('rfd')
                        ? 'bg-teal-100 text-teal-700'
                        : 'bg-slate-100 text-slate-500'
                      return <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium whitespace-nowrap ${cls}`}>{s || '—'}</span>
                    })()}
                  </td>
                )}
                {cols.includes('Assignee') && <td className="py-1.5 px-2 text-slate-500">{item.assignee}</td>}
                {cols.includes('Reporter') && <td className="py-1.5 px-2 text-slate-500">{item.reporter}</td>}
                {cols.includes('When') && <td className="py-1.5 px-2 text-slate-400 whitespace-nowrap">{fmtDate(item.when)}</td>}
                {withRisk && (
                  <td className="py-1.5 px-2">
                    <button
                      onClick={() => onAddToRisk(item)}
                      disabled={alreadyAdded}
                      title={alreadyAdded ? 'Already in Risk Tracker' : 'Add to Risk Tracker'}
                      className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-semibold transition-colors ${
                        alreadyAdded
                          ? 'bg-rose-100 text-rose-400 cursor-default'
                          : 'bg-rose-50 text-rose-600 hover:bg-rose-500 hover:text-white border border-rose-200'
                      }`}
                    >
                      {alreadyAdded ? '✓ Added' : <><Plus className="h-2.5 w-2.5" /> Risk</>}
                    </button>
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function RiskTracker({ risks, saveRisks, bugList }) {
  const [searchQ, setSearchQ]     = useState('')
  const [showDrop, setShowDrop]   = useState(false)
  const [manualText, setManual]   = useState('')
  const [manualLevel, setManualLevel] = useState('High')
  const [dragOver, setDragOver]   = useState(false)
  const dropRef = useRef(null)

  const addBug = useCallback((bug) => {
    if (risks.some(r => r.key === bug.key)) return
    saveRisks([...risks, { key: bug.key, url: bug.url, summary: bug.summary, level: bug.priority || 'High', type: 'bug' }])
    setSearchQ('')
    setShowDrop(false)
  }, [risks, saveRisks])

  const addManual = () => {
    if (!manualText.trim()) return
    saveRisks([...risks, { key: `RISK-${Date.now()}`, url: null, summary: manualText.trim(), level: manualLevel, type: 'manual' }])
    setManual('')
  }

  const remove = (key) => saveRisks(risks.filter(r => r.key !== key))
  const changeLevel = (key, level) => saveRisks(risks.map(r => r.key === key ? { ...r, level } : r))

  const filtered = useMemo(() => {
    if (!searchQ.trim()) return []
    const q = searchQ.toLowerCase()
    return (bugList || []).filter(b =>
      b.key?.toLowerCase().includes(q) || b.summary?.toLowerCase().includes(q)
    ).slice(0, 12)
  }, [searchQ, bugList])

  // Close search dropdown on outside click
  useEffect(() => {
    const h = e => { if (dropRef.current && !dropRef.current.contains(e.target)) setShowDrop(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const handleDragOver = e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOver(true) }
  const handleDragLeave = () => setDragOver(false)
  const handleDrop = e => {
    e.preventDefault()
    setDragOver(false)
    try {
      const bug = JSON.parse(e.dataTransfer.getData('text/plain'))
      if (bug?.key) addBug(bug)
    } catch {}
  }

  return (
    <div className="space-y-3">
      {/* Drag-drop target strip */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`flex items-center justify-center gap-2 rounded-lg border-2 border-dashed py-2.5 text-xs font-medium transition-colors ${
          dragOver
            ? 'border-rose-400 bg-rose-50 text-rose-600'
            : 'border-slate-200 text-slate-400 hover:border-rose-300 hover:text-rose-400'
        }`}
      >
        <GripVertical className="h-3.5 w-3.5" />
        {dragOver ? 'Drop to add as risk' : 'Drag a bug from the list above to add it here'}
      </div>

      {/* Add from bugs dropdown */}
      <div className="flex gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[220px]" ref={dropRef}>
          <div className="flex items-center gap-2 border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white focus-within:ring-2 focus-within:ring-rose-300">
            <Search className="h-3.5 w-3.5 text-slate-400 shrink-0" />
            <input
              className="flex-1 outline-none text-xs text-slate-700 placeholder-slate-400"
              placeholder="Search bugs to add as risk…"
              value={searchQ}
              onChange={e => { setSearchQ(e.target.value); setShowDrop(true) }}
              onFocus={() => setShowDrop(true)}
            />
          </div>
          {showDrop && filtered.length > 0 && (
            <div className="absolute z-20 top-full mt-1 left-0 right-0 bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
              {filtered.map(b => (
                <button
                  key={b.key}
                  onClick={() => addBug(b)}
                  className="w-full text-left px-3 py-2 text-xs hover:bg-rose-50 flex items-start gap-2 border-b border-slate-50 last:border-0"
                >
                  <span className="font-mono text-indigo-600 shrink-0 mt-0.5">{b.key}</span>
                  <span className="text-slate-700 line-clamp-2">{b.summary}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {/* Manual risk entry */}
        <input
          className="border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs flex-1 min-w-[180px] outline-none focus:ring-2 focus:ring-rose-300"
          placeholder="Or type a manual risk…"
          value={manualText}
          onChange={e => setManual(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addManual()}
        />
        <select
          value={manualLevel}
          onChange={e => setManualLevel(e.target.value)}
          className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs outline-none"
        >
          {RISK_LEVELS.map(l => <option key={l}>{l}</option>)}
        </select>
        <button
          onClick={addManual}
          disabled={!manualText.trim()}
          className="flex items-center gap-1 px-3 py-1.5 bg-rose-600 text-white text-xs font-semibold rounded-lg hover:bg-rose-700 disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" /> Add
        </button>
      </div>

      {/* Risk list */}
      {risks.length === 0 ? (
        <p className="text-xs text-slate-400 text-center py-4">No risks added yet — drag a bug from Latest Bugs, search above, or type a manual risk</p>
      ) : (
        <div className="space-y-2">
          {RISK_LEVELS.filter(l => risks.some(r => r.level === l)).map(level => (
            <div key={level}>
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">{level} risk</p>
              <div className="space-y-1">
                {risks.filter(r => r.level === level).map(r => (
                  <div key={r.key} className={`flex items-start gap-2 rounded-lg border px-3 py-2 ${RISK_COLORS[r.level]}`}>
                    <GripVertical className="h-3.5 w-3.5 mt-0.5 opacity-40 shrink-0" />
                    <div className="flex-1 min-w-0">
                      {r.url
                        ? <a href={r.url} target="_blank" rel="noreferrer" className="font-mono text-[11px] font-semibold hover:underline mr-2">{r.key}</a>
                        : <span className="text-[11px] font-semibold text-rose-700 mr-2">Manual</span>
                      }
                      <span className="text-xs">{r.summary}</span>
                    </div>
                    <select
                      value={r.level}
                      onChange={e => changeLevel(r.key, e.target.value)}
                      className="text-[10px] border-0 bg-transparent font-semibold outline-none cursor-pointer shrink-0"
                    >
                      {RISK_LEVELS.map(l => <option key={l}>{l}</option>)}
                    </select>
                    <button onClick={() => remove(r.key)} className="hover:text-red-700 shrink-0">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── QA Activity Chart ─────────────────────────────────────────────────────────

const CHART_SERIES = [
  { key: 'new_bugs',   label: 'New Bugs',   color: '#dc2626', kind: 'bar'  },
  { key: 'done',       label: 'Done',        color: '#16a34a', kind: 'bar'  },
  { key: 'rft',        label: 'RFT',         color: '#7c3aed', kind: 'bar'  },
  { key: 'reopened',   label: 'Reopened',    color: '#ea580c', kind: 'line' },
  { key: 'rfd',        label: 'Deploy',      color: '#0891b2', kind: 'line' },
]

function buildDailyTimeline(data, days) {
  if (!data) return []
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // Create a slot for each day in the period
  const slots = {}
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    slots[key] = { date: key, label: d.toLocaleDateString('en-US', { month:'short', day:'numeric' }), new_bugs: 0, done: 0, rft: 0, reopened: 0, rfd: 0 }
  }

  const bucket = (items, field) => {
    ;(items || []).forEach(item => {
      const raw = item.when
      if (!raw) return
      const key = raw.slice(0, 10)
      if (slots[key]) slots[key][field]++
    })
  }

  bucket(data.new_bugs,   'new_bugs')
  bucket(data.moved_done, 'done')
  bucket(data.moved_rft,  'rft')
  bucket(data.reopened,   'reopened')
  bucket(data.moved_rfd,  'rfd')

  return Object.values(slots)
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-lg px-4 py-3 text-xs min-w-[160px]">
      <p className="font-semibold text-slate-700 mb-2">{label}</p>
      {payload.map(p => (
        <div key={p.dataKey} className="flex items-center justify-between gap-4 mb-1">
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm inline-block shrink-0" style={{ background: p.color }} />
            <span className="text-slate-600">{p.name}</span>
          </span>
          <span className="font-bold text-slate-800">{p.value}</span>
        </div>
      ))}
    </div>
  )
}

function QAActivityChart({ data, days }) {
  const [view, setView]       = useState('chart')  // 'chart' | 'table'
  const [hidden, setHidden]   = useState(new Set())
  const timeline = useMemo(() => buildDailyTimeline(data, days), [data, days])

  const toggle = key => setHidden(prev => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })

  const totals = useMemo(() => {
    const t = { new_bugs: 0, done: 0, rft: 0, reopened: 0, rfd: 0 }
    timeline.forEach(row => Object.keys(t).forEach(k => t[k] += row[k] || 0))
    return t
  }, [timeline])

  if (!data) return null

  return (
    <div className="rounded-xl border border-slate-200 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 bg-slate-50 border-b border-slate-100">
        <BarChart2 className="h-4 w-4 text-slate-500" />
        <span className="font-semibold text-sm text-slate-700">Activity Timeline</span>
        <span className="text-xs text-slate-400">last {days} day{days > 1 ? 's' : ''}</span>
        <div className="ml-auto flex rounded-lg border border-slate-200 overflow-hidden">
          {['chart', 'table'].map(v => (
            <button key={v} onClick={() => setView(v)}
              className={`px-3 py-1 text-xs font-medium transition-colors capitalize ${view === v ? 'bg-slate-700 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}>
              {v}
            </button>
          ))}
        </div>
      </div>

      {view === 'chart' && (
        <div className="p-4">
          {/* Legend toggles */}
          <div className="flex flex-wrap gap-2 mb-3">
            {CHART_SERIES.map(s => (
              <button
                key={s.key}
                onClick={() => toggle(s.key)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-all ${
                  hidden.has(s.key) ? 'border-slate-200 bg-slate-50 text-slate-400' : 'border-transparent text-white'
                }`}
                style={hidden.has(s.key) ? {} : { background: s.color }}
              >
                <span>{s.label}</span>
                <span className={`font-bold ${hidden.has(s.key) ? 'text-slate-400' : 'text-white/80'}`}>
                  {totals[s.key] || 0}
                </span>
              </button>
            ))}
          </div>

          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={timeline} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}
              barCategoryGap="30%">
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
              <Tooltip content={<CustomTooltip />} />
              {CHART_SERIES.filter(s => s.kind === 'bar' && !hidden.has(s.key)).map(s => (
                <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[3,3,0,0]} maxBarSize={32} />
              ))}
              {CHART_SERIES.filter(s => s.kind === 'line' && !hidden.has(s.key)).map(s => (
                <Line key={s.key} dataKey={s.key} name={s.label} stroke={s.color}
                  strokeWidth={2} dot={{ r: 3, fill: s.color }} activeDot={{ r: 5 }} type="monotone" />
              ))}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {view === 'table' && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-100">
                <th className="py-2 px-4 text-left font-semibold text-slate-500 text-[10px] uppercase tracking-wide">Date</th>
                {CHART_SERIES.map(s => (
                  <th key={s.key} className="py-2 px-4 text-center font-semibold text-[10px] uppercase tracking-wide"
                      style={{ color: s.color }}>
                    {s.label}
                  </th>
                ))}
                <th className="py-2 px-4 text-center font-semibold text-slate-400 text-[10px] uppercase tracking-wide">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {[...timeline].reverse().map(row => {
                const total = CHART_SERIES.reduce((sum, s) => sum + (row[s.key] || 0), 0)
                return (
                  <tr key={row.date} className={`hover:bg-slate-50 ${total === 0 ? 'opacity-40' : ''}`}>
                    <td className="py-2 px-4 font-medium text-slate-600 whitespace-nowrap">{row.label}</td>
                    {CHART_SERIES.map(s => (
                      <td key={s.key} className="py-2 px-4 text-center">
                        {row[s.key] > 0
                          ? <span className="font-bold" style={{ color: s.color }}>{row[s.key]}</span>
                          : <span className="text-slate-300">—</span>}
                      </td>
                    ))}
                    <td className="py-2 px-4 text-center font-semibold text-slate-600">{total || '—'}</td>
                  </tr>
                )
              })}
              {/* Totals row */}
              <tr className="bg-slate-50 border-t border-slate-200 font-bold">
                <td className="py-2 px-4 text-slate-700 text-[11px] uppercase tracking-wide">Total</td>
                {CHART_SERIES.map(s => (
                  <td key={s.key} className="py-2 px-4 text-center text-sm font-bold" style={{ color: s.color }}>
                    {totals[s.key] || 0}
                  </td>
                ))}
                <td className="py-2 px-4 text-center text-sm font-bold text-slate-700">
                  {CHART_SERIES.reduce((sum, s) => sum + (totals[s.key] || 0), 0)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Daily QA Summary Panel ────────────────────────────────────────────────────
function DailyQASummaryPanel({ version, jiraBaseUrl, allBugs }) {
  const [sprint, setSprint]         = useState('')
  const [epicKey, setEpicKey]       = useState('')
  const [epicSearch, setEpicSearch] = useState('')
  const [showEpicDrop, setShowEpicDrop] = useState(false)
  const epicDropRef                 = useRef(null)
  const [days, setDays]             = useState(7)
  const [activeSection, setActive]  = useState(null)
  const [queryKey, setQueryKey]     = useState(null)  // null = not yet run

  // Lifted risk state — shared between Latest Bugs table (add buttons/drag) and RiskTracker
  const riskStorageKey = `qa_risks_${version}`
  const [risks, setRisks] = useState(() => {
    try { return JSON.parse(localStorage.getItem(`qa_risks_${version}`) || '[]') } catch { return [] }
  })
  useEffect(() => {
    try { setRisks(JSON.parse(localStorage.getItem(`qa_risks_${version}`) || '[]')) } catch { setRisks([]) }
  }, [version])
  const saveRisks = useCallback((next) => {
    setRisks(next)
    try { localStorage.setItem(riskStorageKey, JSON.stringify(next)) } catch {}
  }, [riskStorageKey])
  const addBugToRisk = useCallback((bug) => {
    setRisks(prev => {
      if (prev.some(r => r.key === bug.key)) return prev
      const next = [...prev, { key: bug.key, url: bug.url, summary: bug.summary, level: bug.priority || 'High', type: 'bug' }]
      try { localStorage.setItem(riskStorageKey, JSON.stringify(next)) } catch {}
      return next
    })
  }, [riskStorageKey])
  const riskKeys = useMemo(() => new Set(risks.map(r => r.key)), [risks])

  const sprintsQ = useQuery({
    queryKey: ['qa-sprints', version],
    queryFn:  () => getSprints(version),
    enabled:  !!version,
    staleTime: 10 * 60 * 1000,
  })
  const sprints = sprintsQ.data?.sprints || []

  const epicsQ = useQuery({
    queryKey: ['all-epics'],
    queryFn:  getEpics,
    staleTime: 60 * 60 * 1000,
  })
  const allEpics = epicsQ.data || []

  const filteredEpics = useMemo(() => {
    const q = epicSearch.toLowerCase()
    if (!q) return allEpics.slice(0, 20)
    return allEpics.filter(e =>
      e.key?.toLowerCase().includes(q) || e.name?.toLowerCase().includes(q)
    ).slice(0, 20)
  }, [epicSearch, allEpics])

  const selectedEpic = allEpics.find(e => e.key === epicKey)

  // Close epic dropdown on outside click
  useEffect(() => {
    const h = ev => { if (epicDropRef.current && !epicDropRef.current.contains(ev.target)) setShowEpicDrop(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const activityQ = useQuery({
    queryKey: ['qa-activity', version, sprint, epicKey, days, queryKey],
    queryFn:  () => getQAActivity(version, sprint, days, epicKey),
    enabled:  !!version && queryKey !== null,
    staleTime: 5 * 60 * 1000,
  })

  const data   = activityQ.data
  const counts = data?.counts || {}

  const SECTIONS = [
    { key: 'new_bugs',   label: 'New Bugs',      color: 'bg-red-50 border-red-200 text-red-700',      icon: Bug,           cols: ['Key','Summary','Priority','Status','Assignee','Reporter','Parent','When'] },
    { key: 'moved_done', label: 'Moved to Done',  color: 'bg-green-50 border-green-200 text-green-700', icon: CheckCircle2,  cols: ['Key','Summary','Type','Assignee','When'] },
    { key: 'moved_rft',  label: 'Moved to RFT',   color: 'bg-purple-50 border-purple-200 text-purple-700', icon: FlaskConical, cols: ['Key','Summary','Type','Assignee','When'] },
    { key: 'reopened',   label: 'Reopened',        color: 'bg-orange-50 border-orange-200 text-orange-700', icon: RefreshCw,   cols: ['Key','Summary','Type','Assignee','When'] },
    { key: 'moved_rfd',  label: 'Ready to Deploy', color: 'bg-teal-50 border-teal-200 text-teal-700',   icon: Activity,      cols: ['Key','Summary','Type','Assignee','When'] },
    { key: 'started',    label: 'Started (In Prog)', color: 'bg-blue-50 border-blue-200 text-blue-700', icon: PlayCircle,    cols: ['Key','Summary','Type','Assignee','When'] },
  ]

  const [showExport, setShowExport] = useState(false)
  const exportRef                 = useRef(null)

  // Close export dropdown on outside click
  useEffect(() => {
    const h = ev => { if (exportRef.current && !exportRef.current.contains(ev.target)) setShowExport(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  // Broad bug pool for risk search: all version bugs + every issue in current activity report
  const allActivityBugs = useMemo(() => {
    if (!data) return allBugs || []
    const map = new Map((allBugs || []).map(b => [b.key, b]))
    const activityItems = [
      ...(data.new_bugs || []),
      ...(data.moved_done || []),
      ...(data.moved_rft || []),
      ...(data.reopened || []),
      ...(data.moved_rfd || []),
      ...(data.started || []),
    ]
    activityItems.forEach(b => { if (b.key && !map.has(b.key)) map.set(b.key, b) })
    return [...map.values()]
  }, [data, allBugs])

  const handleRun = () => {
    setQueryKey(Date.now())
    setActive(null)
  }

  // ── Export helpers ─────────────────────────────────────────────────────────
  const buildHtml = () => {
    const fmtDate = s => s ? new Date(s).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'2-digit' }) : '—'
    const bugRows = (data?.new_bugs || []).map(b =>
      `<tr><td><a href="${b.url}">${b.key}</a></td><td>${b.summary}</td><td>${b.priority}</td><td>${b.status}</td><td>${b.reporter}</td><td>${fmtDate(b.when)}</td></tr>`
    ).join('')
    const riskRows = risks.map(r =>
      `<tr><td>${r.key}</td><td>${r.summary}</td><td>${r.level}</td></tr>`
    ).join('')
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Daily QA Summary — ${version}</title>
<style>body{font-family:sans-serif;padding:24px;color:#1e293b}h1{color:#334155}h2{color:#475569;margin-top:24px}
table{border-collapse:collapse;width:100%;margin-top:8px}th,td{border:1px solid #e2e8f0;padding:6px 10px;text-align:left;font-size:13px}
th{background:#f8fafc;font-weight:600}tr:nth-child(even){background:#f8fafc}a{color:#4f46e5}</style></head><body>
<h1>Daily QA Summary — ${version}${epicKey ? ` + ${epicKey}` : ''}</h1>
<p>Period: last ${days} day${days>1?'s':''} ${sprint ? `| Sprint: ${sprint}` : ''} | Generated: ${new Date().toLocaleString()}</p>
<h2>Activity Summary</h2>
<table><tr><th>Category</th><th>Count</th></tr>
<tr><td>New Bugs</td><td>${counts.new_bugs||0}</td></tr>
<tr><td>Moved to Done</td><td>${counts.done||0}</td></tr>
<tr><td>Moved to RFT</td><td>${counts.rft||0}</td></tr>
<tr><td>Reopened</td><td>${counts.reopened||0}</td></tr>
<tr><td>Ready to Deploy</td><td>${counts.rfd||0}</td></tr>
<tr><td>Started</td><td>${counts.started||0}</td></tr>
</table>
<h2>Latest Bugs Opened (${data?.new_bugs?.length||0})</h2>
<table><tr><th>Key</th><th>Summary</th><th>Priority</th><th>Status</th><th>Reporter</th><th>Opened</th></tr>
${bugRows}</table>
<h2>Risk Tracker (${risks.length})</h2>
${risks.length ? `<table><tr><th>Key / ID</th><th>Description</th><th>Risk Level</th></tr>${riskRows}</table>` : '<p>No risks recorded.</p>'}
</body></html>`
  }

  const exportHTML = () => {
    const html = buildHtml()
    const blob = new Blob([html], { type: 'text/html' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `qa-summary-${version}-${new Date().toISOString().slice(0,10)}.html`
    a.click()
    URL.revokeObjectURL(a.href)
    setShowExport(false)
  }

  const exportDoc = () => {
    const html = buildHtml()
    const blob = new Blob(['﻿', html], { type: 'application/msword' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `qa-summary-${version}-${new Date().toISOString().slice(0,10)}.doc`
    a.click()
    URL.revokeObjectURL(a.href)
    setShowExport(false)
  }

  const exportEmail = () => {
    const c = counts
    const fmtDate = s => s ? new Date(s).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'2-digit' }) : '—'
    const PRIORITY_COLOR = { Highest:'#dc2626', High:'#ea580c', Medium:'#d97706', Low:'#16a34a', Lowest:'#6b7280' }
    const RISK_BG = { Critical:'#fee2e2', High:'#ffedd5', Medium:'#fef9c3', Low:'#f1f5f9' }
    const RISK_CLR = { Critical:'#991b1b', High:'#9a3412', Medium:'#854d0e', Low:'#475569' }

    const bugRows = (data?.new_bugs || []).map(b => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #f1f5f9;font-family:monospace;font-size:12px">
          <a href="${b.url}" style="color:#4f46e5;text-decoration:none">${b.key}</a>
        </td>
        <td style="padding:6px 10px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#1e293b;max-width:380px">${b.summary}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f1f5f9;text-align:center">
          <span style="background:${PRIORITY_COLOR[b.priority]||'#94a3b8'}22;color:${PRIORITY_COLOR[b.priority]||'#94a3b8'};padding:2px 7px;border-radius:4px;font-size:11px;font-weight:600">${b.priority||'—'}</span>
        </td>
        <td style="padding:6px 10px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#64748b">${b.status||'—'}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#64748b">${b.reporter||'—'}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#94a3b8;white-space:nowrap">${fmtDate(b.when)}</td>
      </tr>`).join('')

    const riskRows = risks.map(r => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9">
          ${r.url ? `<a href="${r.url}" style="font-family:monospace;font-size:12px;color:#4f46e5;text-decoration:none">${r.key}</a>` : `<span style="font-size:12px;color:#94a3b8">manual</span>`}
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#1e293b">${r.summary}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #f1f5f9;text-align:center">
          <span style="background:${RISK_BG[r.level]||'#f1f5f9'};color:${RISK_CLR[r.level]||'#475569'};padding:3px 9px;border-radius:5px;font-size:11px;font-weight:700">${r.level}</span>
        </td>
      </tr>`).join('')

    const STAT = (label, val, clr) => `
      <td style="text-align:center;padding:0 8px">
        <div style="background:${clr}18;border:1px solid ${clr}44;border-radius:10px;padding:12px 16px;min-width:90px">
          <div style="font-size:11px;font-weight:600;color:${clr};text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">${label}</div>
          <div style="font-size:26px;font-weight:800;color:${clr}">${val}</div>
        </div>
      </td>`

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>QA Summary — ${version}</title></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 0">
<tr><td align="center">
<table width="680" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">

  <!-- Header -->
  <tr><td style="background:linear-gradient(135deg,#1e293b,#334155);padding:28px 32px">
    <div style="color:#94a3b8;font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;margin-bottom:6px">QA Report</div>
    <div style="color:#ffffff;font-size:22px;font-weight:800;margin-bottom:4px">Daily QA Summary — ${version}${epicKey ? ` <span style="color:#a5b4fc;font-size:16px">+ ${epicKey}</span>` : ''}</div>
    <div style="color:#64748b;font-size:13px">Period: last <strong style="color:#94a3b8">${days} day${days>1?'s':''}</strong>${sprint ? ` &nbsp;·&nbsp; Sprint: <strong style="color:#94a3b8">${sprint}</strong>` : ''} &nbsp;·&nbsp; Generated ${new Date().toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'})}</div>
  </td></tr>

  <!-- Activity stats -->
  <tr><td style="padding:28px 32px 0">
    <div style="font-size:13px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.07em;margin-bottom:14px">Activity Summary</div>
    <table cellpadding="0" cellspacing="0"><tr>
      ${STAT('New Bugs', c.new_bugs||0, '#dc2626')}
      ${STAT('Done', c.done||0, '#16a34a')}
      ${STAT('RFT', c.rft||0, '#7c3aed')}
      ${STAT('Reopened', c.reopened||0, '#ea580c')}
      ${STAT('Deploy', c.rfd||0, '#0891b2')}
      ${STAT('Started', c.started||0, '#2563eb')}
    </tr></table>
  </td></tr>

  <!-- Latest bugs -->
  ${(data?.new_bugs?.length||0) > 0 ? `
  <tr><td style="padding:28px 32px 0">
    <div style="font-size:13px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px">
      Latest Bugs Opened <span style="color:#94a3b8;font-weight:500;font-size:11px;text-transform:none">(${data.new_bugs.length})</span>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #f1f5f9;border-radius:10px;overflow:hidden">
      <tr style="background:#fef2f2">
        <th style="padding:8px 10px;text-align:left;font-size:10px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #fee2e2">Key</th>
        <th style="padding:8px 10px;text-align:left;font-size:10px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #fee2e2">Summary</th>
        <th style="padding:8px 10px;text-align:center;font-size:10px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #fee2e2">Priority</th>
        <th style="padding:8px 10px;text-align:left;font-size:10px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #fee2e2">Status</th>
        <th style="padding:8px 10px;text-align:left;font-size:10px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #fee2e2">Reporter</th>
        <th style="padding:8px 10px;text-align:left;font-size:10px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #fee2e2">Opened</th>
      </tr>
      ${bugRows}
    </table>
  </td></tr>` : ''}

  <!-- Risks -->
  ${risks.length > 0 ? `
  <tr><td style="padding:28px 32px 0">
    <div style="font-size:13px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.07em;margin-bottom:10px">
      Risk Tracker <span style="color:#94a3b8;font-weight:500;font-size:11px;text-transform:none">(${risks.length})</span>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #f1f5f9;border-radius:10px;overflow:hidden">
      <tr style="background:#fff1f2">
        <th style="padding:8px 12px;text-align:left;font-size:10px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #ffe4e6">Key</th>
        <th style="padding:8px 12px;text-align:left;font-size:10px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #ffe4e6">Risk Description</th>
        <th style="padding:8px 12px;text-align:center;font-size:10px;color:#94a3b8;font-weight:600;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #ffe4e6">Level</th>
      </tr>
      ${riskRows}
    </table>
  </td></tr>` : ''}

  <!-- Footer -->
  <tr><td style="padding:28px 32px;text-align:center;color:#94a3b8;font-size:11px;border-top:1px solid #f1f5f9;margin-top:28px">
    Generated by QA Dashboard &nbsp;·&nbsp; ${new Date().toLocaleString()}
  </td></tr>

</table>
</td></tr></table>
</body></html>`

    const w = window.open('', '_blank', 'width=800,height=700,scrollbars=yes')
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Email Preview</title>
<style>body{margin:0;font-family:sans-serif;background:#e2e8f0}
.toolbar{position:sticky;top:0;background:#1e293b;color:#fff;padding:10px 20px;display:flex;align-items:center;gap:12px;z-index:10;font-size:13px}
.btn{padding:7px 16px;border-radius:7px;border:none;font-size:12px;font-weight:600;cursor:pointer}
.btn-copy{background:#6366f1;color:#fff}.btn-copy:hover{background:#4f46e5}
.btn-dl{background:#334155;color:#fff;border:1px solid #475569}.btn-dl:hover{background:#475569}
.hint{color:#94a3b8;font-size:11px;margin-left:auto}
iframe{border:none;width:100%;height:calc(100vh - 50px)}
</style></head><body>
<div class="toolbar">
  <span style="font-weight:700">📧 Email Preview</span>
  <button class="btn btn-copy" onclick="copyHTML()">Copy HTML to Clipboard</button>
  <button class="btn btn-dl" onclick="downloadHTML()">Download .html</button>
  <span class="hint">Paste into Outlook / Gmail compose → Format → HTML</span>
</div>
<iframe id="preview" srcdoc="${html.replace(/"/g, '&quot;')}"></iframe>
<script>
const html = ${JSON.stringify(html)};
function copyHTML(){navigator.clipboard.writeText(html).then(()=>{
  const b=document.querySelector('.btn-copy');b.textContent='✓ Copied!';setTimeout(()=>b.textContent='Copy HTML to Clipboard',2000)
})}
function downloadHTML(){
  const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([html],{type:'text/html'}));
  a.download='qa-summary-${version}-${new Date().toISOString().slice(0,10)}.html';a.click()
}
</script></body></html>`)
    w.document.close()
    setShowExport(false)
  }

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 px-5 py-3 border-b border-slate-100 bg-slate-50">
        {/* Sprint */}
        <div className="flex items-center gap-1.5">
          <label className="text-xs font-medium text-slate-500">Sprint</label>
          <select
            value={sprint}
            onChange={e => setSprint(e.target.value)}
            className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white outline-none focus:ring-2 focus:ring-slate-400 min-w-[160px]"
          >
            <option value="">— All sprints —</option>
            {sprints.map(s => (
              <option key={s.id} value={s.name}>{s.name}{s.state === 'active' ? ' ✓' : ''}</option>
            ))}
          </select>
        </div>

        {/* Epic (searchable) */}
        <div className="flex items-center gap-1.5" ref={epicDropRef}>
          <label className="text-xs font-medium text-slate-500">+ Epic</label>
          <div className="relative">
            <div
              className={`flex items-center gap-1.5 border rounded-lg px-2 py-1.5 bg-white cursor-text min-w-[200px] text-xs ${
                epicKey ? 'border-indigo-400 ring-1 ring-indigo-300' : 'border-slate-200'
              } focus-within:ring-2 focus-within:ring-indigo-300`}
              onClick={() => setShowEpicDrop(true)}
            >
              {epicKey ? (
                <>
                  <span className="font-mono text-indigo-600 shrink-0">{epicKey}</span>
                  <span className="text-slate-600 truncate max-w-[110px]">{selectedEpic?.name || ''}</span>
                  <button
                    onClick={e => { e.stopPropagation(); setEpicKey(''); setEpicSearch('') }}
                    className="ml-auto text-slate-400 hover:text-slate-600 shrink-0"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </>
              ) : (
                <input
                  className="flex-1 outline-none text-xs text-slate-700 placeholder-slate-400 bg-transparent"
                  placeholder="Search epic…"
                  value={epicSearch}
                  onChange={e => { setEpicSearch(e.target.value); setShowEpicDrop(true) }}
                  onFocus={() => setShowEpicDrop(true)}
                />
              )}
            </div>
            {showEpicDrop && !epicKey && (
              <div className="absolute z-20 top-full mt-1 left-0 right-0 bg-white border border-slate-200 rounded-lg shadow-lg max-h-52 overflow-y-auto min-w-[260px]">
                {filteredEpics.length === 0 ? (
                  <p className="text-xs text-slate-400 px-3 py-2">No epics found</p>
                ) : filteredEpics.map(ep => (
                  <button
                    key={ep.key}
                    onClick={() => { setEpicKey(ep.key); setEpicSearch(''); setShowEpicDrop(false) }}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-indigo-50 flex items-start gap-2 border-b border-slate-50 last:border-0"
                  >
                    <span className="font-mono text-indigo-600 shrink-0 mt-0.5">{ep.key}</span>
                    <span className="text-slate-700 line-clamp-1">{ep.name}</span>
                    {ep.status && <span className="ml-auto text-[10px] text-slate-400 shrink-0">{ep.status}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Days */}
        <div className="flex items-center gap-1.5">
          <label className="text-xs font-medium text-slate-500">Period</label>
          <div className="flex rounded-lg border border-slate-200 overflow-hidden">
            {[1, 3, 7, 14, 30].map(d => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  days === d ? 'bg-slate-700 text-white' : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {/* Export */}
          {data && (
            <div className="relative" ref={exportRef}>
              <button
                onClick={() => setShowExport(v => !v)}
                className="flex items-center gap-1.5 px-3 py-1.5 border border-slate-300 bg-white text-slate-600 text-xs font-semibold rounded-lg hover:bg-slate-50 transition-colors"
              >
                <ExternalLink className="h-3.5 w-3.5" /> Export
                <ChevronDown className="h-3 w-3 ml-0.5" />
              </button>
              {showExport && (
                <div className="absolute right-0 top-full mt-1 bg-white border border-slate-200 rounded-xl shadow-lg z-30 min-w-[160px] overflow-hidden">
                  <button onClick={exportHTML}  className="w-full text-left px-4 py-2.5 text-xs hover:bg-slate-50 flex items-center gap-2"><BarChart2 className="h-3.5 w-3.5 text-slate-400" /> Download HTML</button>
                  <button onClick={exportDoc}   className="w-full text-left px-4 py-2.5 text-xs hover:bg-slate-50 flex items-center gap-2 border-t border-slate-50"><ShieldCheck className="h-3.5 w-3.5 text-slate-400" /> Download .doc</button>
                  <button onClick={exportEmail} className="w-full text-left px-4 py-2.5 text-xs hover:bg-slate-50 flex items-center gap-2 border-t border-slate-50"><Activity className="h-3.5 w-3.5 text-slate-400" /> Send via Email</button>
                </div>
              )}
            </div>
          )}

          {/* Run */}
          <button
            onClick={handleRun}
            disabled={!version || activityQ.isFetching}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-slate-700 text-white text-xs font-semibold rounded-lg hover:bg-slate-800 disabled:opacity-40 transition-colors"
          >
            {activityQ.isFetching ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />}
            Run Report
          </button>
        </div>
      </div>

      {/* Content */}
      {queryKey === null && (
        <div className="py-12 text-center text-slate-400 text-sm">
          Select filters above and click <strong>Run Report</strong> to see QA activity
        </div>
      )}

      {activityQ.isError && queryKey !== null && (
        <p className="text-sm text-red-500 text-center py-8">Failed to load activity data</p>
      )}

      {data && (
        <div className="p-5 space-y-5">
          {/* Activity stat tiles */}
          <div className="flex flex-wrap gap-2">
            {SECTIONS.map(s => (
              <ActivityTile
                key={s.key}
                label={s.label}
                count={counts[s.key === 'new_bugs' ? 'new_bugs' : s.key === 'moved_done' ? 'done' : s.key === 'moved_rft' ? 'rft' : s.key === 'reopened' ? 'reopened' : s.key === 'moved_rfd' ? 'rfd' : 'started']}
                color={s.color}
                icon={s.icon}
                active={activeSection === s.key}
                onClick={() => setActive(activeSection === s.key ? null : s.key)}
              />
            ))}
          </div>

          {/* Timeline chart + table */}
          <QAActivityChart data={data} days={days} />

          {/* Detail table for active section */}
          {activeSection && (() => {
            const sec = SECTIONS.find(s => s.key === activeSection)
            const items = data[activeSection] || []
            const isBugs = activeSection === 'new_bugs'
            const bugCols = isBugs
              ? ['Key','Summary','Priority','Status','Assignee','Reporter','Parent','When']
              : sec.cols
            return (
              <div className={`rounded-xl border p-4 ${sec.color}`}>
                <div className="flex items-center gap-2 mb-3">
                  {sec.icon && <sec.icon className="h-4 w-4" />}
                  <span className="font-semibold text-sm">{sec.label}</span>
                  <span className="text-xs opacity-70 ml-1">— last {days} day{days > 1 ? 's' : ''}</span>
                  <button onClick={() => setActive(null)} className="ml-auto opacity-50 hover:opacity-100"><X className="h-4 w-4" /></button>
                </div>
                <div className="bg-white rounded-lg overflow-y-auto" style={isBugs ? { maxHeight: 480 } : {}}>
                  <ActivityTable
                    items={items}
                    emptyMsg={`No "${sec.label}" activity in this period`}
                    cols={bugCols}
                    onAddToRisk={isBugs ? addBugToRisk : undefined}
                    addedKeys={isBugs ? riskKeys : undefined}
                  />
                </div>
              </div>
            )
          })()}

          {/* Always show new bugs as bottom section */}
          {!activeSection && data.new_bugs?.length > 0 && (
            <div className="rounded-xl border border-red-200 bg-red-50">
              <div className="flex items-center gap-2 px-4 py-2.5 border-b border-red-100">
                <Bug className="h-4 w-4 text-red-600" />
                <span className="font-semibold text-sm text-red-700">Latest Bugs Opened</span>
                <span className="text-xs text-red-400 ml-1">last {days}d</span>
              </div>
              <div className="bg-white rounded-b-xl overflow-y-auto" style={{ maxHeight: 420 }}>
                <ActivityTable
                  items={data.new_bugs}
                  emptyMsg="No new bugs"
                  cols={['Key','Summary','Priority','Status','Assignee','Reporter','Parent','When']}
                  onAddToRisk={addBugToRisk}
                  addedKeys={riskKeys}
                />
              </div>
            </div>
          )}

          {/* Risk Tracker */}
          <div className="rounded-xl border border-rose-200 overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2.5 bg-rose-50 border-b border-rose-100">
              <AlertTriangle className="h-4 w-4 text-rose-600" />
              <span className="font-semibold text-sm text-rose-700">Risk Tracker</span>
              <span className="text-xs text-rose-400 ml-1">— saved per version in browser</span>
            </div>
            <div className="p-4 bg-white">
              <RiskTracker risks={risks} saveRisks={saveRisks} bugList={allActivityBugs} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Allocation Tab ────────────────────────────────────────────────────────────
function AllocationTab({ version, jiraBaseUrl }) {
  const [sprintFilter, setSprintFilter] = useState('')
  const [focusMember, setFocusMember]   = useState(null)   // null=All, ''=Unassigned, id=member
  const [localAsgn, setLocalAsgn]       = useState({})     // key → {id, name}
  const [reassignLd, setReassignLd]     = useState({})     // key → bool

  const sprintQ = useQuery({
    queryKey: ['sprints', version],
    queryFn:  () => getSprints(version),
    enabled:  !!version,
    staleTime: 10 * 60 * 1000,
  })
  const sprints = sprintQ.data?.sprints || []

  const q = useQuery({
    queryKey: ['allocation', version, sprintFilter],
    queryFn:  () => getAllocation(version || undefined, sprintFilter || undefined),
    staleTime: 2 * 60 * 1000,
  })

  const rawItems = q.data?.items || []
  const workload  = q.data?.workload  || []

  // Merge local assignee overrides into items
  const items = rawItems.map(i => {
    const local = localAsgn[i.key]
    return local ? { ...i, assignee: local.name, assignee_id: local.id } : i
  })

  // Recompute live workload counts from items (reflecting local reassignments)
  const liveWorkload = useMemo(() => {
    const counts = {}
    workload.forEach(w => { counts[w.id] = { ...w, count: 0 } })
    items.forEach(item => {
      const aid = item.assignee_id || 'unassigned'
      if (!counts[aid]) counts[aid] = { id: aid, name: item.assignee || 'Unassigned', count: 0 }
      counts[aid].count++
    })
    return Object.values(counts).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  }, [items, workload])

  const filteredItems = useMemo(() => {
    if (focusMember === null) return items
    if (focusMember === '')   return items.filter(i => !i.assignee_id)
    return items.filter(i => i.assignee_id === focusMember)
  }, [items, focusMember])

  const allMembers = liveWorkload.filter(w => w.id !== 'unassigned')
  const maxCount   = Math.max(...liveWorkload.map(w => w.count), 1)

  const doReassign = async (key, member) => {
    setReassignLd(p => ({ ...p, [key]: true }))
    try {
      await reassignIssue(key, member.id === 'unassigned' ? null : member.id)
      setLocalAsgn(p => ({ ...p, [key]: member }))
    } catch {} finally { setReassignLd(p => ({ ...p, [key]: false })) }
  }

  const overloadStyle = (count) => {
    if (count === 0) return { ring: 'ring-gray-200',  badge: 'bg-gray-100 text-gray-400',   bar: 'bg-gray-200',  label: ''           }
    if (count <= 2)  return { ring: 'ring-green-300', badge: 'bg-green-100 text-green-700', bar: 'bg-green-400', label: 'OK'         }
    if (count <= 4)  return { ring: 'ring-amber-300', badge: 'bg-amber-100 text-amber-700', bar: 'bg-amber-400', label: 'Busy'       }
    return               { ring: 'ring-red-400',   badge: 'bg-red-100 text-red-700',     bar: 'bg-red-500',   label: 'Overloaded' }
  }

  return (
    <div className="space-y-5">
      {/* Header + filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-semibold text-gray-800">QA Allocation</h2>
          <p className="text-xs text-gray-400 mt-0.5">Ready for Testing — assign &amp; balance workload</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <select value={sprintFilter} onChange={e => { setSprintFilter(e.target.value); setFocusMember(null) }}
            className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 text-gray-600 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300">
            <option value="">All Sprints</option>
            {sprints.map(s => {
              const name = typeof s === 'string' ? s : (s.name || String(s))
              return <option key={name} value={name}>{name}</option>
            })}
          </select>
          <button onClick={() => q.refetch()} disabled={q.isFetching}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-50 text-indigo-600 text-xs font-medium hover:bg-indigo-100 transition-colors disabled:opacity-50">
            <RefreshCw className={`h-3 w-3 ${q.isFetching ? 'animate-spin' : ''}`} />
            {q.isFetching ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        {q.isError && <span className="text-xs text-red-500 w-full">{q.error?.message}</span>}
      </div>

      {/* Workload cards */}
      <div className="flex flex-wrap gap-2">
        <button onClick={() => setFocusMember(null)}
          className={`px-3 py-2 rounded-xl text-xs font-medium border transition-all ${
            focusMember === null ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm' : 'bg-white text-gray-600 border-gray-200 hover:border-indigo-300'
          }`}>
          All ({items.length})
        </button>

        {(() => {
          const u = liveWorkload.find(w => w.id === 'unassigned')
          const cnt = u?.count || 0
          if (cnt === 0 && focusMember !== '') return null
          return (
            <button onClick={() => setFocusMember(focusMember === '' ? null : '')}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium border transition-all ${
                focusMember === '' ? 'bg-gray-800 text-white border-gray-800' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
              }`}>
              Unassigned
              {cnt > 0 && <span className="bg-red-500 text-white rounded-full px-1.5 py-0.5 text-[10px] font-bold">{cnt}</span>}
            </button>
          )
        })()}

        {allMembers.map(member => {
          const { ring, badge, bar, label } = overloadStyle(member.count)
          const focused = focusMember === member.id
          const barPct  = Math.round(member.count / maxCount * 100)
          return (
            <button key={member.id} onClick={() => setFocusMember(focused ? null : member.id)}
              className={`flex flex-col gap-1 px-3 py-2 rounded-xl border transition-all min-w-[105px] text-left ${
                focused ? `ring-2 ${ring} bg-white border-transparent` : 'bg-white border-gray-200 hover:border-indigo-200'
              }`}>
              <div className="flex items-center justify-between gap-1.5">
                <span className="text-[11px] font-medium text-gray-700 truncate">{member.name.split(' ')[0]}</span>
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0 ${badge}`}>{member.count}</span>
              </div>
              {label && <span className={`text-[9px] font-semibold uppercase tracking-wide ${badge} px-1 rounded self-start`}>{label}</span>}
              <div className="h-1 bg-gray-100 rounded-full w-full">
                <div className={`h-1 rounded-full transition-all ${bar}`} style={{ width: `${barPct}%` }} />
              </div>
            </button>
          )
        })}
      </div>

      {/* Table */}
      {q.isLoading ? (
        <div className="text-center py-12 text-gray-400 text-sm">Loading…</div>
      ) : filteredItems.length === 0 ? (
        <div className="text-center py-12 text-gray-400 text-sm">No items{focusMember !== null ? ' for this filter' : ''}</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-100 shadow-sm">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                {['Type','Key','Summary','Priority','Parent','Sprint','Assigned To'].map(h => (
                  <th key={h} className="px-4 py-2.5 text-left font-semibold text-gray-500 uppercase tracking-wide text-[10px]">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filteredItems.map(item => {
                const loading = reassignLd[item.key]
                const currentId = item.assignee_id || 'unassigned'
                return (
                  <tr key={item.key} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      {item.issuetype && (
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                          item.issuetype === 'Bug'      ? 'bg-red-100 text-red-700' :
                          item.issuetype === 'Story'    ? 'bg-green-100 text-green-700' :
                          item.issuetype === 'Task'     ? 'bg-blue-100 text-blue-700' :
                          item.issuetype === 'Sub-task' ? 'bg-purple-100 text-purple-700' :
                          'bg-gray-100 text-gray-600'
                        }`}>{item.issuetype}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <a href={item.url} target="_blank" rel="noopener noreferrer"
                        className="text-indigo-600 hover:text-indigo-800 font-mono font-medium">{item.key}</a>
                    </td>
                    <td className="px-4 py-2.5 max-w-xs">
                      <span className="line-clamp-2 text-gray-700">{item.summary}</span>
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${PRIORITY_COLORS[item.priority] || 'bg-gray-300'}`} />
                      <span className="text-gray-600">{item.priority || '—'}</span>
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      {item.parent_key
                        ? <a href={item.parent_url} target="_blank" rel="noopener noreferrer"
                            className="text-indigo-600 hover:text-indigo-800 font-mono text-[11px]"
                            title={item.parent_summary}>{item.parent_key}</a>
                        : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-gray-500">{item.sprint || '—'}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        {loading && <span className="h-3 w-3 border border-indigo-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />}
                        <select value={currentId} disabled={loading}
                          onChange={e => {
                            const m = [{ id: 'unassigned', name: 'Unassigned' }, ...allMembers].find(x => x.id === e.target.value)
                            if (m) doReassign(item.key, m)
                          }}
                          className="text-xs border border-gray-200 rounded-lg px-2 py-1 text-gray-700 bg-white focus:outline-none focus:ring-1 focus:ring-indigo-300 disabled:opacity-50 max-w-[170px]">
                          <option value="unassigned">Unassigned</option>
                          {allMembers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                        </select>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Handover Status Changer ───────────────────────────────────────────────────
const HANDOVER_STATUS_COLORS = {
  'Done': 'bg-green-100 text-green-700', 'DONE': 'bg-green-100 text-green-700',
  'In Progress': 'bg-blue-100 text-blue-700',
  'Ready for Testing': 'bg-purple-100 text-purple-700',
  'To Do': 'bg-gray-100 text-gray-500', 'ToDo': 'bg-gray-100 text-gray-500',
  'Blocked': 'bg-red-100 text-red-700', 'Reopened': 'bg-orange-100 text-orange-700',
  'Ready For Deployment': 'bg-teal-100 text-teal-700',
  'In Review': 'bg-indigo-100 text-indigo-700',
}

function HandoverStatusChanger({ itemKey, currentStatus, onChanged }) {
  const [open, setOpen]           = useState(false)
  const [transitions, setTrans]   = useState([])
  const [loading, setLoading]     = useState(false)
  const [applying, setApplying]   = useState(false)
  const [localStatus, setLocal]   = useState(currentStatus)
  const ref = useRef(null)

  useEffect(() => { setLocal(currentStatus) }, [currentStatus])
  useEffect(() => {
    if (!open) return
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const openDrop = async (e) => {
    e.stopPropagation()
    if (open) { setOpen(false); return }
    setLoading(true)
    try {
      const d = await getTransitions(itemKey)
      setTrans(d.transitions || [])
      setOpen(true)
    } catch {} finally { setLoading(false) }
  }

  const apply = async (e, t) => {
    e.stopPropagation(); setOpen(false); setApplying(true)
    try {
      await applyTransition({ test_key: itemKey, transition_id: t.id })
      const next = t.to_status || t.name
      setLocal(next); onChanged?.(next)
    } catch {} finally { setApplying(false) }
  }

  const cls = HANDOVER_STATUS_COLORS[localStatus] || 'bg-gray-100 text-gray-600'
  return (
    <div className="relative inline-block" ref={ref}>
      <button onClick={openDrop} disabled={applying}
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium cursor-pointer select-none
          ${cls} ${applying ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-75'}`}>
        {(applying || loading) && <span className="h-2.5 w-2.5 border border-current border-t-transparent rounded-full animate-spin flex-shrink-0" />}
        <span>{localStatus || '—'}</span>
        {!applying && !loading && <ChevronDown className="h-2.5 w-2.5 opacity-50 flex-shrink-0" />}
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 bg-white border border-gray-200 rounded-xl shadow-2xl min-w-[180px] py-1">
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-3 py-1.5 border-b border-gray-100">Transition to…</p>
          {transitions.length === 0 && <p className="text-xs text-gray-400 px-3 py-2">No transitions available</p>}
          {transitions.map(t => (
            <button key={t.id} onClick={(e) => apply(e, t)}
              className="w-full text-left px-3 py-2 text-xs hover:bg-gray-50 transition-colors flex items-center justify-between gap-3">
              <span className="text-gray-700 font-medium">{t.name}</span>
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${HANDOVER_STATUS_COLORS[t.to_status] || 'bg-gray-100 text-gray-500'}`}>{t.to_status}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Handover Tab ──────────────────────────────────────────────────────────────
function HandoverTab({ version, jiraBaseUrl }) {
  const [selected, setSelected]       = useState(new Set())
  const [bulkTrans, setBulkTrans]     = useState([])
  const [bulkOpen, setBulkOpen]       = useState(false)
  const [bulkLoading, setBulkLoading] = useState(false)
  const [bulkApplying, setBulkApply]  = useState(false)
  const [rowResults, setRowResults]   = useState({})
  const [localStatuses, setLocalSt]   = useState({})
  const bulkRef = useRef(null)

  const q = useQuery({
    queryKey: ['handover-items', version],
    queryFn:  () => getHandoverItems(version),
    enabled:  !!version,
    staleTime: 5 * 60 * 1000,
  })

  useEffect(() => {
    if (!bulkOpen) return
    const close = (e) => { if (bulkRef.current && !bulkRef.current.contains(e.target)) setBulkOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [bulkOpen])

  const items = q.data?.items || []

  const toggleSelect = (key) => {
    setSelected(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  }
  const toggleAll = () => setSelected(prev => prev.size === items.length ? new Set() : new Set(items.map(i => i.key)))

  const openBulk = async () => {
    if (bulkOpen) { setBulkOpen(false); return }
    const firstKey = [...selected][0]; if (!firstKey) return
    setBulkLoading(true)
    try { const d = await getTransitions(firstKey); setBulkTrans(d.transitions || []); setBulkOpen(true) }
    catch {} finally { setBulkLoading(false) }
  }

  const applyBulk = async (t) => {
    setBulkOpen(false); setBulkApply(true)
    const keys = [...selected]
    setRowResults(Object.fromEntries(keys.map(k => [k, 'pending'])))
    const newStatus = t.to_status || t.name
    const results = await Promise.allSettled(
      keys.map(k => applyTransition({ test_key: k, transition_id: t.id })
        .then(() => ({ key: k, ok: true })).catch(() => ({ key: k, ok: false })))
    )
    const nextR = {}; const nextSt = { ...localStatuses }
    for (const r of results) {
      const val = r.value
      if (val?.ok) { nextR[val.key] = 'ok'; nextSt[val.key] = newStatus }
      else if (val) { nextR[val.key] = 'error' }
    }
    setRowResults(nextR); setLocalSt(nextSt); setBulkApply(false)
    setTimeout(() => { setSelected(new Set()); setRowResults({}) }, 2500)
  }

  const TYPE_COLORS = {
    'Story': 'bg-green-100 text-green-700', 'Task': 'bg-blue-100 text-blue-700',
    'Sub-task': 'bg-purple-100 text-purple-700', 'Bug': 'bg-red-100 text-red-700',
  }

  if (!version) return <p className="text-sm text-gray-400 text-center py-12">Select a version above</p>

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-gray-800">Handover Process</h2>
          <p className="text-xs text-gray-400 mt-0.5">Stories &amp; tasks with "handover" in description · {version}</p>
          <p className="text-[10px] font-mono text-gray-300 mt-1 select-all">
            project = TMT0 AND fixVersion = &quot;{version}&quot; AND description ~ &quot;handover&quot; ORDER BY updated DESC
          </p>
        </div>
        <div className="flex items-center gap-3">
          {q.isLoading && <span className="text-xs text-gray-400">Loading…</span>}
          {q.isError   && <span className="text-xs text-red-500">{q.error?.message}</span>}
          {!q.isLoading && !q.isError && <span className="text-xs text-gray-500 font-medium">{items.length} items</span>}
          <button onClick={() => q.refetch()} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-50 text-indigo-600 text-xs font-medium hover:bg-indigo-100 transition-colors">
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
        </div>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 px-4 py-2 bg-indigo-50 border border-indigo-200 rounded-xl">
          <span className="text-xs font-semibold text-indigo-700">{selected.size} selected</span>
          <div className="relative" ref={bulkRef}>
            <button onClick={openBulk} disabled={bulkLoading || bulkApplying}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors">
              {(bulkLoading || bulkApplying) && <span className="h-3 w-3 border border-white border-t-transparent rounded-full animate-spin" />}
              Change Status
              {!bulkLoading && !bulkApplying && <ChevronDown className="h-3 w-3" />}
            </button>
            {bulkOpen && (
              <div className="absolute left-0 top-full mt-1 z-50 bg-white border border-gray-200 rounded-xl shadow-2xl min-w-[210px] py-1">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-3 py-1.5 border-b border-gray-100">
                  Apply to {selected.size} item{selected.size > 1 ? 's' : ''}…
                </p>
                {bulkTrans.map(t => (
                  <button key={t.id} onClick={() => applyBulk(t)}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-gray-50 transition-colors flex items-center justify-between gap-3">
                    <span className="text-gray-700 font-medium">{t.name}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${HANDOVER_STATUS_COLORS[t.to_status] || 'bg-gray-100 text-gray-500'}`}>{t.to_status}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button onClick={() => setSelected(new Set())} className="ml-auto text-xs text-gray-400 hover:text-gray-600 transition-colors">Clear</button>
        </div>
      )}

      {/* Empty state */}
      {!q.isLoading && items.length === 0 && (
        <div className="text-center py-16 text-gray-400 text-sm">
          No stories or tasks with &ldquo;handover&rdquo; in description found for <span className="font-medium">{version}</span>
        </div>
      )}

      {/* Table */}
      {items.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                <th className="px-3 py-2.5 w-8">
                  <input type="checkbox"
                    checked={items.length > 0 && selected.size === items.length}
                    ref={el => { if (el) el.indeterminate = selected.size > 0 && selected.size < items.length }}
                    onChange={toggleAll}
                    className="h-3.5 w-3.5 accent-indigo-600 cursor-pointer"
                  />
                </th>
                {['Key', 'Type', 'Summary', 'Status', 'Assignee', 'Parent'].map(h => (
                  <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {items.map(item => {
                const result = rowResults[item.key]
                const rowBg = result === 'ok' ? 'bg-green-50' : result === 'error' ? 'bg-red-50'
                  : selected.has(item.key) ? 'bg-indigo-50' : 'hover:bg-gray-50'
                return (
                  <tr key={item.key} className={`transition-colors ${rowBg}`}>
                    <td className="px-3 py-2.5 w-8 align-middle">
                      {result === 'ok'
                        ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                        : result === 'error'
                        ? <X className="h-3.5 w-3.5 text-red-400" />
                        : result === 'pending'
                        ? <span className="h-3.5 w-3.5 border border-indigo-400 border-t-transparent rounded-full animate-spin inline-block" />
                        : <input type="checkbox" checked={selected.has(item.key)}
                            onChange={() => toggleSelect(item.key)}
                            onClick={e => e.stopPropagation()}
                            className="h-3.5 w-3.5 accent-indigo-600 cursor-pointer" />
                      }
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <a href={item.url} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-indigo-600 font-mono text-xs font-medium hover:underline">
                        {item.key} <ExternalLink className="h-3 w-3" />
                      </a>
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-semibold ${TYPE_COLORS[item.issuetype] || 'bg-gray-100 text-gray-500'}`}>
                        {item.issuetype}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-gray-700 max-w-sm">
                      <span className="line-clamp-2">{item.summary}</span>
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <HandoverStatusChanger
                        itemKey={item.key}
                        currentStatus={localStatuses[item.key] ?? item.status}
                        onChanged={s => setLocalSt(p => ({ ...p, [item.key]: s }))}
                      />
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-xs text-gray-500">
                      {item.assignee || '—'}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      {item.parent_key
                        ? <a href={`${jiraBaseUrl}/browse/${item.parent_key}`} target="_blank" rel="noopener noreferrer"
                            className="text-xs font-mono text-indigo-500 hover:underline flex items-center gap-0.5">
                            {item.parent_key} <ExternalLink className="h-2.5 w-2.5" />
                          </a>
                        : <span className="text-xs text-gray-300">—</span>
                      }
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function VersionQAStatusPage() {
  const [version, setVersion]    = useState('')
  const [refreshKey, setRefresh] = useState(0)
  const [activeTab, setActiveTab] = useState('overview')  // 'overview' | 'daily-qa'

  const versionsQ = useQuery({
    queryKey: ['qa-status-versions'],
    queryFn:  getVersions,
    staleTime: 10*60*1000,
  })
  const versions = useMemo(() => Array.isArray(versionsQ.data) ? versionsQ.data : [], [versionsQ.data])
  useEffect(() => {
    if (!version && versions.length) setVersion(versions[0].name)
  }, [versions])

  const enabled     = !!version
  const coverageQ    = useQuery({ queryKey:['qa-cov',       version,refreshKey], queryFn:()=>getCoverage(version),    enabled, staleTime:5*60*1000 })
  const bugsQ        = useQuery({ queryKey:['qa-bugs',      version,refreshKey], queryFn:()=>getBugs(version),         enabled, staleTime:5*60*1000 })
  const regressionQ  = useQuery({ queryKey:['qa-reg',       version,refreshKey], queryFn:()=>getRegression(version),  enabled, staleTime:5*60*1000 })
  const bugsByEpicQ  = useQuery({ queryKey:['qa-bugs-epic', version,refreshKey], queryFn:()=>getBugsByEpic(version),  enabled, staleTime:5*60*1000 })

  const cov      = coverageQ.data
  const bugs     = bugsQ.data
  const reg      = regressionQ.data
  const allBugs  = bugs?.bugs || []
  const bugStats = bugs?.stats || {}
  const summary  = cov?.summary || {}
  const isLoading = coverageQ.isLoading || bugsQ.isLoading || regressionQ.isLoading || bugsByEpicQ.isLoading

  // Derive Jira base URL from first story URL in coverage data
  const jiraBaseUrl = useMemo(() => {
    const firstStory = (cov?.by_epic || [])[0]?.stories?.[0]
    return jiraBase(firstStory?.url)
  }, [cov])

  const regDone  = useMemo(() => {
    const counts = reg?.status_counts || {}
    return Object.entries(counts).filter(([s])=>DONE_STATUSES.has(s)).reduce((a,[,n])=>a+n,0)
  }, [reg])

  // Stories in DONE status from coverage data
  const { storiesDone, storiesDonePct } = useMemo(() => {
    const allStories = (cov?.by_epic||[]).flatMap(e => e.stories||[])
    const done = allStories.filter(s => s.status === 'DONE').length
    return { storiesDone: done, storiesDonePct: pct(done, allStories.length) }
  }, [cov])

  return (
    <div className="flex flex-col min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-800">QA Version Status</h1>
          <p className="text-xs text-gray-400 mt-0.5">Test coverage + bug breakdown per fix version</p>
        </div>
        <button onClick={()=>setRefresh(k=>k+1)} disabled={isLoading}
          className="flex items-center gap-2 px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${isLoading?'animate-spin':''}`} /> Refresh
        </button>
      </div>

      <div className="flex-1 p-6 space-y-5 max-w-7xl mx-auto w-full">
        {/* Version selector */}
        <div className="flex items-center gap-3">
          <label className="text-sm font-medium text-gray-600">Fix Version</label>
          <select value={version} onChange={e=>setVersion(e.target.value)}
            className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400">
            <option value="">— Select a version —</option>
            {versions.map(v=>(
              <option key={v.id} value={v.name}>{v.name}{v.released?' (released)':''}</option>
            ))}
          </select>
          {version && (
            <a href={jiraFilter(jiraBaseUrl, `fixVersion = "${version}" ORDER BY issuetype ASC, priority DESC`)}
               target="_blank" rel="noopener noreferrer"
               className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline">
              <ExternalLink className="h-3 w-3" /> All issues for {version}
            </a>
          )}
        </div>

        {/* Tab bar */}
        <div className="flex border-b border-gray-200 -mb-2">
          {[
            { id: 'overview',    label: 'Overview' },
            { id: 'daily-qa',    label: 'Daily QA Summary' },
            { id: 'allocation',  label: 'Allocation' },
            { id: 'handover',    label: 'Handover Process' },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-5 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-indigo-600 text-indigo-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ── Overview tab ─────────────────────────────────────────────────── */}
        {activeTab === 'overview' && <>

        {/* Summary tiles */}
        {!isLoading && (cov || bugs) && (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
            <Tile label="Total Stories"   value={summary.total_stories}  color="gray"
              href={version ? jiraFilter(jiraBaseUrl, `issuetype = Story AND fixVersion = "${version}" ORDER BY status ASC`) : null} />
            <Tile label="Covered"         value={`${summary.coverage_pct??0}%`}
                                          sub={`${summary.covered_stories??0} stories`} color="green"
              href={version ? jiraFilter(jiraBaseUrl, `issuetype = Story AND fixVersion = "${version}" AND status = "Ready for Testing" ORDER BY priority DESC`) : null} />
            <Tile label="Story Tests"     value={summary.total_tests}    color="purple"
              href={version && reg?.jira_search_url ? reg.jira_search_url : null} />
            <Tile label="Regression"      value={reg?.total}
                                          sub={reg?`${pct(regDone,reg.total)}% passed`:null} color="indigo"
              href={reg?.jira_search_url || null} />
            <Tile label="Total Bugs"      value={bugStats.total}         color="red"
              href={version ? jiraFilter(jiraBaseUrl, `issuetype = Bug AND fixVersion = "${version}" ORDER BY priority DESC`) : null} />
            <Tile label="Open Bugs"       value={bugStats.open}          color="orange"
              href={version ? jiraFilter(jiraBaseUrl, `issuetype = Bug AND fixVersion = "${version}" AND status not in (Done, DONE, Closed, Removed) ORDER BY priority DESC`) : null} />
            <Tile label="High / Critical" value={bugStats.high_critical} color="red"
              href={version ? jiraFilter(jiraBaseUrl, `issuetype = Bug AND fixVersion = "${version}" AND priority in (Highest, High) ORDER BY status ASC`) : null} />
          </div>
        )}

        {/* Story resolution bar */}
        {bugs && <StoryBar stats={bugStats} version={version} jiraBaseUrl={jiraBaseUrl} />}

        {/* Main two-column grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

          {/* Left: Test Coverage by Epic */}
          <div className="bg-white border border-gray-100 rounded-xl shadow-sm overflow-hidden">
            <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-100 bg-indigo-50">
              <FlaskConical className="h-4 w-4 text-indigo-500" />
              <span className="text-sm font-semibold text-indigo-800">Test Coverage by Epic</span>
              {cov && (
                <>
                  <span className="ml-auto text-xs text-gray-400">
                    {summary.covered_stories}/{summary.total_stories} covered · {summary.coverage_pct}%
                  </span>
                  <span className="text-xs font-semibold text-green-700 bg-green-50 px-2 py-0.5 rounded-full ml-2">
                    {storiesDone} DONE ({storiesDonePct}%)
                  </span>
                  <a href={jiraFilter(jiraBaseUrl,`issuetype = Story AND fixVersion = "${version}" ORDER BY status ASC`)}
                     target="_blank" rel="noopener noreferrer"
                     className="text-xs text-indigo-600 hover:underline flex items-center gap-0.5 ml-2">
                    <ExternalLink className="h-3 w-3" /> Jira
                  </a>
                </>
              )}
            </div>
            <div className="p-3 space-y-2 max-h-[560px] overflow-y-auto">
              {coverageQ.isLoading && <Spinner label="Loading coverage…" />}
              {coverageQ.isError   && <ErrMsg msg={coverageQ.error?.message} />}
              {cov && (cov.by_epic||[]).length===0 && (
                <p className="text-sm text-gray-400 text-center py-8">No epics for this version</p>
              )}
              {(cov?.by_epic||[]).map(e=>(
                <CoverageEpicRow key={e.epic_key} epic={e} jiraBaseUrl={jiraBaseUrl} version={version} />
              ))}
            </div>
          </div>

          {/* Right: Bugs + Regression */}
          <div className="space-y-4">
            {/* Bug breakdown */}
            <div className="bg-white border border-gray-100 rounded-xl shadow-sm overflow-hidden">
              <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-100 bg-red-50">
                <Bug className="h-4 w-4 text-red-500" />
                <span className="text-sm font-semibold text-red-800">Bug Breakdown</span>
                {bugs && (
                  <>
                    <span className="ml-auto text-xs text-gray-400">{allBugs.length} total</span>
                    <a href={jiraFilter(jiraBaseUrl,`issuetype = Bug AND fixVersion = "${version}" ORDER BY priority DESC`)}
                       target="_blank" rel="noopener noreferrer"
                       className="text-xs text-red-600 hover:underline flex items-center gap-0.5 ml-2">
                      <ExternalLink className="h-3 w-3" /> Jira
                    </a>
                  </>
                )}
              </div>
              <div className="p-4">
                {bugsQ.isLoading && <Spinner label="Loading bugs…" />}
                {bugsQ.isError   && <ErrMsg msg={bugsQ.error?.message} />}
                {bugs && allBugs.length===0 && (
                  <p className="text-sm text-gray-400 text-center py-6 flex items-center justify-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-green-500" /> No bugs for this version
                  </p>
                )}
                {bugs && allBugs.length>0 && (
                  <BugBreakdown bugs={allBugs} version={version} jiraBaseUrl={jiraBaseUrl} />
                )}
              </div>
            </div>

            {/* Bugs by Epic */}
            <div className="bg-white border border-gray-100 rounded-xl shadow-sm overflow-hidden">
              <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-100 bg-amber-50">
                <Bug className="h-4 w-4 text-amber-500" />
                <span className="text-sm font-semibold text-amber-800">Bugs by Epic</span>
                {bugsByEpicQ.data && (
                  <>
                    <span className="ml-auto text-xs text-gray-400">{bugsByEpicQ.data.epics?.length} epics</span>
                    <a href={jiraFilter(jiraBaseUrl,`issuetype = Bug AND fixVersion = "${version}" ORDER BY priority DESC`)}
                       target="_blank" rel="noopener noreferrer"
                       className="text-xs text-amber-600 hover:underline flex items-center gap-0.5 ml-2">
                      <ExternalLink className="h-3 w-3" /> Jira
                    </a>
                  </>
                )}
              </div>
              <div className="p-4">
                {bugsByEpicQ.isLoading && <Spinner label="Loading bugs by epic…" />}
                {bugsByEpicQ.isError   && <ErrMsg msg={bugsByEpicQ.error?.message} />}
                {bugsByEpicQ.data && (
                  <BugsByEpic data={bugsByEpicQ.data} version={version} jiraBaseUrl={jiraBaseUrl} />
                )}
              </div>
            </div>

            {/* Regression Suite */}
            <div className="bg-white border border-gray-100 rounded-xl shadow-sm overflow-hidden">
              <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-100 bg-purple-50">
                <ShieldCheck className="h-4 w-4 text-purple-500" />
                <span className="text-sm font-semibold text-purple-800">Regression Suite</span>
                {reg && <span className="ml-auto text-xs text-gray-400">{reg.label}</span>}
              </div>
              <div className="p-4">
                {regressionQ.isLoading && <Spinner label="Loading regression…" />}
                {regressionQ.isError   && <ErrMsg msg={regressionQ.error?.message} />}
                {reg && <RegressionPanel data={reg} />}
              </div>
            </div>
          </div>
        </div>

        {/* Recently Opened Bugs */}
        {bugs && allBugs.length > 0 && (
          <RecentBugsPanel bugs={allBugs} version={version} jiraBaseUrl={jiraBaseUrl} />
        )}

        </>} {/* end overview tab */}

        {/* ── Daily QA Summary tab ─────────────────────────────────────────── */}
        {activeTab === 'daily-qa' && (
          version
            ? <DailyQASummaryPanel version={version} jiraBaseUrl={jiraBaseUrl} allBugs={allBugs} />
            : <p className="text-sm text-gray-400 text-center py-12">Select a version above to view the Daily QA Summary</p>
        )}

        {/* ── Allocation tab ────────────────────────────────────────────────── */}
        {activeTab === 'allocation' && (
          <AllocationTab version={version} jiraBaseUrl={jiraBaseUrl} />
        )}

        {/* ── Handover Process tab ─────────────────────────────────────────── */}
        {activeTab === 'handover' && (
          <HandoverTab version={version} jiraBaseUrl={jiraBaseUrl} />
        )}

      </div>
    </div>
  )
}

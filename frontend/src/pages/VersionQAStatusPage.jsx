import { useState, useMemo, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../services/api'
import {
  FlaskConical, Bug, CheckCircle2, ChevronDown, ChevronRight,
  ExternalLink, RefreshCw, ShieldCheck, BarChart2
} from 'lucide-react'

const getVersions      = ()  => api.get('/coverage/versions')
const getCoverage      = (v) => api.get('/coverage/by-version',           { params: { version: v } })
const getBugs          = (v) => api.get('/dashboard/bugs-by-version',     { params: { version: v } })
const getRegression    = (v) => api.get('/coverage/regression-tests',     { params: { version: v } })
const getBugsByEpic    = (v) => api.get('/dashboard/bugs-grouped-by-epic',{ params: { version: v } })

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
  const epics        = data?.epics || []
  const unlinked     = data?.unlinked_count ?? 0
  const total        = data?.total_bugs ?? 0
  const maxCount     = Math.max(...epics.map(e => e.bug_count), 1)

  if (!epics.length && !unlinked) return (
    <p className="text-sm text-gray-400 text-center py-6">No bug→epic links found</p>
  )

  return (
    <div className="space-y-1.5">
      {epics.map(epic => {
        const jql = `issuetype = Bug AND fixVersion = "${version}" AND issue in linkedIssues("${epic.key}")`
        const barW = Math.round(epic.bug_count / maxCount * 100)
        const openPct = epic.bug_count ? Math.round(epic.open_count / epic.bug_count * 100) : 0
        return (
          <div key={epic.key} className="flex items-center gap-2 group">
            <a href={epic.url} target="_blank" rel="noopener noreferrer"
               className="text-xs font-mono text-brand-600 hover:underline flex-shrink-0 w-28 truncate">
              {epic.key}
            </a>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-gray-600 truncate leading-tight">{epic.summary}</p>
              <div className="flex items-center gap-1.5 mt-0.5">
                <div className="flex-1 bg-gray-100 rounded-full h-2">
                  <div className="bg-red-400 h-2 rounded-full" style={{ width: `${barW}%` }} />
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
        )
      })}
      {unlinked > 0 && (
        <div className="flex items-center gap-2 pt-1 border-t border-gray-100">
          <span className="text-xs text-gray-400 w-28 flex-shrink-0 truncate italic">Not linked</span>
          <div className="flex-1" />
          <span className="text-xs text-gray-400 tabular-nums">{unlinked}</span>
          <a href={jiraFilter(jiraBaseUrl,
              `issuetype = Bug AND fixVersion = "${version}" AND issue not in linkedIssues("TMT0-38353","TMT0-39936","TMT0-39939","TMT0-40037","TMT0-40061","TMT0-41527","TMT0-42218","TMT0-42609","TMT0-39839","TMT0-43262") ORDER BY priority DESC`
            )} target="_blank" rel="noopener noreferrer"
             className="text-gray-300 hover:text-brand-500 flex-shrink-0">
            <ExternalLink className="h-3 w-3" />
          </a>
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

// ── Page ──────────────────────────────────────────────────────────────────────
export default function VersionQAStatusPage() {
  const [version, setVersion]    = useState('')
  const [refreshKey, setRefresh] = useState(0)

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
      </div>
    </div>
  )
}

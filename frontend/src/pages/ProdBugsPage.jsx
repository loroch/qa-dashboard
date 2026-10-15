import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../services/api'
import { Bug, ExternalLink, RefreshCw, AlertTriangle, Tag, User } from 'lucide-react'

const getProdBugs = (refresh) => api.get('/dashboard/prod-bugs', { params: refresh ? { refresh: true } : {} })

function pct(n, d) { return d ? Math.round(n / d * 100) : 0 }

const PRIORITY_ORDER = ['Highest', 'High', 'Medium', 'Low', 'Lowest']
const PRIORITY_COLORS = {
  Highest: { bar: 'bg-red-500',    pill: 'bg-red-100 text-red-700'    },
  High:    { bar: 'bg-orange-400', pill: 'bg-orange-100 text-orange-700' },
  Medium:  { bar: 'bg-yellow-400', pill: 'bg-yellow-100 text-yellow-700' },
  Low:     { bar: 'bg-green-400',  pill: 'bg-green-100 text-green-700'  },
  Lowest:  { bar: 'bg-gray-300',   pill: 'bg-gray-100 text-gray-500'   },
}
const SOURCE_COLORS = {
  'FromHaim':  'bg-blue-100 text-blue-700 border-blue-200',
  'Prod_Zoho': 'bg-purple-100 text-purple-700 border-purple-200',
  'PROD env':  'bg-red-100 text-red-700 border-red-200',
}
const OPEN_STATUSES = new Set(['ToDo', 'In Progress', 'In Review', 'Open', 'Reopened', 'Ready for Testing'])

function Tile({ label, value, color = 'gray', sub }) {
  const cls = { red:'text-red-600', orange:'text-orange-500', green:'text-green-600',
                blue:'text-blue-600', purple:'text-purple-600', gray:'text-gray-700' }
  return (
    <div className="bg-white border border-gray-100 rounded-xl px-4 py-3 text-center shadow-sm">
      <p className="text-xs text-gray-400 uppercase tracking-wide font-medium mb-1">{label}</p>
      <p className={`text-2xl font-bold ${cls[color]}`}>{value ?? '—'}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )
}

function BarRow({ label, count, total, color = 'bg-blue-400', href }) {
  const w = pct(count, total)
  const inner = (
    <div className="flex items-center gap-2 group hover:opacity-80">
      <span className="text-xs text-gray-600 w-32 flex-shrink-0 truncate">{label}</span>
      <div className="flex-1 bg-gray-100 rounded-full h-2.5">
        <div className={`${color} h-2.5 rounded-full`} style={{ width: `${w}%` }} />
      </div>
      <span className="text-xs text-gray-500 w-6 text-right tabular-nums">{count}</span>
      <span className="text-xs text-gray-300 w-8 text-right tabular-nums">{w}%</span>
      {href && <ExternalLink className="h-2.5 w-2.5 text-gray-300 group-hover:text-brand-500 flex-shrink-0" />}
    </div>
  )
  return href ? <a href={href} target="_blank" rel="noopener noreferrer">{inner}</a> : inner
}

function BugRow({ bug }) {
  const prioColor = (PRIORITY_COLORS[bug.priority] || PRIORITY_COLORS.Low).pill
  return (
    <tr className="hover:bg-gray-50 border-b border-gray-100 last:border-0">
      <td className="px-4 py-2.5 whitespace-nowrap">
        <a href={bug.url} target="_blank" rel="noopener noreferrer"
           className="inline-flex items-center gap-1 text-xs font-mono text-brand-600 hover:underline font-medium">
          {bug.key} <ExternalLink className="h-2.5 w-2.5" />
        </a>
      </td>
      <td className="px-4 py-2.5 max-w-xs">
        <span className="text-xs text-gray-700 line-clamp-2">{bug.summary}</span>
      </td>
      <td className="px-4 py-2.5 whitespace-nowrap">
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${prioColor}`}>{bug.priority}</span>
      </td>
      <td className="px-4 py-2.5 whitespace-nowrap">
        <span className={`text-xs px-2 py-0.5 rounded-full ${OPEN_STATUSES.has(bug.status) ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>
          {bug.status}
        </span>
      </td>
      <td className="px-4 py-2.5 whitespace-nowrap text-xs text-gray-500">{bug.assignee}</td>
      <td className="px-4 py-2.5">
        <div className="flex flex-wrap gap-1">
          {bug.source.map(s => (
            <span key={s} className={`text-xs px-1.5 py-0.5 rounded border font-medium ${SOURCE_COLORS[s] || 'bg-gray-100 text-gray-500 border-gray-200'}`}>{s}</span>
          ))}
        </div>
      </td>
      <td className="px-4 py-2.5 whitespace-nowrap text-xs text-gray-400">
        {bug.fix_versions.length ? bug.fix_versions.join(', ') : '—'}
      </td>
    </tr>
  )
}

const JIRA_BASE = 'https://kabatone.atlassian.net'
function jiraFilter(jql) { return `${JIRA_BASE}/jira/issues/?jql=${encodeURIComponent(jql)}` }

export default function ProdBugsPage() {
  const [activeSource, setActiveSource] = useState(null)
  const [activePriority, setActivePriority] = useState(null)
  const [activeVersion, setActiveVersion] = useState('')
  const [search, setSearch] = useState('')

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['prod-bugs'],
    queryFn:  () => getProdBugs(false),
    staleTime: 5 * 60 * 1000,
  })

  const bugs  = data?.bugs  || []
  const stats = data?.stats || {}

  // Unique fix versions present in the loaded bugs, sorted
  const allVersions = useMemo(() => {
    const s = new Set()
    for (const b of bugs) for (const v of b.fix_versions) if (v) s.add(v)
    return [...s].sort((a, b) => b.localeCompare(a))
  }, [bugs])

  // filtered = bugs matching source + version + search (but NOT priority, so breakdowns react to version/source)
  const preFiltered = useMemo(() => {
    let list = bugs
    if (activeSource)  list = list.filter(b => b.source.includes(activeSource))
    if (activeVersion) list = list.filter(b => b.fix_versions.includes(activeVersion))
    return list
  }, [bugs, activeSource, activeVersion])

  const filtered = useMemo(() => {
    let list = preFiltered
    if (activePriority) list = list.filter(b => b.priority === activePriority)
    if (search.trim())  list = list.filter(b =>
      b.key.toLowerCase().includes(search.toLowerCase()) ||
      b.summary.toLowerCase().includes(search.toLowerCase())
    )
    return list
  }, [preFiltered, activePriority, search])

  // Breakdowns computed from preFiltered so they react to source + version filters
  const byPriority = useMemo(() => {
    const m = {}
    for (const b of preFiltered) m[b.priority] = (m[b.priority] || 0) + 1
    return m
  }, [preFiltered])

  const byStatus = useMemo(() => {
    const m = {}
    for (const b of preFiltered) m[b.status] = (m[b.status] || 0) + 1
    return m
  }, [preFiltered])

  const byAssignee = useMemo(() => {
    const m = {}
    for (const b of preFiltered) m[b.assignee || 'Unassigned'] = (m[b.assignee || 'Unassigned'] || 0) + 1
    return m
  }, [preFiltered])

  const total = preFiltered.length

  // Build Jira JQL base that respects the active source + version filters
  const baseJql = useMemo(() => {
    let jql
    if (activeSource === 'FromHaim')  jql = 'issuetype = Bug AND labels = "FromHaim"'
    else if (activeSource === 'Prod_Zoho') jql = 'issuetype = Bug AND labels = "Prod_Zoho"'
    else if (activeSource === 'PROD env')  jql = 'issuetype = Bug AND environment ~ "PROD"'
    else jql = 'issuetype = Bug AND (labels in ("FromHaim", "Prod_Zoho") OR environment ~ "PROD")'
    if (activeVersion) jql += ` AND fixVersion = "${activeVersion}"`
    return jql
  }, [activeSource, activeVersion])

  const mainJql = `${baseJql} ORDER BY priority ASC`

  return (
    <div className="flex flex-col min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-500" /> Production Bugs
          </h1>
          <p className="text-xs text-gray-400 mt-0.5">
            Labels: <code className="bg-gray-100 px-1 rounded">FromHaim</code> · <code className="bg-gray-100 px-1 rounded">Prod_Zoho</code> · Environment: <code className="bg-gray-100 px-1 rounded">PROD</code>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a href={jiraFilter(mainJql)} target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-1 px-3 py-2 border border-gray-200 rounded-lg text-xs text-brand-600 hover:bg-gray-50">
            <ExternalLink className="h-3.5 w-3.5" /> View in Jira
          </a>
          <button onClick={() => refetch()} disabled={isLoading}
            className="flex items-center gap-2 px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      <div className="flex-1 p-6 space-y-5 max-w-7xl mx-auto w-full">
        {isLoading && (
          <div className="flex items-center justify-center py-24">
            <div className="h-8 w-8 border-2 border-gray-200 border-t-red-500 rounded-full animate-spin" />
          </div>
        )}
        {isError && <p className="text-red-500 text-center py-12">{error?.message}</p>}

        {data && (
          <>
            {/* Summary tiles — reflect preFiltered when a filter is active */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <Tile label="Total"         value={preFiltered.length}
                    sub={preFiltered.length !== bugs.length ? `of ${bugs.length}` : null} color="gray" />
              <Tile label="Open"          value={preFiltered.filter(b => OPEN_STATUSES.has(b.status)).length} color="orange" />
              <Tile label="High+Critical" value={preFiltered.filter(b => b.priority === 'Highest' || b.priority === 'High').length} color="red" />
              <Tile label="From Haim"     value={preFiltered.filter(b => b.source.includes('FromHaim')).length}  color="blue"   />
              <Tile label="Prod Zoho"     value={preFiltered.filter(b => b.source.includes('Prod_Zoho')).length} color="purple" />
              <Tile label="PROD Env"      value={preFiltered.filter(b => b.source.includes('PROD env')).length}  color="red"    />
            </div>

            {/* Filters row */}
            <div className="flex flex-wrap gap-3 items-center bg-white border border-gray-100 rounded-xl px-4 py-3 shadow-sm">
              {/* Source */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400 font-medium whitespace-nowrap">Source:</span>
                {['FromHaim', 'Prod_Zoho', 'PROD env'].map(s => (
                  <button key={s} onClick={() => setActiveSource(activeSource === s ? null : s)}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                      activeSource === s
                        ? SOURCE_COLORS[s] + ' border-current'
                        : 'bg-white border-gray-200 text-gray-500 hover:border-gray-400'
                    }`}>
                    {s} {stats.by_source?.[s] ? `(${stats.by_source[s]})` : ''}
                  </button>
                ))}
              </div>

              <div className="w-px h-5 bg-gray-200" />

              {/* Version */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400 font-medium whitespace-nowrap">Version:</span>
                <select value={activeVersion} onChange={e => setActiveVersion(e.target.value)}
                  className="border border-gray-200 rounded-lg px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand-400">
                  <option value="">All versions</option>
                  {allVersions.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>

              {(activeSource || activePriority || activeVersion || search) && (
                <button onClick={() => { setActiveSource(null); setActivePriority(null); setActiveVersion(''); setSearch('') }}
                  className="text-xs text-brand-600 hover:underline ml-auto">Clear all filters</button>
              )}
            </div>

            {/* Breakdowns — 3 columns side by side */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

              {/* By Priority */}
              <div className="bg-white border border-gray-100 rounded-xl shadow-sm p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">By Priority</p>
                  <a href={jiraFilter(`${baseJql} ORDER BY priority ASC`)} target="_blank" rel="noopener noreferrer"
                     className="inline-flex items-center gap-1 text-xs text-brand-500 hover:underline" title="Open in Jira">
                    <ExternalLink className="h-3 w-3" /> Jira
                  </a>
                </div>
                <div className="space-y-2">
                  {PRIORITY_ORDER.filter(p => byPriority[p]).map(p => (
                    <button key={p} onClick={() => setActivePriority(activePriority === p ? null : p)}
                      className={`w-full text-left rounded-lg px-2 py-1 transition-colors ${activePriority === p ? 'ring-2 ring-brand-400 bg-brand-50' : 'hover:bg-gray-50'}`}>
                      <BarRow label={p} count={byPriority[p]} total={total}
                        color={(PRIORITY_COLORS[p]||PRIORITY_COLORS.Low).bar}
                        href={jiraFilter(`${baseJql} AND priority = "${p}" ORDER BY created DESC`)}
                      />
                    </button>
                  ))}
                </div>
              </div>

              {/* By Status */}
              <div className="bg-white border border-gray-100 rounded-xl shadow-sm p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">By Status</p>
                  <a href={jiraFilter(`${baseJql} ORDER BY status ASC`)} target="_blank" rel="noopener noreferrer"
                     className="inline-flex items-center gap-1 text-xs text-brand-500 hover:underline" title="Open in Jira">
                    <ExternalLink className="h-3 w-3" /> Jira
                  </a>
                </div>
                <div className="space-y-2">
                  {Object.entries(byStatus).sort((a,b)=>b[1]-a[1]).map(([s,n])=>(
                    <BarRow key={s} label={s} count={n} total={total} color="bg-blue-400"
                      href={jiraFilter(`${baseJql} AND status = "${s}" ORDER BY priority ASC`)}
                    />
                  ))}
                </div>
              </div>

              {/* By Assignee */}
              <div className="bg-white border border-gray-100 rounded-xl shadow-sm p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1.5">
                    <User className="h-3 w-3" /> By Assignee
                  </p>
                  <a href={jiraFilter(`${baseJql} ORDER BY assignee ASC`)} target="_blank" rel="noopener noreferrer"
                     className="inline-flex items-center gap-1 text-xs text-brand-500 hover:underline" title="Open in Jira">
                    <ExternalLink className="h-3 w-3" /> Jira
                  </a>
                </div>
                <div className="space-y-2">
                  {Object.entries(byAssignee).sort((a,b)=>b[1]-a[1]).map(([a,n])=>(
                    <BarRow key={a} label={a} count={n} total={total} color="bg-indigo-400"
                      href={jiraFilter(`${baseJql} AND assignee = "${a}" ORDER BY priority ASC`)}
                    />
                  ))}
                </div>
              </div>
            </div>

            {/* Bug list — full width */}
            <div className="bg-white border border-gray-100 rounded-xl shadow-sm overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 bg-red-50">
                <Bug className="h-4 w-4 text-red-500" />
                <span className="text-sm font-semibold text-red-800">Bug List</span>
                <a href={jiraFilter(mainJql)} target="_blank" rel="noopener noreferrer"
                   className="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline"
                   title="Open current filter in Jira">
                  <ExternalLink className="h-3 w-3" /> Jira
                </a>
                <span className="text-xs text-gray-400 ml-auto">
                  {filtered.length}{filtered.length !== bugs.length ? ` / ${bugs.length}` : ''} bugs
                </span>
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search key or summary…"
                  className="border border-gray-200 rounded-lg px-2 py-1 text-xs w-56 focus:outline-none focus:ring-1 focus:ring-brand-400"
                />
              </div>
              <div className="overflow-x-auto max-h-[700px] overflow-y-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-100 sticky top-0">
                    <tr>
                      {['Key','Summary','Priority','Status','Assignee','Source','Fix Version'].map(h=>(
                        <th key={h} className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 && (
                      <tr><td colSpan={7} className="text-center py-12 text-gray-400 text-sm">No bugs match the current filter</td></tr>
                    )}
                    {filtered.map(b => <BugRow key={b.key} bug={b} />)}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

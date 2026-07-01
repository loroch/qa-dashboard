import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import {
  Search, X, Loader2, AlertCircle, RefreshCw, ChevronDown,
  ChevronRight, Bug, ClipboardList, Calendar, Users, ExternalLink,
  Layers
} from 'lucide-react'

const API = '/api/mexico-qa'

/* ── helpers ──────────────────────────────────────────────── */
function fmtDate(s) {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
}

const TYPE_BADGE = {
  Bug:        'bg-red-100 text-red-700 border-red-300',
  'Test Case':'bg-teal-100 text-teal-700 border-teal-300',
  'Test Set': 'bg-cyan-100 text-cyan-700 border-cyan-300',
  'Test':     'bg-teal-100 text-teal-700 border-teal-300',
  'QA Task':  'bg-indigo-100 text-indigo-700 border-indigo-300',
  'Task':     'bg-slate-100 text-slate-700 border-slate-300',
  'Story':    'bg-blue-100 text-blue-700 border-blue-300',
  Subtask:    'bg-slate-100 text-slate-600 border-slate-300',
}

const STATUS_CLS = {
  'To Do':             'bg-slate-100 text-slate-600',
  'In Progress':       'bg-blue-100 text-blue-700',
  'Ready for Testing': 'bg-amber-100 text-amber-700',
  'Done':              'bg-green-100 text-green-700',
  'Closed':            'bg-green-100 text-green-700',
  'Reopened':          'bg-red-100 text-red-700',
}

const PRIORITY_CLS = {
  Highest: 'text-red-700 font-bold',
  High:    'text-red-500 font-semibold',
  Medium:  'text-amber-600',
  Low:     'text-blue-500',
  Lowest:  'text-slate-400',
}

const PROJECT_COLOR = {
  CS:   'bg-purple-100 text-purple-800 border-purple-300',
  KB:   'bg-blue-100   text-blue-800   border-blue-300',
  KM:   'bg-green-100  text-green-800  border-green-300',
  TMT0: 'bg-indigo-100 text-indigo-800 border-indigo-300',
}

function TypeBadge({ type }) {
  const cls = TYPE_BADGE[type] || 'bg-slate-100 text-slate-600 border-slate-300'
  return <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${cls}`}>{type || '?'}</span>
}

function StatusPill({ status }) {
  const cls = STATUS_CLS[status] || 'bg-slate-100 text-slate-600'
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{status || '—'}</span>
}

/* ── EpicSearch ───────────────────────────────────────────── */
function EpicSearch({ selected, onAdd }) {
  const [q, setQ]       = useState('')
  const [dq, setDq]     = useState('')
  const [open, setOpen] = useState(false)
  const timer           = useRef(null)
  const wrapRef         = useRef(null)

  const handleQ = v => {
    setQ(v); clearTimeout(timer.current)
    timer.current = setTimeout(() => setDq(v), 350)
    setOpen(true)
  }

  const { data, isFetching } = useQuery({
    queryKey: ['mxqa-epics', dq],
    queryFn: ({ signal }) => axios.get(`${API}/search-epics`, { params: { q: dq }, signal }).then(r => r.data.epics),
    enabled: dq.trim().length >= 2,
    staleTime: 60_000,
  })

  useEffect(() => {
    const h = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const selectedKeys = selected.map(e => e.key)
  const results = data || []

  return (
    <div className="relative" ref={wrapRef}>
      <div className="flex items-center gap-2 bg-white border border-slate-300 rounded-xl px-3 py-2 w-96 shadow-sm focus-within:ring-2 focus-within:ring-emerald-300">
        <Search className="h-4 w-4 text-slate-400 shrink-0" />
        <input
          className="flex-1 outline-none text-sm text-slate-700 placeholder-slate-400"
          placeholder="Search epics in CS / KB / KM…"
          value={q}
          onChange={e => handleQ(e.target.value)}
          onFocus={() => q.length >= 2 && setOpen(true)}
        />
        {isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />}
        {q && <button onClick={() => { setQ(''); setDq(''); setOpen(false) }}><X className="h-3.5 w-3.5 text-slate-400 hover:text-slate-600" /></button>}
      </div>

      {open && dq.length >= 2 && (
        <div className="absolute z-50 mt-1 w-[600px] bg-white border border-slate-200 rounded-xl shadow-xl max-h-72 overflow-y-auto">
          {!isFetching && results.length === 0 && <div className="px-4 py-3 text-sm text-slate-400">No epics found</div>}
          {results.map(r => {
            const already = selectedKeys.includes(r.key)
            const projCls = PROJECT_COLOR[r.project] || 'bg-slate-100 text-slate-700 border-slate-300'
            return (
              <button
                key={r.key}
                onClick={() => { if (!already) { onAdd(r); setQ(''); setDq(''); setOpen(false) } }}
                disabled={already}
                className={`w-full flex items-start gap-3 px-4 py-2.5 text-left hover:bg-slate-50 border-b border-slate-100 last:border-0 transition-colors ${already ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <span className={`shrink-0 mt-0.5 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border ${projCls}`}>{r.project}</span>
                <div className="flex-1 min-w-0">
                  <span className="font-mono text-xs text-purple-700">{r.key}</span>
                  <p className="text-sm text-slate-700 mt-0.5 truncate">{r.summary}</p>
                </div>
                <StatusPill status={r.status} />
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ── IssueRow ─────────────────────────────────────────────── */
function IssueRow({ issue }) {
  const proj = issue.key.split('-')[0]
  const projCls = PROJECT_COLOR[proj] || 'bg-slate-100 text-slate-700 border-slate-300'
  return (
    <tr className="border-b border-slate-100 hover:bg-slate-50 transition-colors text-xs">
      <td className="px-3 py-2 whitespace-nowrap">
        <a href={issue.url} target="_blank" rel="noreferrer"
          className="font-mono text-indigo-600 hover:underline flex items-center gap-1">
          {issue.key}
          <ExternalLink className="h-2.5 w-2.5 opacity-50" />
        </a>
      </td>
      <td className="px-3 py-2">
        <p className="text-slate-700 line-clamp-2 max-w-xs" title={issue.summary}>{issue.summary}</p>
      </td>
      <td className="px-2 py-2 whitespace-nowrap">
        <TypeBadge type={issue.type} />
      </td>
      <td className="px-2 py-2 whitespace-nowrap">
        <StatusPill status={issue.status} />
      </td>
      <td className={`px-2 py-2 whitespace-nowrap ${PRIORITY_CLS[issue.priority] || 'text-slate-500'}`}>
        {issue.priority || '—'}
      </td>
      <td className="px-3 py-2 whitespace-nowrap text-slate-600">
        {issue.assignee || <span className="text-slate-400 italic">unassigned</span>}
      </td>
      <td className="px-3 py-2 whitespace-nowrap text-slate-500">
        {fmtDate(issue.created)}
      </td>
    </tr>
  )
}

/* ── BugRow (date mode) ───────────────────────────────────── */
function BugRow({ bug }) {
  const proj = bug.key.split('-')[0]
  const projCls = PROJECT_COLOR[proj] || 'bg-slate-100 text-slate-700 border-slate-300'
  return (
    <tr className="border-b border-slate-100 hover:bg-slate-50 transition-colors text-xs">
      <td className="px-3 py-2 whitespace-nowrap">
        <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium border ${projCls}`}>{proj}</span>
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        <a href={bug.url} target="_blank" rel="noreferrer"
          className="font-mono text-indigo-600 hover:underline">{bug.key}</a>
      </td>
      <td className="px-3 py-2 max-w-xs">
        <p className="text-slate-700 line-clamp-2" title={bug.summary}>{bug.summary}</p>
      </td>
      <td className="px-2 py-2 whitespace-nowrap">
        <StatusPill status={bug.status} />
      </td>
      <td className={`px-2 py-2 whitespace-nowrap ${PRIORITY_CLS[bug.priority] || 'text-slate-500'}`}>
        {bug.priority || '—'}
      </td>
      <td className="px-3 py-2 whitespace-nowrap text-slate-600">{bug.reporter || '—'}</td>
      <td className="px-3 py-2 whitespace-nowrap text-slate-600">
        {bug.fix_versions[0] || <span className="text-slate-400">—</span>}
      </td>
      <td className="px-3 py-2 whitespace-nowrap text-slate-500">{fmtDate(bug.created)}</td>
    </tr>
  )
}

/* ── EpicCard ─────────────────────────────────────────────── */
function EpicCard({ epic, memberIds, onRemove, refresh, isPinned }) {
  const [expanded, setExpanded] = useState(true)
  const [tab, setTab]           = useState('tasks')   // 'tasks' | 'bugs'

  const proj    = epic.key.split('-')[0]
  const projCls = PROJECT_COLOR[proj] || 'bg-slate-100 text-slate-700 border-slate-300'

  const memberParam = memberIds.join(',')

  const { data, isFetching, error } = useQuery({
    queryKey: ['mxqa-epic-work', epic.key, memberParam, refresh],
    queryFn: ({ signal }) =>
      axios.get(`${API}/epic-work`, { params: { epic_key: epic.key, member_ids: memberParam }, signal })
           .then(r => r.data),
    enabled: memberIds.length > 0,
    staleTime: 120_000,
  })

  const tasks = data?.tasks || []
  const bugs  = data?.bugs  || []

  return (
    <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
      {/* Epic header */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50 select-none"
        onClick={() => setExpanded(v => !v)}
      >
        {expanded
          ? <ChevronDown className="h-4 w-4 text-slate-400 shrink-0" />
          : <ChevronRight className="h-4 w-4 text-slate-400 shrink-0" />
        }
        <span className={`shrink-0 px-2 py-0.5 rounded text-xs font-semibold border ${projCls}`}>{proj}</span>
        <span className="font-mono text-xs text-purple-700 shrink-0">{epic.key}</span>
        <p className="text-sm font-semibold text-slate-800 flex-1 truncate">{epic.summary}</p>
        <StatusPill status={epic.status} />
        {isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400 shrink-0" />}
        <div className="flex items-center gap-2 shrink-0">
          {!isFetching && (
            <>
              <span className="text-xs text-slate-500 bg-slate-100 rounded-full px-2 py-0.5">
                <ClipboardList className="h-3 w-3 inline mr-0.5 text-teal-600" />{tasks.length}
              </span>
              <span className="text-xs text-slate-500 bg-slate-100 rounded-full px-2 py-0.5">
                <Bug className="h-3 w-3 inline mr-0.5 text-red-500" />{bugs.length}
              </span>
            </>
          )}
          {!isPinned && (
            <button
              onClick={e => { e.stopPropagation(); onRemove(epic.key) }}
              className="text-slate-400 hover:text-red-500 transition-colors ml-1"
              title="Remove"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Expanded body */}
      {expanded && (
        <div className="border-t border-slate-200">
          {error && (
            <div className="flex items-center gap-2 px-4 py-3 text-sm text-red-600 bg-red-50">
              <AlertCircle className="h-4 w-4 shrink-0" />
              Failed to load — {error?.response?.data?.detail || 'error'}
            </div>
          )}

          {/* Tabs */}
          <div className="flex items-center gap-0 border-b border-slate-200 px-4 pt-1">
            <button
              onClick={() => setTab('tasks')}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors -mb-px ${
                tab === 'tasks' ? 'border-teal-500 text-teal-700' : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              <ClipboardList className="h-3.5 w-3.5" />
              QA Work &amp; Tests
              <span className="ml-1 bg-teal-100 text-teal-700 rounded-full px-1.5 py-0.5 text-[10px]">{tasks.length}</span>
            </button>
            <button
              onClick={() => setTab('bugs')}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors -mb-px ${
                tab === 'bugs' ? 'border-red-500 text-red-700' : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              <Bug className="h-3.5 w-3.5" />
              Bugs opened by team
              <span className="ml-1 bg-red-100 text-red-700 rounded-full px-1.5 py-0.5 text-[10px]">{bugs.length}</span>
            </button>
          </div>

          {/* Table */}
          {isFetching ? (
            <div className="flex items-center gap-2 px-4 py-4 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin text-indigo-500" /> Loading…
            </div>
          ) : (
            <div className="overflow-x-auto">
              {tab === 'tasks' && (
                tasks.length === 0
                  ? <p className="px-4 py-4 text-xs text-slate-400 italic">No QA tasks or tests assigned to team under this epic.</p>
                  : (
                    <table className="w-full border-collapse text-xs">
                      <thead>
                        <tr className="bg-teal-50 text-teal-800 text-[11px] font-semibold">
                          <th className="px-3 py-2 text-left">Key</th>
                          <th className="px-3 py-2 text-left">Summary</th>
                          <th className="px-2 py-2 text-left">Type</th>
                          <th className="px-2 py-2 text-left">Status</th>
                          <th className="px-2 py-2 text-left">Priority</th>
                          <th className="px-3 py-2 text-left">Assignee</th>
                          <th className="px-3 py-2 text-left">Created</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tasks.map(t => <IssueRow key={t.key} issue={t} />)}
                      </tbody>
                    </table>
                  )
              )}

              {tab === 'bugs' && (
                bugs.length === 0
                  ? <p className="px-4 py-4 text-xs text-slate-400 italic">No bugs opened or assigned to team under this epic.</p>
                  : (
                    <table className="w-full border-collapse text-xs">
                      <thead>
                        <tr className="bg-red-50 text-red-800 text-[11px] font-semibold">
                          <th className="px-3 py-2 text-left">Key</th>
                          <th className="px-3 py-2 text-left">Summary</th>
                          <th className="px-2 py-2 text-left">Type</th>
                          <th className="px-2 py-2 text-left">Status</th>
                          <th className="px-2 py-2 text-left">Priority</th>
                          <th className="px-3 py-2 text-left">Assignee</th>
                          <th className="px-3 py-2 text-left">Created</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bugs.map(b => <IssueRow key={b.key} issue={b} />)}
                      </tbody>
                    </table>
                  )
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ── MexicoQAPage ─────────────────────────────────────────── */
export default function MexicoQAPage() {
  const [mode,          setMode]         = useState('epic')   // 'epic' | 'date'
  const [extraEpics,    setExtraEpics]   = useState([])       // user-added via search
  const [days,          setDays]         = useState(14)
  const [refreshKey,    setRefreshKey]   = useState(0)

  /* Team members */
  const teamQuery = useQuery({
    queryKey: ['mxqa-team'],
    queryFn: () => axios.get(`${API}/team`).then(r => r.data.members),
    staleTime: 3_600_000,
  })
  const members    = teamQuery.data || []
  const memberIds  = members.map(m => m.id).filter(Boolean)
  const memberParam = memberIds.join(',')

  /* Pinned epics (from Paloma's release plan) */
  const pinnedQuery = useQuery({
    queryKey: ['mxqa-pinned', refreshKey],
    queryFn: () => axios.get(`${API}/pinned-epics`).then(r => r.data.epics),
    staleTime: 300_000,
  })
  const pinnedEpics = pinnedQuery.data || []
  const pinnedKeys  = pinnedEpics.map(e => e.key)

  /* Combined epic list: pinned first, then extras not already in pinned */
  const selectedEpics = useMemo(() => {
    const extras = extraEpics.filter(e => !pinnedKeys.includes(e.key))
    return [...pinnedEpics, ...extras]
  }, [pinnedEpics, extraEpics, pinnedKeys])

  /* Bugs by date (date mode) */
  const bugsQuery = useQuery({
    queryKey: ['mxqa-bugs', days, memberParam, refreshKey],
    queryFn: ({ signal }) =>
      axios.get(`${API}/bugs`, { params: { days, member_ids: memberParam }, signal })
           .then(r => r.data.bugs),
    enabled: mode === 'date' && memberIds.length > 0,
    staleTime: 120_000,
  })

  /* Assigned work by date */
  const assignedQuery = useQuery({
    queryKey: ['mxqa-assigned', days, memberParam, refreshKey],
    queryFn: ({ signal }) =>
      axios.get(`${API}/assigned`, { params: { days, member_ids: memberParam }, signal })
           .then(r => r.data.grouped),
    enabled: mode === 'assigned' && memberIds.length > 0,
    staleTime: 120_000,
  })

  const handleRefresh = () => setRefreshKey(k => k + 1)

  /* Derived stats for date mode */
  const bugsByReporter = useMemo(() => {
    const bugs = bugsQuery.data || []
    const map = {}
    bugs.forEach(b => {
      const r = b.reporter || 'Unknown'
      if (!map[r]) map[r] = []
      map[r].push(b)
    })
    return map
  }, [bugsQuery.data])

  return (
    <div className="flex flex-col min-h-screen bg-slate-50">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 border-b border-slate-200 bg-white">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2.5">
              <span className="text-2xl">🇲🇽</span>
              Mexico QA Team
            </h1>
            <p className="text-sm text-slate-500 mt-1">
              Track QA tasks, tests, and bugs for the Mexico team across CS · KB · KM projects.
            </p>
          </div>
          <button
            onClick={handleRefresh}
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 border border-slate-300 rounded-lg px-3 py-1.5 bg-white hover:bg-slate-50 transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>

        {/* Team member pills */}
        <div className="flex items-center gap-3 mt-3">
          {teamQuery.isLoading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
          {members.map(m => (
            <div key={m.id || m.name} className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-full pl-1.5 pr-3 py-1">
              {m.avatar
                ? <img src={m.avatar} alt={m.name} className="h-6 w-6 rounded-full" />
                : <div className="h-6 w-6 rounded-full bg-emerald-400 flex items-center justify-center text-white text-xs font-bold">
                    {m.name.charAt(0)}
                  </div>
              }
              <span className="text-sm font-medium text-emerald-800">{m.name}</span>
              {!m.id && <span className="text-xs text-red-500 ml-1">not found</span>}
            </div>
          ))}
          {teamQuery.isError && (
            <span className="text-xs text-red-500 flex items-center gap-1">
              <AlertCircle className="h-3.5 w-3.5" /> Could not load team
            </span>
          )}
        </div>

        {/* Mode tabs */}
        <div className="flex items-center gap-1 mt-4">
          <button
            onClick={() => setMode('epic')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${mode === 'epic' ? 'bg-emerald-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            <Layers className="h-3.5 w-3.5" />
            By Epic
          </button>
          <button
            onClick={() => setMode('assigned')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${mode === 'assigned' ? 'bg-emerald-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            <Users className="h-3.5 w-3.5" />
            Assigned Work
          </button>
          <button
            onClick={() => setMode('date')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${mode === 'date' ? 'bg-emerald-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            <Bug className="h-3.5 w-3.5" />
            Bugs Opened
          </button>
        </div>
      </div>

      {/* Controls bar */}
      <div className="px-6 py-4 bg-white border-b border-slate-200">
        {mode === 'epic' ? (
          <div className="space-y-3">
            {/* Search bar for extra epics */}
            <div className="flex items-center gap-3">
              <EpicSearch
                selected={selectedEpics}
                onAdd={e => setExtraEpics(prev => prev.find(x => x.key === e.key) ? prev : [...prev, e])}
              />
              {pinnedQuery.isFetching && <Loader2 className="h-4 w-4 animate-spin text-emerald-500" />}
            </div>

            {/* Epic chips */}
            <div className="flex flex-wrap gap-1.5 items-center">
              {/* Pinned chips (fixed — no remove) */}
              {pinnedEpics.map(e => {
                const proj = e.key.split('-')[0]
                const cls  = PROJECT_COLOR[proj] || 'bg-slate-100 text-slate-700 border-slate-300'
                return (
                  <span key={e.key}
                    className={`inline-flex items-center gap-1.5 text-xs font-medium rounded-full pl-2 pr-2.5 py-1 border ${cls}`}
                    title={e.summary}
                  >
                    <span className="font-mono font-semibold">{e.key}</span>
                    <span className="truncate max-w-[140px] text-current opacity-80">{e.summary}</span>
                  </span>
                )
              })}

              {/* Extra chips (removable) */}
              {extraEpics.filter(e => !pinnedKeys.includes(e.key)).map(e => {
                const proj = e.key.split('-')[0]
                const cls  = PROJECT_COLOR[proj] || 'bg-slate-100 text-slate-700 border-slate-300'
                return (
                  <span key={e.key}
                    className={`inline-flex items-center gap-1 text-xs font-medium rounded-full pl-2 pr-1.5 py-1 border border-dashed ${cls}`}
                    title={e.summary}
                  >
                    <span className="font-mono">{e.key}</span>
                    <button onClick={() => setExtraEpics(prev => prev.filter(x => x.key !== e.key))} className="hover:text-red-600 ml-0.5">
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                )
              })}

              {extraEpics.length > 0 && (
                <button onClick={() => setExtraEpics([])} className="text-xs text-slate-400 hover:text-red-500 px-1">
                  Clear extras
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            {[7, 14, 30, 60].map(d => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${days === d ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}
              >
                Last {d}d
              </button>
            ))}
            {mode === 'assigned' && assignedQuery.data && (
              <span className="text-sm text-slate-500 ml-2">
                {Object.values(assignedQuery.data).flat().length} issues found
              </span>
            )}
            {mode === 'date' && bugsQuery.data && (
              <span className="text-sm text-slate-500 ml-2">
                {bugsQuery.data.length} bug{bugsQuery.data.length !== 1 ? 's' : ''} found
              </span>
            )}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-6 py-4 space-y-4">

        {/* ── Epic mode ── */}
        {mode === 'epic' && (
          <>
            {memberIds.length === 0 && !teamQuery.isLoading && (
              <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-700">
                <AlertCircle className="h-4 w-4 shrink-0" />
                Team members could not be resolved in Jira. Epic work cannot be filtered by team.
              </div>
            )}
            {selectedEpics.length === 0 && pinnedQuery.isFetching && (
              <div className="flex items-center gap-2 text-sm text-slate-500 py-8">
                <Loader2 className="h-4 w-4 animate-spin text-emerald-500" /> Loading release plan epics…
              </div>
            )}
            {selectedEpics.map(epic => (
              <EpicCard
                key={epic.key}
                epic={epic}
                memberIds={memberIds}
                isPinned={pinnedKeys.includes(epic.key)}
                onRemove={k => setExtraEpics(prev => prev.filter(e => e.key !== k))}
                refresh={refreshKey}
              />
            ))}
          </>
        )}

        {/* ── Date mode ── */}
        {mode === 'date' && (
          <>
            {bugsQuery.isFetching && (
              <div className="flex items-center gap-2 text-sm text-slate-500 py-6">
                <Loader2 className="h-4 w-4 animate-spin text-emerald-500" /> Loading bugs…
              </div>
            )}
            {bugsQuery.error && (
              <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {bugsQuery.error?.response?.data?.detail || 'Failed to load bugs'}
              </div>
            )}

            {/* Per-member grouping */}
            {!bugsQuery.isFetching && Object.entries(bugsByReporter).map(([reporter, bugs]) => (
              <div key={reporter} className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3 bg-slate-50 border-b border-slate-200">
                  <div className="h-7 w-7 rounded-full bg-emerald-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
                    {reporter.charAt(0)}
                  </div>
                  <p className="text-sm font-semibold text-slate-800">{reporter}</p>
                  <span className="ml-auto text-xs text-slate-500 bg-red-100 text-red-700 rounded-full px-2 py-0.5">
                    {bugs.length} bug{bugs.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="bg-red-50 text-red-800 text-[11px] font-semibold">
                        <th className="px-3 py-2 text-left">Project</th>
                        <th className="px-3 py-2 text-left">Key</th>
                        <th className="px-3 py-2 text-left">Summary</th>
                        <th className="px-2 py-2 text-left">Status</th>
                        <th className="px-2 py-2 text-left">Priority</th>
                        <th className="px-3 py-2 text-left">Reporter</th>
                        <th className="px-3 py-2 text-left">Fix Version</th>
                        <th className="px-3 py-2 text-left">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bugs.map(b => <BugRow key={b.key} bug={b} />)}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}

            {!bugsQuery.isFetching && !bugsQuery.error && (bugsQuery.data?.length === 0) && (
              <div className="flex flex-col items-center justify-center py-16 text-slate-400">
                <Bug className="h-10 w-10 opacity-20 mb-2" />
                <p className="text-sm">No bugs found for the team in the last {days} days.</p>
              </div>
            )}
          </>
        )}

        {/* ── Assigned Work mode ── */}
        {mode === 'assigned' && (
          <>
            {assignedQuery.isFetching && (
              <div className="flex items-center gap-2 text-sm text-slate-500 py-6">
                <Loader2 className="h-4 w-4 animate-spin text-emerald-500" /> Loading assigned work…
              </div>
            )}
            {assignedQuery.error && (
              <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {assignedQuery.error?.response?.data?.detail || 'Failed to load'}
              </div>
            )}

            {!assignedQuery.isFetching && assignedQuery.data &&
              Object.entries(assignedQuery.data).map(([person, issues]) => {
                const member  = members.find(m => m.name === person)
                const avatar  = member?.avatar
                const counts  = issues.reduce((acc, i) => {
                  acc[i.type] = (acc[i.type] || 0) + 1
                  return acc
                }, {})
                const openIssues   = issues.filter(i => !['Done', 'Closed'].includes(i.status))
                const closedIssues = issues.filter(i => ['Done', 'Closed'].includes(i.status))

                return (
                  <div key={person} className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
                    {/* Member header */}
                    <div className="flex items-center gap-3 px-4 py-3 bg-emerald-50 border-b border-emerald-100">
                      {avatar
                        ? <img src={avatar} alt={person} className="h-8 w-8 rounded-full border-2 border-emerald-300" />
                        : <div className="h-8 w-8 rounded-full bg-emerald-500 flex items-center justify-center text-white text-sm font-bold shrink-0">
                            {person.charAt(0)}
                          </div>
                      }
                      <div className="flex-1">
                        <p className="text-sm font-bold text-slate-800">{person}</p>
                        <p className="text-xs text-slate-500">Last {days} days · {issues.length} issues</p>
                      </div>
                      {/* Type breakdown pills */}
                      <div className="flex flex-wrap gap-1.5 justify-end">
                        {Object.entries(counts).map(([type, count]) => (
                          <span key={type} className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[11px] font-medium border ${TYPE_BADGE[type] || 'bg-slate-100 text-slate-600 border-slate-300'}`}>
                            {count} {type}
                          </span>
                        ))}
                      </div>
                      {/* Open / Done counts */}
                      <div className="flex items-center gap-2 ml-2 shrink-0">
                        <span className="text-xs bg-blue-100 text-blue-700 rounded-full px-2 py-0.5 font-medium">
                          {openIssues.length} open
                        </span>
                        <span className="text-xs bg-green-100 text-green-700 rounded-full px-2 py-0.5 font-medium">
                          {closedIssues.length} done
                        </span>
                      </div>
                    </div>

                    {/* Issues table */}
                    <div className="overflow-x-auto">
                      <table className="w-full border-collapse text-xs">
                        <thead>
                          <tr className="bg-slate-700 text-white text-[11px] font-semibold">
                            <th className="px-3 py-2 text-left whitespace-nowrap">Key</th>
                            <th className="px-3 py-2 text-left">Summary</th>
                            <th className="px-2 py-2 text-left whitespace-nowrap">Type</th>
                            <th className="px-2 py-2 text-left whitespace-nowrap">Status</th>
                            <th className="px-2 py-2 text-left whitespace-nowrap">Priority</th>
                            <th className="px-3 py-2 text-left whitespace-nowrap">Parent</th>
                            <th className="px-3 py-2 text-left whitespace-nowrap">Fix Version</th>
                            <th className="px-3 py-2 text-left whitespace-nowrap">Updated</th>
                          </tr>
                        </thead>
                        <tbody>
                          {issues.map(issue => {
                            const proj    = issue.key.split('-')[0]
                            const projCls = PROJECT_COLOR[proj] || 'bg-slate-100 text-slate-700 border-slate-300'
                            return (
                              <tr key={issue.key} className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
                                <td className="px-3 py-2 whitespace-nowrap">
                                  <a href={issue.url} target="_blank" rel="noreferrer"
                                    className="font-mono text-indigo-600 hover:underline flex items-center gap-1">
                                    <span className={`shrink-0 px-1 rounded text-[9px] font-semibold border ${projCls}`}>{proj}</span>
                                    {issue.key}
                                  </a>
                                </td>
                                <td className="px-3 py-2 max-w-xs">
                                  <p className="text-slate-700 line-clamp-2" title={issue.summary}>{issue.summary}</p>
                                </td>
                                <td className="px-2 py-2 whitespace-nowrap">
                                  <TypeBadge type={issue.type} />
                                </td>
                                <td className="px-2 py-2 whitespace-nowrap">
                                  <StatusPill status={issue.status} />
                                </td>
                                <td className={`px-2 py-2 whitespace-nowrap ${PRIORITY_CLS[issue.priority] || 'text-slate-500'}`}>
                                  {issue.priority || '—'}
                                </td>
                                <td className="px-3 py-2 whitespace-nowrap">
                                  {issue.parent_key
                                    ? <span className="font-mono text-xs text-purple-600">{issue.parent_key}</span>
                                    : <span className="text-slate-400">—</span>
                                  }
                                </td>
                                <td className="px-3 py-2 whitespace-nowrap text-slate-600">
                                  {issue.fix_versions[0] || <span className="text-slate-400">—</span>}
                                </td>
                                <td className="px-3 py-2 whitespace-nowrap text-slate-500">
                                  {fmtDate(issue.updated)}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )
              })
            }

            {!assignedQuery.isFetching && !assignedQuery.error &&
             assignedQuery.data && Object.keys(assignedQuery.data).length === 0 && (
              <div className="flex flex-col items-center justify-center py-16 text-slate-400">
                <Users className="h-10 w-10 opacity-20 mb-2" />
                <p className="text-sm">No assigned work found for the team in the last {days} days.</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

import { useState, useMemo, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import axios from 'axios'
import { getDashboard, exportUrl, BASE_URL } from '../services/api'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { Header } from '../components/layout/Header'
import { IssueTable } from '../components/tables/DataTable'
import { SummaryCard } from '../components/cards/SummaryCard'
import { PageLoader, ErrorState } from '../components/common/LoadingSpinner'
import {
  Bug, Users, ChevronDown, Save, X, ExternalLink,
  RefreshCw, Settings, CheckSquare, Square,
} from 'lucide-react'

const API = `${BASE_URL}/bug-triage`

// ── Status colors ──────────────────────────────────────────────────────────
const STATUS_COLORS = {
  'To Do':                'bg-gray-100 text-gray-600',
  'ToDo':                 'bg-gray-100 text-gray-600',
  'Open':                 'bg-gray-100 text-gray-600',
  'In Progress':          'bg-blue-100 text-blue-700',
  'In Review':            'bg-indigo-100 text-indigo-700',
  'Ready for Testing':    'bg-purple-100 text-purple-700',
  'Validation':           'bg-violet-100 text-violet-700',
  'Ready For Deployment': 'bg-teal-100 text-teal-700',
  'Monitoring':           'bg-cyan-100 text-cyan-700',
  'Done':                 'bg-green-100 text-green-700',
  'DONE':                 'bg-green-100 text-green-700',
  'Removed':              'bg-gray-100 text-gray-400',
  'Closed':               'bg-gray-100 text-gray-400',
  'Blocked':              'bg-red-100 text-red-700',
  'QA Monitoring':        'bg-cyan-100 text-cyan-700',
}

const TYPE_COLORS = {
  Bug:   'bg-red-50 text-red-600',
  Story: 'bg-blue-50 text-blue-700',
  Task:  'bg-yellow-50 text-yellow-700',
  Epic:  'bg-purple-50 text-purple-700',
  Test:  'bg-teal-50 text-teal-700',
}

const PRIORITY_DOT = {
  Highest: 'bg-red-600', High: 'bg-orange-500', Medium: 'bg-yellow-400',
  Low: 'bg-blue-400', Lowest: 'bg-slate-400',
}

function StatusPill({ status }) {
  const cls = STATUS_COLORS[status] || 'bg-slate-100 text-slate-600'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${cls}`}>
      {status || '—'}
    </span>
  )
}

function TypePill({ type }) {
  const cls = TYPE_COLORS[type] || 'bg-slate-100 text-slate-600'
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}>
      {type || '—'}
    </span>
  )
}

// ── Inline editable cell with a small dropdown ──────────────────────────────
function InlineSelect({ value, options, placeholder, onChange, disabled }) {
  const [open, setOpen]     = useState(false)
  const [pos, setPos]       = useState(null)
  const [search, setSearch] = useState('')
  const btnRef    = useRef(null)
  const dropRef   = useRef(null)
  const inputRef  = useRef(null)

  useEffect(() => {
    if (!open) { setSearch(''); return }
    setTimeout(() => inputRef.current?.focus(), 0)
    const h = e => {
      if (btnRef.current?.contains(e.target) || dropRef.current?.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const toggle = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 2, left: r.left, width: Math.max(r.width, 220) })
    setOpen(v => !v)
  }

  const pick = (val) => { onChange(val); setOpen(false) }

  const filtered = search
    ? options.filter(o => o.label.toLowerCase().startsWith(search.toLowerCase()))
    : options

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        disabled={disabled}
        className="flex items-center gap-1 text-left text-xs border border-transparent hover:border-blue-300 hover:bg-blue-50 rounded px-1.5 py-0.5 transition-colors disabled:opacity-40 w-full"
      >
        <span className="flex-1 truncate">
          {value
            ? (options?.find(o => o.value === value)?.label ?? value)
            : <span className="text-slate-400">{placeholder}</span>}
        </span>
        <ChevronDown className="h-3 w-3 text-slate-400 shrink-0" />
      </button>
      {open && pos && createPortal(
        <div ref={dropRef} className="fixed z-[9999] bg-white border border-slate-200 rounded-xl shadow-2xl flex flex-col"
          style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: 300 }}>
          <div className="px-2 pt-2 pb-1 border-b border-slate-100">
            <input
              ref={inputRef}
              value={search}
              onChange={e => setSearch(e.target.value)}
              onMouseDown={e => e.stopPropagation()}
              placeholder="Search…"
              className="w-full text-xs border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:border-blue-400"
            />
          </div>
          <div className="overflow-y-auto py-1">
            {!search && (
              <div onMouseDown={() => pick('')} className="px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-50 cursor-pointer italic">{placeholder}</div>
            )}
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-xs text-slate-400 italic">No match</div>
            )}
            {filtered.map(o => (
              <div key={o.value} onMouseDown={() => pick(o.value)}
                className={`px-3 py-1.5 text-xs cursor-pointer hover:bg-blue-50 ${o.value === value ? 'bg-blue-50 font-semibold text-blue-700' : 'text-slate-700'}`}>
                {o.label}
              </div>
            ))}
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

// ── QA Team configurator ────────────────────────────────────────────────────
function QATeamSelector({ allAssignees, qaTeam, onSave }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(new Set(qaTeam))

  useEffect(() => { setDraft(new Set(qaTeam)) }, [qaTeam])

  const toggle = (id) => setDraft(prev => {
    const s = new Set(prev)
    s.has(id) ? s.delete(id) : s.add(id)
    return s
  })

  if (!open) return (
    <button onClick={() => setOpen(true)}
      className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white hover:bg-slate-50">
      <Settings className="h-3.5 w-3.5" />
      QA Team ({qaTeam.length})
    </button>
  )

  return (
    <div className="bg-white border border-blue-200 rounded-xl p-3 shadow-lg">
      <p className="text-xs font-semibold text-slate-700 mb-2">Select QA Team Members</p>
      <div className="grid grid-cols-2 gap-1 max-h-48 overflow-y-auto">
        {allAssignees.map(u => {
          const checked = draft.has(u.id)
          return (
            <label key={u.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-50 cursor-pointer text-xs">
              {checked
                ? <CheckSquare className="h-3.5 w-3.5 text-blue-600 shrink-0" />
                : <Square className="h-3.5 w-3.5 text-slate-300 shrink-0" />}
              <input type="checkbox" className="sr-only" checked={checked} onChange={() => toggle(u.id)} />
              <span className="truncate text-slate-700">{u.name}</span>
            </label>
          )
        })}
      </div>
      <div className="flex gap-2 mt-2 pt-2 border-t border-slate-100">
        <button onClick={() => { onSave([...draft]); setOpen(false) }}
          className="bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium px-3 py-1 rounded-lg">Save</button>
        <button onClick={() => setOpen(false)} className="text-slate-500 text-xs px-3 py-1 rounded-lg border border-slate-200">Cancel</button>
      </div>
    </div>
  )
}

// ── QA Assignments Panel ────────────────────────────────────────────────────
function QAAssignmentsPanel() {
  const qc = useQueryClient()

  const [qaTeam, setQaTeam] = useState(() => {
    try { return JSON.parse(localStorage.getItem('qa-dashboard:qa-team-ids') || '[]') } catch { return [] }
  })
  const saveQaTeam = (ids) => {
    setQaTeam(ids)
    localStorage.setItem('qa-dashboard:qa-team-ids', JSON.stringify(ids))
  }

  const [filterTypes,    setFilterTypes]    = useState(new Set())
  const [filterStatuses, setFilterStatuses] = useState(new Set())
  const [filterAssignee, setFilterAssignee] = useState('')
  const [pendingEdits,   setPendingEdits]   = useState({})  // { key: { field: value } }

  const metaQ = useQuery({
    queryKey: ['triage-meta'],
    queryFn: () => axios.get(`${API}/meta`).then(r => r.data),
    staleTime: 300_000,
  })

  const assignmentsQ = useQuery({
    queryKey: ['triage-qa-assignments', qaTeam.join(',')],
    queryFn: ({ signal }) =>
      axios.get(`${API}/qa-assignments`, { params: { assignees: qaTeam.join(',') }, signal })
           .then(r => r.data.issues),
    enabled: qaTeam.length > 0,
    staleTime: 120_000,
  })

  const [localIssues, setLocalIssues] = useState(null)
  useEffect(() => {
    if (assignmentsQ.data) setLocalIssues(assignmentsQ.data)
  }, [assignmentsQ.data])

  const saveMutation = useMutation({
    mutationFn: ({ key, field, value }) =>
      axios.patch(`${API}/${key}`, { field, value }).then(r => r.data),
    onSuccess: (_, { key, field, value }) => {
      const meta = metaQ.data
      setLocalIssues(prev => prev ? prev.map(i => {
        if (i.key !== key) return i
        if (field === 'assignee') {
          const a = meta?.assignees?.find(x => x.id === value)
          return { ...i, assignee_id: value || '', assignee: a?.name || '' }
        }
        if (field === 'fix_version') return { ...i, fix_versions: value ? [value] : [] }
        if (field === 'sprint') {
          const s = meta?.sprints?.find(x => String(x.id) === value)
          return { ...i, sprint_id: value ? Number(value) : null, sprint: s?.name || '' }
        }
        if (field === 'status') return { ...i, status: value }
        return i
      }) : prev)
      setPendingEdits(p => {
        const n = { ...p }
        if (n[key]) { delete n[key][field]; if (!Object.keys(n[key]).length) delete n[key] }
        return n
      })
    },
  })

  const issues = localIssues || []

  const allTypes    = useMemo(() => [...new Set(issues.map(i => i.issue_type).filter(Boolean))].sort(), [issues])
  const allStatuses = useMemo(() => [...new Set(issues.map(i => i.status).filter(Boolean))].sort(), [issues])

  const filtered = useMemo(() => {
    let list = issues
    if (filterTypes.size)    list = list.filter(i => filterTypes.has(i.issue_type))
    if (filterStatuses.size) list = list.filter(i => filterStatuses.has(i.status))
    if (filterAssignee)      list = list.filter(i => i.assignee_id === filterAssignee)
    return list
  }, [issues, filterTypes, filterStatuses, filterAssignee])

  const toggleSet = (setter, val) => setter(prev => {
    const s = new Set(prev); s.has(val) ? s.delete(val) : s.add(val); return s
  })

  const setPending = (key, field, value) =>
    setPendingEdits(p => ({ ...p, [key]: { ...(p[key] || {}), [field]: value } }))

  const hasPending = (key) => !!pendingEdits[key] && Object.keys(pendingEdits[key]).length > 0

  const saveRow = (issue) => {
    const edits = pendingEdits[issue.key] || {}
    Object.entries(edits).forEach(([field, value]) =>
      saveMutation.mutate({ key: issue.key, field, value })
    )
  }

  const meta = metaQ.data

  const assigneeOptions = (meta?.assignees || []).map(u => ({ value: u.id, label: u.name }))
  const sprintOptions   = (meta?.sprints   || []).map(s => ({ value: String(s.id), label: s.name + (s.state === 'active' ? ' ✓' : '') }))
  const versionOptions  = (meta?.fix_versions || []).map(v => ({ value: v.name, label: v.name }))
  const statusOptions   = allStatuses.map(s => ({ value: s, label: s }))

  const statsByType = useMemo(() => {
    const m = {}
    issues.forEach(i => { m[i.issue_type] = (m[i.issue_type] || 0) + 1 })
    return m
  }, [issues])

  return (
    <div className="space-y-4">
      {/* QA Team + Stats */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex flex-wrap gap-2 items-center">
          {Object.entries(statsByType).sort(([,a],[,b]) => b-a).map(([type, count]) => (
            <div key={type} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium ${TYPE_COLORS[type] || 'bg-slate-50 text-slate-600 border-slate-200'} border-current/20`}>
              <span className="text-base font-bold">{count}</span>
              <span>{type}</span>
            </div>
          ))}
          {issues.length > 0 && (
            <span className="text-xs text-slate-400">{filtered.length} of {issues.length} shown</span>
          )}
        </div>
        <div className="flex items-start gap-2">
          <button
            onClick={() => assignmentsQ.refetch()}
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white">
            <RefreshCw className={`h-3.5 w-3.5 ${assignmentsQ.isFetching ? 'animate-spin' : ''}`} />
          </button>
          <QATeamSelector
            allAssignees={meta?.assignees || []}
            qaTeam={qaTeam}
            onSave={saveQaTeam}
          />
        </div>
      </div>

      {qaTeam.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
          <Users className="h-8 w-8 text-slate-300 mx-auto mb-2" />
          <p className="text-slate-500 font-medium text-sm">No QA team configured</p>
          <p className="text-slate-400 text-xs mt-1">Click "QA Team" above to select team members.</p>
        </div>
      ) : assignmentsQ.isLoading ? (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center text-slate-400 text-sm">Loading…</div>
      ) : assignmentsQ.isError ? (
        <div className="bg-red-50 rounded-xl border border-red-200 p-6 text-center text-red-600 text-sm">
          Error loading assignments. <button onClick={() => assignmentsQ.refetch()} className="underline">Retry</button>
        </div>
      ) : (
        <>
          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3 bg-white border border-slate-200 rounded-xl px-4 py-2.5">
            {/* Type filter */}
            <div className="flex flex-wrap gap-1 items-center">
              <span className="text-xs text-slate-400 font-medium mr-1">Type:</span>
              {allTypes.map(t => (
                <button key={t} onClick={() => toggleSet(setFilterTypes, t)}
                  className={`px-2 py-0.5 rounded-full text-xs font-medium border transition-colors ${filterTypes.has(t) ? `${TYPE_COLORS[t] || 'bg-slate-100 text-slate-600'} border-transparent` : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'}`}>
                  {t}
                </button>
              ))}
              {filterTypes.size > 0 && <button onClick={() => setFilterTypes(new Set())} className="text-[10px] text-red-400 hover:text-red-600 px-1">✕</button>}
            </div>

            <div className="w-px h-4 bg-slate-200" />

            {/* Status filter */}
            <div className="flex flex-wrap gap-1 items-center">
              <span className="text-xs text-slate-400 font-medium mr-1">Status:</span>
              {allStatuses.map(s => (
                <button key={s} onClick={() => toggleSet(setFilterStatuses, s)}
                  className={`px-2 py-0.5 rounded-full text-xs font-medium border transition-colors ${filterStatuses.has(s) ? `${STATUS_COLORS[s] || 'bg-slate-100 text-slate-600'} border-transparent` : 'bg-white text-slate-500 border-slate-200 hover:border-slate-400'}`}>
                  {s}
                </button>
              ))}
              {filterStatuses.size > 0 && <button onClick={() => setFilterStatuses(new Set())} className="text-[10px] text-red-400 hover:text-red-600 px-1">✕</button>}
            </div>

            <div className="w-px h-4 bg-slate-200" />

            {/* Assignee filter */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-400 font-medium">Assignee:</span>
              <select value={filterAssignee} onChange={e => setFilterAssignee(e.target.value)}
                className="text-xs border border-slate-200 rounded-lg px-2 py-0.5 bg-white focus:outline-none focus:ring-1 focus:ring-blue-300">
                <option value="">All</option>
                {(meta?.assignees || [])
                  .filter(u => qaTeam.includes(u.id))
                  .map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
          </div>

          {/* Table */}
          {filtered.length === 0 ? (
            <div className="bg-white rounded-xl border border-slate-200 p-10 text-center text-slate-400 text-sm">
              No issues match the current filters.
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-xs" style={{ minWidth: 900 }}>
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr className="text-slate-500 uppercase tracking-wide">
                      <th className="px-3 py-2 text-left font-medium w-28">Key</th>
                      <th className="px-3 py-2 text-left font-medium w-20">Type</th>
                      <th className="px-3 py-2 text-left font-medium w-36">Status</th>
                      <th className="px-3 py-2 text-left font-medium">Summary</th>
                      <th className="px-3 py-2 text-left font-medium w-20">Priority</th>
                      <th className="px-3 py-2 text-left font-medium w-32">Fix Version</th>
                      <th className="px-3 py-2 text-left font-medium w-36">Sprint</th>
                      <th className="px-3 py-2 text-left font-medium w-32">Reporter</th>
                      <th className="px-3 py-2 text-left font-medium w-36">Assignee</th>
                      <th className="px-3 py-2 text-center font-medium w-12">Save</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filtered.map(issue => {
                      const pending = pendingEdits[issue.key] || {}
                      const dirty   = hasPending(issue.key)
                      const curAssigneeId  = pending.assignee    !== undefined ? pending.assignee    : issue.assignee_id
                      const curVersion     = pending.fix_version !== undefined ? pending.fix_version : (issue.fix_versions?.[0] || '')
                      const curSprintId    = pending.sprint      !== undefined ? pending.sprint      : (issue.sprint_id ? String(issue.sprint_id) : '')
                      const curStatus      = pending.status      !== undefined ? pending.status      : issue.status

                      return (
                        <tr key={issue.key} className={`hover:bg-slate-50/60 ${dirty ? 'bg-yellow-50/40' : ''}`}>
                          {/* Key */}
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-1.5">
                              {PRIORITY_DOT[issue.priority] && (
                                <span className={`w-2 h-2 rounded-full shrink-0 ${PRIORITY_DOT[issue.priority]}`} title={issue.priority} />
                              )}
                              <a href={issue.url} target="_blank" rel="noreferrer"
                                className="text-blue-600 hover:underline font-medium font-mono whitespace-nowrap flex items-center gap-0.5">
                                {issue.key}
                                <ExternalLink className="h-3 w-3 shrink-0" />
                              </a>
                            </div>
                          </td>

                          {/* Type */}
                          <td className="px-3 py-2.5"><TypePill type={issue.issue_type} /></td>

                          {/* Status (editable) */}
                          <td className="px-3 py-2.5">
                            <InlineSelect
                              value={curStatus}
                              options={statusOptions}
                              placeholder="— status —"
                              onChange={val => setPending(issue.key, 'status', val)}
                            />
                          </td>

                          {/* Summary */}
                          <td className="px-3 py-2.5">
                            <p className="text-slate-700 text-xs line-clamp-2 leading-snug">{issue.summary}</p>
                            {issue.parent_key && (
                              <p className="text-slate-400 text-[10px] mt-0.5">{issue.parent_key} · {issue.parent_summary}</p>
                            )}
                          </td>

                          {/* Priority */}
                          <td className="px-3 py-2.5 text-slate-600">{issue.priority || '—'}</td>

                          {/* Fix Version (editable) */}
                          <td className="px-3 py-2.5">
                            <InlineSelect
                              value={curVersion}
                              options={versionOptions}
                              placeholder="— version —"
                              onChange={val => setPending(issue.key, 'fix_version', val)}
                            />
                          </td>

                          {/* Sprint (editable) */}
                          <td className="px-3 py-2.5">
                            <InlineSelect
                              value={curSprintId}
                              options={sprintOptions}
                              placeholder="— sprint —"
                              onChange={val => setPending(issue.key, 'sprint', val)}
                            />
                          </td>

                          {/* Reporter */}
                          <td className="px-3 py-2.5 text-slate-500 truncate" title={issue.reporter}>
                            {issue.reporter || '—'}
                          </td>

                          {/* Assignee (editable) */}
                          <td className="px-3 py-2.5">
                            <InlineSelect
                              value={curAssigneeId}
                              options={assigneeOptions}
                              placeholder="— assignee —"
                              onChange={val => setPending(issue.key, 'assignee', val)}
                            />
                          </td>

                          {/* Save */}
                          <td className="px-3 py-2.5 text-center">
                            {dirty ? (
                              <div className="flex items-center justify-center gap-1">
                                <button
                                  onClick={() => saveRow(issue)}
                                  disabled={saveMutation.isPending}
                                  className="p-1 text-green-600 hover:bg-green-100 rounded"
                                  title="Save changes">
                                  <Save className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  onClick={() => setPendingEdits(p => { const n = { ...p }; delete n[issue.key]; return n })}
                                  className="p-1 text-slate-400 hover:bg-slate-100 rounded"
                                  title="Discard">
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            ) : (
                              <span className="text-slate-200">—</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Main page ───────────────────────────────────────────────────────────────
const TABS = [
  { key: 'bugs',        label: 'Bugs (30d)',       icon: Bug   },
  { key: 'assignments', label: 'QA Assignments',   icon: Users },
]

export default function BugsReport() {
  const [activeTab, setActiveTab]   = useState('bugs')
  const [filters, setFilters]       = useState({})
  const [activeReporter, setActiveReporter] = useState(null)

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['dashboard-bugs', filters],
    queryFn: () => getDashboard({ ...filters }),
    refetchInterval: 5 * 60 * 1000,
    enabled: activeTab === 'bugs',
  })

  const { lastRefresh, isRefreshing, refresh } = useAutoRefresh([['dashboard-bugs', filters]])

  if (isLoading && activeTab === 'bugs') return <PageLoader />
  if (isError   && activeTab === 'bugs') return <div className="flex-1 p-6"><ErrorState message={error?.message} onRetry={refetch} /></div>

  const bugs = data?.bugs_30d || []
  const highest = bugs.filter(b => b.priority === 'Highest' || b.priority === 'Critical').length
  const open    = bugs.filter(b => b.status_category !== 'Done').length

  const byCreator = {}
  bugs.forEach(b => {
    const name = b.reporter?.display_name || 'Unknown'
    byCreator[name] = (byCreator[name] || 0) + 1
  })

  const visibleBugs = activeReporter
    ? bugs.filter(b => (b.reporter?.display_name || 'Unknown') === activeReporter)
    : bugs

  const toggleReporter = (name) => setActiveReporter(prev => prev === name ? null : name)

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Bugs — Last 30 Days"
        lastRefresh={lastRefresh}
        isRefreshing={isRefreshing}
        onRefresh={() => refresh(true)}
        onFilter={setFilters}
        exportOptions={[
          { label: 'Export CSV',   href: exportUrl('bugs/csv')   },
          { label: 'Export Excel', href: exportUrl('bugs/excel') },
        ]}
      />
      <div className="flex-1 p-6 space-y-5 overflow-auto">

        {/* Tab bar */}
        <div className="flex gap-1 bg-white rounded-xl border border-slate-200 p-1 w-fit">
          {TABS.map(tab => {
            const Icon = tab.icon
            return (
              <button key={tab.key} onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${activeTab === tab.key ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            )
          })}
        </div>

        {activeTab === 'bugs' && (
          <>
            <div className="grid grid-cols-3 gap-4">
              <SummaryCard title="Total Bugs (30d)" value={bugs.length}  icon={Bug} color="red" />
              <SummaryCard title="Highest / Critical" value={highest}    icon={Bug} color="red" />
              <SummaryCard title="Still Open"        value={open}        icon={Bug} color="orange" />
            </div>

            {Object.keys(byCreator).length > 0 && (
              <div className="card">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="font-semibold text-gray-800 text-sm">Bugs by Reporter</h2>
                  {activeReporter && (
                    <button onClick={() => setActiveReporter(null)} className="text-xs text-red-500 hover:text-red-700 underline">
                      Clear filter
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-3">
                  {Object.entries(byCreator).sort(([,a],[,b]) => b-a).map(([name, count]) => {
                    const isActive = activeReporter === name
                    return (
                      <button key={name} onClick={() => toggleReporter(name)}
                        className={`rounded-lg px-4 py-3 text-center min-w-[100px] border transition-colors cursor-pointer ${isActive ? 'bg-red-600 border-red-600 text-white' : 'bg-red-50 border-red-100 hover:bg-red-100'}`}>
                        <p className={`text-2xl font-bold ${isActive ? 'text-white' : 'text-red-600'}`}>{count}</p>
                        <p className={`text-xs mt-1 ${isActive ? 'text-red-100' : 'text-gray-600'}`}>{name}</p>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="card">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-semibold text-gray-800 text-sm">
                  {activeReporter ? `Bugs by ${activeReporter}` : 'All Bugs'}
                  {activeReporter && <span className="ml-2 text-xs font-normal text-gray-400">({visibleBugs.length} of {bugs.length})</span>}
                </h2>
              </div>
              <IssueTable issues={visibleBugs} />
            </div>
          </>
        )}

        {activeTab === 'assignments' && <QAAssignmentsPanel />}
      </div>
    </div>
  )
}

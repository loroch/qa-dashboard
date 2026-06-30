import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { Search, X, Loader2, AlertCircle, RefreshCw, ChevronDown, Bug, Calendar, Users } from 'lucide-react'

const API = '/api/bug-triage'

/* ── helpers ─────────────────────────────────────────────── */
function fmtDate(s) {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
}

const PRIORITY_COLORS = {
  Highest: 'text-red-700 font-bold',
  High:    'text-red-500 font-semibold',
  Medium:  'text-amber-600',
  Low:     'text-blue-500',
  Lowest:  'text-slate-400',
}

const STATUS_PILL = {
  'To Do':             'bg-slate-100 text-slate-600',
  'In Progress':       'bg-blue-100 text-blue-700',
  'Ready for Testing': 'bg-amber-100 text-amber-700',
  'Done':              'bg-green-100 text-green-700',
  'DONE':              'bg-green-100 text-green-700',
  'Closed':            'bg-green-100 text-green-700',
  'Reopened':          'bg-red-100 text-red-700',
}

function StatusPill({ status }) {
  const cls = STATUS_PILL[status] || 'bg-slate-100 text-slate-600'
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{status || '—'}</span>
}

/* ── EpicSearch – multi-select ───────────────────────────── */
function EpicSearch({ selectedEpics, onAdd, onRemove }) {
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
    queryKey: ['triage-epic-search', dq],
    queryFn: ({ signal }) => axios.get(`${API}/search-epics`, { params: { q: dq }, signal }).then(r => r.data.epics),
    enabled: dq.trim().length >= 2,
    staleTime: 60_000,
  })

  useEffect(() => {
    const h = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const clear = () => { setQ(''); setDq(''); setOpen(false) }
  const results = data || []
  const selectedKeys = selectedEpics.map(e => e.key)

  return (
    <div className="space-y-2">
      <div className="relative" ref={wrapRef}>
        <div className="flex items-center gap-2 bg-white border border-slate-300 rounded-lg px-3 py-2 w-96 shadow-sm focus-within:ring-2 focus-within:ring-indigo-300">
          <Search className="h-4 w-4 text-slate-400 shrink-0" />
          <input
            className="flex-1 outline-none text-sm text-slate-700 placeholder-slate-400"
            placeholder="Search epics to include…"
            value={q}
            onChange={e => handleQ(e.target.value)}
            onFocus={() => q.length >= 2 && setOpen(true)}
          />
          {isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />}
          {q && <button onClick={clear}><X className="h-3.5 w-3.5 text-slate-400 hover:text-slate-600" /></button>}
        </div>

        {open && dq.length >= 2 && (
          <div className="absolute z-50 mt-1 w-[560px] bg-white border border-slate-200 rounded-xl shadow-xl max-h-72 overflow-y-auto">
            {!isFetching && results.length === 0 && <div className="px-4 py-3 text-sm text-slate-400">No epics found</div>}
            {results.map(r => {
              const already = selectedKeys.includes(r.key)
              return (
                <button
                  key={r.key}
                  onClick={() => { if (!already) { onAdd(r); clear() } }}
                  disabled={already}
                  className={`w-full flex items-start gap-3 px-4 py-2.5 text-left hover:bg-slate-50 border-b border-slate-100 last:border-0 transition-colors ${already ? 'opacity-40 cursor-not-allowed' : ''}`}
                >
                  <span className="shrink-0 mt-0.5 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border bg-purple-100 text-purple-800 border-purple-300">Epic</span>
                  <div className="flex-1 min-w-0">
                    <span className="font-mono text-xs text-purple-700">{r.key}</span>
                    <p className="text-sm text-slate-700 mt-0.5">{r.summary}</p>
                  </div>
                  {already ? <span className="text-xs text-slate-400 shrink-0 mt-1">added</span> : <span className="text-xs text-indigo-500 shrink-0 mt-1">+ Add</span>}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Selected epic chips */}
      {selectedEpics.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedEpics.map(e => (
            <span key={e.key} className="inline-flex items-center gap-1 bg-purple-100 text-purple-800 text-xs font-medium rounded-full pl-2.5 pr-1.5 py-0.5 border border-purple-300">
              <span className="font-mono">{e.key}</span>
              <span className="text-purple-600 truncate max-w-[160px]">{e.summary}</span>
              <button onClick={() => onRemove(e.key)} className="ml-0.5 hover:text-red-600">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── CreatorMultiSelect ──────────────────────────────────── */
function CreatorMultiSelect({ days, selected, onChange }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  const { data } = useQuery({
    queryKey: ['triage-creators', days],
    queryFn: ({ signal }) => axios.get(`${API}/creators`, { params: { days }, signal }).then(r => r.data.creators),
    staleTime: 300_000,
  })

  useEffect(() => {
    const h = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const creators = data || []
  const toggle = id => onChange(selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id])

  const label = selected.length === 0 ? 'All reporters' : `${selected.length} reporter${selected.length > 1 ? 's' : ''}`

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setOpen(v => !v)}
        className="flex items-center gap-2 bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-700 shadow-sm hover:bg-slate-50 transition-colors"
      >
        <Users className="h-4 w-4 text-slate-400" />
        {label}
        <ChevronDown className="h-3.5 w-3.5 text-slate-400" />
      </button>

      {open && creators.length > 0 && (
        <div className="absolute z-50 mt-1 w-64 bg-white border border-slate-200 rounded-xl shadow-xl max-h-64 overflow-y-auto">
          <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-500">Filter by Reporter</span>
            {selected.length > 0 && (
              <button onClick={() => onChange([])} className="text-xs text-indigo-600 hover:underline">Clear</button>
            )}
          </div>
          {creators.map(c => (
            <label key={c.id} className="flex items-center gap-2 px-3 py-2 hover:bg-slate-50 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.includes(c.id)}
                onChange={() => toggle(c.id)}
                className="accent-indigo-600 h-4 w-4"
              />
              <span className="text-sm text-slate-700">{c.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── InlineSelect ────────────────────────────────────────── */
function InlineSelect({ bugKey, field, value, options, saveState, onSave, placeholder = '—' }) {
  const state = saveState[`${bugKey}:${field}`] || 'idle'

  const borderClass = state === 'saving' ? 'border-amber-300' :
                      state === 'saved'  ? 'border-green-400' :
                      state === 'error'  ? 'border-red-400'   : 'border-slate-200'

  return (
    <div className="relative">
      <select
        value={value || ''}
        onChange={e => onSave(bugKey, field, e.target.value || null)}
        disabled={state === 'saving'}
        className={`w-full text-xs border rounded px-2 py-1 bg-white outline-none focus:ring-1 focus:ring-indigo-300 cursor-pointer appearance-none pr-5 ${borderClass} ${state === 'saving' ? 'opacity-60' : ''}`}
      >
        <option value="">{placeholder}</option>
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center">
        {state === 'saving' ? <Loader2 className="h-3 w-3 animate-spin text-amber-500" /> :
         state === 'saved'  ? <span className="text-green-500 text-[10px]">✓</span> :
         state === 'error'  ? <span className="text-red-500 text-[10px]">!</span> :
         <ChevronDown className="h-3 w-3 text-slate-400" />}
      </div>
    </div>
  )
}

/* ── ParentCell ──────────────────────────────────────────── */
function ParentCell({ bugKey, parentKey, parentType, parentSummary, saveState, onSave }) {
  const [editing, setEditing] = useState(false)
  const [q, setQ]             = useState('')
  const [dq, setDq]           = useState('')
  const [open, setOpen]       = useState(false)
  const [hovered, setHovered] = useState(false)
  const timer = useRef(null)
  const wrapRef = useRef(null)
  const state = saveState[`${bugKey}:parent`] || 'idle'

  const handleQ = v => {
    setQ(v); clearTimeout(timer.current)
    timer.current = setTimeout(() => setDq(v), 350)
    setOpen(true)
  }

  const { data } = useQuery({
    queryKey: ['triage-parents', dq],
    queryFn: ({ signal }) => axios.get(`${API}/search-parents`, { params: { q: dq }, signal }).then(r => r.data.results),
    enabled: dq.trim().length >= 2,
    staleTime: 60_000,
  })

  useEffect(() => {
    const h = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) { setOpen(false); setEditing(false) } }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  if (!editing) {
    const badgeCls = parentType === 'Epic'
      ? 'bg-purple-100 text-purple-700 border-purple-300'
      : 'bg-blue-100 text-blue-700 border-blue-300'
    return (
      <div className="relative" ref={wrapRef}>
        <button
          onClick={() => setEditing(true)}
          onMouseEnter={() => parentKey && parentSummary && setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          className="flex items-center gap-1 text-xs hover:bg-slate-100 rounded px-1 py-0.5 w-full text-left"
        >
          {parentKey ? (
            <>
              <span className={`shrink-0 px-1 rounded text-[10px] border ${badgeCls}`}>{parentType || 'P'}</span>
              <span className="font-mono text-indigo-600 truncate">{parentKey}</span>
            </>
          ) : (
            <span className="text-slate-400 italic">—  click to set</span>
          )}
          {state === 'saved' && <span className="text-green-500 text-[10px] ml-auto">✓</span>}
          {state === 'error' && <span className="text-red-500 text-[10px] ml-auto">!</span>}
        </button>

        {hovered && parentSummary && (
          <div className="absolute z-50 bottom-full left-0 mb-1.5 w-72 bg-slate-800 text-white text-xs rounded-lg px-3 py-2 shadow-xl pointer-events-none">
            <p className={`font-semibold mb-0.5 ${parentType === 'Epic' ? 'text-purple-300' : 'text-blue-300'}`}>
              {parentType} · {parentKey}
            </p>
            <p className="text-slate-200 leading-snug">{parentSummary}</p>
            <div className="absolute top-full left-4 border-4 border-transparent border-t-slate-800" />
          </div>
        )}
      </div>
    )
  }

  const results = data || []

  return (
    <div className="relative" ref={wrapRef}>
      <input
        autoFocus
        className="w-full text-xs border border-indigo-300 rounded px-2 py-1 outline-none focus:ring-1 focus:ring-indigo-400"
        placeholder="Search key or title…"
        value={q}
        onChange={e => handleQ(e.target.value)}
      />
      {open && results.length > 0 && (
        <div className="absolute z-50 left-0 mt-0.5 w-72 bg-white border border-slate-200 rounded-lg shadow-xl max-h-48 overflow-y-auto">
          {results.map(r => (
            <button
              key={r.key}
              onClick={() => { onSave(bugKey, 'parent', r.key); setEditing(false); setQ(''); setOpen(false) }}
              className="w-full flex items-start gap-2 px-3 py-2 hover:bg-indigo-50 border-b border-slate-100 last:border-0 text-left"
            >
              <span className={`shrink-0 mt-0.5 px-1 rounded text-[10px] border ${r.type === 'Epic' ? 'bg-purple-100 text-purple-700 border-purple-300' : 'bg-blue-100 text-blue-700 border-blue-300'}`}>{r.type}</span>
              <div className="min-w-0">
                <p className="font-mono text-xs text-indigo-700">{r.key}</p>
                <p className="text-xs text-slate-600 truncate">{r.summary}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── BugRow ──────────────────────────────────────────────── */
function BugRow({ bug, meta, saveState, onSave }) {
  const versionOptions  = meta.versions.map(v => ({ value: v.name, label: v.name }))
  const priorityOptions = meta.priorities.map(p => ({ value: p.name, label: p.name }))
  const sprintOptions   = meta.sprints.map(s => ({ value: String(s.id), label: s.name }))
  const assigneeOptions = meta.assignees.map(a => ({ value: a.id, label: a.name }))

  const currentSprintVal = bug.sprint_id ? String(bug.sprint_id) : ''

  return (
    <tr className="border-b border-slate-100 hover:bg-slate-50 transition-colors">
      {/* Key */}
      <td className="px-3 py-2 whitespace-nowrap">
        <a href={bug.url} target="_blank" rel="noreferrer" className="font-mono text-xs text-indigo-600 hover:underline">
          {bug.key}
        </a>
      </td>

      {/* Summary */}
      <td className="px-3 py-2 max-w-xs">
        <p className="text-sm text-slate-700 line-clamp-2" title={bug.summary}>{bug.summary}</p>
      </td>

      {/* Status */}
      <td className="px-3 py-2 whitespace-nowrap">
        <StatusPill status={bug.status} />
      </td>

      {/* Priority – editable */}
      <td className="px-2 py-2 w-28">
        <InlineSelect
          bugKey={bug.key} field="priority"
          value={bug.priority}
          options={priorityOptions}
          saveState={saveState}
          onSave={onSave}
          placeholder="—"
        />
        {bug.priority && (
          <span className={`block text-[10px] mt-0.5 pl-1 ${PRIORITY_COLORS[bug.priority] || 'text-slate-500'}`}>
            {bug.priority}
          </span>
        )}
      </td>

      {/* Fix Version – editable */}
      <td className="px-2 py-2 w-32">
        <InlineSelect
          bugKey={bug.key} field="fix_version"
          value={bug.fix_versions[0] || ''}
          options={versionOptions}
          saveState={saveState}
          onSave={onSave}
          placeholder="— version"
        />
      </td>

      {/* Sprint – editable */}
      <td className="px-2 py-2 w-36">
        <InlineSelect
          bugKey={bug.key} field="sprint"
          value={currentSprintVal}
          options={sprintOptions}
          saveState={saveState}
          onSave={onSave}
          placeholder="— sprint"
        />
      </td>

      {/* Assignee – editable */}
      <td className="px-2 py-2 w-36">
        <InlineSelect
          bugKey={bug.key} field="assignee"
          value={bug.assignee_id}
          options={assigneeOptions}
          saveState={saveState}
          onSave={onSave}
          placeholder="— unassigned"
        />
      </td>

      {/* Parent – editable */}
      <td className="px-2 py-2 w-40">
        <ParentCell
          bugKey={bug.key}
          parentKey={bug.parent_key}
          parentType={bug.parent_type}
          parentSummary={bug.parent_summary}
          saveState={saveState}
          onSave={onSave}
        />
      </td>

      {/* Created */}
      <td className="px-3 py-2 whitespace-nowrap text-xs text-slate-500">
        {fmtDate(bug.created)}
      </td>

      {/* Reporter */}
      <td className="px-3 py-2 whitespace-nowrap text-xs text-slate-600">
        {bug.reporter || '—'}
      </td>
    </tr>
  )
}

/* ── BugTriagePage ───────────────────────────────────────── */
export default function BugTriagePage() {
  const [mode,           setMode]          = useState('epic')       // 'epic' | 'date'
  const [selectedEpics,  setSelectedEpics] = useState([])
  const [days,           setDays]          = useState(14)
  const [creators,       setCreators]      = useState([])
  const [saveState,      setSaveState]     = useState({})           // { 'KEY:field': 'saving'|'saved'|'error'|'idle' }
  const [localBugs,      setLocalBugs]     = useState(null)         // optimistic updates
  const [priorityFilter, setPriorityFilter] = useState('')
  const [statusFilter,   setStatusFilter]  = useState('')

  /* ── meta query (fix versions, sprints, assignees, priorities) */
  const metaQuery = useQuery({
    queryKey: ['triage-meta'],
    queryFn: () => axios.get(`${API}/meta`).then(r => r.data),
    staleTime: 600_000,
  })
  const meta = metaQuery.data || { versions: [], priorities: [], sprints: [], assignees: [] }

  /* ── bug query */
  const epicParam   = mode === 'epic' ? selectedEpics.map(e => e.key).join(',') : ''
  const bugEnabled  = mode === 'epic' ? selectedEpics.length > 0 : true

  const bugQuery = useQuery({
    queryKey: ['triage-bugs', mode, epicParam, days, creators.join(',')],
    queryFn: ({ signal }) => {
      const params = mode === 'epic'
        ? { epic_keys: epicParam }
        : { days, creators: creators.join(',') || undefined }
      return axios.get(`${API}/bugs`, { params, signal }).then(r => r.data.bugs)
    },
    enabled: bugEnabled,
    staleTime: 60_000,
    onSuccess: data => setLocalBugs(data),
  })

  // Sync localBugs when fresh data arrives
  useEffect(() => {
    if (bugQuery.data) setLocalBugs(bugQuery.data)
  }, [bugQuery.data])

  /* ── save field ──────────────────────────────────────────── */
  const handleSave = useCallback(async (bugKey, field, value) => {
    const stateKey = `${bugKey}:${field}`
    setSaveState(prev => ({ ...prev, [stateKey]: 'saving' }))

    // Optimistic update
    setLocalBugs(prev => prev ? prev.map(b => {
      if (b.key !== bugKey) return b
      if (field === 'priority')    return { ...b, priority: value }
      if (field === 'fix_version') return { ...b, fix_versions: value ? [value] : [] }
      if (field === 'assignee') {
        const a = meta.assignees.find(x => x.id === value)
        return { ...b, assignee_id: value || '', assignee: a?.name || '' }
      }
      if (field === 'sprint') {
        const s = meta.sprints.find(x => String(x.id) === value)
        return { ...b, sprint_id: value ? Number(value) : null, sprint: s?.name || '' }
      }
      if (field === 'parent') return { ...b, parent_key: value || '' }
      return b
    }) : prev)

    try {
      await axios.patch(`${API}/${bugKey}`, { field, value: value || null })
      setSaveState(prev => ({ ...prev, [stateKey]: 'saved' }))
      setTimeout(() => setSaveState(prev => ({ ...prev, [stateKey]: 'idle' })), 2000)
    } catch {
      setSaveState(prev => ({ ...prev, [stateKey]: 'error' }))
      setTimeout(() => setSaveState(prev => ({ ...prev, [stateKey]: 'idle' })), 4000)
      bugQuery.refetch()
    }
  }, [meta, bugQuery])

  /* ── filtering ───────────────────────────────────────────── */
  const displayBugs = useMemo(() => {
    let list = localBugs || []
    if (priorityFilter) list = list.filter(b => b.priority === priorityFilter)
    if (statusFilter)   list = list.filter(b => b.status   === statusFilter)
    return list
  }, [localBugs, priorityFilter, statusFilter])

  const uniqueStatuses   = useMemo(() => [...new Set((localBugs || []).map(b => b.status).filter(Boolean))], [localBugs])
  const uniquePriorities = useMemo(() => [...new Set((localBugs || []).map(b => b.priority).filter(Boolean))], [localBugs])

  return (
    <div className="flex flex-col min-h-screen bg-slate-50">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 border-b border-slate-200 bg-white">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2.5">
              <Bug className="h-6 w-6 text-red-500" />
              Bug Priority Meeting
            </h1>
            <p className="text-sm text-slate-500 mt-1">Review and update bug priorities, versions, sprints and assignments in one place.</p>
          </div>
          <button
            onClick={() => bugQuery.refetch()}
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 border border-slate-300 rounded-lg px-3 py-1.5 bg-white hover:bg-slate-50 transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>

        {/* Mode tabs */}
        <div className="flex items-center gap-1 mt-4">
          <button
            onClick={() => setMode('epic')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${mode === 'epic' ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            <Search className="h-3.5 w-3.5" />
            By Epic
          </button>
          <button
            onClick={() => setMode('date')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${mode === 'date' ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            <Calendar className="h-3.5 w-3.5" />
            By Date
          </button>
        </div>
      </div>

      {/* Controls */}
      <div className="px-6 py-4 bg-white border-b border-slate-200">
        {mode === 'epic' ? (
          <EpicSearch
            selectedEpics={selectedEpics}
            onAdd={e => setSelectedEpics(prev => prev.find(x => x.key === e.key) ? prev : [...prev, e])}
            onRemove={k => setSelectedEpics(prev => prev.filter(e => e.key !== k))}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1">
              {[7, 14, 30].map(d => (
                <button
                  key={d}
                  onClick={() => setDays(d)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${days === d ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}
                >
                  Last {d}d
                </button>
              ))}
            </div>
            <CreatorMultiSelect days={days} selected={creators} onChange={setCreators} />
          </div>
        )}
      </div>

      {/* Table filters */}
      {(localBugs?.length > 0) && (
        <div className="px-6 py-3 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center gap-3">
          <span className="text-xs font-semibold text-slate-500">Filter:</span>

          <select
            value={priorityFilter}
            onChange={e => setPriorityFilter(e.target.value)}
            className="text-xs border border-slate-300 rounded-lg px-2 py-1.5 bg-white text-slate-700 outline-none"
          >
            <option value="">All priorities</option>
            {uniquePriorities.map(p => <option key={p} value={p}>{p}</option>)}
          </select>

          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="text-xs border border-slate-300 rounded-lg px-2 py-1.5 bg-white text-slate-700 outline-none"
          >
            <option value="">All statuses</option>
            {uniqueStatuses.map(s => <option key={s} value={s}>{s}</option>)}
          </select>

          <span className="text-xs text-slate-500 ml-auto">
            {displayBugs.length} / {localBugs.length} bugs
          </span>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 overflow-auto px-6 py-4">

        {/* Empty states */}
        {mode === 'epic' && selectedEpics.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-slate-400 space-y-3">
            <Bug className="h-12 w-12 opacity-25" />
            <p className="text-lg font-semibold">Select one or more Epics</p>
            <p className="text-sm text-center max-w-sm">Search for an Epic above to load its bugs for review.</p>
          </div>
        )}

        {/* Loading */}
        {bugQuery.isFetching && (
          <div className="flex items-center gap-2 text-sm text-slate-500 py-6">
            <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
            Loading bugs…
          </div>
        )}

        {/* Error */}
        {bugQuery.error && (
          <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700 my-4">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {bugQuery.error?.response?.data?.detail || 'Failed to load bugs'}
            <button onClick={() => bugQuery.refetch()} className="ml-auto underline">Retry</button>
          </div>
        )}

        {/* Bug table */}
        {!bugQuery.isFetching && displayBugs.length > 0 && (
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-slate-700 text-white text-xs font-semibold">
                    <th className="px-3 py-2.5 text-left whitespace-nowrap">Key</th>
                    <th className="px-3 py-2.5 text-left">Summary</th>
                    <th className="px-3 py-2.5 text-left whitespace-nowrap">Status</th>
                    <th className="px-2 py-2.5 text-left whitespace-nowrap">Priority</th>
                    <th className="px-2 py-2.5 text-left whitespace-nowrap">Fix Version</th>
                    <th className="px-2 py-2.5 text-left whitespace-nowrap">Sprint</th>
                    <th className="px-2 py-2.5 text-left whitespace-nowrap">Assignee</th>
                    <th className="px-2 py-2.5 text-left whitespace-nowrap">Parent</th>
                    <th className="px-3 py-2.5 text-left whitespace-nowrap">Created</th>
                    <th className="px-3 py-2.5 text-left whitespace-nowrap">Reporter</th>
                  </tr>
                </thead>
                <tbody>
                  {displayBugs.map(bug => (
                    <BugRow
                      key={bug.key}
                      bug={bug}
                      meta={meta}
                      saveState={saveState}
                      onSave={handleSave}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!bugQuery.isFetching && !bugQuery.error && displayBugs.length === 0 && (localBugs?.length ?? 0) > 0 && (
          <p className="text-sm text-slate-400 py-4">No bugs match the current filters.</p>
        )}

        {!bugQuery.isFetching && !bugQuery.error && (localBugs?.length === 0) && bugEnabled && (
          <p className="text-sm text-slate-400 py-4">No bugs found for the selected criteria.</p>
        )}
      </div>
    </div>
  )
}

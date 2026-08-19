import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import {
  Search, X, Loader2, AlertCircle, RefreshCw, ChevronDown,
  Bug, Calendar, Users, Tag, AlertTriangle, CheckCircle2, LayoutList,
} from 'lucide-react'
import { SummaryCard } from '../components/cards/SummaryCard'

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
  'In Review':         'bg-indigo-100 text-indigo-700',
  'Ready for Testing': 'bg-amber-100 text-amber-700',
  'Validation':        'bg-violet-100 text-violet-700',
  'Done':              'bg-green-100 text-green-700',
  'DONE':              'bg-green-100 text-green-700',
  'Closed':            'bg-green-100 text-green-700',
  'Reopened':          'bg-red-100 text-red-700',
  'Blocked':           'bg-red-100 text-red-700',
  'Known Issue':       'bg-yellow-100 text-yellow-700',
}

function StatusPill({ status }) {
  const cls = STATUS_PILL[status] || 'bg-slate-100 text-slate-600'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {status || '—'}
    </span>
  )
}

function AgeTag({ created }) {
  const days = Math.floor((Date.now() - new Date(created)) / 86400000)
  const cls = days > 30 ? 'text-red-600 font-bold' :
              days > 14 ? 'text-orange-500 font-semibold' :
              days > 7  ? 'text-amber-500' : 'text-slate-500'
  return <span className={`text-xs ${cls}`} title={fmtDate(created)}>{days}d</span>
}

/* ── Status toggle cards (same pattern as BugsByVersionPage) ── */
const STATUS_CFG = [
  { key: 'To Do',             label: 'To Do',             bg: 'bg-gray-50',   border: 'border-gray-300',   text: 'text-gray-700',   activeBg: 'bg-gray-600',   activeText: 'text-white' },
  { key: 'In Progress',       label: 'In Progress',       bg: 'bg-blue-50',   border: 'border-blue-300',   text: 'text-blue-700',   activeBg: 'bg-blue-600',   activeText: 'text-white' },
  { key: 'In Review',         label: 'In Review',         bg: 'bg-indigo-50', border: 'border-indigo-300', text: 'text-indigo-700', activeBg: 'bg-indigo-600', activeText: 'text-white' },
  { key: 'Ready for Testing', label: 'Ready for Testing', bg: 'bg-purple-50', border: 'border-purple-300', text: 'text-purple-700', activeBg: 'bg-purple-600', activeText: 'text-white' },
  { key: 'Validation',        label: 'Validation',        bg: 'bg-violet-50', border: 'border-violet-300', text: 'text-violet-700', activeBg: 'bg-violet-600', activeText: 'text-white' },
  { key: 'Reopened',          label: 'Reopened',          bg: 'bg-orange-50', border: 'border-orange-300', text: 'text-orange-700', activeBg: 'bg-orange-500', activeText: 'text-white' },
  { key: 'Known Issue',       label: 'Known Issue',       bg: 'bg-yellow-50', border: 'border-yellow-300', text: 'text-yellow-700', activeBg: 'bg-yellow-500', activeText: 'text-white' },
  { key: 'Blocked',           label: 'Blocked',           bg: 'bg-red-50',    border: 'border-red-300',    text: 'text-red-700',    activeBg: 'bg-red-600',    activeText: 'text-white' },
  { key: 'Done',              label: 'Done',              bg: 'bg-green-50',  border: 'border-green-300',  text: 'text-green-700',  activeBg: 'bg-green-600',  activeText: 'text-white' },
  { key: 'DONE',              label: 'Done',              bg: 'bg-green-50',  border: 'border-green-300',  text: 'text-green-700',  activeBg: 'bg-green-600',  activeText: 'text-white' },
]

function StatusToggle({ cfg, count, active, onClick }) {
  const { label, bg, border, text, activeBg, activeText } = cfg
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center justify-center px-4 py-3 rounded-xl border-2 font-medium transition-all duration-150 select-none min-w-[110px] ${
        active
          ? `${activeBg} ${activeText} border-transparent shadow-md scale-[1.03]`
          : `${bg} ${text} ${border} hover:shadow-sm hover:scale-[1.01] opacity-80 hover:opacity-100`
      }`}
    >
      <span className={`text-2xl font-bold leading-none ${active ? activeText : text}`}>{count}</span>
      <span className={`text-xs mt-1 leading-tight text-center ${active ? 'opacity-90' : 'opacity-75'}`}>{label}</span>
    </button>
  )
}

function MiniBar({ label, count, total, color = 'bg-blue-500' }) {
  const pct = total ? Math.round(count / total * 100) : 0
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-40 text-gray-600 truncate shrink-0">{label}</span>
      <div className="flex-1 bg-gray-100 rounded-full h-2">
        <div className={`${color} h-2 rounded-full`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right font-medium text-gray-700">{count}</span>
    </div>
  )
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
              <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} className="accent-indigo-600 h-4 w-4" />
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
      <td className="px-3 py-2 max-w-[220px]">
        <p className="text-sm text-slate-700 line-clamp-2" title={bug.summary}>{bug.summary}</p>
      </td>

      {/* Labels */}
      <td className="px-2 py-2 max-w-[180px]">
        <div className="flex flex-wrap gap-1">
          {(bug.labels || []).slice(0, 3).map(l => (
            <span key={l} className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-50 text-indigo-700 border border-indigo-200">{l}</span>
          ))}
          {(bug.labels || []).length > 3 && (
            <span className="text-[10px] text-slate-400">+{bug.labels.length - 3}</span>
          )}
          {(!bug.labels || bug.labels.length === 0) && <span className="text-slate-300 text-xs">—</span>}
        </div>
      </td>

      {/* Status */}
      <td className="px-3 py-2 whitespace-nowrap">
        <StatusPill status={bug.status} />
      </td>

      {/* Priority – editable */}
      <td className="px-2 py-2 w-28">
        <InlineSelect bugKey={bug.key} field="priority" value={bug.priority} options={priorityOptions} saveState={saveState} onSave={onSave} placeholder="—" />
        {bug.priority && (
          <span className={`block text-[10px] mt-0.5 pl-1 ${PRIORITY_COLORS[bug.priority] || 'text-slate-500'}`}>
            {bug.priority}
          </span>
        )}
      </td>

      {/* Fix Version – editable */}
      <td className="px-2 py-2 w-32">
        <InlineSelect bugKey={bug.key} field="fix_version" value={bug.fix_versions[0] || ''} options={versionOptions} saveState={saveState} onSave={onSave} placeholder="— version" />
      </td>

      {/* Sprint – editable */}
      <td className="px-2 py-2 w-36">
        <InlineSelect bugKey={bug.key} field="sprint" value={currentSprintVal} options={sprintOptions} saveState={saveState} onSave={onSave} placeholder="— sprint" />
      </td>

      {/* Assignee – editable */}
      <td className="px-2 py-2 w-36">
        <InlineSelect bugKey={bug.key} field="assignee" value={bug.assignee_id} options={assigneeOptions} saveState={saveState} onSave={onSave} placeholder="— unassigned" />
      </td>

      {/* Parent – editable */}
      <td className="px-2 py-2 w-40">
        <ParentCell bugKey={bug.key} parentKey={bug.parent_key} parentType={bug.parent_type} parentSummary={bug.parent_summary} saveState={saveState} onSave={onSave} />
      </td>

      {/* Age */}
      <td className="px-3 py-2 whitespace-nowrap">
        <AgeTag created={bug.created} />
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
  const [mode,           setMode]          = useState('epic')
  const [selectedEpics,  setSelectedEpics] = useState([])
  const [days,           setDays]          = useState(14)
  const [daysInput,      setDaysInput]     = useState('14')
  const [creators,       setCreators]      = useState([])
  const [saveState,      setSaveState]     = useState({})
  const [localBugs,      setLocalBugs]     = useState(null)
  const [activeStatuses, setActiveStatuses] = useState(new Set())
  const [labelFilter,    setLabelFilter]   = useState(new Set())
  const [priorityFilter, setPriorityFilter] = useState('')

  /* ── meta */
  const metaQuery = useQuery({
    queryKey: ['triage-meta'],
    queryFn: () => axios.get(`${API}/meta`).then(r => r.data),
    staleTime: 600_000,
  })
  const meta = metaQuery.data || { versions: [], priorities: [], sprints: [], assignees: [] }

  /* ── bug query */
  const epicParam  = mode === 'epic' ? selectedEpics.map(e => e.key).join(',') : ''
  const bugEnabled = mode === 'epic' ? selectedEpics.length > 0 : true

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
  })

  useEffect(() => {
    if (bugQuery.data) {
      setLocalBugs(bugQuery.data)
      setActiveStatuses(new Set())
      setLabelFilter(new Set())
      setPriorityFilter('')
    }
  }, [bugQuery.data])

  /* ── save field */
  const handleSave = useCallback(async (bugKey, field, value) => {
    const stateKey = `${bugKey}:${field}`
    setSaveState(prev => ({ ...prev, [stateKey]: 'saving' }))

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

  /* ── stats & filters from localBugs */
  const totalBugs = localBugs?.length ?? 0

  const countByStatus = useMemo(() => {
    const m = {}
    for (const b of localBugs || []) { const s = b.status || 'Unknown'; m[s] = (m[s] || 0) + 1 }
    return m
  }, [localBugs])

  const presentCfgs = useMemo(
    () => STATUS_CFG.filter(c => countByStatus[c.key] > 0),
    [countByStatus]
  )

  const byStatus = useMemo(() => {
    return Object.entries(countByStatus)
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => ({ status, count }))
  }, [countByStatus])

  const byPriority = useMemo(() => {
    const m = {}
    for (const b of localBugs || []) { const p = b.priority || 'None'; m[p] = (m[p] || 0) + 1 }
    const order = ['Highest', 'High', 'Medium', 'Low', 'Lowest', 'None']
    return order.filter(p => m[p]).map(p => ({ priority: p, count: m[p] }))
  }, [localBugs])

  const byReporter = useMemo(() => {
    const m = {}
    for (const b of localBugs || []) { const r = b.reporter || 'Unknown'; m[r] = (m[r] || 0) + 1 }
    return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([reporter, count]) => ({ reporter, count }))
  }, [localBugs])

  const allLabels = useMemo(() => {
    const s = new Set()
    for (const b of localBugs || []) { (b.labels || []).forEach(l => s.add(l)) }
    return [...s].sort()
  }, [localBugs])

  const uniquePriorities = useMemo(
    () => [...new Set((localBugs || []).map(b => b.priority).filter(Boolean))],
    [localBugs]
  )

  const openBugs      = useMemo(() => (localBugs || []).filter(b => !['Done', 'DONE', 'Closed'].includes(b.status)).length, [localBugs])
  const highCritical  = useMemo(() => (localBugs || []).filter(b => ['Highest', 'High'].includes(b.priority)).length, [localBugs])
  const isFiltered    = activeStatuses.size > 0 || labelFilter.size > 0 || !!priorityFilter

  const displayBugs = useMemo(() => {
    let list = localBugs || []
    if (activeStatuses.size > 0) list = list.filter(b => activeStatuses.has(b.status))
    if (labelFilter.size > 0)    list = list.filter(b => (b.labels || []).some(l => labelFilter.has(l)))
    if (priorityFilter)          list = list.filter(b => b.priority === priorityFilter)
    return list
  }, [localBugs, activeStatuses, labelFilter, priorityFilter])

  const toggleStatus = key => setActiveStatuses(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key); else next.add(key)
    return next
  })

  const toggleLabel = label => setLabelFilter(prev => {
    const next = new Set(prev)
    if (next.has(label)) next.delete(label); else next.add(label)
    return next
  })

  const applyDays = () => {
    const n = parseInt(daysInput, 10)
    if (!isNaN(n) && n > 0) setDays(n)
  }

  /* ── render ─────────────────────────────────────────────── */
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
            {/* Days presets */}
            <div className="flex items-center gap-1">
              {[7, 14, 30, 60].map(d => (
                <button
                  key={d}
                  onClick={() => { setDays(d); setDaysInput(String(d)) }}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${days === d && daysInput === String(d) ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}
                >
                  {d}d
                </button>
              ))}
            </div>

            {/* Custom days input */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-500 shrink-0">Custom:</span>
              <input
                type="number"
                min="1"
                max="365"
                value={daysInput}
                onChange={e => setDaysInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && applyDays()}
                className="w-16 text-sm border border-slate-300 rounded-lg px-2 py-1.5 outline-none focus:ring-2 focus:ring-indigo-300 text-center"
                placeholder="days"
              />
              <button
                onClick={applyDays}
                className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 transition-colors"
              >
                Apply
              </button>
              {days !== parseInt(daysInput, 10) && (
                <span className="text-xs text-slate-400">showing last {days}d</span>
              )}
            </div>

            {/* Reporter / Creator filter */}
            <CreatorMultiSelect days={days} selected={creators} onChange={setCreators} />
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-6 py-4 space-y-4">

        {/* Empty state – epic mode */}
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
          <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {bugQuery.error?.response?.data?.detail || 'Failed to load bugs'}
            <button onClick={() => bugQuery.refetch()} className="ml-auto underline">Retry</button>
          </div>
        )}

        {/* Results — shown once data is loaded */}
        {!bugQuery.isFetching && localBugs && (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-4 gap-4">
              <SummaryCard title="Total Bugs"      value={totalBugs}     icon={Bug}          color="red" />
              <SummaryCard title="Open Bugs"       value={openBugs}      icon={AlertTriangle} color="orange" />
              <SummaryCard title="High / Critical" value={highCritical}  icon={AlertTriangle} color="red" />
              <SummaryCard
                title={isFiltered ? 'Showing (filtered)' : 'Showing (all)'}
                value={displayBugs.length}
                icon={isFiltered ? CheckCircle2 : LayoutList}
                color={isFiltered ? 'blue' : 'green'}
              />
            </div>

            {/* Status filter toggles */}
            {presentCfgs.length > 0 && (
              <div className="card">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm font-semibold text-gray-700">
                    Filter by Status
                    <span className="ml-2 text-xs font-normal text-gray-400">— click one or more to combine</span>
                  </p>
                  {activeStatuses.size > 0 && (
                    <button onClick={() => setActiveStatuses(new Set())} className="text-xs text-brand-600 hover:text-brand-800 font-medium underline">
                      Show all ({totalBugs})
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-3">
                  {presentCfgs.map(cfg => (
                    <StatusToggle
                      key={cfg.key} cfg={cfg}
                      count={countByStatus[cfg.key] || 0}
                      active={activeStatuses.has(cfg.key)}
                      onClick={() => toggleStatus(cfg.key)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Charts: By Status + By Priority */}
            <div className="grid grid-cols-2 gap-4">
              {byStatus.length > 0 && (
                <div className="card">
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">By Status</h3>
                  <div className="space-y-2">
                    {byStatus.map(({ status, count }) => (
                      <MiniBar key={status} label={status} count={count} total={totalBugs}
                        color={
                          ['Done', 'DONE', 'Closed'].includes(status) ? 'bg-green-500' :
                          status === 'In Progress'       ? 'bg-blue-500'   :
                          status === 'In Review'         ? 'bg-indigo-500' :
                          status === 'Ready for Testing' ? 'bg-purple-500' :
                          status === 'Validation'        ? 'bg-violet-500' :
                          status === 'Blocked'           ? 'bg-red-500'    :
                          status === 'Reopened'          ? 'bg-orange-500' :
                          status === 'Known Issue'       ? 'bg-yellow-500' :
                          'bg-gray-400'
                        }
                      />
                    ))}
                  </div>
                </div>
              )}
              {byPriority.length > 0 && (
                <div className="card">
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">By Priority</h3>
                  <div className="space-y-2">
                    {byPriority.map(({ priority, count }) => (
                      <MiniBar key={priority} label={priority} count={count} total={totalBugs}
                        color={
                          priority === 'Highest'                  ? 'bg-red-600'    :
                          priority === 'High'                     ? 'bg-orange-500' :
                          priority === 'Medium'                   ? 'bg-yellow-500' :
                          priority === 'Low' || priority === 'Lowest' ? 'bg-green-400' :
                          'bg-gray-300'
                        }
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* By Reporter */}
            {byReporter.length > 0 && (
              <div className="card">
                <h3 className="text-sm font-semibold text-gray-700 mb-3">By Reporter</h3>
                <div className="flex flex-wrap gap-3">
                  {byReporter.map(({ reporter, count }) => (
                    <div key={reporter} className="bg-red-50 border border-red-100 rounded-lg px-4 py-3 text-center min-w-[90px]">
                      <p className="text-2xl font-bold text-red-600">{count}</p>
                      <p className="text-xs text-gray-600 mt-1">{reporter}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Label + Priority filter bar */}
            {(allLabels.length > 0 || uniquePriorities.length > 0) && (
              <div className="card">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-xs font-semibold text-slate-500 shrink-0">Filter:</span>

                  {allLabels.length > 0 && (
                    <div className="flex items-center gap-2">
                      <Tag className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                      <span className="text-xs text-slate-500 shrink-0">Labels:</span>
                      <div className="flex flex-wrap gap-1">
                        {allLabels.map(l => (
                          <button
                            key={l}
                            onClick={() => toggleLabel(l)}
                            className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium border transition-all ${
                              labelFilter.has(l)
                                ? 'bg-indigo-600 text-white border-indigo-600'
                                : 'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100'
                            }`}
                          >
                            {l}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {uniquePriorities.length > 0 && (
                    <select
                      value={priorityFilter}
                      onChange={e => setPriorityFilter(e.target.value)}
                      className="text-xs border border-slate-300 rounded-lg px-2 py-1.5 bg-white text-slate-700 outline-none"
                    >
                      <option value="">All priorities</option>
                      {uniquePriorities.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>
                  )}

                  {isFiltered && (
                    <button
                      onClick={() => { setActiveStatuses(new Set()); setLabelFilter(new Set()); setPriorityFilter('') }}
                      className="text-xs text-indigo-600 hover:underline ml-auto"
                    >
                      Clear all filters — showing {displayBugs.length} of {totalBugs}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Bug table */}
            {displayBugs.length > 0 ? (
              <div className="card p-0 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
                  <p className="text-sm font-semibold text-gray-700">
                    {isFiltered
                      ? `Bugs — filtered`
                      : mode === 'date'
                        ? `Bugs opened in last ${days} days`
                        : `Bugs by Epic`
                    }
                  </p>
                  <span className="text-xs text-gray-400">{displayBugs.length} bug{displayBugs.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="bg-slate-700 text-white text-xs font-semibold">
                        <th className="px-3 py-2.5 text-left whitespace-nowrap">Key</th>
                        <th className="px-3 py-2.5 text-left">Summary</th>
                        <th className="px-2 py-2.5 text-left whitespace-nowrap">Labels</th>
                        <th className="px-3 py-2.5 text-left whitespace-nowrap">Status</th>
                        <th className="px-2 py-2.5 text-left whitespace-nowrap">Priority</th>
                        <th className="px-2 py-2.5 text-left whitespace-nowrap">Fix Version</th>
                        <th className="px-2 py-2.5 text-left whitespace-nowrap">Sprint</th>
                        <th className="px-2 py-2.5 text-left whitespace-nowrap">Assignee</th>
                        <th className="px-2 py-2.5 text-left whitespace-nowrap">Parent</th>
                        <th className="px-3 py-2.5 text-left whitespace-nowrap">Age</th>
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
            ) : (
              <p className="text-sm text-slate-400 py-4">No bugs match the current filters.</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

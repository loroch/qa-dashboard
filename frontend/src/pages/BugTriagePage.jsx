import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { BASE_URL } from '../services/api'
import {
  Search, X, Loader2, AlertCircle, RefreshCw, ChevronDown,
  Bug, Calendar, Users, Tag, AlertTriangle, CheckCircle2, LayoutList, ClipboardList, UserX, ChevronUp,
} from 'lucide-react'
import { SummaryCard } from '../components/cards/SummaryCard'

const API = `${BASE_URL}/bug-triage`

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

/* ── Status config — exhaustive list matching Jira workflow statuses ── */
const STATUS_CFG = [
  { key: 'To Do',                label: 'To Do',                bg: 'bg-gray-50',   border: 'border-gray-300',   text: 'text-gray-700',   activeBg: 'bg-gray-600',   activeText: 'text-white' },
  { key: 'ToDo',                 label: 'To Do',                bg: 'bg-gray-50',   border: 'border-gray-300',   text: 'text-gray-700',   activeBg: 'bg-gray-600',   activeText: 'text-white' },
  { key: 'Open',                 label: 'Open',                 bg: 'bg-gray-50',   border: 'border-gray-300',   text: 'text-gray-700',   activeBg: 'bg-gray-600',   activeText: 'text-white' },
  { key: 'In Progress',          label: 'In Progress',          bg: 'bg-blue-50',   border: 'border-blue-300',   text: 'text-blue-700',   activeBg: 'bg-blue-600',   activeText: 'text-white' },
  { key: 'In Review',            label: 'In Review',            bg: 'bg-indigo-50', border: 'border-indigo-300', text: 'text-indigo-700', activeBg: 'bg-indigo-600', activeText: 'text-white' },
  { key: 'Ready for Testing',    label: 'Ready for Testing',    bg: 'bg-purple-50', border: 'border-purple-300', text: 'text-purple-700', activeBg: 'bg-purple-600', activeText: 'text-white' },
  { key: 'Validation',           label: 'Validation',           bg: 'bg-violet-50', border: 'border-violet-300', text: 'text-violet-700', activeBg: 'bg-violet-600', activeText: 'text-white' },
  { key: 'Ready For Deployment', label: 'Ready for Deployment', bg: 'bg-teal-50',   border: 'border-teal-300',   text: 'text-teal-700',   activeBg: 'bg-teal-600',   activeText: 'text-white' },
  { key: 'Ready for Deployment', label: 'Ready for Deployment', bg: 'bg-teal-50',   border: 'border-teal-300',   text: 'text-teal-700',   activeBg: 'bg-teal-600',   activeText: 'text-white' },
  { key: 'Monitoring',           label: 'Monitoring',           bg: 'bg-cyan-50',   border: 'border-cyan-300',   text: 'text-cyan-700',   activeBg: 'bg-cyan-600',   activeText: 'text-white' },
  { key: 'Done',                 label: 'Done',                 bg: 'bg-green-50',  border: 'border-green-300',  text: 'text-green-700',  activeBg: 'bg-green-600',  activeText: 'text-white' },
  { key: 'DONE',                 label: 'Done',                 bg: 'bg-green-50',  border: 'border-green-300',  text: 'text-green-700',  activeBg: 'bg-green-600',  activeText: 'text-white' },
  { key: 'Closed',               label: 'Closed',               bg: 'bg-green-50',  border: 'border-green-300',  text: 'text-green-700',  activeBg: 'bg-green-600',  activeText: 'text-white' },
  { key: 'Reopened',             label: 'Reopened',             bg: 'bg-orange-50', border: 'border-orange-300', text: 'text-orange-700', activeBg: 'bg-orange-500', activeText: 'text-white' },
  { key: 'Known Issue',          label: 'Known Issue',          bg: 'bg-yellow-50', border: 'border-yellow-300', text: 'text-yellow-700', activeBg: 'bg-yellow-500', activeText: 'text-white' },
  { key: 'Blocked',              label: 'Blocked',              bg: 'bg-red-50',    border: 'border-red-300',    text: 'text-red-700',    activeBg: 'bg-red-600',    activeText: 'text-white' },
  { key: 'Removed',              label: 'Removed',              bg: 'bg-gray-50',   border: 'border-gray-200',   text: 'text-gray-400',   activeBg: 'bg-gray-400',   activeText: 'text-white' },
]

const STATUS_CFG_MAP = Object.fromEntries(STATUS_CFG.map(c => [c.key, c]))
const STATUS_CFG_DEFAULT = {
  bg: 'bg-slate-50', border: 'border-slate-200', text: 'text-slate-600',
  activeBg: 'bg-slate-500', activeText: 'text-white',
}

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

/* ── TodoBugsPanel ───────────────────────────────────────── */
function TodoBugsPanel({ query, localBugs: localBugsProp, meta, saveState, onSave }) {
  const [search,          setSearch]          = useState('')
  const [filterVersion,   setFilterVersion]   = useState('')
  const [filterSprint,    setFilterSprint]    = useState('')
  const [filterReporter,  setFilterReporter]  = useState('')
  const [filterAssignee,  setFilterAssignee]  = useState('')
  const [filterMissing,   setFilterMissing]   = useState(false)
  const [sortField, setSortField] = useState('created')
  const [sortDir, setSortDir]     = useState('asc')

  const PRIORITY_ORDER = { Highest: 1, High: 2, Medium: 3, Low: 4, Lowest: 5 }

  const bugs = localBugsProp || query.data || []

  const filtered = useMemo(() => {
    let list = bugs
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(b =>
        b.key?.toLowerCase().includes(q) ||
        b.summary?.toLowerCase().includes(q) ||
        b.reporter?.toLowerCase().includes(q) ||
        b.parent_key?.toLowerCase().includes(q) ||
        (b.labels || []).some(l => l.toLowerCase().includes(q))
      )
    }
    if (filterVersion)  list = list.filter(b => (b.fix_versions || []).includes(filterVersion))
    if (filterSprint)   list = list.filter(b => b.sprint_id ? String(b.sprint_id) === filterSprint : filterSprint === '__none__')
    if (filterReporter) list = list.filter(b => b.reporter === filterReporter)
    if (filterAssignee === '__unassigned__') list = list.filter(b => !b.assignee_id)
    else if (filterAssignee) list = list.filter(b => b.assignee_id === filterAssignee)
    if (filterMissing)  list = list.filter(b => !b.parent_key || !b.fix_versions?.length || !b.assignee)
    return [...list].sort((a, b) => {
      let av, bv
      if (sortField === 'created' || sortField === 'age') {
        av = new Date(a.created).getTime()
        bv = new Date(b.created).getTime()
      } else if (sortField === 'priority') {
        av = PRIORITY_ORDER[a.priority] ?? 99
        bv = PRIORITY_ORDER[b.priority] ?? 99
      } else if (sortField === 'fix_version') {
        av = (a.fix_versions?.[0] || '').toLowerCase()
        bv = (b.fix_versions?.[0] || '').toLowerCase()
      } else {
        av = (a[sortField] || '').toString().toLowerCase()
        bv = (b[sortField] || '').toString().toLowerCase()
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
  }, [bugs, search, filterVersion, filterSprint, filterReporter, filterAssignee, filterMissing, sortField, sortDir])

  const toggleSort = (field) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(field); setSortDir('asc') }
  }

  const SortIcon = ({ field }) =>
    sortField !== field ? <span className="opacity-30 text-[10px]">↕</span>
    : <span className="text-[10px]">{sortDir === 'asc' ? '↑' : '↓'}</span>

  const Th = ({ label, field }) => (
    <th
      onClick={() => toggleSort(field)}
      className="px-3 py-2.5 text-left whitespace-nowrap cursor-pointer select-none hover:bg-red-800 transition-colors"
    >
      <span className="inline-flex items-center gap-1">{label} <SortIcon field={field} /></span>
    </th>
  )

  const versionOptions  = meta.versions.map(v => ({ value: v.name, label: v.name }))
  const sprintOptions   = meta.sprints.map(s => ({ value: String(s.id), label: s.name }))
  const assigneeOptions = meta.assignees.map(a => ({ value: a.id, label: a.name }))

  const reporterOptions = useMemo(() => {
    const seen = new Map()
    bugs.forEach(b => { if (b.reporter) seen.set(b.reporter, b.reporter) })
    return [...seen.entries()].map(([v, l]) => ({ value: v, label: l })).sort((a,b) => a.label.localeCompare(b.label))
  }, [bugs])

  const activeFilterCount = [filterVersion, filterSprint, filterReporter, filterAssignee].filter(Boolean).length + (filterMissing ? 1 : 0)

  const missingCount = bugs.filter(b => !b.parent_key || !b.fix_versions?.length || !b.assignee).length

  return (
    <div className="space-y-4">
      {/* Header stats */}
      <div className="grid grid-cols-3 gap-4">
        <SummaryCard title="Total To Do Bugs" value={query.isFetching ? '…' : bugs.length} icon={Bug} color="red" />
        <SummaryCard title="Missing Info (red)" value={query.isFetching ? '…' : missingCount} icon={AlertTriangle} color="orange" />
        <SummaryCard title="Shown (filtered)" value={query.isFetching ? '…' : filtered.length} icon={LayoutList} color="blue" />
      </div>

      {/* Loading */}
      {query.isFetching && (
        <div className="flex items-center gap-2 text-sm text-slate-500 py-6">
          <Loader2 className="h-4 w-4 animate-spin text-red-500" />
          Loading To Do bugs…
        </div>
      )}

      {query.error && (
        <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {query.error?.response?.data?.detail || 'Failed to load bugs'}
          <button onClick={() => query.refetch()} className="ml-auto underline">Retry</button>
        </div>
      )}

      {!query.isFetching && query.data && (
        <div className="card p-0 overflow-hidden">
          {/* Table toolbar */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
            <div className="flex items-center gap-2">
              <p className="text-sm font-semibold text-gray-700">TMT0 — To Do Bugs</p>
              <span className="text-xs bg-red-100 text-red-700 font-medium px-2 py-0.5 rounded-full">{bugs.length}</span>
              {missingCount > 0 && (
                <span className="text-xs bg-orange-100 text-orange-700 font-medium px-2 py-0.5 rounded-full">
                  {missingCount} missing info
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Search className="h-3.5 w-3.5 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search…"
                className="text-xs border border-slate-300 rounded-lg px-2 py-1.5 bg-white outline-none focus:ring-2 focus:ring-red-300 w-44"
              />
              {search && <button onClick={() => setSearch('')}><X className="h-3.5 w-3.5 text-slate-400 hover:text-slate-600" /></button>}
              <button
                onClick={() => query.refetch()}
                className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 border border-slate-300 rounded px-2 py-1.5"
              >
                <RefreshCw className="h-3 w-3" /> Refresh
              </button>
            </div>
          </div>

          {/* Filter bar */}
          <div className="px-4 py-2.5 border-b border-slate-200 bg-slate-50 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-slate-500 shrink-0">Filter:</span>

            <select value={filterVersion} onChange={e => setFilterVersion(e.target.value)}
              className="text-xs border border-slate-300 rounded px-2 py-1 bg-white outline-none focus:ring-2 focus:ring-red-300 max-w-[140px]">
              <option value="">All Versions</option>
              {versionOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>

            <select value={filterSprint} onChange={e => setFilterSprint(e.target.value)}
              className="text-xs border border-slate-300 rounded px-2 py-1 bg-white outline-none focus:ring-2 focus:ring-red-300 max-w-[160px]">
              <option value="">All Sprints</option>
              {sprintOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>

            <select value={filterReporter} onChange={e => setFilterReporter(e.target.value)}
              className="text-xs border border-slate-300 rounded px-2 py-1 bg-white outline-none focus:ring-2 focus:ring-red-300 max-w-[140px]">
              <option value="">All Reporters</option>
              {reporterOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>

            <select value={filterAssignee} onChange={e => setFilterAssignee(e.target.value)}
              className="text-xs border border-slate-300 rounded px-2 py-1 bg-white outline-none focus:ring-2 focus:ring-red-300 max-w-[140px]">
              <option value="">All Assignees</option>
              <option value="__unassigned__">— Unassigned</option>
              {assigneeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>

            <label className="flex items-center gap-1.5 text-xs text-red-700 cursor-pointer select-none">
              <input type="checkbox" checked={filterMissing} onChange={e => setFilterMissing(e.target.checked)}
                className="accent-red-600 w-3.5 h-3.5" />
              Missing info only
            </label>

            {activeFilterCount > 0 && (
              <button
                onClick={() => { setFilterVersion(''); setFilterSprint(''); setFilterReporter(''); setFilterAssignee(''); setFilterMissing(false) }}
                className="ml-auto text-xs text-red-500 hover:text-red-700 underline flex items-center gap-1"
              >
                <X className="h-3 w-3" /> Clear filters ({activeFilterCount})
              </button>
            )}
          </div>

          {/* Legend */}
          <div className="px-4 py-2 bg-red-50 border-b border-red-100 text-xs text-red-600 flex items-center gap-1.5">
            <span className="inline-block w-3 h-3 bg-red-200 border border-red-400 rounded-sm" />
            Row highlighted red = missing parent, fix version, or assignee
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-red-700 text-white text-xs font-semibold">
                  <Th label="Bug #"       field="key" />
                  <Th label="Description" field="summary" />
                  <Th label="Parent"      field="parent_key" />
                  <Th label="Fix Version" field="fix_version" />
                  <Th label="Sprint"      field="sprint" />
                  <Th label="Age"         field="age" />
                  <Th label="Reporter"    field="reporter" />
                  <th className="px-2 py-2.5 text-left whitespace-nowrap">Labels</th>
                  <Th label="Assign To"   field="assignee" />
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={9} className="text-center py-8 text-slate-400 text-sm">No bugs match.</td></tr>
                )}
                {filtered.map(bug => {
                  const missingInfo = !bug.parent_key || !bug.fix_versions?.length || !bug.assignee
                  const rowCls = missingInfo
                    ? 'bg-red-50 border-b border-red-100 hover:bg-red-100 transition-colors'
                    : 'border-b border-slate-100 hover:bg-slate-50 transition-colors'
                  const days = Math.floor((Date.now() - new Date(bug.created)) / 86400000)
                  const ageCls = days > 30 ? 'text-red-600 font-bold' : days > 14 ? 'text-orange-500 font-semibold' : days > 7 ? 'text-amber-500' : 'text-slate-500'
                  return (
                    <tr key={bug.key} className={rowCls}>
                      {/* Bug # */}
                      <td className="px-3 py-2 whitespace-nowrap">
                        <a href={bug.url} target="_blank" rel="noreferrer" className="font-mono text-xs text-indigo-600 hover:underline font-medium">
                          {bug.key}
                        </a>
                      </td>
                      {/* Description */}
                      <td className="px-3 py-2 max-w-[220px]">
                        <p className="text-sm text-slate-700 line-clamp-2" title={bug.summary}>{bug.summary}</p>
                      </td>
                      {/* Parent */}
                      <td className="px-2 py-2 w-40">
                        <ParentCell bugKey={bug.key} parentKey={bug.parent_key} parentType={bug.parent_type} parentSummary={bug.parent_summary} saveState={saveState} onSave={onSave} />
                      </td>
                      {/* Fix Version */}
                      <td className="px-2 py-2 w-32">
                        <InlineSelect bugKey={bug.key} field="fix_version" value={bug.fix_versions?.[0] || ''} options={versionOptions} saveState={saveState} onSave={onSave} placeholder="— version" />
                        {!bug.fix_versions?.length && <span className="text-[10px] text-red-500 pl-1">missing</span>}
                      </td>
                      {/* Sprint */}
                      <td className="px-2 py-2 w-36">
                        <InlineSelect bugKey={bug.key} field="sprint" value={bug.sprint_id ? String(bug.sprint_id) : ''} options={sprintOptions} saveState={saveState} onSave={onSave} placeholder="— sprint" />
                      </td>
                      {/* Age */}
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className={`text-xs ${ageCls}`}>{days}d</span>
                      </td>
                      {/* Reporter */}
                      <td className="px-3 py-2 whitespace-nowrap text-xs text-slate-600">{bug.reporter || '—'}</td>
                      {/* Labels */}
                      <td className="px-2 py-2 max-w-[160px]">
                        <div className="flex flex-wrap gap-1">
                          {(bug.labels || []).slice(0, 3).map(l => (
                            <span key={l} className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium bg-indigo-50 text-indigo-700 border border-indigo-200">{l}</span>
                          ))}
                          {(bug.labels || []).length > 3 && <span className="text-[10px] text-slate-400">+{bug.labels.length - 3}</span>}
                          {(!bug.labels || bug.labels.length === 0) && <span className="text-slate-300 text-xs">—</span>}
                        </div>
                      </td>
                      {/* Assign To */}
                      <td className="px-2 py-2 w-36">
                        <InlineSelect bugKey={bug.key} field="assignee" value={bug.assignee_id} options={assigneeOptions} saveState={saveState} onSave={onSave} placeholder="— unassigned" />
                        {!bug.assignee && <span className="text-[10px] text-red-500 pl-1">missing</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── QAMisassignedPanel ──────────────────────────────────── */
function QAMisassignedPanel({ query, localBugs: localBugsProp, meta, saveState, onSave, qaTeam, onQaTeamChange }) {
  const [configOpen,      setConfigOpen]      = useState(qaTeam.length === 0)
  const [search,          setSearch]          = useState('')
  const [filterStatuses,  setFilterStatuses]  = useState(new Set())
  const [filterTypes,     setFilterTypes]     = useState(new Set())
  const [filterAssignee,  setFilterAssignee]  = useState('')
  const [sortField,       setSortField]       = useState('created')
  const [sortDir,         setSortDir]         = useState('asc')

  const PRIORITY_ORDER = { Highest: 1, High: 2, Medium: 3, Low: 4, Lowest: 5 }

  const bugs = localBugsProp || query.data || []

  const statusOptions = useMemo(() => {
    const seen = new Set()
    bugs.forEach(b => { if (b.status) seen.add(b.status) })
    return [...seen].sort()
  }, [bugs])

  const typeOptions = useMemo(() => {
    const seen = new Set()
    bugs.forEach(b => { if (b.issue_type) seen.add(b.issue_type) })
    return [...seen].sort()
  }, [bugs])

  const assigneeOptions = useMemo(() => {
    const seen = new Map()
    bugs.forEach(b => { if (b.assignee && b.assignee_id) seen.set(b.assignee_id, b.assignee) })
    return [...seen.entries()].map(([id, name]) => ({ value: id, label: name })).sort((a, b) => a.label.localeCompare(b.label))
  }, [bugs])

  const filtered = useMemo(() => {
    let list = bugs
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(b =>
        b.key?.toLowerCase().includes(q) ||
        b.summary?.toLowerCase().includes(q) ||
        b.assignee?.toLowerCase().includes(q) ||
        b.issue_type?.toLowerCase().includes(q) ||
        b.parent_key?.toLowerCase().includes(q)
      )
    }
    if (filterStatuses.size > 0) list = list.filter(b => filterStatuses.has(b.status))
    if (filterTypes.size > 0)    list = list.filter(b => filterTypes.has(b.issue_type))
    if (filterAssignee) list = list.filter(b => b.assignee_id === filterAssignee)
    return [...list].sort((a, b) => {
      let av, bv
      if (sortField === 'created' || sortField === 'age') {
        av = new Date(a.created).getTime(); bv = new Date(b.created).getTime()
      } else if (sortField === 'priority') {
        av = PRIORITY_ORDER[a.priority] ?? 99; bv = PRIORITY_ORDER[b.priority] ?? 99
      } else {
        av = (a[sortField] || '').toString().toLowerCase()
        bv = (b[sortField] || '').toString().toLowerCase()
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
  }, [bugs, search, filterStatuses, filterTypes, filterAssignee, sortField, sortDir])

  const toggleSort = (field) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(field); setSortDir('asc') }
  }
  const SortIcon = ({ field }) =>
    sortField !== field ? <span className="opacity-30 text-[10px]">↕</span>
    : <span className="text-[10px]">{sortDir === 'asc' ? '↑' : '↓'}</span>
  const Th = ({ label, field }) => (
    <th onClick={() => toggleSort(field)}
      className="px-3 py-2.5 text-left whitespace-nowrap cursor-pointer select-none hover:bg-amber-800 transition-colors">
      <span className="inline-flex items-center gap-1">{label} <SortIcon field={field} /></span>
    </th>
  )

  const assigneeSelectOptions = meta.assignees.map(a => ({ value: a.id, label: a.name }))

  const TYPE_PILL = {
    Bug:   'bg-red-100 text-red-700',
    Story: 'bg-blue-100 text-blue-700',
    Task:  'bg-slate-100 text-slate-600',
    Epic:  'bg-purple-100 text-purple-700',
  }

  return (
    <div className="space-y-4">
      {/* QA Team Configurator */}
      <div className="card">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-amber-600" />
            <span className="text-sm font-semibold text-gray-800">QA Team Members</span>
            {qaTeam.length > 0 && (
              <div className="flex flex-wrap gap-1.5 ml-2">
                {qaTeam.map(id => {
                  const a = meta.assignees.find(x => x.id === id)
                  return (
                    <span key={id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-800 border border-amber-200">
                      {a?.name || id}
                      <button onClick={() => onQaTeamChange(qaTeam.filter(x => x !== id))} className="hover:text-red-600 ml-0.5">×</button>
                    </span>
                  )
                })}
              </div>
            )}
          </div>
          <button onClick={() => setConfigOpen(o => !o)}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 border border-slate-300 rounded px-2 py-1">
            {configOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {configOpen ? 'Done' : 'Configure'}
          </button>
        </div>

        {configOpen && (
          <div className="mt-3 grid grid-cols-3 gap-x-6 gap-y-2">
            {meta.assignees.map(a => (
              <label key={a.id} className="flex items-center gap-2 text-sm cursor-pointer select-none hover:text-amber-700">
                <input type="checkbox" checked={qaTeam.includes(a.id)}
                  onChange={e => onQaTeamChange(e.target.checked ? [...qaTeam, a.id] : qaTeam.filter(x => x !== a.id))}
                  className="accent-amber-600 w-3.5 h-3.5" />
                {a.name}
              </label>
            ))}
          </div>
        )}

        {qaTeam.length === 0 && !configOpen && (
          <p className="mt-2 text-xs text-slate-400">No QA team members selected. Click Configure to pick them.</p>
        )}
      </div>

      {qaTeam.length === 0 ? (
        <div className="card flex flex-col items-center py-12 text-slate-400">
          <UserX className="h-10 w-10 mb-3 text-amber-300" />
          <p className="text-sm font-medium">Select QA team members above to find wrong assignments</p>
        </div>
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-3 gap-4">
            <SummaryCard title="Wrong Assignments" value={query.isFetching ? '…' : bugs.length} icon={UserX} color="orange" />
            <SummaryCard title="Assignees Affected" value={query.isFetching ? '…' : assigneeOptions.length} icon={Users} color="orange" />
            <SummaryCard title="Shown (filtered)" value={query.isFetching ? '…' : filtered.length} icon={LayoutList} color="blue" />
          </div>

          {query.isFetching && (
            <div className="flex items-center gap-2 text-sm text-slate-500 py-6">
              <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
              Checking assignments…
            </div>
          )}
          {query.error && (
            <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {query.error?.response?.data?.detail || 'Failed to load data'}
              <button onClick={() => query.refetch()} className="ml-auto underline">Retry</button>
            </div>
          )}

          {!query.isFetching && query.data !== undefined && (
            <div className="card p-0 overflow-hidden">
              {/* Toolbar */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-gray-700">Wrong Assignments</p>
                  <span className="text-xs bg-amber-100 text-amber-700 font-medium px-2 py-0.5 rounded-full">{bugs.length}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Search className="h-3.5 w-3.5 text-slate-400" />
                  <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…"
                    className="text-xs border border-slate-300 rounded-lg px-2 py-1.5 bg-white outline-none focus:ring-2 focus:ring-amber-300 w-44" />
                  {search && <button onClick={() => setSearch('')}><X className="h-3.5 w-3.5 text-slate-400 hover:text-slate-600" /></button>}
                  <button onClick={() => query.refetch()}
                    className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 border border-slate-300 rounded px-2 py-1.5">
                    <RefreshCw className="h-3 w-3" /> Refresh
                  </button>
                </div>
              </div>

              {/* Filter bar */}
              <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 space-y-2.5">
                {/* Status checklist */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  <span className="text-xs font-semibold text-slate-500 shrink-0 w-14">Status:</span>
                  {statusOptions.map(s => {
                    const checked = filterStatuses.has(s)
                    const pill = STATUS_PILL[s] || 'bg-slate-100 text-slate-600'
                    return (
                      <label key={s} className="flex items-center gap-1.5 cursor-pointer select-none group">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => setFilterStatuses(prev => {
                            const next = new Set(prev)
                            next.has(s) ? next.delete(s) : next.add(s)
                            return next
                          })}
                          className="accent-amber-600 w-3.5 h-3.5"
                        />
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium transition-opacity ${pill} ${checked ? 'opacity-100' : 'opacity-60 group-hover:opacity-90'}`}>
                          {s}
                        </span>
                      </label>
                    )
                  })}
                  {filterStatuses.size > 0 && (
                    <button onClick={() => setFilterStatuses(new Set())}
                      className="text-xs text-amber-600 hover:text-amber-800 underline ml-1">
                      clear
                    </button>
                  )}
                </div>

                {/* Type checklist */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  <span className="text-xs font-semibold text-slate-500 shrink-0 w-14">Type:</span>
                  {typeOptions.map(t => {
                    const checked = filterTypes.has(t)
                    const pill = TYPE_PILL[t] || 'bg-slate-100 text-slate-600'
                    return (
                      <label key={t} className="flex items-center gap-1.5 cursor-pointer select-none group">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => setFilterTypes(prev => {
                            const next = new Set(prev)
                            next.has(t) ? next.delete(t) : next.add(t)
                            return next
                          })}
                          className="accent-amber-600 w-3.5 h-3.5"
                        />
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium transition-opacity ${pill} ${checked ? 'opacity-100' : 'opacity-60 group-hover:opacity-90'}`}>
                          {t}
                        </span>
                      </label>
                    )
                  })}
                  {filterTypes.size > 0 && (
                    <button onClick={() => setFilterTypes(new Set())}
                      className="text-xs text-amber-600 hover:text-amber-800 underline ml-1">
                      clear
                    </button>
                  )}
                </div>

                {/* Assignee + clear row */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-slate-500 shrink-0 w-14">Assignee:</span>
                  <select value={filterAssignee} onChange={e => setFilterAssignee(e.target.value)}
                    className="text-xs border border-slate-300 rounded px-2 py-1 bg-white outline-none focus:ring-2 focus:ring-amber-300 max-w-[180px]">
                    <option value="">All QA Assignees</option>
                    {assigneeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  {filterAssignee && (
                    <button onClick={() => setFilterAssignee('')}
                      className="text-xs text-amber-600 hover:text-amber-800 underline">
                      clear
                    </button>
                  )}
                </div>
              </div>

              {/* Legend */}
              <div className="px-4 py-2 bg-amber-50 border-b border-amber-100 text-xs text-amber-700 flex items-center gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5" />
                These issues are assigned to QA team members but are in a pre-QA status (To Do, In Progress, In Review, Ready for Deployment, Validation, etc.)
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-sm border-collapse">
                  <thead>
                    <tr className="bg-amber-700 text-white text-xs font-semibold">
                      <Th label="Issue #"      field="key" />
                      <Th label="Type"         field="issue_type" />
                      <Th label="Status"       field="status" />
                      <Th label="Description"  field="summary" />
                      <Th label="Parent"       field="parent_key" />
                      <Th label="Parent Name"  field="parent_summary" />
                      <Th label="Fix Version"  field="fix_version" />
                      <Th label="Sprint"       field="sprint" />
                      <Th label="Age"          field="age" />
                      <Th label="Reporter"     field="reporter" />
                      <Th label="Assignee"     field="assignee" />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 && (
                      <tr><td colSpan={11} className="text-center py-8 text-slate-400 text-sm">
                        {bugs.length === 0 ? '✓ No wrong assignments found' : 'No results match your filters.'}
                      </td></tr>
                    )}
                    {filtered.map(bug => {
                      const days = Math.floor((Date.now() - new Date(bug.created)) / 86400000)
                      const ageCls = days > 30 ? 'text-red-600 font-bold' : days > 14 ? 'text-orange-500 font-semibold' : days > 7 ? 'text-amber-500' : 'text-slate-500'
                      const typePill = TYPE_PILL[bug.issue_type] || 'bg-slate-100 text-slate-600'
                      const stKey = `${bug.key}:saving`
                      return (
                        <tr key={bug.key} className="border-b border-amber-50 bg-amber-25 hover:bg-amber-50 transition-colors" style={{ background: '#fffdf5' }}>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <a href={bug.url} target="_blank" rel="noreferrer" className="font-mono text-xs text-indigo-600 hover:underline font-medium">{bug.key}</a>
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <span className={`inline-flex px-1.5 py-0.5 rounded text-[10px] font-medium ${typePill}`}>{bug.issue_type || '—'}</span>
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <StatusPill status={bug.status} />
                          </td>
                          <td className="px-3 py-2 max-w-[220px]">
                            <p className="text-sm text-slate-700 line-clamp-2" title={bug.summary}>{bug.summary}</p>
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap">
                            {bug.parent_key
                              ? <span className="inline-flex items-center gap-1 text-xs bg-indigo-50 text-indigo-700 px-1.5 py-0.5 rounded border border-indigo-200 font-mono">{bug.parent_key}</span>
                              : <span className="text-slate-300 text-xs">—</span>}
                          </td>
                          <td className="px-2 py-2 max-w-[180px]">
                            {bug.parent_summary
                              ? <p className="text-xs text-slate-600 line-clamp-2" title={bug.parent_summary}>{bug.parent_summary}</p>
                              : <span className="text-slate-300 text-xs">—</span>}
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap text-xs text-slate-600">{bug.fix_versions?.[0] || <span className="text-slate-300">—</span>}</td>
                          <td className="px-2 py-2 whitespace-nowrap text-xs text-slate-600">{bug.sprint || <span className="text-slate-300">—</span>}</td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <span className={`text-xs ${ageCls}`}>{days}d</span>
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap text-xs text-slate-600">{bug.reporter || '—'}</td>
                          <td className="px-2 py-2 w-36">
                            <InlineSelect bugKey={bug.key} field="assignee" value={bug.assignee_id} options={assigneeSelectOptions} saveState={saveState} onSave={onSave} placeholder="— unassigned" />
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

/* ── BugTriagePage ───────────────────────────────────────── */
export default function BugTriagePage() {
  const [mode,            setMode]           = useState('epic')
  const [selectedEpics,   setSelectedEpics]  = useState([])
  const [selectedVersion, setSelectedVersion] = useState('')
  const [days,            setDays]           = useState(14)
  const [daysInput,       setDaysInput]      = useState('14')
  const [creators,        setCreators]       = useState([])
  const [saveState,             setSaveState]            = useState({})
  const [localBugs,             setLocalBugs]            = useState(null)
  const [localTodoBugs,         setLocalTodoBugs]        = useState(null)
  const [localMisassignedBugs,  setLocalMisassignedBugs] = useState(null)
  const [qaTeam, setQaTeam] = useState(() => {
    try { return JSON.parse(localStorage.getItem('qa-dashboard:qa-team-ids') || '[]') } catch { return [] }
  })
  const saveQaTeam = (ids) => {
    setQaTeam(ids)
    localStorage.setItem('qa-dashboard:qa-team-ids', JSON.stringify(ids))
  }
  const [activeStatuses,  setActiveStatuses] = useState(new Set())
  const [labelFilter,     setLabelFilter]    = useState(new Set())
  const [priorityFilter,  setPriorityFilter] = useState('')
  const [searchText,      setSearchText]     = useState('')
  const [sortField,       setSortField]      = useState('created')
  const [sortDir,         setSortDir]        = useState('desc')
  const [tablePage,       setTablePage]      = useState(1)
  const TABLE_PAGE_SIZE = 50

  /* ── meta */
  const metaQuery = useQuery({
    queryKey: ['triage-meta'],
    queryFn: () => axios.get(`${API}/meta`).then(r => r.data),
    staleTime: 600_000,
  })
  const meta = metaQuery.data || { versions: [], priorities: [], sprints: [], assignees: [] }

  /* ── bug query */
  const epicParam  = mode === 'epic' ? selectedEpics.map(e => e.key).join(',') : ''
  const bugEnabled =
    mode === 'epic'    ? selectedEpics.length > 0 :
    mode === 'version' ? !!selectedVersion :
    true  // date mode always enabled

  const bugQuery = useQuery({
    queryKey: ['triage-bugs', mode, epicParam, selectedVersion, days, creators.join(',')],
    queryFn: ({ signal }) => {
      let params = {}
      if (mode === 'epic')    params = { epic_keys: epicParam }
      else if (mode === 'version') params = { fix_version: selectedVersion }
      else params = { days, creators: creators.join(',') || undefined }
      return axios.get(`${API}/bugs`, { params, signal }).then(r => r.data.bugs)
    },
    enabled: bugEnabled && mode !== 'todo' && mode !== 'misassigned',
    staleTime: 60_000,
  })

  const todoQuery = useQuery({
    queryKey: ['triage-todo-bugs'],
    queryFn: ({ signal }) => axios.get(`${API}/todo-bugs`, { signal }).then(r => r.data.bugs),
    enabled: mode === 'todo',
    staleTime: 120_000,
  })

  const misassignedQuery = useQuery({
    queryKey: ['triage-qa-misassigned', qaTeam.join(',')],
    queryFn: ({ signal }) => axios.get(`${API}/qa-misassigned`, { params: { assignees: qaTeam.join(',') }, signal }).then(r => r.data.bugs),
    enabled: mode === 'misassigned' && qaTeam.length > 0,
    staleTime: 120_000,
  })

  useEffect(() => {
    if (bugQuery.data) {
      setLocalBugs(bugQuery.data)
      setActiveStatuses(new Set())
      setLabelFilter(new Set())
      setPriorityFilter('')
    }
  }, [bugQuery.data])

  useEffect(() => {
    if (todoQuery.data) setLocalTodoBugs(todoQuery.data)
  }, [todoQuery.data])

  useEffect(() => {
    if (misassignedQuery.data) setLocalMisassignedBugs(misassignedQuery.data)
  }, [misassignedQuery.data])

  /* ── save field */
  const handleSave = useCallback(async (bugKey, field, value) => {
    const stateKey = `${bugKey}:${field}`
    setSaveState(prev => ({ ...prev, [stateKey]: 'saving' }))

    const applyUpdate = (prev) => prev ? prev.map(b => {
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
    }) : prev

    setLocalBugs(applyUpdate)
    setLocalTodoBugs(applyUpdate)
    setLocalMisassignedBugs(applyUpdate)

    try {
      await axios.patch(`${API}/${bugKey}`, { field, value: value || null })
      setSaveState(prev => ({ ...prev, [stateKey]: 'saved' }))
      setTimeout(() => setSaveState(prev => ({ ...prev, [stateKey]: 'idle' })), 2000)
    } catch {
      setSaveState(prev => ({ ...prev, [stateKey]: 'error' }))
      setTimeout(() => setSaveState(prev => ({ ...prev, [stateKey]: 'idle' })), 4000)
      bugQuery.refetch()
      todoQuery.refetch()
      misassignedQuery.refetch()
    }
  }, [meta, bugQuery, todoQuery, misassignedQuery])

  /* ── stats & filters from localBugs */
  const totalBugs = localBugs?.length ?? 0

  const countByStatus = useMemo(() => {
    const m = {}
    for (const b of localBugs || []) { const s = b.status || 'Unknown'; m[s] = (m[s] || 0) + 1 }
    return m
  }, [localBugs])

  // Build toggle list from actual statuses in the data, preserving predefined order
  const presentCfgs = useMemo(() => {
    const seen = new Set()
    const result = []
    // First: add statuses that are in our predefined list, in order
    for (const cfg of STATUS_CFG) {
      if (countByStatus[cfg.key] > 0 && !seen.has(cfg.key)) {
        seen.add(cfg.key)
        result.push(cfg)
      }
    }
    // Then: add any remaining statuses from the data not in the predefined list
    for (const s of Object.keys(countByStatus)) {
      if (countByStatus[s] > 0 && !seen.has(s)) {
        seen.add(s)
        result.push({ key: s, label: s, ...STATUS_CFG_DEFAULT })
      }
    }
    return result
  }, [countByStatus])

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
  const PRIORITY_ORDER = { Highest: 1, High: 2, Medium: 3, Low: 4, Lowest: 5 }

  const isFiltered    = activeStatuses.size > 0 || labelFilter.size > 0 || !!priorityFilter || !!searchText.trim()

  const filteredBugs = useMemo(() => {
    let list = localBugs || []
    if (activeStatuses.size > 0) list = list.filter(b => activeStatuses.has(b.status))
    if (labelFilter.size > 0)    list = list.filter(b => (b.labels || []).some(l => labelFilter.has(l)))
    if (priorityFilter)          list = list.filter(b => b.priority === priorityFilter)
    if (searchText.trim()) {
      const q = searchText.trim().toLowerCase()
      list = list.filter(b =>
        b.key?.toLowerCase().includes(q) ||
        b.summary?.toLowerCase().includes(q) ||
        b.reporter?.toLowerCase().includes(q) ||
        (b.labels || []).some(l => l.toLowerCase().includes(q))
      )
    }
    return list
  }, [localBugs, activeStatuses, labelFilter, priorityFilter, searchText])

  const displayBugs = useMemo(() => {
    const sorted = [...filteredBugs].sort((a, b) => {
      let av, bv
      if (sortField === 'age' || sortField === 'created') {
        av = new Date(a.created).getTime()
        bv = new Date(b.created).getTime()
      } else if (sortField === 'priority') {
        av = PRIORITY_ORDER[a.priority] ?? 99
        bv = PRIORITY_ORDER[b.priority] ?? 99
      } else if (sortField === 'fix_version') {
        av = (a.fix_versions?.[0] || '').toLowerCase()
        bv = (b.fix_versions?.[0] || '').toLowerCase()
      } else if (sortField === 'reporter') {
        av = (a.reporter || '').toLowerCase()
        bv = (b.reporter || '').toLowerCase()
      } else if (sortField === 'assignee') {
        av = (a.assignee || '').toLowerCase()
        bv = (b.assignee || '').toLowerCase()
      } else if (sortField === 'parent') {
        av = (a.parent_key || '').toLowerCase()
        bv = (b.parent_key || '').toLowerCase()
      } else {
        av = (a[sortField] || '').toString().toLowerCase()
        bv = (b[sortField] || '').toString().toLowerCase()
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
    return sorted
  }, [filteredBugs, sortField, sortDir])

  const totalTablePages = Math.ceil(displayBugs.length / TABLE_PAGE_SIZE)
  const pagedBugs = displayBugs.slice((tablePage - 1) * TABLE_PAGE_SIZE, tablePage * TABLE_PAGE_SIZE)

  const toggleSort = (field) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(field); setSortDir('asc') }
    setTablePage(1)
  }

  const SortIcon = ({ field }) => {
    if (sortField !== field) return <span className="opacity-30 text-[10px]">↕</span>
    return <span className="text-[10px]">{sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  const Th = ({ label, field }) => (
    <th
      className="px-3 py-2.5 text-left whitespace-nowrap cursor-pointer select-none hover:bg-slate-600 transition-colors"
      onClick={() => toggleSort(field)}
    >
      <span className="inline-flex items-center gap-1">{label} <SortIcon field={field} /></span>
    </th>
  )

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
            onClick={() => setMode('version')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${mode === 'version' ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            <Tag className="h-3.5 w-3.5" />
            By Fix Version
          </button>
          <button
            onClick={() => setMode('date')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${mode === 'date' ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            <Calendar className="h-3.5 w-3.5" />
            By Date
          </button>
          <button
            onClick={() => setMode('todo')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${mode === 'todo' ? 'bg-red-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            <ClipboardList className="h-3.5 w-3.5" />
            TMT0 — To Do
          </button>
          <button
            onClick={() => setMode('misassigned')}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${mode === 'misassigned' ? 'bg-amber-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
          >
            <UserX className="h-3.5 w-3.5" />
            Wrong Assignments
          </button>
        </div>
      </div>

      {/* Controls — hidden in todo and misassigned modes */}
      {mode !== 'todo' && mode !== 'misassigned' && <div className="px-6 py-4 bg-white border-b border-slate-200">
        {mode === 'epic' ? (
          <EpicSearch
            selectedEpics={selectedEpics}
            onAdd={e => setSelectedEpics(prev => prev.find(x => x.key === e.key) ? prev : [...prev, e])}
            onRemove={k => setSelectedEpics(prev => prev.filter(e => e.key !== k))}
          />
        ) : mode === 'version' ? (
          <div className="flex items-center gap-3">
            <label className="text-sm font-medium text-slate-700 shrink-0">Fix Version</label>
            {metaQuery.isLoading ? (
              <span className="text-sm text-slate-400 flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading versions…
              </span>
            ) : (
              <select
                className="border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 min-w-[280px] bg-white"
                value={selectedVersion}
                onChange={e => setSelectedVersion(e.target.value)}
              >
                <option value="">— Select a version —</option>
                {(meta.versions || []).map(v => (
                  <option key={v.id} value={v.name}>
                    {v.name}{v.released ? ' (released)' : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
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
      </div>}

      {/* Body */}
      <div className="flex-1 overflow-auto px-6 py-4 space-y-4">

        {/* ── TMT0 To Do view ─────────────────────────────── */}
        {mode === 'todo' && (
          <TodoBugsPanel
            query={todoQuery}
            localBugs={localTodoBugs}
            meta={meta}
            saveState={saveState}
            onSave={handleSave}
          />
        )}

        {/* ── Wrong Assignments view ────────────────────────── */}
        {mode === 'misassigned' && (
          <QAMisassignedPanel
            query={misassignedQuery}
            localBugs={localMisassignedBugs}
            meta={meta}
            saveState={saveState}
            onSave={handleSave}
            qaTeam={qaTeam}
            onQaTeamChange={saveQaTeam}
          />
        )}

        {/* Empty states */}
        {mode !== 'todo' && mode === 'epic' && selectedEpics.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24 text-slate-400 space-y-3">
            <Bug className="h-12 w-12 opacity-25" />
            <p className="text-lg font-semibold">Select one or more Epics</p>
            <p className="text-sm text-center max-w-sm">Search for an Epic above to load its bugs for review.</p>
          </div>
        )}
        {mode === 'version' && !selectedVersion && (
          <div className="flex flex-col items-center justify-center py-24 text-slate-400 space-y-3">
            <Tag className="h-12 w-12 opacity-25" />
            <p className="text-lg font-semibold">Select a Fix Version</p>
            <p className="text-sm text-center max-w-sm">Choose a fix version above to load its bugs for review.</p>
          </div>
        )}

        {/* Loading (non-todo, non-misassigned modes) */}
        {mode !== 'todo' && mode !== 'misassigned' && bugQuery.isFetching && (
          <div className="flex items-center gap-2 text-sm text-slate-500 py-6">
            <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
            Loading bugs…
          </div>
        )}

        {/* Error (non-todo, non-misassigned modes) */}
        {mode !== 'todo' && mode !== 'misassigned' && bugQuery.error && (
          <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {bugQuery.error?.response?.data?.detail || 'Failed to load bugs'}
            <button onClick={() => bugQuery.refetch()} className="ml-auto underline">Retry</button>
          </div>
        )}

        {/* Results — shown once data is loaded (non-todo, non-misassigned modes) */}
        {mode !== 'todo' && mode !== 'misassigned' && !bugQuery.isFetching && localBugs && (
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

                  <div className="flex items-center gap-1.5 ml-auto">
                    <Search className="h-3.5 w-3.5 text-slate-400 shrink-0" />
                    <input
                      type="text"
                      value={searchText}
                      onChange={e => { setSearchText(e.target.value); setTablePage(1) }}
                      placeholder="Search key, summary, reporter…"
                      className="text-xs border border-slate-300 rounded-lg px-2 py-1.5 bg-white outline-none focus:ring-2 focus:ring-indigo-300 w-52"
                    />
                    {searchText && (
                      <button onClick={() => setSearchText('')} className="text-slate-400 hover:text-slate-600">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>

                  {isFiltered && (
                    <button
                      onClick={() => { setActiveStatuses(new Set()); setLabelFilter(new Set()); setPriorityFilter(''); setSearchText('') }}
                      className="text-xs text-indigo-600 hover:underline"
                    >
                      Clear all — showing {displayBugs.length} of {totalBugs}
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
                        : mode === 'version'
                          ? `Bugs — ${selectedVersion}`
                          : `Bugs by Epic`
                    }
                  </p>
                  <span className="text-xs text-gray-400">
                    {isFiltered ? `${displayBugs.length} of ${totalBugs}` : displayBugs.length} bug{displayBugs.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="bg-slate-700 text-white text-xs font-semibold">
                        <Th label="Key"         field="key" />
                        <Th label="Summary"     field="summary" />
                        <th className="px-2 py-2.5 text-left whitespace-nowrap">Labels</th>
                        <Th label="Status"      field="status" />
                        <Th label="Priority"    field="priority" />
                        <Th label="Fix Version" field="fix_version" />
                        <Th label="Sprint"      field="sprint" />
                        <Th label="Assignee"    field="assignee" />
                        <Th label="Parent"      field="parent" />
                        <Th label="Age"         field="age" />
                        <Th label="Created"     field="created" />
                        <Th label="Reporter"    field="reporter" />
                      </tr>
                    </thead>
                    <tbody>
                      {pagedBugs.map(bug => (
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
                {totalTablePages > 1 && (
                  <div className="flex items-center justify-between px-4 py-3 border-t border-slate-200 text-xs text-slate-500">
                    <span>Page {tablePage} of {totalTablePages} · {displayBugs.length} bugs</span>
                    <div className="flex items-center gap-2">
                      <button
                        className="px-2 py-1 border border-slate-300 rounded disabled:opacity-40 hover:bg-slate-50"
                        disabled={tablePage === 1}
                        onClick={() => setTablePage(p => p - 1)}
                      >← Prev</button>
                      <button
                        className="px-2 py-1 border border-slate-300 rounded disabled:opacity-40 hover:bg-slate-50"
                        disabled={tablePage === totalTablePages}
                        onClick={() => setTablePage(p => p + 1)}
                      >Next →</button>
                    </div>
                  </div>
                )}
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

import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { Search, X, Plus, GitBranch, Loader2, AlertCircle } from 'lucide-react'

/* ── constants ───────────────────────────────────────────── */
const API        = '/api/investigation'
const LEFT_W     = 440   // px – issue info column
const RIGHT_W    = 228   // px – milestone dates column
const TYPE_ORDER = { Epic: 0, Story: 1, Bug: 2 }

/* ── date helpers ────────────────────────────────────────── */
function parseDate(s) {
  if (!s) return null
  const d = new Date(s)
  return isNaN(d) ? null : d
}
function fmt(d) {
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : '—'
}
function fmtShort(d) {
  return d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''
}

/* ── type styling ────────────────────────────────────────── */
const TYPE_META = {
  Epic: {
    badge:  'bg-purple-100 text-purple-800 border-purple-300',
    row:    'bg-slate-800',
    text:   'text-slate-200',
    border: 'border-l-[5px] border-purple-500',
    link:   'text-purple-300',
  },
  Story: {
    badge:  'bg-blue-100 text-blue-800 border-blue-300',
    row:    'bg-blue-50',
    text:   'text-slate-700',
    border: 'border-l-[5px] border-blue-400',
    link:   'text-indigo-600',
  },
  Bug: {
    badge:  'bg-red-100 text-red-800 border-red-300',
    row:    'bg-white',
    text:   'text-slate-700',
    border: 'border-l-[5px] border-red-400',
    link:   'text-indigo-600',
  },
}
function getMeta(type) {
  return TYPE_META[type] || {
    badge: 'bg-slate-100 text-slate-700 border-slate-300',
    row: 'bg-white', text: 'text-slate-700',
    border: 'border-l-[5px] border-slate-300', link: 'text-indigo-600',
  }
}

/* ── status pill ─────────────────────────────────────────── */
const STATUS_COLORS = {
  'To Do':             'bg-slate-100 text-slate-600',
  'In Progress':       'bg-blue-100 text-blue-700',
  'Ready for Testing': 'bg-amber-100 text-amber-700',
  'DONE': 'bg-green-100 text-green-700',
  'Done': 'bg-green-100 text-green-700',
  'Closed': 'bg-green-100 text-green-700',
  'Reopened': 'bg-red-100 text-red-700',
}
function StatusPill({ status }) {
  const cls = STATUS_COLORS[status] || 'bg-slate-100 text-slate-600'
  return (
    <span className={`shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {status || '—'}
    </span>
  )
}

/* ── post-RFT colour ─────────────────────────────────────── */
const PASS_KW   = ['done', 'closed', 'resolved', 'passed', 'verified']
const REOPEN_KW = ['reopen', 'fail', 'reject', 'blocked']
function postRftBg(status) {
  if (!status) return 'bg-slate-400'
  const s = status.toLowerCase()
  if (PASS_KW.some(k => s.includes(k)))   return 'bg-green-500'
  if (REOPEN_KW.some(k => s.includes(k))) return 'bg-red-500'
  return 'bg-slate-400'
}

/* ── tree builder ────────────────────────────────────────── */
function buildDisplayRows(items, bugLayerSet = new Set()) {
  const byKey = {}
  items.forEach(i => (byKey[i.key] = { ...i, children: [], isBugLayer: bugLayerSet.has(i.key) }))

  const roots = []
  items.forEach(i => {
    if (i.parent_key && byKey[i.parent_key]) {
      byKey[i.parent_key].children.push(byKey[i.key])
    } else {
      roots.push(byKey[i.key])
    }
  })

  const sortFn = (a, b) => (TYPE_ORDER[a.type] ?? 3) - (TYPE_ORDER[b.type] ?? 3)
  roots.sort(sortFn)

  const flat = []
  function walk(node, depth) {
    flat.push({ ...node, depth })
    node.children.sort(sortFn).forEach(c => walk(c, depth + 1))
  }
  roots.forEach(r => walk(r, 0))
  return flat
}

/* ── gantt math ──────────────────────────────────────────── */
function xPct(ms, minMs, totalMs) {
  return `${Math.min(100, Math.max(0, ((ms - minMs) / totalMs) * 100)).toFixed(3)}%`
}
function wPct(a, b, totalMs) {
  return `${Math.min(100, Math.max(0.3, ((b - a) / totalMs) * 100)).toFixed(3)}%`
}

/* ── GanttRow ────────────────────────────────────────────── */
function GanttRow({ row, minMs, totalMs }) {
  // Bug-layer rows get amber styling instead of red
  const meta = row.isBugLayer && row.type === 'Bug'
    ? { ...getMeta('Bug'), badge: 'bg-orange-100 text-orange-800 border-orange-300', row: 'bg-orange-50', border: 'border-l-[5px] border-orange-400', link: 'text-indigo-600', text: 'text-slate-700' }
    : getMeta(row.type)
  const today = Date.now()
  const todo    = parseDate(row.todo_date)
  const rft     = parseDate(row.rft_date)
  const postRft = parseDate(row.post_rft_date)

  const devStart  = todo    ? todo.getTime()    : minMs
  const devEnd    = rft     ? rft.getTime()     : today
  const rftStart  = rft     ? rft.getTime()     : null
  const rftEnd    = postRft ? postRft.getTime() : (rft ? today : null)
  const pStart    = postRft ? postRft.getTime() : null

  const depth  = row.depth || 0
  const indent = 12 + depth * 20

  return (
    <div className={`flex items-stretch border-b border-slate-200 ${meta.row} ${meta.border}`}>
      {/* Issue info */}
      <div
        className="shrink-0 flex flex-col justify-center gap-1 py-2 pr-3 border-r border-slate-200"
        style={{ width: LEFT_W, paddingLeft: indent }}
      >
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`shrink-0 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border ${meta.badge}`}>
            {row.type || '?'}
          </span>
          <a
            href={row.url}
            target="_blank"
            rel="noreferrer"
            className={`font-mono text-xs hover:underline shrink-0 ${meta.link}`}
          >
            {row.key}
          </a>
          <StatusPill status={row.status} />
        </div>
        <p className={`text-sm leading-snug ${meta.text}`}>
          {row.summary}
        </p>
      </div>

      {/* Timeline bar */}
      <div className="flex-1 relative" style={{ minHeight: 60 }}>
        <div className="absolute inset-y-3 left-1 right-1">
          {/* Dev phase */}
          {todo && (
            <div
              title={`Dev: ${fmt(todo)} → ${fmt(rft || new Date())}`}
              className="absolute h-full rounded-sm bg-indigo-500 opacity-90"
              style={{ left: xPct(devStart, minMs, totalMs), width: wPct(devStart, devEnd, totalMs) }}
            />
          )}
          {/* RFT phase */}
          {rft && rftEnd && (
            <div
              title={`RFT: ${fmt(rft)} → ${fmt(postRft || new Date())}`}
              className="absolute h-full bg-amber-400 opacity-90"
              style={{ left: xPct(rftStart, minMs, totalMs), width: wPct(rftStart, rftEnd, totalMs) }}
            />
          )}
          {/* Post-RFT phase */}
          {postRft && (
            <div
              title={`Post-RFT (${row.post_rft_status}): from ${fmt(postRft)}`}
              className={`absolute h-full rounded-sm opacity-90 ${postRftBg(row.post_rft_status)}`}
              style={{ left: xPct(pStart, minMs, totalMs), width: wPct(pStart, today, totalMs) }}
            />
          )}
          {/* Phase dividers */}
          {rft    && <div className="absolute top-0 bottom-0 w-px bg-white/60" style={{ left: xPct(rftStart, minMs, totalMs) }} />}
          {postRft && <div className="absolute top-0 bottom-0 w-px bg-white/60" style={{ left: xPct(pStart, minMs, totalMs) }} />}
        </div>
      </div>

      {/* Milestone dates */}
      <div className="shrink-0 grid grid-cols-3 border-l border-slate-200 py-2 text-center items-center" style={{ width: RIGHT_W }}>
        <span className="text-xs text-slate-500">{fmt(todo)}</span>
        <span className="text-xs text-amber-600 font-medium">{fmt(rft)}</span>
        <span className={`text-xs font-medium ${postRft ? 'text-green-600' : 'text-slate-300'}`}>{fmt(postRft)}</span>
      </div>
    </div>
  )
}

/* ── GanttChart ──────────────────────────────────────────── */
function GanttChart({ rows }) {
  const allMs = rows.flatMap(r => [
    parseDate(r.todo_date),
    parseDate(r.rft_date),
    parseDate(r.post_rft_date),
  ]).filter(Boolean).map(d => d.getTime())

  const now   = Date.now()
  allMs.push(now)

  const minMs   = Math.min(...allMs)
  const maxMs   = Math.max(...allMs)
  const totalMs = Math.max(maxMs - minMs, 86_400_000 * 7)

  const spanDays    = (maxMs - minMs) / 86_400_000
  const tickEvery   = spanDays <= 14 ? 2 : spanDays <= 60 ? 7 : spanDays <= 120 ? 14 : 30
  const ticks       = []
  const cur         = new Date(minMs)
  cur.setHours(0, 0, 0, 0)
  while (cur.getTime() <= maxMs + 86_400_000) {
    ticks.push(new Date(cur))
    cur.setDate(cur.getDate() + tickEvery)
  }

  return (
    <div className="border border-slate-200 rounded-xl overflow-hidden shadow-sm">
      {/* Header */}
      <div className="flex items-stretch bg-slate-700 text-white text-xs font-semibold">
        <div className="shrink-0 flex items-center px-4 py-2.5 border-r border-slate-600" style={{ width: LEFT_W }}>
          Issue
        </div>
        <div className="flex-1 relative" style={{ minHeight: 36 }}>
          {ticks.map(t => (
            <div key={t.getTime()} className="absolute top-0 bottom-0 flex flex-col" style={{ left: xPct(t.getTime(), minMs, totalMs) }}>
              <div className="h-full border-l border-dashed border-slate-500" />
              <span className="absolute top-1.5 text-[11px] text-slate-300 -translate-x-1/2 whitespace-nowrap">{fmtShort(t)}</span>
            </div>
          ))}
          <div className="absolute top-0 bottom-0 border-l-2 border-red-400" style={{ left: xPct(now, minMs, totalMs) }}>
            <span className="absolute top-1.5 text-[11px] text-red-300 -translate-x-1/2 whitespace-nowrap">Today</span>
          </div>
        </div>
        <div className="shrink-0 grid grid-cols-3 border-l border-slate-600 py-2.5 text-center" style={{ width: RIGHT_W }}>
          <span className="text-indigo-300">To Do</span>
          <span className="text-amber-300">RFT</span>
          <span className="text-green-300">Post-RFT</span>
        </div>
      </div>

      {/* Rows */}
      {rows.map(row => (
        <GanttRow key={row.key} row={row} minMs={minMs} totalMs={totalMs} />
      ))}

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-5 px-4 py-2.5 bg-slate-50 border-t border-slate-200 text-xs text-slate-500">
        <span className="flex items-center gap-1.5"><span className="inline-block w-6 h-3 bg-indigo-500 rounded" />Dev (To Do → RFT)</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-6 h-3 bg-amber-400 rounded" />RFT phase</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-6 h-3 bg-green-500 rounded" />Post-RFT (pass)</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-6 h-3 bg-red-500 rounded" />Post-RFT (reopen/fail)</span>
        <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 bg-orange-50 border border-orange-400 rounded" />Bug overlay layer</span>
        <span className="ml-auto flex items-center gap-1.5 text-red-400">
          <span className="inline-block w-px h-3 border-l-2 border-red-400" />Today
        </span>
      </div>
    </div>
  )
}

/* ── IssueSearch ─────────────────────────────────────────── */
function IssueSearch({ typeFilter, onSelect, alreadyTracked }) {
  const [q, setQ]         = useState('')
  const [dq, setDq]       = useState('')
  const [open, setOpen]   = useState(false)
  const timer             = useRef(null)
  const wrapRef           = useRef(null)

  const handleQ = v => {
    setQ(v)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setDq(v), 350)
    setOpen(true)
  }

  const typesParam = typeFilter === 'all' ? '' : typeFilter

  const { data, isFetching } = useQuery({
    queryKey: ['inv-search', dq, typesParam],
    queryFn: ({ signal }) =>
      axios.get(`${API}/search`, { params: { q: dq, types: typesParam }, signal })
           .then(r => r.data.results),
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

  return (
    <div className="relative" ref={wrapRef}>
      <div className="flex items-center gap-2 bg-white border border-slate-300 rounded-lg px-3 py-2 w-96 shadow-sm focus-within:ring-2 focus-within:ring-indigo-300">
        <Search className="h-4 w-4 text-slate-400 shrink-0" />
        <input
          className="flex-1 outline-none text-sm text-slate-700 placeholder-slate-400"
          placeholder="Search issue key or summary…"
          value={q}
          onChange={e => handleQ(e.target.value)}
          onFocus={() => q.length >= 2 && setOpen(true)}
        />
        {isFetching && <Loader2 className="h-3.5 w-3.5 text-slate-400 animate-spin" />}
        {q && <button onClick={clear}><X className="h-3.5 w-3.5 text-slate-400 hover:text-slate-600" /></button>}
      </div>

      {open && dq.length >= 2 && (
        <div className="absolute z-50 mt-1 w-[580px] bg-white border border-slate-200 rounded-xl shadow-xl max-h-80 overflow-y-auto">
          {!isFetching && results.length === 0 && (
            <div className="px-4 py-3 text-sm text-slate-400">No results found</div>
          )}
          {results.map(r => {
            const already = alreadyTracked.includes(r.key)
            const meta    = getMeta(r.type)
            return (
              <button
                key={r.key}
                disabled={already}
                onClick={() => { onSelect(r); clear() }}
                className={`w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-slate-50 border-b border-slate-100 last:border-0 transition-colors ${already ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <span className={`shrink-0 mt-0.5 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border ${meta.badge}`}>{r.type}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`font-mono text-xs shrink-0 ${meta.link}`}>{r.key}</span>
                    <span className="text-xs text-slate-400 truncate">{r.status}</span>
                  </div>
                  <p className="text-sm text-slate-700 mt-0.5 leading-snug">{r.summary}</p>
                </div>
                {already
                  ? <span className="text-xs text-slate-400 shrink-0 mt-1">added</span>
                  : <Plus className="h-4 w-4 text-indigo-500 shrink-0 mt-0.5" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ── PendingItemPanel ────────────────────────────────────── */
function PendingItemPanel({ item, onConfirm, onCancel, alreadyTracked }) {
  const [includeStories, setIncludeStories] = useState(true)
  const [includeBugs,    setIncludeBugs]    = useState(true)
  const [loading,        setLoading]        = useState(false)

  const isEpic  = item.type === 'Epic'
  const isStory = item.type === 'Story'

  const handleAdd = async () => {
    setLoading(true)
    const keys = [item.key]
    try {
      if (isEpic && (includeStories || includeBugs)) {
        const types = []
        if (includeStories) types.push('Story')
        if (includeBugs && !includeStories) types.push('Bug')

        if (types.length) {
          const res = await axios.get(`${API}/children`, { params: { parent: item.key, types: types.join(',') } })
          const children = res.data.children || []
          keys.push(...children.map(c => c.key))

          if (includeStories && includeBugs) {
            const storyKeys = children.filter(c => c.type === 'Story').map(c => c.key)
            await Promise.all(storyKeys.map(async sk => {
              const br = await axios.get(`${API}/children`, { params: { parent: sk, types: 'Bug' } })
              keys.push(...(br.data.children || []).map(c => c.key))
            }))
          }
        }
      } else if (isStory && includeBugs) {
        const res = await axios.get(`${API}/children`, { params: { parent: item.key, types: 'Bug' } })
        keys.push(...(res.data.children || []).map(c => c.key))
      }
    } catch (e) {
      console.error('Failed to load children:', e)
    }
    onConfirm([...new Set(keys)])
    setLoading(false)
  }

  const meta = getMeta(item.type)

  return (
    <div className="bg-white border-2 border-indigo-200 rounded-xl p-4 shadow-lg w-80 shrink-0 space-y-3">
      <div className="flex items-start gap-2">
        <span className={`shrink-0 mt-0.5 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border ${meta.badge}`}>
          {item.type}
        </span>
        <div className="min-w-0">
          <p className={`font-mono text-xs ${meta.link}`}>{item.key}</p>
          <p className="text-sm text-slate-700 leading-snug mt-0.5">{item.summary}</p>
        </div>
      </div>

      {(isEpic || isStory) && (
        <div className="border-t border-slate-100 pt-3 space-y-2">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Also include:</p>
          {isEpic && (
            <label className="flex items-center gap-2 cursor-pointer hover:bg-slate-50 px-1 py-0.5 rounded">
              <input type="checkbox" checked={includeStories} onChange={e => setIncludeStories(e.target.checked)} className="accent-indigo-600 h-4 w-4" />
              <span className="text-sm text-slate-700">Stories of this Epic</span>
            </label>
          )}
          <label className="flex items-center gap-2 cursor-pointer hover:bg-slate-50 px-1 py-0.5 rounded">
            <input type="checkbox" checked={includeBugs} onChange={e => setIncludeBugs(e.target.checked)} className="accent-indigo-600 h-4 w-4" />
            <span className="text-sm text-slate-700">
              {isEpic ? 'Bugs of each Story' : 'Bugs of this Story'}
            </span>
          </label>
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          onClick={handleAdd}
          disabled={loading}
          className="flex-1 py-2 bg-indigo-600 text-white rounded-lg text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
        >
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Add to Timeline
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-2 border border-slate-300 text-slate-600 rounded-lg text-sm hover:bg-slate-50 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

/* ── BugLayerPanel ───────────────────────────────────────── */
function BugLayerPanel({ onAddKeys, allTrackedKeys }) {
  const [layerMode, setLayerMode] = useState('Bug')   // 'Bug' | 'Epic'
  const [q, setQ]                 = useState('')
  const [dq, setDq]               = useState('')
  const [open, setOpen]           = useState(false)
  const [loading, setLoading]     = useState(false)
  const [lastAdded, setLastAdded] = useState(null)
  const timer   = useRef(null)
  const wrapRef = useRef(null)

  const handleQ = v => {
    setQ(v)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setDq(v), 350)
    setOpen(true)
  }

  const { data, isFetching } = useQuery({
    queryKey: ['bug-layer-search', dq, layerMode],
    queryFn: ({ signal }) =>
      axios.get(`${API}/search`, { params: { q: dq, types: layerMode }, signal })
           .then(r => r.data.results),
    enabled: dq.trim().length >= 2,
    staleTime: 60_000,
  })

  useEffect(() => {
    const h = e => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const clear = () => { setQ(''); setDq(''); setOpen(false) }

  const handleSelect = async item => {
    clear()
    setLoading(true)
    try {
      if (layerMode === 'Bug') {
        onAddKeys([item.key])
        setLastAdded(`${item.key} added`)
      } else {
        // Epic mode: load all bugs of this epic
        const res = await axios.get(`${API}/children`, { params: { parent: item.key, types: 'Bug' } })
        const bugKeys = (res.data.children || []).map(c => c.key)
        onAddKeys(bugKeys)
        setLastAdded(`${bugKeys.length} bugs from ${item.key} added`)
      }
    } catch (e) {
      console.error('Bug layer add failed:', e)
    }
    setLoading(false)
    setTimeout(() => setLastAdded(null), 3000)
  }

  const results = data || []

  return (
    <div className="flex items-center gap-3 bg-orange-50 border border-orange-200 rounded-xl px-4 py-2.5">
      {/* Label */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="inline-block w-2 h-2 rounded-full bg-orange-400" />
        <span className="text-xs font-semibold text-orange-700 whitespace-nowrap">Bug Layer</span>
      </div>

      {/* Mode toggle */}
      <div className="relative shrink-0">
        <select
          value={layerMode}
          onChange={e => { setLayerMode(e.target.value); setQ(''); setDq('') }}
          className="appearance-none border border-orange-300 rounded-lg pl-3 pr-7 py-1.5 text-xs bg-white shadow-sm outline-none focus:ring-2 focus:ring-orange-300 text-slate-700 cursor-pointer"
        >
          <option value="Bug">Add Bug</option>
          <option value="Epic">Add Epic's Bugs</option>
        </select>
        <div className="pointer-events-none absolute inset-y-0 right-1.5 flex items-center">
          <svg className="h-3.5 w-3.5 text-slate-400" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
        </div>
      </div>

      {/* Search input */}
      <div className="relative flex-1 max-w-sm" ref={wrapRef}>
        <div className="flex items-center gap-2 bg-white border border-orange-300 rounded-lg px-3 py-1.5 shadow-sm focus-within:ring-2 focus-within:ring-orange-300">
          <Search className="h-3.5 w-3.5 text-slate-400 shrink-0" />
          <input
            className="flex-1 outline-none text-sm text-slate-700 placeholder-slate-400"
            placeholder={layerMode === 'Bug' ? 'Search bug key or summary…' : 'Search epic to load all its bugs…'}
            value={q}
            onChange={e => handleQ(e.target.value)}
            onFocus={() => q.length >= 2 && setOpen(true)}
          />
          {(isFetching || loading) && <Loader2 className="h-3.5 w-3.5 text-orange-400 animate-spin" />}
          {q && <button onClick={clear}><X className="h-3.5 w-3.5 text-slate-400 hover:text-slate-600" /></button>}
        </div>

        {open && dq.length >= 2 && (
          <div className="absolute z-50 mt-1 w-[520px] bg-white border border-orange-200 rounded-xl shadow-xl max-h-72 overflow-y-auto">
            {!isFetching && results.length === 0 && (
              <div className="px-4 py-3 text-sm text-slate-400">No results</div>
            )}
            {results.map(r => {
              const already = allTrackedKeys.includes(r.key)
              const meta    = getMeta(r.type)
              return (
                <button
                  key={r.key}
                  disabled={already}
                  onClick={() => handleSelect(r)}
                  className={`w-full flex items-start gap-3 px-4 py-2.5 text-left hover:bg-orange-50 border-b border-slate-100 last:border-0 transition-colors ${already ? 'opacity-40 cursor-not-allowed' : ''}`}
                >
                  <span className={`shrink-0 mt-0.5 inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium border ${meta.badge}`}>{r.type}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-indigo-600 shrink-0">{r.key}</span>
                      <span className="text-xs text-slate-400">{r.status}</span>
                    </div>
                    <p className="text-sm text-slate-700 mt-0.5 leading-snug">{r.summary}</p>
                  </div>
                  {already
                    ? <span className="text-xs text-slate-400 shrink-0 mt-1">added</span>
                    : <Plus className="h-4 w-4 text-orange-500 shrink-0 mt-0.5" />}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* Feedback */}
      {lastAdded && (
        <span className="text-xs text-green-600 font-medium shrink-0 animate-pulse">{lastAdded}</span>
      )}
      {!loading && !lastAdded && (
        <span className="text-xs text-orange-500 shrink-0">
          {layerMode === 'Bug' ? 'Bug rows shown in orange' : 'Loads all bugs from the selected Epic'}
        </span>
      )}
    </div>
  )
}

/* ── tracked chips ───────────────────────────────────────── */
function TrackedChips({ keys, onRemove, onClearAll }) {
  if (!keys.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5 max-w-4xl">
      {keys.map(k => (
        <span key={k} className="inline-flex items-center gap-1 bg-indigo-50 text-indigo-700 text-xs font-mono rounded-full px-2.5 py-0.5 border border-indigo-200">
          {k}
          <button onClick={() => onRemove(k)} className="hover:text-red-600 ml-0.5">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <button onClick={onClearAll} className="text-xs text-slate-400 hover:text-red-500 px-2 py-0.5 rounded hover:bg-red-50 transition-colors">
        Clear all
      </button>
    </div>
  )
}

/* ── InvestigationPage ───────────────────────────────────── */
export default function InvestigationPage() {
  const [trackedKeys,  setTrackedKeys]  = useState([])   // hierarchy layer (epics/stories/bugs)
  const [bugLayerKeys, setBugLayerKeys] = useState([])   // bug overlay layer
  const [typeFilter,   setTypeFilter]   = useState('all')
  const [pendingItem,  setPendingItem]  = useState(null)

  const removeKey = useCallback(k => {
    setTrackedKeys(prev => prev.filter(x => x !== k))
    setBugLayerKeys(prev => prev.filter(x => x !== k))
  }, [])
  const clearAll = useCallback(() => { setTrackedKeys([]); setBugLayerKeys([]) }, [])

  const handleSelect  = useCallback(item => setPendingItem(item), [])
  const cancelPending = useCallback(() => setPendingItem(null), [])

  const handleConfirm = useCallback(keys => {
    setTrackedKeys(prev => {
      const next = [...prev]
      for (const k of keys) if (!next.includes(k)) next.push(k)
      return next
    })
    setPendingItem(null)
  }, [])

  const addBugLayerKeys = useCallback(keys => {
    setBugLayerKeys(prev => {
      const next = [...prev]
      for (const k of keys) if (!next.includes(k)) next.push(k)
      return next
    })
    // Also add to trackedKeys so they appear in timeline query
    setTrackedKeys(prev => {
      const next = [...prev]
      for (const k of keys) if (!next.includes(k)) next.push(k)
      return next
    })
  }, [])

  // All unique keys to fetch timeline for
  const allKeys   = useMemo(() => [...new Set([...trackedKeys, ...bugLayerKeys])], [trackedKeys, bugLayerKeys])
  const keysParam = allKeys.join(',')

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['inv-timeline', keysParam],
    queryFn: ({ signal }) =>
      axios.get(`${API}/timeline`, { params: { keys: keysParam }, signal })
           .then(r => r.data.items),
    enabled: allKeys.length > 0,
    staleTime: 300_000,
  })

  const bugLayerSet = useMemo(() => new Set(bugLayerKeys), [bugLayerKeys])

  const displayRows = useMemo(() => {
    if (!data?.length) return []
    return buildDisplayRows(data, bugLayerSet)
  }, [data, bugLayerSet])

  const counts = useMemo(() => {
    const c = { Epic: 0, Story: 0, Bug: 0 }
    displayRows.forEach(r => { if (c[r.type] !== undefined) c[r.type]++ })
    return c
  }, [displayRows])

  return (
    <div className="p-6 space-y-5 min-h-screen bg-slate-50">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2.5">
          <GitBranch className="h-6 w-6 text-indigo-600" />
          Investigation Timeline
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          Track milestones — To Do → Ready for Testing → Post-RFT. Select an Epic to load its full hierarchy automatically.
        </p>
      </div>

      {/* Toolbar */}
      <div className="flex flex-col gap-3">
        {/* Row 1: Bug overlay layer search */}
        <BugLayerPanel onAddKeys={addBugLayerKeys} allTrackedKeys={allKeys} />

        {/* Row 2: Hierarchy search (Epic / Story / Bug) */}
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div className="relative">
                <select
                  value={typeFilter}
                  onChange={e => setTypeFilter(e.target.value)}
                  className="appearance-none border border-slate-300 rounded-lg pl-3 pr-8 py-2 text-sm bg-white shadow-sm outline-none focus:ring-2 focus:ring-indigo-300 text-slate-700 cursor-pointer"
                >
                  <option value="all">All types</option>
                  <option value="Epic">Epic only</option>
                  <option value="Story">Story only</option>
                  <option value="Epic,Story">Epic + Story</option>
                  <option value="Bug">Bug only</option>
                </select>
                <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center">
                  <svg className="h-4 w-4 text-slate-400" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                  </svg>
                </div>
              </div>
              <IssueSearch
                typeFilter={typeFilter}
                onSelect={handleSelect}
                alreadyTracked={allKeys}
              />
            </div>

            {/* Hierarchy chips */}
            <TrackedChips keys={trackedKeys} onRemove={removeKey} onClearAll={clearAll} />

            {/* Bug layer chips (amber colour) */}
            {bugLayerKeys.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 max-w-4xl">
                <span className="text-xs font-semibold text-orange-600 mr-1">Bug Layer:</span>
                {bugLayerKeys.map(k => (
                  <span key={k} className="inline-flex items-center gap-1 bg-orange-50 text-orange-700 text-xs font-mono rounded-full px-2.5 py-0.5 border border-orange-200">
                    {k}
                    <button onClick={() => removeKey(k)} className="hover:text-red-600 ml-0.5">
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Pending item confirm panel */}
          {pendingItem && (
            <PendingItemPanel
              item={pendingItem}
              onConfirm={handleConfirm}
              onCancel={cancelPending}
              alreadyTracked={allKeys}
            />
          )}
        </div>
      </div>

      {/* Summary counts */}
      {displayRows.length > 0 && (
        <div className="flex items-center gap-3 text-xs flex-wrap">
          {counts.Epic  > 0 && <span className="bg-purple-50 text-purple-700 border border-purple-200 rounded-full px-3 py-1">{counts.Epic} Epic{counts.Epic !== 1 ? 's' : ''}</span>}
          {counts.Story > 0 && <span className="bg-blue-50 text-blue-700 border border-blue-200 rounded-full px-3 py-1">{counts.Story} Stor{counts.Story !== 1 ? 'ies' : 'y'}</span>}
          {counts.Bug   > 0 && <span className="bg-red-50 text-red-700 border border-red-200 rounded-full px-3 py-1">{counts.Bug - bugLayerKeys.length} Bug{(counts.Bug - bugLayerKeys.length) !== 1 ? 's' : ''} (hierarchy)</span>}
          {bugLayerKeys.length > 0 && <span className="bg-orange-50 text-orange-700 border border-orange-200 rounded-full px-3 py-1">{bugLayerKeys.length} Bug{bugLayerKeys.length !== 1 ? 's' : ''} (overlay)</span>}
        </div>
      )}

      {/* Empty state */}
      {allKeys.length === 0 && !pendingItem && (
        <div className="flex flex-col items-center justify-center py-24 text-slate-400 space-y-3">
          <GitBranch className="h-12 w-12 opacity-25" />
          <p className="text-lg font-semibold">No issues tracked yet</p>
          <p className="text-sm text-center max-w-sm leading-relaxed">
            Choose <strong>"Epic only"</strong> from the dropdown, search for an Epic, then select it to automatically load its Stories and Bugs into the hierarchical timeline.
          </p>
        </div>
      )}

      {/* Loading */}
      {allKeys.length > 0 && isFetching && (
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin text-indigo-500" />
          Loading timeline for {allKeys.length} issue{allKeys.length !== 1 ? 's' : ''}…
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error?.response?.data?.detail || 'Failed to load timeline data'}
          <button onClick={() => refetch()} className="ml-auto underline hover:no-underline shrink-0">Retry</button>
        </div>
      )}

      {/* Gantt */}
      {!isFetching && displayRows.length > 0 && (
        <div className="overflow-x-auto">
          <GanttChart rows={displayRows} />
        </div>
      )}

      {!isFetching && !error && allKeys.length > 0 && displayRows.length === 0 && (
        <p className="text-sm text-slate-400">No timeline data returned.</p>
      )}
    </div>
  )
}

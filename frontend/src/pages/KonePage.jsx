import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import {
  RefreshCw, ExternalLink, ChevronDown, ChevronRight,
  Bug, X, Loader2, CheckCircle, AlertCircle, Paperclip, Sparkles, Languages,
  TrendingUp, Clock, Users, AlertOctagon, Filter
} from 'lucide-react'

const API = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000'
const api = axios.create({ baseURL: API, timeout: 60000 })
const MAX_ATT_BYTES = 10 * 1024 * 1024  // 10 MB — larger files cause timeout on transfer

// ── Colours ──────────────────────────────────────────────────────────────────
const STATUS_COLORS = {
  'Open':                   'bg-blue-100 text-blue-800',
  'In Progress':            'bg-yellow-100 text-yellow-800',
  'Waiting for customer':   'bg-purple-100 text-purple-800',
  'Pending':                'bg-orange-100 text-orange-800',
  'Resolved':               'bg-green-100 text-green-800',
  'Closed':                 'bg-gray-100 text-gray-700',
}
const statusColor = (s) => STATUS_COLORS[s] || 'bg-gray-100 text-gray-700'

const JIRA_STATUS_COLORS = {
  'To Do':                 'bg-gray-100 text-gray-700',
  'Open':                  'bg-gray-100 text-gray-700',
  'In Progress':           'bg-blue-100 text-blue-700',
  'In Review':             'bg-indigo-100 text-indigo-700',
  'Ready for Testing':     'bg-purple-100 text-purple-700',
  'Validation':            'bg-violet-100 text-violet-700',
  'Ready For Deployment':  'bg-teal-100 text-teal-700',
  'Monitoring':            'bg-cyan-100 text-cyan-700',
  'Done':                  'bg-green-100 text-green-700',
  'Reopened':              'bg-orange-100 text-orange-700',
  'Blocked':               'bg-red-100 text-red-700',
}
const jiraStatusColor = (s) => JIRA_STATUS_COLORS[s] || 'bg-gray-100 text-gray-600'

const PRIORITY_COLORS = {
  'Critical':       'text-red-600 font-bold',
  'High':           'text-orange-500 font-semibold',
  'Medium':         'text-yellow-600',
  'Low':            'text-gray-500',
  'Low (migrated)': 'text-gray-400',
  'Normal':         'text-gray-500',
}
const priorityColor = (p) => PRIORITY_COLORS[p] || 'text-gray-500'

const CHART_PALETTE = [
  '#3B82F6','#10B981','#F59E0B','#EF4444','#8B5CF6',
  '#06B6D4','#F97316','#EC4899','#14B8A6','#84CC16',
  '#6366F1','#D97706','#0EA5E9','#A855F7','#22C55E',
]

// ── SVG Donut Chart ───────────────────────────────────────────────────────────
function DonutChart({ data, size = 200 }) {
  const total = data.reduce((s, d) => s + d.value, 0)
  if (!total) return null

  const cx = size / 2, cy = size / 2
  const R = size * 0.4, r = size * 0.25

  let angle = -Math.PI / 2
  const arcs = data.map(d => {
    if (d.value === 0) return null
    const start = angle
    const sweep = (d.value / total) * 2 * Math.PI
    angle += sweep
    const end = angle
    const large = sweep > Math.PI ? 1 : 0

    const x1 = cx + R * Math.cos(start), y1 = cy + R * Math.sin(start)
    const x2 = cx + R * Math.cos(end),   y2 = cy + R * Math.sin(end)
    const ix1 = cx + r * Math.cos(start), iy1 = cy + r * Math.sin(start)
    const ix2 = cx + r * Math.cos(end),   iy2 = cy + r * Math.sin(end)

    return {
      ...d,
      path: `M ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} L ${ix2} ${iy2} A ${r} ${r} 0 ${large} 0 ${ix1} ${iy1} Z`,
    }
  }).filter(Boolean)

  return (
    <svg width={size} height={size} className="shrink-0">
      {arcs.map((arc, i) => (
        <path key={i} d={arc.path} fill={arc.color} opacity={0.85} />
      ))}
      <text x={cx} y={cy - 8} textAnchor="middle" fontSize={size * 0.14} fontWeight="bold" fill="#111827">{total}</text>
      <text x={cx} y={cy + 12} textAnchor="middle" fontSize={size * 0.08} fill="#6B7280">tickets</text>
    </svg>
  )
}

// ── Highlight matched substring in red ───────────────────────────────────────
function HighlightText({ text, query }) {
  if (!query || !text) return <span>{text}</span>
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return <span>{text}</span>
  return (
    <span>
      {text.slice(0, idx)}
      <span className="text-red-600 font-bold">{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </span>
  )
}

// ── Fixed-position tooltip ────────────────────────────────────────────────────
function TooltipCell({ text, className, children }) {
  const [pos, setPos] = useState(null)
  return (
    <td className={className}
      onMouseEnter={e => {
        if (!text || text.length < 30) return
        const r = e.currentTarget.getBoundingClientRect()
        setPos({ top: r.bottom + 6, left: Math.min(r.left, window.innerWidth - 400) })
      }}
      onMouseLeave={() => setPos(null)}>
      {children}
      {pos && (
        <div className="fixed z-[9999] bg-slate-800 text-white text-xs rounded-lg px-3 py-2 shadow-xl pointer-events-none leading-relaxed whitespace-pre-wrap"
          style={{ top: pos.top, left: pos.left, maxWidth: 380 }}>
          {text}
          <div className="absolute -top-1.5 left-4 w-3 h-3 bg-slate-800 rotate-45" />
        </div>
      )}
    </td>
  )
}

// ── Jira Bug / Status / Fix Version cells (shared across all ticket tables) ───
function JiraBugCells({ link, ticket, onCreateBug }) {
  return (
    <>
      <td className="px-3 py-2 whitespace-nowrap">
        {link ? (
          <a href={link.jira_url} target="_blank" rel="noopener noreferrer"
            className="text-indigo-600 font-mono hover:underline text-xs font-medium">{link.jira_key} ↗</a>
        ) : (
          <button onClick={() => onCreateBug(ticket)}
            className="inline-flex items-center gap-1 text-xs text-red-600 border border-red-200 bg-red-50 hover:bg-red-100 rounded px-2 py-1 font-medium">
            <Bug className="h-3 w-3" />Create
          </button>
        )}
      </td>
      <td className="px-3 py-2 whitespace-nowrap">
        {link?.jira_status ? (
          <span className={`px-1.5 py-0.5 rounded text-xs ${jiraStatusColor(link.jira_status)}`}>{link.jira_status}</span>
        ) : (
          <span className="text-gray-300">—</span>
        )}
      </td>
      <td className="px-3 py-2 whitespace-nowrap text-gray-500">
        {link?.jira_fix_versions?.length ? link.jira_fix_versions.join(', ') : <span className="text-gray-300">—</span>}
      </td>
    </>
  )
}

// ── Sort + checkbox-filter table header (shared by all ticket tables) ────────
function ColumnFilterMenu({ options, selected, onChange }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const triggerRef = useRef(null)
  const dropdownRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const h = (e) => {
      if (triggerRef.current?.contains(e.target) || dropdownRef.current?.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const isActive = selected.size > 0
  const toggle = (val) => {
    const next = new Set(selected)
    if (next.has(val)) next.delete(val); else next.add(val)
    onChange(next)
  }

  return (
    <>
      <button ref={triggerRef} type="button"
        onClick={(e) => {
          e.stopPropagation()
          const r = triggerRef.current?.getBoundingClientRect()
          if (r) setPos({ top: r.bottom + 4, left: r.left })
          setOpen(o => !o)
        }}
        className={`p-0.5 rounded hover:bg-gray-200 ${isActive ? 'text-blue-600' : 'text-gray-300'}`}>
        <Filter className="h-3 w-3" />
      </button>
      {open && pos && createPortal(
        <div ref={dropdownRef} onClick={e => e.stopPropagation()}
          className="fixed z-[9999] bg-white border border-gray-200 rounded-lg shadow-2xl min-w-[170px] max-h-64 overflow-y-auto py-1 normal-case font-normal"
          style={{ top: pos.top, left: pos.left }}>
          {isActive && (
            <div onMouseDown={() => onChange(new Set())}
              className="px-3 py-1.5 text-xs text-blue-600 hover:bg-gray-50 cursor-pointer border-b border-gray-100 font-medium">
              Clear filter
            </div>
          )}
          {options.map(opt => (
            <label key={opt} onMouseDown={(e) => e.preventDefault()}
              className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 cursor-pointer">
              <input type="checkbox" className="h-3 w-3 text-blue-600 rounded"
                checked={selected.has(opt)} onChange={() => toggle(opt)} />
              {opt}
            </label>
          ))}
          {options.length === 0 && <div className="px-3 py-1.5 text-xs text-gray-400">No values</div>}
        </div>,
        document.body
      )}
    </>
  )
}

// ── Create Bug Modal ──────────────────────────────────────────────────────────
function CreateBugModal({ ticket, onClose, onCreated }) {
  const [form, setForm] = useState({
    summary: '', description: '', steps_to_reproduce: '',
    actual_result: '', expected_result: '',
    severity: 'Medium', environments: '',
    found_in_version_id: '', epic_key: '', fix_version_id: '',
    priority_name: '', sprint_id: '', assignee_id: '',
    attachments: [], comment: '',
  })
  const [submitting, setSubmitting] = useState(false)
  const [aiGenerating, setAiGenerating] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [epicSearch, setEpicSearch] = useState('')
  const [epicOpen, setEpicOpen] = useState(false)
  const [epicDropdownPos, setEpicDropdownPos] = useState(null)
  const [filteredEpics, setFilteredEpics] = useState([])
  const epicRef = useRef(null)
  const epicInputRef = useRef(null)
  const epicDropdownRef = useRef(null)

  const { data: meta } = useQuery({
    queryKey: ['kone-create-bug-meta'],
    queryFn: () => api.get('/api/kone/create-bug/meta').then(r => r.data),
    staleTime: 5 * 60 * 1000,
  })

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['kone-ticket-detail', ticket.key],
    queryFn: () => api.get(`/api/kone/ticket/${ticket.key}/detail`).then(r => r.data),
    staleTime: 5 * 60 * 1000,
  })

  useEffect(() => {
    if (detail) {
      setForm(f => ({
        ...f,
        summary:     f.summary     || detail.summary    || ticket.summary || '',
        description: f.description || detail.description || '',
        attachments: (detail.attachments || []).filter(a => a.size <= MAX_ATT_BYTES),
      }))
    }
  }, [detail])

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  const toggleAtt = (att) => setForm(f => {
    const exists = f.attachments.some(a => a.name === att.name)
    return { ...f, attachments: exists ? f.attachments.filter(a => a.name !== att.name) : [...f.attachments, att] }
  })
  const isAtt = (att) => form.attachments.some(a => a.name === att.name)

  // ── Sync filteredEpics when meta loads ──
  useEffect(() => {
    setFilteredEpics(meta?.epics || [])
  }, [meta])

  const epicQ = epicSearch.trim().toLowerCase()

  const applyEpicFilter = (query, allEpics) => {
    const q = query.trim().toLowerCase()
    if (!q) return allEpics
    return allEpics.filter(e =>
      (e.name || '').toLowerCase().includes(q) ||
      (e.key  || '').toLowerCase().includes(q)
    )
  }

  useEffect(() => {
    const h = (e) => {
      if (epicRef.current?.contains(e.target) || epicDropdownRef.current?.contains(e.target)) return
      setEpicOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const selectEpic = (key, name) => { set('epic_key', key); setEpicSearch(name); setEpicOpen(false) }

  const handleSubmit = async () => {
    if (!form.summary.trim()) { setError('Summary is required.'); return }
    setSubmitting(true); setError(null)
    try {
      const res = await api.post('/api/kone/create-bug', {
        kone_key: ticket.key, kone_url: ticket.url,
        summary: form.summary, description: form.description,
        steps_to_reproduce: form.steps_to_reproduce,
        actual_result: form.actual_result, expected_result: form.expected_result,
        severity: form.severity || 'Medium',
        environments: form.environments ? form.environments.split(',').map(s => s.trim()).filter(Boolean) : [],
        found_in_version_id: form.found_in_version_id || null,
        epic_key: form.epic_key || null,
        fix_version_id: form.fix_version_id || null,
        priority_name: form.priority_name || null,
        sprint_id: form.sprint_id ? Number(form.sprint_id) : null,
        assignee_id: form.assignee_id || null,
        attachments: form.attachments,
        comment: form.comment || null,
      }, { timeout: 300000 })
      setResult(res.data)
      onCreated?.(ticket.key, res.data)
    } catch (e) {
      setError(e.response?.data?.detail || e.message || 'Unknown error')
    } finally { setSubmitting(false) }
  }

  const generateWithAI = async () => {
    setAiGenerating(true); setError(null)
    try {
      const res = await api.post('/api/kone/ai-generate-bug-fields', {
        summary: form.summary, description: form.description,
      })
      setForm(f => ({
        ...f,
        summary:            res.data.summary            || f.summary,
        steps_to_reproduce: res.data.steps_to_reproduce || f.steps_to_reproduce,
        actual_result:      res.data.actual_result      || f.actual_result,
        expected_result:    res.data.expected_result    || f.expected_result,
      }))
    } catch (e) {
      setError(e.response?.data?.detail || e.message || 'AI generation failed')
    } finally { setAiGenerating(false) }
  }

  const F = ({ label, required, children }) => (
    <div>
      <label className="block text-xs font-semibold text-gray-600 mb-1">
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Bug className="h-5 w-5 text-red-500" />
            <span className="font-semibold text-gray-800">Create Jira Bug</span>
            <span className="text-xs text-gray-400 ml-1">from KONE {ticket.key}</span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X className="h-5 w-5" /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {detailLoading && (
            <div className="flex items-center justify-center py-8 gap-2 text-gray-500">
              <Loader2 className="h-5 w-5 animate-spin" /><span className="text-sm">Loading ticket data…</span>
            </div>
          )}

          {!detailLoading && result && (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <CheckCircle className="h-12 w-12 text-green-500" />
              <p className="text-lg font-semibold text-gray-800">Bug created!</p>
              <a href={result.url} target="_blank" rel="noopener noreferrer"
                className="text-blue-600 font-mono font-bold text-lg hover:underline">{result.key} ↗</a>

              {result.attachment_results?.length > 0 && (
                <div className="w-full max-w-sm text-left bg-gray-50 rounded-lg px-4 py-3 text-xs space-y-1">
                  <p className="font-semibold text-gray-600 mb-1.5">Attachments</p>
                  {result.attachment_results.map((r, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      {r.success
                        ? <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
                        : <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />}
                      <span className="truncate text-gray-700">{r.name}</span>
                      {!r.success && <span className="text-red-500 shrink-0">— failed</span>}
                    </div>
                  ))}
                </div>
              )}

              {result.comment_result && (
                <div className="w-full max-w-sm text-left bg-gray-50 rounded-lg px-4 py-3 text-xs flex items-center gap-1.5">
                  {result.comment_result.success
                    ? <CheckCircle className="h-3.5 w-3.5 text-green-500 shrink-0" />
                    : <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />}
                  <span className="text-gray-700">
                    {result.comment_result.success ? 'Comment posted' : 'Comment failed to post'}
                  </span>
                </div>
              )}

              <button onClick={onClose} className="mt-2 px-4 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Close</button>
            </div>
          )}

          {!detailLoading && !result && (
            <>
              <div className="bg-gray-50 rounded-lg px-4 py-3 text-xs text-gray-500 space-y-1">
                <p><span className="font-medium text-gray-700">KONE Ticket:</span> {ticket.key}</p>
                <p><span className="font-medium text-gray-700">Cliente:</span> {ticket.cliente}{ticket.cuenta ? ` · ${ticket.cuenta}` : ''}</p>
                <p><span className="font-medium text-gray-700">Producto:</span> {ticket.producto}{ticket.modulo ? ` / ${ticket.modulo}` : ''}</p>
                <a href={ticket.url} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-blue-600 hover:underline">
                  View in KONE Jira <ExternalLink className="h-3 w-3" />
                </a>
              </div>

              <F label="Summary" required>
                <input className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400"
                  value={form.summary} onChange={e => set('summary', e.target.value)} placeholder="Bug summary…" />
              </F>

              <F label="Description">
                <textarea rows={4}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400 resize-y"
                  value={form.description} onChange={e => set('description', e.target.value)} placeholder="Describe the issue…" />
              </F>

              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Bug Details</span>
                <button type="button" onClick={generateWithAI} disabled={aiGenerating || !form.summary}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-violet-50 text-violet-700 hover:bg-violet-100 disabled:opacity-50 transition-colors">
                  {aiGenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  {aiGenerating ? 'Generating…' : 'AI Generate'}
                </button>
              </div>

              <F label="Steps to Reproduce">
                <textarea rows={3}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400 resize-y"
                  value={form.steps_to_reproduce} onChange={e => set('steps_to_reproduce', e.target.value)}
                  placeholder="1. Go to…&#10;2. Click…&#10;3. Observe…" />
              </F>

              <div className="grid grid-cols-2 gap-3">
                <F label="Actual Result">
                  <textarea rows={3}
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400 resize-y"
                    value={form.actual_result} onChange={e => set('actual_result', e.target.value)}
                    placeholder="What actually happened…" />
                </F>
                <F label="Expected Result">
                  <textarea rows={3}
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400 resize-y"
                    value={form.expected_result} onChange={e => set('expected_result', e.target.value)}
                    placeholder="What should happen…" />
                </F>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <F label="Severity" required>
                  <select className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                    value={form.severity} onChange={e => set('severity', e.target.value)}>
                    {(meta?.severities || ['Critical','Highest','High','Medium','Low']).map(s => <option key={s}>{s}</option>)}
                  </select>
                </F>
                <F label="Environments (comma-sep)">
                  <input className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400"
                    value={form.environments} onChange={e => set('environments', e.target.value)}
                    placeholder="e.g. PROD, Staging" />
                </F>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {/* Epic — searchable with portal dropdown to escape overflow clipping */}
                <div ref={epicRef} className="col-span-2">
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Epic (Parent)</label>
                  <div className="relative">
                    <input type="text"
                      ref={epicInputRef}
                      className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 pr-8 focus:outline-none focus:border-blue-400"
                      placeholder="Search epic by name or key…"
                      value={epicSearch}
                      onChange={e => {
                        const val = e.target.value
                        setEpicSearch(val)
                        setFilteredEpics(applyEpicFilter(val, meta?.epics || []))
                        setEpicOpen(true)
                        const r = epicInputRef.current?.getBoundingClientRect()
                        if (r) setEpicDropdownPos({ top: r.bottom + 2, left: r.left, width: r.width })
                      }}
                      onFocus={() => {
                        setFilteredEpics(applyEpicFilter(epicSearch, meta?.epics || []))
                        setEpicOpen(true)
                        const r = epicInputRef.current?.getBoundingClientRect()
                        if (r) setEpicDropdownPos({ top: r.bottom + 2, left: r.left, width: r.width })
                      }}
                    />
                    {epicSearch && (
                      <button className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                        onMouseDown={() => { setEpicSearch(''); setFilteredEpics(meta?.epics || []); set('epic_key', ''); setEpicOpen(false) }}>
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  {epicOpen && epicDropdownPos && createPortal(
                    <div
                      ref={epicDropdownRef}
                      className="fixed z-[9999] bg-white border border-gray-200 rounded-lg shadow-2xl max-h-64 overflow-y-auto"
                      style={{ top: epicDropdownPos.top, left: epicDropdownPos.left, width: epicDropdownPos.width }}
                    >
                      <div className="px-3 py-2 text-xs text-gray-400 cursor-pointer hover:bg-gray-50"
                        onMouseDown={() => selectEpic('', '')}>— No epic —</div>
                      {filteredEpics.length === 0 ? (
                        <div className="px-3 py-3 text-sm text-gray-400 italic text-center">
                          No epics match "<span className="text-red-600 font-bold">{epicSearch}</span>"
                        </div>
                      ) : filteredEpics.map(e => (
                        <div key={e.key} onMouseDown={() => selectEpic(e.key, e.name)}
                          className={`px-3 py-2 text-sm cursor-pointer hover:bg-blue-50 flex items-center justify-between ${form.epic_key === e.key ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700'}`}>
                          <span className="truncate mr-2"><HighlightText text={e.name} query={epicSearch} /></span>
                          <span className="text-xs text-gray-400 shrink-0"><HighlightText text={e.key} query={epicSearch} /></span>
                        </div>
                      ))}
                      {filteredEpics.length > 0 && (
                        <div className="px-3 py-1.5 text-xs text-gray-400 border-t border-gray-100">
                          {filteredEpics.length} epic{filteredEpics.length !== 1 ? 's' : ''}{epicQ ? ` matching "${epicSearch}"` : ' total'}
                        </div>
                      )}
                    </div>,
                    document.body
                  )}
                </div>

                <F label="Fix Version">
                  <select className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                    value={form.fix_version_id} onChange={e => set('fix_version_id', e.target.value)}>
                    <option value="">— No version —</option>
                    {(meta?.fix_versions || []).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </F>

                <F label="Found In Version">
                  <select className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                    value={form.found_in_version_id} onChange={e => set('found_in_version_id', e.target.value)}>
                    <option value="">— Unknown —</option>
                    {(meta?.found_in_versions || []).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </F>

                <F label="Priority">
                  <select className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                    value={form.priority_name} onChange={e => set('priority_name', e.target.value)}>
                    <option value="">— Default —</option>
                    {(meta?.priorities || []).map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
                  </select>
                </F>

                <F label="Assign To">
                  <select className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                    value={form.assignee_id} onChange={e => set('assignee_id', e.target.value)}>
                    <option value="">— Unassigned —</option>
                    {(meta?.assignees || []).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </F>

                <div className="col-span-2">
                  <F label="Sprint">
                    <select className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                      value={form.sprint_id} onChange={e => set('sprint_id', e.target.value)}>
                      <option value="">— No sprint —</option>
                      {(meta?.sprints || []).map(s => <option key={s.id} value={s.id}>{s.name}{s.state === 'active' ? ' ✓' : ''}</option>)}
                    </select>
                  </F>
                </div>
              </div>

              {/* Attachments */}
              {detail?.attachments?.length > 0 && (
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-2">
                    <Paperclip className="h-3.5 w-3.5 inline mr-1" />Attachments from KONE
                    <span className="font-normal text-gray-400 ml-1">— checked items will be copied to the TMT0 bug</span>
                  </label>
                  <div className="space-y-1.5">
                    {detail.attachments.map(att => {
                      const proxyUrl = `${API}/api/kone/ticket/${ticket.key}/attachment/${att.id}`
                      const isImage = (att.content_type || '').startsWith('image/')
                      const tooBig = att.size > MAX_ATT_BYTES
                      return (
                        <div key={att.id || att.name}
                          className="flex items-center gap-2.5 hover:bg-gray-50 rounded px-2 py-1">
                          <label className={`flex items-center gap-2.5 cursor-pointer flex-1 min-w-0 ${tooBig ? 'opacity-60' : ''}`}>
                            <input type="checkbox" className="h-3.5 w-3.5 text-blue-600 rounded shrink-0"
                              checked={isAtt(att)} onChange={() => toggleAtt(att)} />
                            {isImage ? (
                              <img src={proxyUrl} alt={att.name}
                                className="h-10 w-10 rounded object-cover border border-gray-200 shrink-0" />
                            ) : (
                              <Paperclip className="h-4 w-4 text-gray-400 shrink-0" />
                            )}
                            <span className="text-sm text-gray-700 truncate">{att.name}</span>
                            {att.size > 0 && (
                              <span className={`text-xs shrink-0 ${tooBig ? 'text-red-500 font-medium' : 'text-gray-400'}`}>
                                ({att.size > 1024 * 1024 ? `${(att.size / (1024 * 1024)).toFixed(0)} MB` : `${(att.size / 1024).toFixed(0)} KB`})
                                {tooBig && ' — too large'}
                              </span>
                            )}
                          </label>
                          <a href={proxyUrl} target="_blank" rel="noopener noreferrer"
                            className="text-xs text-blue-600 hover:underline shrink-0">Preview ↗</a>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              <F label="Comment">
                <textarea rows={2}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400 resize-y"
                  value={form.comment} onChange={e => set('comment', e.target.value)}
                  placeholder="Optional — posted as the first comment on the new TMT0 bug…" />
              </F>

              {error && (
                <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" /><span>{error}</span>
                </div>
              )}
            </>
          )}
        </div>

        {!result && !detailLoading && (
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
            <button onClick={onClose} disabled={submitting}
              className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">Cancel</button>
            <button onClick={handleSubmit} disabled={submitting || !form.summary.trim()}
              className="inline-flex items-center gap-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors">
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bug className="h-4 w-4" />}
              {submitting ? 'Creating…' : 'Create Bug in Jira'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Dashboard Tab ─────────────────────────────────────────────────────────────
function DashboardTab({ tickets, bugLinks, onCreateBug }) {
  const [days, setDays] = useState(7)

  const clienteData = useMemo(() => {
    const map = {}
    tickets.forEach(t => { const c = t.cliente || 'Unknown'; map[c] = (map[c] || 0) + 1 })
    return Object.entries(map).sort(([,a],[,b]) => b - a)
      .map(([label, value], i) => ({ label, value, color: CHART_PALETTE[i % CHART_PALETTE.length] }))
  }, [tickets])

  const statusData = useMemo(() => {
    const map = {}
    tickets.forEach(t => { const s = t.status || 'Unknown'; map[s] = (map[s] || 0) + 1 })
    return Object.entries(map).sort(([,a],[,b]) => b - a)
  }, [tickets])

  const recentTickets = useMemo(() =>
    tickets.filter(t => t.days_open <= days).sort((a, b) => a.days_open - b.days_open)
  , [tickets, days])

  const overdueTickets = useMemo(() =>
    [...tickets].filter(t => t.days_open > 14).sort((a, b) => b.days_open - a.days_open).slice(0, 15)
  , [tickets])

  const unassigned = tickets.filter(t => !t.assignee).length
  const withBug    = Object.keys(bugLinks || {}).length
  const maxBar     = Math.max(...statusData.map(([,c]) => c), 1)

  return (
    <div className="space-y-6">
      {/* Row 1: Donut + Status breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* Donut — by Cliente */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-700 mb-4">Tickets by Cliente</h3>
          <div className="flex items-start gap-5">
            <DonutChart data={clienteData} size={180} />
            <div className="flex-1 space-y-1.5 overflow-y-auto max-h-44">
              {clienteData.map(d => (
                <div key={d.label} className="flex items-center gap-2 text-xs">
                  <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: d.color }} />
                  <span className="flex-1 truncate text-gray-700">{d.label}</span>
                  <span className="font-semibold text-gray-800">{d.value}</span>
                  <span className="text-gray-400 w-10 text-right">{((d.value / tickets.length) * 100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Status breakdown + quick stats */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm space-y-4">
          <h3 className="text-sm font-semibold text-gray-700">Status Breakdown</h3>
          <div className="space-y-2">
            {statusData.map(([status, count]) => (
              <div key={status} className="flex items-center gap-2 text-xs">
                <span className="w-28 shrink-0 text-gray-600 truncate">{status}</span>
                <div className="flex-1 bg-gray-100 rounded-full h-2.5 overflow-hidden">
                  <div className="h-full rounded-full bg-blue-500"
                    style={{ width: `${(count / maxBar) * 100}%` }} />
                </div>
                <span className="font-semibold text-gray-800 w-8 text-right">{count}</span>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2 pt-2 border-t border-gray-100">
            <div className="bg-orange-50 rounded-lg p-3 text-center">
              <div className="text-xl font-bold text-orange-600">{unassigned}</div>
              <div className="text-xs text-orange-500">Unassigned</div>
            </div>
            <div className="bg-indigo-50 rounded-lg p-3 text-center">
              <div className="text-xl font-bold text-indigo-600">{withBug}</div>
              <div className="text-xs text-indigo-500">Linked to Jira Bug</div>
            </div>
          </div>
        </div>
      </div>

      {/* Row 2: Recent tickets */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-blue-500" />
            <h3 className="text-sm font-semibold text-gray-700">Recent Tickets</h3>
            <span className="text-xs text-gray-400">({recentTickets.length})</span>
          </div>
          <div className="flex gap-1">
            {[1, 7, 30].map(d => (
              <button key={d} onClick={() => setDays(d)}
                className={`px-3 py-1 text-xs font-medium rounded-lg transition-colors ${days === d ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                {d === 1 ? 'Today' : `${d}d`}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                {['Key','Summary','Status','Cliente','Cuenta','Producto','Assignee','Days Open','Jira Bug','Jira Status','Fix Version'].map(h => (
                  <th key={h} className="px-3 py-2 text-left text-gray-600 font-medium whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recentTickets.slice(0, 30).map(t => {
                const link = bugLinks?.[t.key]
                return (
                  <tr key={t.key} className="border-t border-gray-50 hover:bg-gray-50">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <a href={t.url} target="_blank" rel="noopener noreferrer"
                        className="text-blue-600 hover:underline font-mono">{t.key}</a>
                    </td>
                    <TooltipCell text={t.summary} className="px-3 py-2 max-w-[220px] cursor-default">
                      <span className="block truncate">{t.summary}</span>
                    </TooltipCell>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={`px-1.5 py-0.5 rounded text-xs ${statusColor(t.status)}`}>{t.status}</span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-700">{t.cliente}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-500">{t.cuenta}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-700">{t.producto}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-500">{t.assignee || <span className="text-orange-400">Unassigned</span>}</td>
                    <td className="px-3 py-2 text-center">
                      <span className="text-blue-600 font-semibold">{t.days_open}d</span>
                    </td>
                    <JiraBugCells link={link} ticket={t} onCreateBug={onCreateBug} />
                  </tr>
                )
              })}
              {recentTickets.length === 0 && (
                <tr><td colSpan={11} className="text-center py-8 text-gray-400">No tickets in last {days} day{days !== 1 ? 's' : ''}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Row 3: Most overdue */}
      {overdueTickets.length > 0 && (
        <div className="bg-white rounded-xl border border-red-100 shadow-sm">
          <div className="flex items-center gap-2 px-5 py-4 border-b border-red-100">
            <AlertOctagon className="h-4 w-4 text-red-500" />
            <h3 className="text-sm font-semibold text-red-700">Most Overdue (&gt;14 days open)</h3>
            <span className="text-xs text-red-400">({overdueTickets.length})</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-red-50">
                <tr>
                  {['Key','Summary','Days Open','Status','Cliente','Cuenta','Producto','Assignee','Jira Bug','Jira Status','Fix Version'].map(h => (
                    <th key={h} className="px-3 py-2 text-left text-red-700 font-medium whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {overdueTickets.map(t => {
                  const link = bugLinks?.[t.key]
                  return (
                    <tr key={t.key} className="border-t border-red-50 hover:bg-red-50">
                      <td className="px-3 py-2 whitespace-nowrap">
                        <a href={t.url} target="_blank" rel="noopener noreferrer"
                          className="text-blue-600 hover:underline font-mono">{t.key}</a>
                      </td>
                      <TooltipCell text={t.summary} className="px-3 py-2 max-w-[240px] cursor-default">
                        <span className="block truncate">{t.summary}</span>
                      </TooltipCell>
                      <td className="px-3 py-2 text-center">
                        <span className={`font-bold ${t.days_open > 30 ? 'text-red-700' : 'text-orange-600'}`}>{t.days_open}d</span>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className={`px-1.5 py-0.5 rounded text-xs ${statusColor(t.status)}`}>{t.status}</span>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-gray-700">{t.cliente}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-gray-500">{t.cuenta}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-gray-700">{t.producto}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-gray-500">{t.assignee || <span className="text-orange-400">Unassigned</span>}</td>
                      <JiraBugCells link={link} ticket={t} onCreateBug={onCreateBug} />
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

// ── By Cliente Tab ────────────────────────────────────────────────────────────
function ByClienteTab({ tickets, clienteGroups, bugLinks, onCreateBug }) {
  const [selectedCliente, setSelectedCliente] = useState(null)
  const [statusFilter, setStatusFilter] = useState(new Set())
  const [priorityFilter, setPriorityFilter] = useState(new Set())
  const [cuentaFilter, setCuentaFilter] = useState(new Set())
  const [productoFilter, setProductoFilter] = useState(new Set())
  const [assigneeFilter, setAssigneeFilter] = useState(new Set())
  const [jiraStatusFilter, setJiraStatusFilter] = useState(new Set())
  const [fixVersionFilter, setFixVersionFilter] = useState(new Set())
  const [sortCol, setSortCol] = useState('created')
  const [sortDir, setSortDir] = useState('desc')

  const jiraStatusOf = t => bugLinks?.[t.key]?.jira_status || ''
  const fixVersionsOf = t => bugLinks?.[t.key]?.jira_fix_versions || []

  const options = useMemo(() => ({
    statuses:     [...new Set(tickets.map(t => t.status).filter(Boolean))].sort(),
    priorities:   [...new Set(tickets.map(t => t.priority).filter(Boolean))].sort(),
    cuentas:      [...new Set(tickets.map(t => t.cuenta).filter(Boolean))].sort(),
    productos:    [...new Set(tickets.map(t => t.producto).filter(Boolean))].sort(),
    assignees:    [...new Set(tickets.map(t => t.assignee).filter(Boolean))].sort(),
    jiraStatuses: [...new Set(tickets.map(jiraStatusOf).filter(Boolean))].sort(),
    fixVersions:  [...new Set(tickets.flatMap(fixVersionsOf))].sort(),
  }), [tickets, bugLinks])

  const filteredTickets = useMemo(() => {
    let list = tickets
    if (selectedCliente)      list = list.filter(t => t.cliente === selectedCliente)
    if (statusFilter.size)    list = list.filter(t => statusFilter.has(t.status))
    if (priorityFilter.size)  list = list.filter(t => priorityFilter.has(t.priority))
    if (cuentaFilter.size)    list = list.filter(t => cuentaFilter.has(t.cuenta))
    if (productoFilter.size)  list = list.filter(t => productoFilter.has(t.producto))
    if (assigneeFilter.size)  list = list.filter(t => assigneeFilter.has(t.assignee))
    if (jiraStatusFilter.size) list = list.filter(t => jiraStatusFilter.has(jiraStatusOf(t)))
    if (fixVersionFilter.size) list = list.filter(t => fixVersionsOf(t).some(v => fixVersionFilter.has(v)))
    return [...list].sort((a, b) => {
      let av, bv
      if (sortCol === 'jira_key') { av = bugLinks?.[a.key]?.jira_key || ''; bv = bugLinks?.[b.key]?.jira_key || '' }
      else if (sortCol === 'jira_status') { av = jiraStatusOf(a); bv = jiraStatusOf(b) }
      else if (sortCol === 'fix_version') { av = fixVersionsOf(a).join(', '); bv = fixVersionsOf(b).join(', ') }
      else { av = a[sortCol] || ''; bv = b[sortCol] || '' }
      if (sortCol === 'days_open') { av = Number(av); bv = Number(bv) }
      const cmp = typeof av === 'number' ? av - bv : av < bv ? -1 : av > bv ? 1 : 0
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [tickets, selectedCliente, statusFilter, priorityFilter, cuentaFilter, productoFilter, assigneeFilter, jiraStatusFilter, fixVersionFilter, sortCol, sortDir, bugLinks])

  const toggleSort = col => { if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortCol(col); setSortDir('desc') } }
  const si = col => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''
  const th = (label, col, filterCfg) => (
    <th className="text-left px-3 py-2 text-gray-600 font-medium whitespace-nowrap">
      <span className="inline-flex items-center gap-1">
        <span className="cursor-pointer hover:text-gray-900" onClick={() => toggleSort(col)}>{label}{si(col)}</span>
        {filterCfg && <ColumnFilterMenu options={filterCfg.options} selected={filterCfg.selected} onChange={filterCfg.onChange} />}
      </span>
    </th>
  )

  const anyFilterActive = [statusFilter, priorityFilter, cuentaFilter, productoFilter, assigneeFilter, jiraStatusFilter, fixVersionFilter].some(s => s.size > 0)
  const clearAllFilters = () => {
    setStatusFilter(new Set()); setPriorityFilter(new Set()); setCuentaFilter(new Set())
    setProductoFilter(new Set()); setAssigneeFilter(new Set()); setJiraStatusFilter(new Set()); setFixVersionFilter(new Set())
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
        {clienteGroups.map(g => {
          const sel = selectedCliente === g.cliente
          return (
            <div key={g.cliente}
              className={`border rounded-xl p-4 cursor-pointer transition-all ${sel ? 'border-blue-500 bg-blue-50 shadow-md' : 'border-gray-200 bg-white hover:border-blue-300'}`}
              onClick={() => setSelectedCliente(sel ? null : g.cliente)}>
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-gray-900 text-sm">{g.cliente || 'Unknown'}</h3>
                  {g.cuentas?.length > 0 && <p className="text-xs text-gray-500 mt-0.5">{g.cuentas.join(' · ')}</p>}
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-2xl font-bold text-blue-600">{g.total}</span>
                  {sel ? <ChevronDown className="h-4 w-4 text-gray-400 mt-1" /> : <ChevronRight className="h-4 w-4 text-gray-400 mt-1" />}
                </div>
              </div>
              <div className="flex flex-wrap gap-1 mt-3">
                {g.statuses?.map(s => (
                  <span key={s.status} className={`text-xs px-2 py-0.5 rounded-full ${statusColor(s.status)}`}>
                    {s.status}: {s.count}
                  </span>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <span className="text-sm font-medium text-gray-700">
            {selectedCliente ? `${selectedCliente} — ` : 'All — '}{filteredTickets.length} ticket{filteredTickets.length !== 1 ? 's' : ''}
          </span>
          <div className="flex items-center gap-2">
            {anyFilterActive && <button onClick={clearAllFilters} className="text-xs text-blue-500 hover:underline">Clear filters</button>}
            {selectedCliente && <button onClick={() => setSelectedCliente(null)} className="text-xs text-blue-500 hover:underline">Clear cliente</button>}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                {th('Key', 'key')}
                {th('Summary', 'summary')}
                {th('Status', 'status', { options: options.statuses, selected: statusFilter, onChange: setStatusFilter })}
                {th('Priority', 'priority', { options: options.priorities, selected: priorityFilter, onChange: setPriorityFilter })}
                {th('Cliente', 'cliente')}
                {th('Cuenta', 'cuenta', { options: options.cuentas, selected: cuentaFilter, onChange: setCuentaFilter })}
                {th('Producto', 'producto', { options: options.productos, selected: productoFilter, onChange: setProductoFilter })}
                {th('Assignee', 'assignee', { options: options.assignees, selected: assigneeFilter, onChange: setAssigneeFilter })}
                {th('Days Open', 'days_open')}
                {th('Jira Bug', 'jira_key')}
                {th('Jira Status', 'jira_status', { options: options.jiraStatuses, selected: jiraStatusFilter, onChange: setJiraStatusFilter })}
                {th('Fix Version', 'fix_version', { options: options.fixVersions, selected: fixVersionFilter, onChange: setFixVersionFilter })}
              </tr>
            </thead>
            <tbody>
              {filteredTickets.map(t => {
                const link = bugLinks?.[t.key]
                return (
                  <tr key={t.key} className="border-t border-gray-50 hover:bg-gray-50">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <a href={t.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline font-mono">{t.key}</a>
                    </td>
                    <TooltipCell text={t.summary} className="px-3 py-2 max-w-[240px] cursor-default">
                      <span className="block truncate">{t.summary}</span>
                    </TooltipCell>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={`px-1.5 py-0.5 rounded text-xs ${statusColor(t.status)}`}>{t.status}</span>
                    </td>
                    <td className={`px-3 py-2 whitespace-nowrap ${priorityColor(t.priority)}`}>{t.priority}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{t.cliente}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{t.cuenta}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{t.producto}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{t.assignee || <span className="text-orange-400">—</span>}</td>
                    <td className="px-3 py-2 text-center">
                      <span className={t.days_open > 14 ? 'text-red-600 font-semibold' : 'text-gray-500'}>{t.days_open}d</span>
                    </td>
                    <JiraBugCells link={link} ticket={t} onCreateBug={onCreateBug} />
                  </tr>
                )
              })}
              {filteredTickets.length === 0 && <tr><td colSpan={12} className="text-center py-8 text-gray-400">No tickets</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ── All Tickets Tab ───────────────────────────────────────────────────────────
function AllTicketsTab({ tickets, bugLinks, onCreateBug, translations, isTranslating, translateOn }) {
  const [search, setSearch]                 = useState('')
  const [statusFilter, setStatusFilter]     = useState(new Set())
  const [priorityFilter, setPriorityFilter] = useState(new Set())
  const [clienteFilter, setClienteFilter]   = useState(new Set())
  const [cuentaFilter, setCuentaFilter]     = useState(new Set())
  const [productoFilter, setProductoFilter] = useState(new Set())
  const [assigneeFilter, setAssigneeFilter] = useState(new Set())
  const [jiraStatusFilter, setJiraStatusFilter] = useState(new Set())
  const [fixVersionFilter, setFixVersionFilter] = useState(new Set())
  const [sortCol, setSortCol]         = useState('created')
  const [sortDir, setSortDir]         = useState('desc')
  const [page, setPage]               = useState(1)
  const PAGE_SIZE = 50

  const jiraStatusOf = t => bugLinks?.[t.key]?.jira_status || ''
  const fixVersionsOf = t => bugLinks?.[t.key]?.jira_fix_versions || []

  const options = useMemo(() => ({
    statuses:     [...new Set(tickets.map(t => t.status).filter(Boolean))].sort(),
    priorities:   [...new Set(tickets.map(t => t.priority).filter(Boolean))].sort(),
    clientes:     [...new Set(tickets.map(t => t.cliente).filter(Boolean))].sort(),
    cuentas:      [...new Set(tickets.map(t => t.cuenta).filter(Boolean))].sort(),
    productos:    [...new Set(tickets.map(t => t.producto).filter(Boolean))].sort(),
    assignees:    [...new Set(tickets.map(t => t.assignee).filter(Boolean))].sort(),
    jiraStatuses: [...new Set(tickets.map(jiraStatusOf).filter(Boolean))].sort(),
    fixVersions:  [...new Set(tickets.flatMap(fixVersionsOf))].sort(),
  }), [tickets, bugLinks])

  const tr = (text) => (translateOn && translations[text]) ? translations[text] : text

  const filtered = useMemo(() => {
    let list = tickets
    if (search) list = list.filter(t => `${t.key} ${t.summary} ${t.assignee} ${t.reporter}`.toLowerCase().includes(search.toLowerCase()))
    if (statusFilter.size)     list = list.filter(t => statusFilter.has(t.status))
    if (priorityFilter.size)   list = list.filter(t => priorityFilter.has(t.priority))
    if (clienteFilter.size)    list = list.filter(t => clienteFilter.has(t.cliente))
    if (cuentaFilter.size)     list = list.filter(t => cuentaFilter.has(t.cuenta))
    if (productoFilter.size)   list = list.filter(t => productoFilter.has(t.producto))
    if (assigneeFilter.size)   list = list.filter(t => assigneeFilter.has(t.assignee))
    if (jiraStatusFilter.size) list = list.filter(t => jiraStatusFilter.has(jiraStatusOf(t)))
    if (fixVersionFilter.size) list = list.filter(t => fixVersionsOf(t).some(v => fixVersionFilter.has(v)))
    return [...list].sort((a, b) => {
      let av, bv
      if (sortCol === 'jira_key') { av = bugLinks?.[a.key]?.jira_key || ''; bv = bugLinks?.[b.key]?.jira_key || '' }
      else if (sortCol === 'jira_status') { av = jiraStatusOf(a); bv = jiraStatusOf(b) }
      else if (sortCol === 'fix_version') { av = fixVersionsOf(a).join(', '); bv = fixVersionsOf(b).join(', ') }
      else { av = a[sortCol] || ''; bv = b[sortCol] || '' }
      if (sortCol === 'days_open') { av = Number(av); bv = Number(bv) }
      const cmp = typeof av === 'number' ? av - bv : av < bv ? -1 : av > bv ? 1 : 0
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [tickets, search, statusFilter, priorityFilter, clienteFilter, cuentaFilter, productoFilter, assigneeFilter, jiraStatusFilter, fixVersionFilter, sortCol, sortDir, bugLinks])

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE)
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const toggleSort = col => { if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc'); else { setSortCol(col); setSortDir('desc') }; setPage(1) }
  const si = col => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''
  const wrapFilter = (setter) => (next) => { setter(next); setPage(1) }
  const th = (label, col, filterCfg) => (
    <th className="text-left px-3 py-2 text-gray-600 font-medium whitespace-nowrap">
      <span className="inline-flex items-center gap-1">
        <span className="cursor-pointer hover:text-gray-900" onClick={() => toggleSort(col)}>{label}{si(col)}</span>
        {filterCfg && <ColumnFilterMenu options={filterCfg.options} selected={filterCfg.selected} onChange={wrapFilter(filterCfg.onChange)} />}
      </span>
    </th>
  )

  const anyFilterActive = [statusFilter, priorityFilter, clienteFilter, cuentaFilter, productoFilter, assigneeFilter, jiraStatusFilter, fixVersionFilter].some(s => s.size > 0)
  const clearAllFilters = () => {
    setStatusFilter(new Set()); setPriorityFilter(new Set()); setClienteFilter(new Set()); setCuentaFilter(new Set())
    setProductoFilter(new Set()); setAssigneeFilter(new Set()); setJiraStatusFilter(new Set()); setFixVersionFilter(new Set())
    setPage(1)
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-gray-100">
        <input type="text" placeholder="Search key / summary / assignee…" value={search}
          onChange={e => { setSearch(e.target.value); setPage(1) }}
          className="text-xs border border-gray-200 rounded px-2 py-1 w-52" />
        {anyFilterActive && <button onClick={clearAllFilters} className="text-xs text-blue-500 hover:underline">Clear filters</button>}
        {isTranslating && <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-500" />}
        <span className="ml-auto text-xs text-gray-500">{filtered.length} tickets</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-50">
            <tr>
              {th('Key', 'key')}
              {th('Summary', 'summary')}
              {th('Status', 'status', { options: options.statuses, selected: statusFilter, onChange: setStatusFilter })}
              {th('Priority', 'priority', { options: options.priorities, selected: priorityFilter, onChange: setPriorityFilter })}
              {th('Cliente', 'cliente', { options: options.clientes, selected: clienteFilter, onChange: setClienteFilter })}
              {th('Site', 'cliente_site')}
              {th('Cuenta', 'cuenta', { options: options.cuentas, selected: cuentaFilter, onChange: setCuentaFilter })}
              {th('Producto', 'producto', { options: options.productos, selected: productoFilter, onChange: setProductoFilter })}
              {th('Módulo', 'modulo')}
              {th('Urgency', 'urgency')}
              {th('Assignee', 'assignee', { options: options.assignees, selected: assigneeFilter, onChange: setAssigneeFilter })}
              {th('Reporter', 'reporter')}
              {th('Days Open', 'days_open')}
              {th('Created', 'created')}
              {th('Jira Bug', 'jira_key')}
              {th('Jira Status', 'jira_status', { options: options.jiraStatuses, selected: jiraStatusFilter, onChange: setJiraStatusFilter })}
              {th('Fix Version', 'fix_version', { options: options.fixVersions, selected: fixVersionFilter, onChange: setFixVersionFilter })}
            </tr>
          </thead>
          <tbody>
            {paged.map(t => {
              const link = bugLinks?.[t.key]
              const disp = tr(t.summary)
              return (
                <tr key={t.key} className="border-t border-gray-50 hover:bg-gray-50">
                  <td className="px-3 py-2 whitespace-nowrap">
                    <a href={t.url} target="_blank" rel="noopener noreferrer"
                      className="text-blue-600 hover:underline font-mono flex items-center gap-1">
                      {t.key}<ExternalLink className="h-2.5 w-2.5 opacity-60" />
                    </a>
                  </td>
                  <TooltipCell text={disp} className="px-3 py-2 max-w-[260px] cursor-default">
                    <span className="block truncate">{disp}</span>
                  </TooltipCell>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={`px-1.5 py-0.5 rounded text-xs ${statusColor(t.status)}`}>{t.status}</span>
                  </td>
                  <td className={`px-3 py-2 whitespace-nowrap ${priorityColor(t.priority)}`}>{t.priority}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-700">{t.cliente}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-500">{t.cliente_site}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-700">{t.cuenta}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-700">{t.producto}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-500">{t.modulo}</td>
                  <td className={`px-3 py-2 whitespace-nowrap ${priorityColor(t.urgency)}`}>{t.urgency}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-700">{t.assignee || <span className="text-orange-400">—</span>}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-500">{t.reporter}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={t.days_open > 14 ? 'text-red-600 font-semibold' : 'text-gray-500'}>{t.days_open}d</span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-500">{t.created ? t.created.slice(0,10) : ''}</td>
                  <JiraBugCells link={link} ticket={t} onCreateBug={onCreateBug} />
                </tr>
              )
            })}
            {paged.length === 0 && <tr><td colSpan={17} className="text-center py-8 text-gray-400">No tickets match filters</td></tr>}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 text-xs">
          <button disabled={page === 1} onClick={() => setPage(p => p - 1)}
            className="px-3 py-1 border rounded disabled:opacity-40 hover:bg-gray-50">Previous</button>
          <span className="text-gray-500">Page {page} of {totalPages}</span>
          <button disabled={page === totalPages} onClick={() => setPage(p => p + 1)}
            className="px-3 py-1 border rounded disabled:opacity-40 hover:bg-gray-50">Next</button>
        </div>
      )}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function KonePage() {
  const [tab, setTab] = useState('dashboard')
  const [refreshKey, setRefreshKey] = useState(0)
  const [createBugTicket, setCreateBugTicket] = useState(null)
  const [translateOn, setTranslateOn] = useState(false)
  const [translations, setTranslations] = useState({})
  const [isTranslating, setIsTranslating] = useState(false)
  const translationsRef = useRef({})
  translationsRef.current = translations

  const translateTexts = useCallback(async (texts) => {
    const untranslated = [...new Set(texts)].filter(t => t && t.trim() && !translationsRef.current[t])
    if (!untranslated.length) return
    setIsTranslating(true)
    try {
      const res = await api.post('/api/mexico-qa/translate', { texts: untranslated })
      setTranslations(prev => ({ ...prev, ...res.data.translations }))
    } catch (e) { console.error('Translation failed:', e) }
    finally { setIsTranslating(false) }
  }, [])

  const { data: ticketsData, isLoading: loadingTickets, error: ticketsError, refetch: refetchTickets } =
    useQuery({ queryKey: ['kone-tickets', refreshKey], queryFn: () => api.get('/api/kone/tickets').then(r => r.data), staleTime: 5 * 60 * 1000 })

  const { data: clienteData, isLoading: loadingCliente, refetch: refetchCliente } =
    useQuery({ queryKey: ['kone-by-cliente', refreshKey], queryFn: () => api.get('/api/kone/by-cliente').then(r => r.data), staleTime: 5 * 60 * 1000 })

  const { data: bugLinks, refetch: refetchBugLinks } =
    useQuery({ queryKey: ['kone-bug-links'], queryFn: () => api.get('/api/kone/bug-links').then(r => r.data), staleTime: 60 * 1000 })

  useEffect(() => {
    if (!translateOn || !ticketsData?.tickets?.length) return
    translateTexts(ticketsData.tickets.map(t => t.summary).filter(Boolean))
  }, [translateOn, ticketsData?.tickets, translateTexts])

  const handleRefresh = async () => {
    setRefreshKey(k => k + 1)
    await Promise.all([api.get('/api/kone/tickets?refresh=true'), api.get('/api/kone/by-cliente?refresh=true')])
    await Promise.all([refetchTickets(), refetchCliente(), refetchBugLinks()])
  }

  const handleBugCreated = () => refetchBugLinks()

  const tickets       = ticketsData?.tickets || []
  const clienteGroups = clienteData?.groups  || []
  const isLoading     = loadingTickets || loadingCliente

  const totalOpen      = tickets.length
  const openCount      = tickets.filter(t => t.status === 'Open').length
  const pendingCount   = tickets.filter(t => t.status === 'Pending').length
  const inProgress     = tickets.filter(t => t.status === 'In Progress').length
  const overdue        = tickets.filter(t => t.days_open > 14).length
  const uniqueClientes = new Set(tickets.map(t => t.cliente).filter(Boolean)).size

  const TABS = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'cliente',   label: 'By Cliente' },
    { id: 'all',       label: `All Tickets (${totalOpen})` },
  ]

  return (
    <div className="p-6 space-y-5">
      {createBugTicket && (
        <CreateBugModal ticket={createBugTicket} onClose={() => setCreateBugTicket(null)} onCreated={handleBugCreated} />
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">K1-Support</h1>
          <p className="text-sm text-gray-500 mt-0.5">kabatone-ops-it.atlassian.net · All open tickets</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setTranslateOn(v => !v)} title="Translate Spanish → English"
            className={`flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border transition-colors ${translateOn ? 'bg-violet-600 text-white border-violet-600' : 'bg-white text-gray-600 border-gray-200 hover:border-violet-400'}`}>
            <Languages className="h-4 w-4" />
            {translateOn ? 'ES→EN On' : 'ES→EN'}
          </button>
          <button onClick={handleRefresh} disabled={isLoading}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40">
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
        {[
          { label: 'Total Open',  value: totalOpen,      color: 'text-blue-600' },
          { label: 'Open',        value: openCount,      color: 'text-blue-500' },
          { label: 'Pending',     value: pendingCount,   color: 'text-orange-500' },
          { label: 'In Progress', value: inProgress,     color: 'text-yellow-600' },
          { label: '>14d Open',   value: overdue,        color: 'text-red-600' },
          { label: 'Clientes',    value: uniqueClientes, color: 'text-gray-700' },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-xl border border-gray-200 p-4 text-center shadow-sm">
            <div className={`text-2xl font-bold ${s.color}`}>{isLoading ? '—' : s.value}</div>
            <div className="text-xs text-gray-500 mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      {ticketsError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
          Failed to load tickets: {ticketsError.message}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === t.id ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-48 text-gray-400">
          <RefreshCw className="h-6 w-6 animate-spin mr-2" />Loading K1-Support tickets…
        </div>
      ) : (
        <>
          {tab === 'dashboard' && <DashboardTab tickets={tickets} bugLinks={bugLinks || {}} onCreateBug={setCreateBugTicket} />}
          {tab === 'cliente'   && <ByClienteTab tickets={tickets} clienteGroups={clienteGroups} bugLinks={bugLinks || {}} onCreateBug={setCreateBugTicket} />}
          {tab === 'all'       && <AllTicketsTab tickets={tickets} bugLinks={bugLinks || {}} onCreateBug={setCreateBugTicket} translations={translations} isTranslating={isTranslating} translateOn={translateOn} />}
        </>
      )}
    </div>
  )
}

import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import {
  RefreshCw, ExternalLink, ChevronDown, ChevronRight,
  Bug, X, Loader2, CheckCircle, AlertCircle, Paperclip, Sparkles, Languages
} from 'lucide-react'

const API = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000'
const api = axios.create({ baseURL: API, timeout: 60000 })

// ── Status helpers ──────────────────────────────────────────────────────────
const STATUS_COLORS = {
  'Open':        'bg-blue-100 text-blue-800',
  'In Progress': 'bg-yellow-100 text-yellow-800',
  'Waiting for customer': 'bg-purple-100 text-purple-800',
  'Pending':     'bg-orange-100 text-orange-800',
  'Resolved':    'bg-green-100 text-green-800',
  'Closed':      'bg-gray-100 text-gray-700',
}
const statusColor = (s) => STATUS_COLORS[s] || 'bg-gray-100 text-gray-700'

const PRIORITY_COLORS = {
  'Critical': 'text-red-600 font-bold',
  'High':     'text-orange-500 font-semibold',
  'Medium':   'text-yellow-600',
  'Low':      'text-gray-500',
  'Low (migrated)': 'text-gray-400',
  'Normal':   'text-gray-500',
}
const priorityColor = (p) => PRIORITY_COLORS[p] || 'text-gray-500'

// ── Fixed-position tooltip ──────────────────────────────────────────────────
function TooltipCell({ text, className, children }) {
  const [pos, setPos] = useState(null)
  return (
    <td
      className={className}
      onMouseEnter={e => {
        if (!text || text.length < 30) return
        const r = e.currentTarget.getBoundingClientRect()
        setPos({ top: r.bottom + 6, left: Math.min(r.left, window.innerWidth - 400) })
      }}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos && (
        <div
          className="fixed z-[9999] bg-slate-800 text-white text-xs rounded-lg px-3 py-2 shadow-xl pointer-events-none leading-relaxed whitespace-pre-wrap"
          style={{ top: pos.top, left: pos.left, maxWidth: 380 }}
        >
          {text}
          <div className="absolute -top-1.5 left-4 w-3 h-3 bg-slate-800 rotate-45" />
        </div>
      )}
    </td>
  )
}

// ── Create Bug Modal ────────────────────────────────────────────────────────
function CreateBugModal({ ticket, onClose, onCreated }) {
  const [form, setForm] = useState({
    summary: '',
    description: '',
    steps_to_reproduce: '',
    actual_result: '',
    expected_result: '',
    severity: 'Medium',
    environments: '',
    found_in_version_id: '',
    epic_key: '',
    fix_version_id: '',
    priority_name: '',
    sprint_id: '',
    attachments: [],  // [{href, name, content_type}] selected for upload
  })
  const [submitting, setSubmitting] = useState(false)
  const [aiGenerating, setAiGenerating] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [epicSearch, setEpicSearch] = useState('')
  const [epicOpen, setEpicOpen] = useState(false)
  const epicRef = useRef(null)

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
        attachments: (detail.attachments || []),  // start all pre-selected
      }))
    }
  }, [detail])

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }))

  const toggleAttachment = (att) => {
    setForm(f => {
      const exists = f.attachments.some(a => a.name === att.name)
      return {
        ...f,
        attachments: exists
          ? f.attachments.filter(a => a.name !== att.name)
          : [...f.attachments, att],
      }
    })
  }

  const isAttachmentSelected = (att) => form.attachments.some(a => a.name === att.name)

  const handleSubmit = async () => {
    if (!form.summary.trim()) { setError('Summary is required.'); return }
    setSubmitting(true)
    setError(null)
    try {
      const envList = form.environments
        ? form.environments.split(',').map(s => s.trim()).filter(Boolean)
        : []
      const res = await api.post('/api/kone/create-bug', {
        kone_key:             ticket.key,
        kone_url:             ticket.url,
        summary:              form.summary,
        description:          form.description,
        steps_to_reproduce:   form.steps_to_reproduce,
        actual_result:        form.actual_result,
        expected_result:      form.expected_result,
        severity:             form.severity || 'Medium',
        environments:         envList,
        found_in_version_id:  form.found_in_version_id || null,
        epic_key:             form.epic_key || null,
        fix_version_id:       form.fix_version_id || null,
        priority_name:        form.priority_name || null,
        sprint_id:            form.sprint_id ? Number(form.sprint_id) : null,
        attachments:          form.attachments,
      })
      setResult(res.data)
      onCreated?.(ticket.key, res.data)
    } catch (e) {
      setError(e.response?.data?.detail || e.message || 'Unknown error')
    } finally {
      setSubmitting(false)
    }
  }

  const generateWithAI = async () => {
    setAiGenerating(true)
    setError(null)
    try {
      const res = await api.post('/api/kone/ai-generate-bug-fields', {
        summary: form.summary,
        description: form.description,
      })
      setForm(f => ({
        ...f,
        steps_to_reproduce: res.data.steps_to_reproduce || f.steps_to_reproduce,
        actual_result:      res.data.actual_result      || f.actual_result,
        expected_result:    res.data.expected_result    || f.expected_result,
      }))
    } catch (e) {
      setError(e.response?.data?.detail || e.message || 'AI generation failed')
    } finally {
      setAiGenerating(false)
    }
  }

  const filteredEpics = useMemo(() => {
    const q = epicSearch.toLowerCase()
    return (meta?.epics || []).filter(e =>
      e.name.toLowerCase().includes(q) || e.key.toLowerCase().includes(q)
    )
  }, [meta?.epics, epicSearch])

  useEffect(() => {
    const handler = (e) => { if (epicRef.current && !epicRef.current.contains(e.target)) setEpicOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const selectEpic = (key, label) => { set('epic_key', key); setEpicSearch(label); setEpicOpen(false) }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-2">
            <Bug className="h-5 w-5 text-red-500" />
            <span className="font-semibold text-gray-800">Create Jira Bug</span>
            <span className="text-xs text-gray-400 ml-1">from KONE {ticket.key}</span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1 rounded">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {detailLoading && (
            <div className="flex items-center justify-center py-8 gap-2 text-gray-500">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Loading ticket data…</span>
            </div>
          )}

          {!detailLoading && result && (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <CheckCircle className="h-12 w-12 text-green-500" />
              <p className="text-lg font-semibold text-gray-800">Bug created successfully!</p>
              <a href={result.url} target="_blank" rel="noopener noreferrer"
                className="text-blue-600 font-mono font-bold text-lg hover:underline">
                {result.key} ↗
              </a>
              <button onClick={onClose} className="mt-2 px-4 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Close</button>
            </div>
          )}

          {!detailLoading && !result && (
            <>
              {/* Source */}
              <div className="bg-gray-50 rounded-lg px-4 py-3 text-xs text-gray-500 space-y-1">
                <p><span className="font-medium text-gray-700">KONE Ticket:</span> {ticket.key}</p>
                <p><span className="font-medium text-gray-700">Cliente:</span> {ticket.cliente}{ticket.cuenta ? ` · ${ticket.cuenta}` : ''}</p>
                <p><span className="font-medium text-gray-700">Producto:</span> {ticket.producto} {ticket.modulo ? `/ ${ticket.modulo}` : ''}</p>
                <a href={ticket.url} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-blue-600 hover:underline">
                  View in KONE Jira <ExternalLink className="h-3 w-3" />
                </a>
              </div>

              {/* Summary */}
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Summary *</label>
                <input
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400"
                  value={form.summary}
                  onChange={e => set('summary', e.target.value)}
                  placeholder="Bug summary…"
                />
              </div>

              {/* Description */}
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Description</label>
                <textarea
                  rows={4}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400 resize-y"
                  value={form.description}
                  onChange={e => set('description', e.target.value)}
                  placeholder="Describe the issue…"
                />
              </div>

              {/* AI Generate */}
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Bug Details</span>
                <button
                  type="button"
                  onClick={generateWithAI}
                  disabled={aiGenerating || !form.summary}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-violet-50 text-violet-700 hover:bg-violet-100 disabled:opacity-50 transition-colors"
                >
                  {aiGenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  {aiGenerating ? 'Generating…' : 'AI Generate'}
                </button>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Steps to Reproduce</label>
                <textarea rows={3}
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400 resize-y"
                  value={form.steps_to_reproduce}
                  onChange={e => set('steps_to_reproduce', e.target.value)}
                  placeholder="1. Go to…&#10;2. Click…&#10;3. Observe…"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Actual Result</label>
                  <textarea rows={3}
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400 resize-y"
                    value={form.actual_result}
                    onChange={e => set('actual_result', e.target.value)}
                    placeholder="What actually happened…"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Expected Result</label>
                  <textarea rows={3}
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400 resize-y"
                    value={form.expected_result}
                    onChange={e => set('expected_result', e.target.value)}
                    placeholder="What should happen…"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Severity *</label>
                  <select className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                    value={form.severity} onChange={e => set('severity', e.target.value)}>
                    {(meta?.severities || ['Critical','Highest','High','Medium','Low']).map(s => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">
                    Environments <span className="font-normal text-gray-400">(comma-sep)</span>
                  </label>
                  <input
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400"
                    value={form.environments}
                    onChange={e => set('environments', e.target.value)}
                    placeholder="e.g. Web, Mobile"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {/* Epic — searchable combobox */}
                <div ref={epicRef} className="relative">
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Epic (Parent)</label>
                  <input type="text"
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400"
                    placeholder="Search epic…"
                    value={epicSearch}
                    onChange={e => { setEpicSearch(e.target.value); setEpicOpen(true) }}
                    onFocus={() => setEpicOpen(true)}
                  />
                  {epicOpen && (
                    <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-xl max-h-52 overflow-y-auto">
                      <div className="px-3 py-2 text-sm text-gray-400 hover:bg-gray-50 cursor-pointer"
                        onMouseDown={() => selectEpic('', '')}>— No epic —</div>
                      {filteredEpics.map(e => (
                        <div key={e.key} onMouseDown={() => selectEpic(e.key, e.name)}
                          className={`px-3 py-2 text-sm cursor-pointer hover:bg-blue-50 ${form.epic_key === e.key ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700'}`}>
                          {e.name} <span className="text-xs text-gray-400 ml-1">{e.key}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Fix Version</label>
                  <select className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                    value={form.fix_version_id} onChange={e => set('fix_version_id', e.target.value)}>
                    <option value="">— No version —</option>
                    {(meta?.fix_versions || []).map(v => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Found In Version</label>
                  <select className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                    value={form.found_in_version_id} onChange={e => set('found_in_version_id', e.target.value)}>
                    <option value="">— Unknown —</option>
                    {(meta?.found_in_versions || []).map(v => (
                      <option key={v.id} value={v.id}>{v.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Priority</label>
                  <select className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                    value={form.priority_name} onChange={e => set('priority_name', e.target.value)}>
                    <option value="">— Default —</option>
                    {(meta?.priorities || []).map(p => (
                      <option key={p.id} value={p.name}>{p.name}</option>
                    ))}
                  </select>
                </div>

                <div className="col-span-2">
                  <label className="block text-xs font-semibold text-gray-600 mb-1">Sprint</label>
                  <select className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                    value={form.sprint_id} onChange={e => set('sprint_id', e.target.value)}>
                    <option value="">— No sprint —</option>
                    {(meta?.sprints || []).map(s => (
                      <option key={s.id} value={s.id}>{s.name}{s.state === 'active' ? ' ✓' : ''}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Attachments */}
              {detail?.attachments?.length > 0 && (
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-2">
                    <Paperclip className="h-3.5 w-3.5 inline mr-1" />
                    Attachments from KONE ticket
                  </label>
                  <div className="space-y-1.5">
                    {detail.attachments.map(att => (
                      <label key={att.id || att.name} className="flex items-center gap-2.5 cursor-pointer hover:bg-gray-50 rounded px-2 py-1">
                        <input type="checkbox"
                          className="h-3.5 w-3.5 text-blue-600 rounded"
                          checked={isAttachmentSelected(att)}
                          onChange={() => toggleAttachment(att)}
                        />
                        <span className="text-sm text-gray-700">{att.name}</span>
                        {att.size > 0 && (
                          <span className="text-xs text-gray-400">({(att.size / 1024).toFixed(0)} KB)</span>
                        )}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {error && (
                <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {!result && !detailLoading && (
          <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200">
            <button onClick={onClose} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50" disabled={submitting}>
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={submitting || !form.summary.trim()}
              className="inline-flex items-center gap-2 bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bug className="h-4 w-4" />}
              {submitting ? 'Creating…' : 'Create Bug in Jira'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── By Cliente tab ──────────────────────────────────────────────────────────
function ByClienteTab({ tickets, clienteGroups, bugLinks, onCreateBug }) {
  const [selectedCliente, setSelectedCliente] = useState(null)
  const [statusFilter, setStatusFilter] = useState('All')
  const [sortCol, setSortCol] = useState('created')
  const [sortDir, setSortDir] = useState('desc')

  const filteredTickets = useMemo(() => {
    let list = tickets
    if (selectedCliente) list = list.filter(t => t.cliente === selectedCliente)
    if (statusFilter !== 'All') list = list.filter(t => t.status === statusFilter)
    return [...list].sort((a, b) => {
      let av = a[sortCol] || '', bv = b[sortCol] || ''
      if (sortCol === 'days_open') { av = Number(av); bv = Number(bv) }
      const cmp = typeof av === 'number' ? av - bv : av < bv ? -1 : av > bv ? 1 : 0
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [tickets, selectedCliente, statusFilter, sortCol, sortDir])

  const allStatuses = useMemo(() => {
    const s = new Set(tickets.map(t => t.status).filter(Boolean))
    return ['All', ...Array.from(s).sort()]
  }, [tickets])

  const toggleSort = col => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('desc') }
  }
  const sortIcon = col => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {clienteGroups.map(g => {
          const isSelected = selectedCliente === g.cliente
          return (
            <div key={g.cliente}
              className={`border rounded-xl p-4 cursor-pointer transition-all ${isSelected ? 'border-blue-500 bg-blue-50 shadow-md' : 'border-gray-200 bg-white hover:border-blue-300'}`}
              onClick={() => setSelectedCliente(isSelected ? null : g.cliente)}
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-gray-900 text-sm">{g.cliente || 'Unknown'}</h3>
                  {g.cuentas?.length > 0 && <p className="text-xs text-gray-500 mt-0.5">{g.cuentas.join(' · ')}</p>}
                </div>
                <div className="flex items-center gap-1">
                  <span className="text-2xl font-bold text-blue-600">{g.total}</span>
                  {isSelected ? <ChevronDown className="h-4 w-4 text-gray-400 mt-1" /> : <ChevronRight className="h-4 w-4 text-gray-400 mt-1" />}
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
            {selectedCliente ? `${selectedCliente} — ` : 'All — '}
            {filteredTickets.length} ticket{filteredTickets.length !== 1 ? 's' : ''}
          </span>
          <div className="flex items-center gap-2">
            <select className="text-xs border border-gray-200 rounded px-2 py-1"
              value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              {allStatuses.map(s => <option key={s}>{s}</option>)}
            </select>
            {selectedCliente && (
              <button onClick={() => setSelectedCliente(null)} className="text-xs text-blue-500 hover:underline">Clear</button>
            )}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                {[['key','Key'],['summary','Summary'],['status','Status'],['priority','Priority'],
                  ['cliente','Cliente'],['cuenta','Cuenta'],['producto','Producto'],
                  ['assignee','Assignee'],['days_open','Days Open']].map(([col,label]) => (
                  <th key={col} className="text-left px-3 py-2 text-gray-600 font-medium cursor-pointer hover:text-gray-900 whitespace-nowrap"
                    onClick={() => toggleSort(col)}>
                    {label}{sortIcon(col)}
                  </th>
                ))}
                <th className="px-3 py-2 text-gray-600 font-medium">Jira Bug</th>
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
                    <td className="px-3 py-2 whitespace-nowrap">{t.assignee}</td>
                    <td className="px-3 py-2 text-center">
                      <span className={t.days_open > 14 ? 'text-red-600 font-semibold' : 'text-gray-500'}>{t.days_open}d</span>
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {link ? (
                        <a href={link.jira_url} target="_blank" rel="noopener noreferrer"
                          className="text-indigo-600 font-mono hover:underline text-xs font-medium">
                          {link.jira_key} ↗
                        </a>
                      ) : (
                        <button onClick={() => onCreateBug(t)}
                          className="inline-flex items-center gap-1 text-xs text-red-600 border border-red-200 bg-red-50 hover:bg-red-100 rounded px-2 py-1 font-medium transition-colors">
                          <Bug className="h-3 w-3" />Create Bug
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {filteredTickets.length === 0 && (
                <tr><td colSpan={10} className="text-center py-8 text-gray-400">No tickets</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ── All Tickets tab ─────────────────────────────────────────────────────────
function AllTicketsTab({ tickets, bugLinks, onCreateBug, translations, isTranslating, translateOn }) {
  const [search, setSearch]           = useState('')
  const [statusFilter, setStatus]     = useState('All')
  const [clienteFilter, setCliente]   = useState('All')
  const [cuentaFilter, setCuenta]     = useState('All')
  const [productoFilter, setProducto] = useState('All')
  const [assigneeFilter, setAssignee] = useState('All')
  const [sortCol, setSortCol]         = useState('created')
  const [sortDir, setSortDir]         = useState('desc')
  const [page, setPage]               = useState(1)
  const PAGE_SIZE = 50

  const options = useMemo(() => ({
    statuses:  ['All', ...Array.from(new Set(tickets.map(t => t.status).filter(Boolean))).sort()],
    clientes:  ['All', ...Array.from(new Set(tickets.map(t => t.cliente).filter(Boolean))).sort()],
    cuentas:   ['All', ...Array.from(new Set(tickets.map(t => t.cuenta).filter(Boolean))).sort()],
    productos: ['All', ...Array.from(new Set(tickets.map(t => t.producto).filter(Boolean))).sort()],
    assignees: ['All', ...Array.from(new Set(tickets.map(t => t.assignee).filter(Boolean))).sort()],
  }), [tickets])

  const tr = (text) => (translateOn && translations[text]) ? translations[text] : text

  const filtered = useMemo(() => {
    let list = tickets
    if (search)                list = list.filter(t => `${t.key} ${t.summary} ${t.assignee} ${t.reporter}`.toLowerCase().includes(search.toLowerCase()))
    if (statusFilter !== 'All')    list = list.filter(t => t.status   === statusFilter)
    if (clienteFilter !== 'All')   list = list.filter(t => t.cliente  === clienteFilter)
    if (cuentaFilter !== 'All')    list = list.filter(t => t.cuenta   === cuentaFilter)
    if (productoFilter !== 'All')  list = list.filter(t => t.producto === productoFilter)
    if (assigneeFilter !== 'All')  list = list.filter(t => t.assignee === assigneeFilter)
    return [...list].sort((a, b) => {
      let av = a[sortCol] || '', bv = b[sortCol] || ''
      if (sortCol === 'days_open') { av = Number(av); bv = Number(bv) }
      const cmp = typeof av === 'number' ? av - bv : av < bv ? -1 : av > bv ? 1 : 0
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [tickets, search, statusFilter, clienteFilter, cuentaFilter, productoFilter, assigneeFilter, sortCol, sortDir])

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE)
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const toggleSort = col => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('desc') }
    setPage(1)
  }
  const sortIcon = col => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''

  const Sel = ({ label, value, onChange, options: opts }) => (
    <select className="text-xs border border-gray-200 rounded px-2 py-1" value={value}
      onChange={e => { onChange(e.target.value); setPage(1) }} title={label}>
      {opts.map(o => <option key={o}>{o}</option>)}
    </select>
  )

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-gray-100">
        <input type="text" placeholder="Search key / summary / assignee…"
          value={search} onChange={e => { setSearch(e.target.value); setPage(1) }}
          className="text-xs border border-gray-200 rounded px-2 py-1 w-52" />
        <Sel label="Status"   value={statusFilter}   onChange={setStatus}   options={options.statuses} />
        <Sel label="Cliente"  value={clienteFilter}  onChange={setCliente}  options={options.clientes} />
        <Sel label="Cuenta"   value={cuentaFilter}   onChange={setCuenta}   options={options.cuentas} />
        <Sel label="Producto" value={productoFilter} onChange={setProducto} options={options.productos} />
        <Sel label="Assignee" value={assigneeFilter} onChange={setAssignee} options={options.assignees} />
        {isTranslating && <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-500 ml-1" />}
        <span className="ml-auto text-xs text-gray-500">{filtered.length} tickets</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-50">
            <tr>
              {[
                ['key','Key'],['summary','Summary'],['status','Status'],['priority','Priority'],
                ['cliente','Cliente'],['cliente_site','Site'],['cuenta','Cuenta'],
                ['producto','Producto'],['modulo','Módulo'],['urgency','Urgency'],
                ['assignee','Assignee'],['reporter','Reporter'],['days_open','Days Open'],['created','Created'],
              ].map(([col,label]) => (
                <th key={col} className="text-left px-3 py-2 text-gray-600 font-medium cursor-pointer hover:text-gray-900 whitespace-nowrap"
                  onClick={() => toggleSort(col)}>
                  {label}{sortIcon(col)}
                </th>
              ))}
              <th className="px-3 py-2 text-gray-600 font-medium whitespace-nowrap">Jira Bug</th>
            </tr>
          </thead>
          <tbody>
            {paged.map(t => {
              const link = bugLinks?.[t.key]
              const displaySummary = tr(t.summary)
              return (
                <tr key={t.key} className="border-t border-gray-50 hover:bg-gray-50">
                  <td className="px-3 py-2 whitespace-nowrap">
                    <a href={t.url} target="_blank" rel="noopener noreferrer"
                      className="text-blue-600 hover:underline font-mono flex items-center gap-1">
                      {t.key}<ExternalLink className="h-2.5 w-2.5 opacity-60" />
                    </a>
                  </td>
                  <TooltipCell text={displaySummary} className="px-3 py-2 max-w-[260px] cursor-default">
                    <span className="block truncate">{displaySummary}</span>
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
                  <td className="px-3 py-2 whitespace-nowrap text-gray-700">{t.assignee}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-500">{t.reporter}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={t.days_open > 14 ? 'text-red-600 font-semibold' : 'text-gray-500'}>{t.days_open}d</span>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-500">{t.created ? t.created.slice(0,10) : ''}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {link ? (
                      <a href={link.jira_url} target="_blank" rel="noopener noreferrer"
                        className="text-indigo-600 font-mono hover:underline text-xs font-medium">
                        {link.jira_key} ↗
                      </a>
                    ) : (
                      <button onClick={() => onCreateBug(t)}
                        className="inline-flex items-center gap-1 text-xs text-red-600 border border-red-200 bg-red-50 hover:bg-red-100 rounded px-2 py-1 font-medium transition-colors">
                        <Bug className="h-3 w-3" />Create Bug
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
            {paged.length === 0 && (
              <tr><td colSpan={15} className="text-center py-8 text-gray-400">No tickets match filters</td></tr>
            )}
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

// ── Main Page ────────────────────────────────────────────────────────────────
export default function KonePage() {
  const [tab, setTab] = useState('cliente')
  const [refreshKey, setRefreshKey] = useState(0)
  const [createBugTicket, setCreateBugTicket] = useState(null)
  const [translateOn, setTranslateOn] = useState(false)
  const [translations, setTranslations] = useState({})
  const [isTranslating, setIsTranslating] = useState(false)
  const translationsRef = useRef({})

  // Keep ref in sync with state (avoids stale closure in translateTexts)
  translationsRef.current = translations

  const translateTexts = useCallback(async (texts) => {
    const untranslated = [...new Set(texts)].filter(t => t && t.trim() && !translationsRef.current[t])
    if (untranslated.length === 0) return
    setIsTranslating(true)
    try {
      const res = await api.post('/api/mexico-qa/translate', { texts: untranslated })
      setTranslations(prev => ({ ...prev, ...res.data.translations }))
    } catch (e) {
      console.error('Translation failed:', e)
    } finally {
      setIsTranslating(false)
    }
  }, [])

  const { data: ticketsData, isLoading: loadingTickets, error: ticketsError, refetch: refetchTickets } =
    useQuery({
      queryKey: ['kone-tickets', refreshKey],
      queryFn: () => api.get('/api/kone/tickets').then(r => r.data),
      staleTime: 5 * 60 * 1000,
    })

  const { data: clienteData, isLoading: loadingCliente, refetch: refetchCliente } =
    useQuery({
      queryKey: ['kone-by-cliente', refreshKey],
      queryFn: () => api.get('/api/kone/by-cliente').then(r => r.data),
      staleTime: 5 * 60 * 1000,
    })

  const { data: bugLinks, refetch: refetchBugLinks } =
    useQuery({
      queryKey: ['kone-bug-links'],
      queryFn: () => api.get('/api/kone/bug-links').then(r => r.data),
      staleTime: 60 * 1000,
    })

  // Auto-translate when toggle is on and tickets are loaded
  useEffect(() => {
    if (!translateOn || !ticketsData?.tickets?.length) return
    const texts = ticketsData.tickets.map(t => t.summary).filter(Boolean)
    translateTexts(texts)
  }, [translateOn, ticketsData?.tickets, translateTexts])

  const handleRefresh = async () => {
    setRefreshKey(k => k + 1)
    await Promise.all([
      api.get('/api/kone/tickets?refresh=true'),
      api.get('/api/kone/by-cliente?refresh=true'),
    ])
    await Promise.all([refetchTickets(), refetchCliente(), refetchBugLinks()])
  }

  const handleBugCreated = (koneKey, result) => {
    refetchBugLinks()
  }

  const tickets       = ticketsData?.tickets || []
  const clienteGroups = clienteData?.groups  || []
  const isLoading     = loadingTickets || loadingCliente

  const totalOpen      = tickets.length
  const openCount      = tickets.filter(t => t.status === 'Open').length
  const pendingCount   = tickets.filter(t => t.status === 'Pending').length
  const inProgress     = tickets.filter(t => t.status === 'In Progress').length
  const overdue        = tickets.filter(t => t.days_open > 14).length
  const uniqueClientes = new Set(tickets.map(t => t.cliente).filter(Boolean)).size

  return (
    <div className="p-6 space-y-5">
      {createBugTicket && (
        <CreateBugModal
          ticket={createBugTicket}
          onClose={() => setCreateBugTicket(null)}
          onCreated={handleBugCreated}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">K-1 KONE Service Desk</h1>
          <p className="text-sm text-gray-500 mt-0.5">kabatone-ops-it.atlassian.net · All open tickets</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Translation toggle */}
          <button
            onClick={() => setTranslateOn(v => !v)}
            title="Translate Spanish → English"
            className={`flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border transition-colors ${
              translateOn
                ? 'bg-violet-600 text-white border-violet-600'
                : 'bg-white text-gray-600 border-gray-200 hover:border-violet-400'
            }`}
          >
            <Languages className="h-4 w-4" />
            {translateOn ? 'ES→EN On' : 'ES→EN'}
          </button>
          <button
            onClick={handleRefresh}
            disabled={isLoading}
            className="flex items-center gap-2 px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40"
          >
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
          Failed to load KONE tickets: {ticketsError.message}
        </div>
      )}

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-gray-200">
        {[
          { id: 'cliente', label: 'By Cliente' },
          { id: 'all',     label: `All Tickets (${totalOpen})` },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t.id ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-48 text-gray-400">
          <RefreshCw className="h-6 w-6 animate-spin mr-2" />
          Loading K-1 tickets…
        </div>
      ) : (
        <>
          {tab === 'cliente' && (
            <ByClienteTab
              tickets={tickets}
              clienteGroups={clienteGroups}
              bugLinks={bugLinks || {}}
              onCreateBug={setCreateBugTicket}
            />
          )}
          {tab === 'all' && (
            <AllTicketsTab
              tickets={tickets}
              bugLinks={bugLinks || {}}
              onCreateBug={setCreateBugTicket}
              translations={translations}
              isTranslating={isTranslating}
              translateOn={translateOn}
            />
          )}
        </>
      )}
    </div>
  )
}

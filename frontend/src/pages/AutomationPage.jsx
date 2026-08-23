import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Header } from '../components/layout/Header'
import axios from 'axios'
import { BASE_URL } from '../services/api'
import {
  Wand2, ExternalLink, Trash2, ChevronRight, CheckCircle2,
  Loader2, AlertCircle, RotateCcw, Sparkles, FileText,
  XCircle, Edit3, Check, X, Plus, ChevronDown, BookOpen,
  FileImage, Upload, Link2, Info, Database, Eye, Search,
  Figma as FigmaIcon, Layers, PlayCircle, Bug
} from 'lucide-react'

// Local axios with long timeout for Claude generation + automation runs (Playwright can take a while)
const api = axios.create({ baseURL: BASE_URL, timeout: 120000 })
const automationApi = axios.create({ baseURL: BASE_URL, timeout: 180000 })

const fetchVersions   = () => api.get('/test-generator/versions').then(r => r.data)
const fetchStories    = (v) => api.get(`/test-generator/stories?version=${encodeURIComponent(v)}`).then(r => r.data)
const searchEpics     = (q) => api.get(`/test-generator/epics/search?q=${encodeURIComponent(q)}`).then(r => r.data.epics)
const fetchEpicChildren = (key) => api.get(`/test-generator/epics/${encodeURIComponent(key)}/children`).then(r => r.data.children)
const fetchContext    = (d) => api.post('/test-generator/context', d).then(r => r.data)
const uploadFiles     = (form) => api.post('/test-generator/upload-context', form, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data)
const generateTC      = (d) => api.post('/test-generator/generate', d).then(r => r.data)
const createTC        = (d) => api.post('/test-generator/create', d).then(r => r.data)
const runAutomation   = (d) => automationApi.post('/automation/runs', d).then(r => r.data)
const fetchBugCandidates = (storyKey) => api.get(`/automation/bug-candidates${storyKey ? `?story_key=${encodeURIComponent(storyKey)}` : ''}`).then(r => r.data.candidates)
const fetchTestsForStory = (storyKey) => api.get(`/automation/story/${encodeURIComponent(storyKey)}/tests`).then(r => r.data.tests)
const fetchRunsForStory  = (storyKey) => api.get(`/automation/story/${encodeURIComponent(storyKey)}/runs`).then(r => r.data.runs)
const runBatch         = ({ storyKey, target_url }) => automationApi.post(`/automation/story/${encodeURIComponent(storyKey)}/run-batch`, { target_url }).then(r => r.data)
const fileBugCandidate = (id) => api.post(`/automation/bug-candidates/${id}/file`).then(r => r.data)
const fetchRun         = (runId) => api.get(`/automation/runs/${runId}`).then(r => r.data)
const fetchRunResults  = (runId) => api.get(`/automation/runs/${runId}/results`).then(r => r.data.steps)
const runScreenshotUrl = (runId) => `${BASE_URL}/automation/runs/${runId}/screenshot`
const RUN_IN_PROGRESS = new Set(['pending', 'running'])

const ALLOWED_EXTS = ['.txt', '.md', '.csv', '.json', '.png', '.jpg', '.jpeg', '.gif', '.webp']

// ── Status pill ────────────────────────────────────────────────────────────────
const STATUS_COLORS = {
  'Done':              'bg-green-100 text-green-700',
  'In Progress':       'bg-blue-100 text-blue-700',
  'Ready for Testing': 'bg-purple-100 text-purple-700',
  'To Do':             'bg-gray-100 text-gray-500',
  'Blocked':           'bg-red-100 text-red-700',
}
function StatusPill({ status }) {
  const cls = STATUS_COLORS[status] || 'bg-gray-100 text-gray-600'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {status || '—'}
    </span>
  )
}

// ── Step indicator ─────────────────────────────────────────────────────────────
function Steps({ current }) {
  const steps = ['Select Story', 'Context & Summary', 'Review & Edit', 'Automation']
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {steps.map((label, i) => {
        const idx = i + 1
        const done   = current > idx
        const active = current === idx
        return (
          <div key={label} className="flex items-center gap-2">
            <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium
              ${done ? 'bg-green-100 text-green-700' : active ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-400'}`}>
              {done ? <CheckCircle2 className="h-3 w-3" /> : <span>{idx}</span>}
              {label}
            </div>
            {i < steps.length - 1 && (
              <ChevronRight className="h-3.5 w-3.5 text-gray-300 flex-shrink-0" />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Epic search (live, portal dropdown) ─────────────────────────────────────────
function EpicSearchBox({ onSelect }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const [dropdownPos, setDropdownPos] = useState(null)
  const boxRef = useRef(null)
  const dropdownRef = useRef(null)

  const searchMutation = useMutation({
    mutationFn: searchEpics,
    onSuccess: (data) => setResults(data || []),
  })

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setResults([]); return }
    const t = setTimeout(() => searchMutation.mutate(q), 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  useEffect(() => {
    const h = (e) => {
      if (boxRef.current?.contains(e.target) || dropdownRef.current?.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  const openDropdown = () => {
    const r = boxRef.current?.getBoundingClientRect()
    if (r) setDropdownPos({ top: r.bottom + 2, left: r.left, width: r.width })
    setOpen(true)
  }

  const pick = (epic) => {
    setQuery(`${epic.key} — ${epic.summary}`)
    setOpen(false)
    onSelect(epic)
  }

  return (
    <div ref={boxRef} className="relative">
      <div className="relative">
        <Search className="h-4 w-4 text-gray-300 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          className="text-sm border border-gray-200 rounded-lg pl-9 pr-8 py-2 bg-white w-80 focus:outline-none focus:ring-2 focus:ring-brand-300"
          placeholder="Search epic by name or key (e.g. TMT0-39936)…"
          value={query}
          onChange={e => { setQuery(e.target.value); openDropdown() }}
          onFocus={openDropdown}
        />
        {searchMutation.isPending && (
          <Loader2 className="h-3.5 w-3.5 text-brand-400 animate-spin absolute right-3 top-1/2 -translate-y-1/2" />
        )}
      </div>

      {open && dropdownPos && createPortal(
        <div
          ref={dropdownRef}
          className="fixed z-50 bg-white border border-gray-200 rounded-lg shadow-lg max-h-72 overflow-y-auto"
          style={{ top: dropdownPos.top, left: dropdownPos.left, width: dropdownPos.width }}
        >
          {query.trim().length < 2 ? (
            <div className="px-3 py-3 text-xs text-gray-400">Type at least 2 characters…</div>
          ) : results.length === 0 && !searchMutation.isPending ? (
            <div className="px-3 py-3 text-xs text-gray-400">No epics match "{query}"</div>
          ) : (
            results.map(epic => (
              <button
                key={epic.key}
                onMouseDown={() => pick(epic)}
                className="w-full text-left px-3 py-2 text-sm hover:bg-brand-50 flex items-center justify-between gap-2 border-b border-gray-50 last:border-0"
              >
                <span className="truncate flex-1">{epic.summary}</span>
                <span className="text-xs font-mono text-brand-500 flex-shrink-0">{epic.key}</span>
              </button>
            ))
          )}
        </div>,
        document.body
      )}
    </div>
  )
}

// ── Inline editable field ──────────────────────────────────────────────────────
function EditableText({ value, onChange, multiline = false, className = '' }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  const commit = () => { onChange(draft); setEditing(false) }
  const cancel = () => { setDraft(value); setEditing(false) }

  if (!editing) {
    return (
      <span
        className={`cursor-pointer hover:bg-yellow-50 rounded px-1 -mx-1 group ${className}`}
        onClick={() => { setDraft(value); setEditing(true) }}
      >
        {value || <span className="text-gray-300 italic">click to edit</span>}
        <Edit3 className="h-3 w-3 text-gray-300 group-hover:text-brand-400 inline ml-1" />
      </span>
    )
  }

  return (
    <span className="flex items-start gap-1">
      {multiline ? (
        <textarea
          autoFocus
          className="flex-1 text-sm border border-brand-300 rounded px-2 py-1 resize-none focus:outline-none focus:ring-1 focus:ring-brand-400"
          rows={3}
          value={draft}
          onChange={e => setDraft(e.target.value)}
        />
      ) : (
        <input
          autoFocus
          className="flex-1 text-sm border border-brand-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-brand-400"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') cancel() }}
        />
      )}
      <button onClick={commit} className="text-green-600 hover:text-green-700 mt-0.5"><Check className="h-4 w-4" /></button>
      <button onClick={cancel} className="text-gray-400 hover:text-gray-600 mt-0.5"><X className="h-4 w-4" /></button>
    </span>
  )
}

// ── Source badge ───────────────────────────────────────────────────────────────
const SOURCE_STYLES = {
  jira_story: { icon: Database,  bg: 'bg-blue-50 border-blue-200',   badge: 'bg-blue-100 text-blue-700',   label: 'Jira Story' },
  jira_epic:  { icon: Link2,     bg: 'bg-purple-50 border-purple-200', badge: 'bg-purple-100 text-purple-700', label: 'Epic' },
  confluence: { icon: BookOpen,  bg: 'bg-teal-50 border-teal-200',   badge: 'bg-teal-100 text-teal-700',   label: 'Confluence' },
  figma:      { icon: FigmaIcon, bg: 'bg-pink-50 border-pink-200',   badge: 'bg-pink-100 text-pink-700',   label: 'Figma' },
  upload:     { icon: Upload,    bg: 'bg-orange-50 border-orange-200', badge: 'bg-orange-100 text-orange-700', label: 'Uploaded' },
}

function SourceCard({ source }) {
  const [expanded, setExpanded] = useState(false)
  const style = SOURCE_STYLES[source.type] || SOURCE_STYLES.confluence
  const Icon = style.icon

  return (
    <div className={`border rounded-xl overflow-hidden ${style.bg}`}>
      <div className="flex items-start gap-3 px-4 py-3">
        <Icon className="h-4 w-4 mt-0.5 flex-shrink-0 text-gray-500" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs font-semibold px-2 py-0.5 rounded ${style.badge}`}>
              {style.label}
            </span>
            {source.url ? (
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-medium text-gray-800 hover:text-brand-600 hover:underline flex items-center gap-1 truncate"
              >
                {source.title} <ExternalLink className="h-3 w-3 flex-shrink-0" />
              </a>
            ) : (
              <span className="text-sm font-medium text-gray-800 truncate">{source.title}</span>
            )}
            {source.has_content
              ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
              : <AlertCircle className="h-3.5 w-3.5 text-amber-400 flex-shrink-0" />}
          </div>
          {source.preview && (
            <p className={`text-xs text-gray-500 mt-1 ${expanded ? '' : 'line-clamp-2'}`}>
              {source.preview}
            </p>
          )}
        </div>
        {source.preview && (
          <button
            onClick={() => setExpanded(e => !e)}
            className="text-gray-400 hover:text-gray-600 flex-shrink-0"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            <Eye className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  )
}

// ── File upload zone ───────────────────────────────────────────────────────────
function FileUploadZone({ uploadedFiles, onUpload, onRemove, isUploading }) {
  const inputRef = useRef(null)
  const [dragging, setDragging] = useState(false)

  const handleFiles = (fileList) => {
    const valid = Array.from(fileList).filter(f => {
      const ext = '.' + f.name.split('.').pop().toLowerCase()
      return ALLOWED_EXTS.includes(ext)
    })
    if (valid.length) onUpload(valid)
  }

  return (
    <div className="space-y-3">
      {/* Drop zone */}
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files) }}
        className={`border-2 border-dashed rounded-xl px-6 py-8 text-center cursor-pointer transition-colors
          ${dragging ? 'border-brand-400 bg-brand-50' : 'border-gray-200 bg-gray-50 hover:border-brand-300 hover:bg-brand-50/30'}`}
      >
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          multiple
          accept={ALLOWED_EXTS.join(',')}
          onChange={e => handleFiles(e.target.files)}
        />
        {isUploading ? (
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="h-8 w-8 text-brand-400 animate-spin" />
            <p className="text-sm text-brand-600 font-medium">Processing files…</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <Upload className="h-8 w-8 text-gray-300" />
            <p className="text-sm font-medium text-gray-600">Drop files here or click to browse</p>
            <p className="text-xs text-gray-400">
              Supported: .txt, .md, .csv, .json, .png, .jpg, .jpeg, .gif, .webp · Max 10 MB each · Up to 5 files
            </p>
          </div>
        )}
      </div>

      {/* Uploaded file list */}
      {uploadedFiles.length > 0 && (
        <div className="space-y-2">
          {uploadedFiles.map((f, i) => (
            <div key={i} className="flex items-center gap-3 bg-white border border-gray-200 rounded-lg px-3 py-2">
              <FileImage className="h-4 w-4 text-gray-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-700 truncate">{f.name}</p>
                {f.ok
                  ? <p className="text-xs text-green-600">
                      {f.type === 'image' ? 'Image described by AI' : `${f.chars?.toLocaleString()} characters extracted`}
                    </p>
                  : <p className="text-xs text-red-500">{f.error || 'Failed'}</p>}
              </div>
              {f.ok
                ? <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" />
                : <XCircle className="h-4 w-4 text-red-400 flex-shrink-0" />}
              <button onClick={() => onRemove(i)} className="text-gray-300 hover:text-red-400">
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Test case card (review step) ───────────────────────────────────────────────
function TestCaseCard({ tc, index, onRemove, onUpdate }) {
  const update = (field, val) => onUpdate(index, { ...tc, [field]: val })
  const updateStep = (si, val) => {
    const steps = [...(tc.steps || [])]
    steps[si] = val
    update('steps', steps)
  }
  const removeStep = (si) => update('steps', (tc.steps || []).filter((_, i) => i !== si))
  const addStep = () => update('steps', [...(tc.steps || []), ''])

  const isNeg = tc.summary?.toLowerCase().includes('negative') ||
                tc.summary?.toLowerCase().includes('(negative)')

  return (
    <div className={`border rounded-xl overflow-hidden ${isNeg ? 'border-orange-200 bg-orange-50/30' : 'border-gray-200 bg-white'}`}>
      <div className={`flex items-start gap-3 px-4 py-3 ${isNeg ? 'bg-orange-50' : 'bg-gray-50'} border-b border-inherit`}>
        <span className={`flex-shrink-0 text-xs font-bold px-2 py-0.5 rounded ${isNeg ? 'bg-orange-100 text-orange-700' : 'bg-brand-100 text-brand-700'}`}>
          {index + 1}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-800">
            <EditableText value={tc.summary} onChange={v => update('summary', v)} />
          </p>
          {tc.description && (
            <p className="text-xs text-gray-500 mt-0.5">
              <EditableText value={tc.description} onChange={v => update('description', v)} />
            </p>
          )}
        </div>
        <button onClick={() => onRemove(index)} className="text-gray-300 hover:text-red-500 transition-colors flex-shrink-0">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      <div className="px-4 py-3 space-y-3 text-sm">
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Steps</p>
          <ol className="space-y-1 list-decimal list-inside">
            {(tc.steps || []).map((step, si) => (
              <li key={si} className="flex items-start gap-1 text-gray-700">
                <span className="flex-1"><EditableText value={step} onChange={v => updateStep(si, v)} /></span>
                <button onClick={() => removeStep(si)} className="text-gray-200 hover:text-red-400 mt-0.5 flex-shrink-0">
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ol>
          <button onClick={addStep} className="mt-1.5 text-xs text-brand-500 hover:text-brand-700 flex items-center gap-1">
            <Plus className="h-3 w-3" /> Add step
          </button>
        </div>

        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Expected Result</p>
          <p className="text-gray-700">
            <EditableText value={tc.expected} onChange={v => update('expected', v)} multiline />
          </p>
        </div>

        {tc.source && (
          <div className="border-t border-dashed border-gray-200 pt-2">
            <p className="text-xs font-semibold text-gray-400 uppercase mb-0.5">Based on</p>
            <p className="text-xs text-gray-500 italic">
              <EditableText value={tc.source} onChange={v => update('source', v)} multiline />
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Creation report ────────────────────────────────────────────────────────────
// ── Automation status badge ─────────────────────────────────────────────────────
const AUTOMATION_STATUS_STYLES = {
  passed: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  error:  'bg-red-100 text-red-700',
  running: 'bg-blue-100 text-blue-700',
  pending: 'bg-gray-100 text-gray-500',
}

// Draws a red box over the screenshot at the failing element's page coordinates,
// scaled from the image's natural (captured) size to however big it renders on screen.
function RunScreenshot({ runId, markBox }) {
  const imgRef = useRef(null)
  const [scale, setScale] = useState(null)

  const recompute = () => {
    const img = imgRef.current
    if (img && img.naturalWidth) setScale(img.clientWidth / img.naturalWidth)
  }

  useEffect(() => {
    const img = imgRef.current
    if (!img) return
    const observer = new ResizeObserver(recompute)
    observer.observe(img)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="relative inline-block max-w-full">
      <img
        ref={imgRef}
        src={runScreenshotUrl(runId)}
        onLoad={recompute}
        alt="Automation run screenshot"
        className="max-w-full rounded-lg border border-gray-200"
      />
      {markBox && scale && (
        <div
          className="absolute border-2 border-red-500 rounded-sm pointer-events-none"
          style={{
            left: markBox.x * scale, top: markBox.y * scale,
            width: markBox.width * scale, height: markBox.height * scale,
            boxShadow: '0 0 0 9999px rgba(0,0,0,0.25)',
          }}
        />
      )}
    </div>
  )
}

function AutomationRow({ testKey, testSummary, storyKey, targetUrl, initialRun }) {
  const [runId, setRunId] = useState(initialRun?.id || null)
  const [expanded, setExpanded] = useState(false)
  const logBoxRef = useRef(null)

  const { data: runData } = useQuery({
    queryKey: ['automation-run', runId],
    queryFn: () => fetchRun(runId),
    enabled: !!runId,
    initialData: runId === initialRun?.id ? initialRun : undefined,
    refetchInterval: (query) => (RUN_IN_PROGRESS.has(query.state.data?.status) ? 1200 : false),
  })

  const isDone = runData && !RUN_IN_PROGRESS.has(runData.status)
  const { data: steps = [] } = useQuery({
    queryKey: ['automation-run-results', runId],
    queryFn: () => fetchRunResults(runId),
    enabled: !!runId && isDone,
  })

  useEffect(() => {
    if (logBoxRef.current) logBoxRef.current.scrollTop = logBoxRef.current.scrollHeight
  }, [runData?.log_output])

  // Run ids only increase — if a story-level batch run creates a newer run for
  // this test while this row is idle, pick it up next time persistedRuns polls
  // (parent re-renders with a fresher initialRun), without stomping a run this
  // row itself just kicked off via the button below.
  useEffect(() => {
    if (initialRun?.id && (!runId || initialRun.id > runId)) setRunId(initialRun.id)
  }, [initialRun?.id])

  const runMutation = useMutation({
    mutationFn: runAutomation,
    onSuccess: (data) => { setRunId(data.id); setExpanded(true) },
  })

  const handleRun = () => {
    if (!targetUrl) return
    runMutation.mutate({ jira_test_key: testKey, target_url: targetUrl, story_key: storyKey })
  }

  const status = runMutation.isPending ? 'pending' : (runData?.status || null)
  const running = RUN_IN_PROGRESS.has(status)
  const firstFailedBox = steps.find(s => s.status === 'failed' && s.element_box)?.element_box

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-2.5 bg-white">
        <span className="font-mono text-xs text-brand-600 font-semibold w-24 flex-shrink-0">{testKey}</span>
        <span className="text-sm text-gray-700 flex-1 min-w-0 truncate">{testSummary}</span>
        {status && (
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0 ${AUTOMATION_STATUS_STYLES[status] || 'bg-gray-100 text-gray-500'}`}>
            {status}
          </span>
        )}
        {runId && (
          <button onClick={() => setExpanded(e => !e)} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
            <Eye className="h-4 w-4" />
          </button>
        )}
        <button
          onClick={handleRun}
          disabled={!targetUrl || running}
          className="flex-shrink-0 inline-flex items-center gap-1.5 text-xs bg-gray-900 hover:bg-black disabled:opacity-40 text-white px-3 py-1.5 rounded-lg font-medium"
        >
          {running
            ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Running…</>
            : <><PlayCircle className="h-3.5 w-3.5" /> Run automation</>}
        </button>
      </div>

      {runMutation.isError && (
        <div className="px-4 py-2 bg-red-50 border-t border-red-100 text-xs text-red-600">
          {runMutation.error?.response?.data?.detail || runMutation.error?.message}
        </div>
      )}

      {expanded && runData && (
        <div className="px-4 py-3 bg-gray-50 border-t border-gray-100 space-y-3">
          {running && (
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1">Console</p>
              <pre
                ref={logBoxRef}
                className="bg-gray-900 text-gray-200 text-[11px] leading-relaxed rounded-lg p-3 max-h-48 overflow-auto whitespace-pre-wrap"
              >
                {runData.log_output || 'Starting…'}
              </pre>
            </div>
          )}

          {isDone && (
            <>
              {runData.summary && <p className="text-xs text-gray-600">{runData.summary}</p>}
              {runData.jira_status_action && (
                <p className="text-xs text-gray-400">
                  Jira: <span className="font-mono">{runData.jira_status_action}</span>
                </p>
              )}
              {steps.map((s, i) => (
                <div key={i} className="flex items-start gap-2 text-xs">
                  {s.status === 'passed'
                    ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500 flex-shrink-0 mt-0.5" />
                    : <XCircle className="h-3.5 w-3.5 text-red-400 flex-shrink-0 mt-0.5" />}
                  <div>
                    <span className="text-gray-700">{s.description}</span>
                    {s.error_text && <p className="text-red-500 mt-0.5">{s.error_text}</p>}
                  </div>
                </div>
              ))}
              {runData.error_text && !steps.length && (
                <p className="text-xs text-red-500">{runData.error_text}</p>
              )}
              {runData.has_screenshot && (
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-1.5">
                    Screenshot{firstFailedBox ? ' — issue marked in red' : ''}
                  </p>
                  <RunScreenshot runId={runId} markBox={firstFailedBox} />
                </div>
              )}
              <details>
                <summary className="text-xs text-gray-400 cursor-pointer hover:text-gray-600">Console output</summary>
                <pre className="mt-1.5 bg-gray-900 text-gray-200 text-[11px] leading-relaxed rounded-lg p-3 max-h-48 overflow-auto whitespace-pre-wrap">
                  {runData.log_output || '(no output captured)'}
                </pre>
              </details>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ── Bug candidates (from failed automation runs) ────────────────────────────────
function BugCandidatesPanel({ storyKey }) {
  const { data: candidates = [], refetch } = useQuery({
    queryKey: ['automation-bug-candidates', storyKey],
    queryFn: () => fetchBugCandidates(storyKey),
    staleTime: 10 * 1000,
  })

  const fileMutation = useMutation({
    mutationFn: fileBugCandidate,
    onSuccess: () => refetch(),
  })

  if (candidates.length === 0) return null

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Bug className="h-4 w-4 text-red-400" />
          <h2 className="text-sm font-semibold text-gray-700">
            Recommended Bugs <span className="text-xs text-gray-400 font-normal">from failed automation runs</span>
          </h2>
        </div>
        <button onClick={() => refetch()} className="text-xs text-brand-600 hover:text-brand-800 flex items-center gap-1">
          <RotateCcw className="h-3.5 w-3.5" /> Refresh
        </button>
      </div>
      <div className="space-y-2">
        {candidates.map(c => (
          <div key={c.id} className="border border-red-100 bg-red-50/40 rounded-lg px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-gray-800">{c.title}</span>
                  <span className="text-xs font-mono text-gray-400">{c.jira_test_key}</span>
                </div>
                <p className="text-xs text-gray-600 mt-1 whitespace-pre-line">{c.description}</p>
              </div>
              <div className="flex-shrink-0">
                {c.status === 'filed' ? (
                  <a href={`https://avite.atlassian.net/browse/${c.jira_bug_key}`} target="_blank" rel="noopener noreferrer"
                     className="inline-flex items-center gap-1 text-xs font-mono text-brand-600 font-semibold hover:underline">
                    {c.jira_bug_key} <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  <button
                    onClick={() => fileMutation.mutate(c.id)}
                    disabled={fileMutation.isPending}
                    className="inline-flex items-center gap-1.5 text-xs bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg font-medium"
                  >
                    {fileMutation.isPending && fileMutation.variables === c.id
                      ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Filing…</>
                      : <><Bug className="h-3.5 w-3.5" /> Open Bug in Jira</>}
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Persistent story automation view (the "Automation" tab's core) ─────────────
function StoryAutomationPanel({ storyKey, storySummary, newlyCreated, onReset }) {
  const [targetUrl, setTargetUrl] = useState('')

  const { data: existingTests = [], refetch: refetchTests } = useQuery({
    queryKey: ['story-tests', storyKey],
    queryFn: () => fetchTestsForStory(storyKey),
    enabled: !!storyKey,
  })

  // Batch runs execute in the background on the server — keep polling this
  // while any test's latest run is still pending/running so per-row status
  // updates live without the user needing to hit Refresh themselves.
  const { data: persistedRuns = {}, refetch: refetchRuns } = useQuery({
    queryKey: ['story-runs', storyKey],
    queryFn: () => fetchRunsForStory(storyKey),
    enabled: !!storyKey,
    refetchInterval: (query) => {
      const data = query.state.data || {}
      return Object.values(data).some(r => RUN_IN_PROGRESS.has(r.status)) ? 2000 : false
    },
  })

  const batchMutation = useMutation({
    mutationFn: runBatch,
    onSuccess: () => { refetchRuns() },
  })

  // Merge: freshly-created report rows (if we just came from generating) + whatever's
  // already linked to the story in Jira — de-duplicated by key, newest info wins.
  const testRows = (() => {
    const byKey = {}
    for (const t of existingTests) byKey[t.key] = { key: t.key, summary: t.summary, url: t.url }
    if (newlyCreated) {
      for (const r of newlyCreated.created) {
        if (r.ok && r.key) byKey[r.key] = { key: r.key, summary: r.summary, url: r.url }
      }
    }
    return Object.values(byKey)
  })()

  const handleRunBatch = () => {
    if (!targetUrl || testRows.length === 0) return
    batchMutation.mutate({ storyKey, target_url: targetUrl })
  }

  // The batch endpoint fires-and-forgets, so batchMutation.isPending only covers
  // the instant POST — derive the real in-progress state from whether any test's
  // latest run is still pending/running (which persistedRuns keeps polling for).
  const batchInProgress = batchMutation.isPending
    || Object.values(persistedRuns).some(r => RUN_IN_PROGRESS.has(r.status))

  return (
    <div className="space-y-4">
      <div className="card px-5 py-4 flex items-center gap-4 flex-wrap">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-gray-400 uppercase font-semibold">Story / Task</p>
          <div className="flex items-center gap-2 mt-0.5">
            <a href={`https://avite.atlassian.net/browse/${storyKey}`} target="_blank" rel="noopener noreferrer"
               className="font-mono text-sm font-bold text-brand-600 hover:underline flex items-center gap-1">
              {storyKey} <ExternalLink className="h-3.5 w-3.5" />
            </a>
            {storySummary && <span className="text-sm text-gray-700 truncate">{storySummary}</span>}
          </div>
        </div>
        <button onClick={onReset} className="btn-secondary px-3 py-1.5 text-xs flex items-center gap-1.5">
          <RotateCcw className="h-3.5 w-3.5" /> Pick another story
        </button>
      </div>

      {newlyCreated && (
        <div className={`flex items-center gap-3 rounded-xl px-5 py-3 ${newlyCreated.failure_count === 0 ? 'bg-green-50 border border-green-200' : 'bg-yellow-50 border border-yellow-200'}`}>
          {newlyCreated.failure_count === 0
            ? <CheckCircle2 className="h-5 w-5 text-green-500 flex-shrink-0" />
            : <AlertCircle className="h-5 w-5 text-yellow-500 flex-shrink-0" />}
          <p className="text-sm text-gray-700">
            {newlyCreated.success_count} new test case{newlyCreated.success_count !== 1 ? 's' : ''} just created in Jira
            {newlyCreated.failure_count > 0 && `, ${newlyCreated.failure_count} failed`}
          </p>
        </div>
      )}

      <div className="card p-5">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <PlayCircle className="h-4 w-4 text-gray-400" />
            <h2 className="text-sm font-semibold text-gray-700">
              Test Cases &amp; Automation
              <span className="ml-2 text-xs text-gray-400 font-normal">{testRows.length} test{testRows.length !== 1 ? 's' : ''} linked to this story</span>
            </h2>
          </div>
          <button onClick={() => refetchTests()} className="text-xs text-brand-600 hover:text-brand-800 flex items-center gap-1">
            <RotateCcw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>

        <div className="flex items-center gap-3 mb-3 flex-wrap">
          <input
            className="text-sm border border-gray-200 rounded-lg px-3 py-2 flex-1 min-w-[280px] max-w-lg focus:outline-none focus:ring-2 focus:ring-brand-300"
            placeholder="Target app URL to test against (e.g. https://staging.citylab.local/)"
            value={targetUrl}
            onChange={e => setTargetUrl(e.target.value)}
          />
          <button
            onClick={handleRunBatch}
            disabled={!targetUrl || testRows.length === 0 || batchInProgress}
            className="inline-flex items-center gap-2 text-sm bg-gray-900 hover:bg-black disabled:opacity-40 text-white px-4 py-2 rounded-lg font-medium"
          >
            {batchInProgress
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Running tests…</>
              : <><PlayCircle className="h-4 w-4" /> Run automatic tests for this story</>}
          </button>
        </div>
        <p className="text-xs text-gray-400 mb-3">AI drafts a Playwright script per test and executes it — best-effort, not a curated suite.</p>

        {batchMutation.isError && (
          <p className="text-xs text-red-500 mb-2">{batchMutation.error?.response?.data?.detail || batchMutation.error?.message}</p>
        )}

        <div className="space-y-2">
          {testRows.map(row => (
            <AutomationRow
              key={row.key}
              testKey={row.key}
              testSummary={row.summary}
              storyKey={storyKey}
              targetUrl={targetUrl}
              initialRun={persistedRuns[row.key] || null}
            />
          ))}
          {testRows.length === 0 && (
            <p className="text-sm text-gray-400 text-center py-6">No test cases linked to this story yet.</p>
          )}
        </div>
      </div>

      <BugCandidatesPanel storyKey={storyKey} />
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function AutomationPage() {
  const [step, setStep] = useState(1)   // 1=select, 2=context, 3=review, 4=automation

  // Fix versions
  const { data: allVersionsRaw, isLoading: versionsLoading, isError: versionsError } = useQuery({
    queryKey: ['fix-versions'],
    queryFn: fetchVersions,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  })
  const allVersions = Array.isArray(allVersionsRaw) ? allVersionsRaw : []
  const visibleVersions = allVersions.filter(v => !v.archived)

  // Step 1 state
  const [versionInput, setVersionInput]   = useState('')
  const [loadedVersion, setLoadedVersion] = useState('')
  const [stories, setStories]             = useState([])
  const [selectedStory, setSelectedStory] = useState(null)
  const [storiesError, setStoriesError]   = useState('')

  // Step 1 state — search by Epic (alternative to the fix-version list above)
  const [selectedEpic, setSelectedEpic]   = useState(null)
  const {
    data: epicChildrenRaw, isLoading: epicChildrenLoading, isError: epicChildrenError,
  } = useQuery({
    queryKey: ['epic-children', selectedEpic?.key],
    queryFn: () => fetchEpicChildren(selectedEpic.key),
    enabled: !!selectedEpic,
  })

  const epicChildren = Array.isArray(epicChildrenRaw) ? epicChildrenRaw : []

  // Once a story/task is picked, check whether it already has test cases —
  // if so, offer a shortcut straight to the persistent Automation view
  // instead of forcing the user through generation again.
  const existingTestsQuery = useQuery({
    queryKey: ['existing-tests-check', selectedStory?.key],
    queryFn: () => fetchTestsForStory(selectedStory.key),
    enabled: !!selectedStory,
  })
  const existingTestsForSelected = existingTestsQuery.data || []
  // Guards the auto-advance-into-generation effect below so it only fires once
  // per story selection, not on every re-render while the query is settled.
  const autoAdvancedKeyRef = useRef(null)

  // Step 2 state
  const [contextData, setContextData]     = useState(null)
  const [uploadedFiles, setUploadedFiles] = useState([])   // file summaries from backend
  const [extraContext, setExtraContext]   = useState('')    // combined extracted text
  const [testMode, setTestMode]           = useState('basic')  // "basic" | "extended"
  const [wantConfluence, setWantConfluence] = useState(true)
  // Defaults on like Confluence — auto-detection means it costs nothing to try
  // and gracefully finds no sources if the story has no embedded Figma link.
  const [wantFigma, setWantFigma]           = useState(true)
  const [figmaUrl, setFigmaUrl]             = useState('')
  const [wantUpload, setWantUpload]         = useState(false)
  // No figmaUrl requirement — when left blank, the backend auto-detects a Figma
  // link already embedded in the story/epic description (these tickets commonly
  // include a "Figma ref:" link), so the checkbox alone is enough to opt in.
  const sourceToggles = { jira: true, confluence: wantConfluence, figma: wantFigma }

  // Step 3 state
  const [testCases, setTestCases]               = useState([])
  const [fixVersionForCreate, setFixVersionForCreate] = useState('')

  // Step 4 state
  const [creationReport, setCreationReport] = useState(null)

  // ── Mutations ──
  const storiesMutation = useMutation({
    mutationFn: fetchStories,
    onSuccess: (data) => {
      setStories(data)
      setLoadedVersion(versionInput)
      setStoriesError('')
      setSelectedStory(null)
    },
    onError: (err) => setStoriesError(err.response?.data?.detail || err.message),
  })

  const contextMutation = useMutation({
    mutationFn: fetchContext,
    onSuccess: (data) => {
      setContextData(data)
      setStep(2)
    },
    onError: () => {},
  })

  const uploadMutation = useMutation({
    mutationFn: uploadFiles,
    onSuccess: (data) => {
      setUploadedFiles(prev => [...prev, ...data.files])
      setExtraContext(prev => prev ? prev + '\n\n' + data.extracted_text : data.extracted_text)
    },
    onError: () => {},
  })

  const generateMutation = useMutation({
    mutationFn: generateTC,
    onSuccess: (data) => {
      setTestCases(data.test_cases || [])
      setFixVersionForCreate(data.fix_versions?.[0] || loadedVersion)
      setStep(3)
    },
    onError: () => {},
  })

  const createMutation = useMutation({
    mutationFn: createTC,
    onSuccess: (data) => {
      setCreationReport(data)
      setStep(4)
    },
    onError: () => {},
  })

  // ── Handlers ──
  const handleLoadStories = () => {
    if (!versionInput) return
    storiesMutation.mutate(versionInput)
  }

  const handleOpenContext = (story) => {
    setSelectedStory(story)
    contextMutation.mutate({
      story_key: story.key,
      sources: sourceToggles,
      figma_url: figmaUrl,
    })
  }

  // Picking a row only selects the story — it does NOT immediately regenerate
  // test cases. We wait for the existing-tests check so a story that already
  // has Jira tests can offer the "View & Run Automation" shortcut instead.
  const handleSelectStory = (story) => {
    setSelectedStory(story)
  }

  // Once the existing-tests check settles empty for the selected story, fall
  // through into normal context generation — preserves the original one-click
  // flow for stories that have no test cases yet.
  useEffect(() => {
    if (!selectedStory) return
    if (existingTestsQuery.isLoading || existingTestsQuery.isFetching) return
    if (autoAdvancedKeyRef.current === selectedStory.key) return
    if (existingTestsForSelected.length === 0) {
      autoAdvancedKeyRef.current = selectedStory.key
      handleOpenContext(selectedStory)
    }
  }, [selectedStory, existingTestsQuery.isLoading, existingTestsQuery.isFetching, existingTestsForSelected.length])

  // Re-fetch context when the user flips a source checkbox or edits the Figma URL
  // while already on Step 2, so the sources/preview stay in sync with the toggles.
  const handleRefreshContext = () => {
    if (!selectedStory) return
    contextMutation.mutate({
      story_key: selectedStory.key,
      sources: sourceToggles,
      figma_url: figmaUrl,
    })
  }

  const handleUploadFiles = async (files) => {
    const form = new FormData()
    files.forEach(f => form.append('files', f))
    uploadMutation.mutate(form)
  }

  const handleRemoveFile = (idx) => {
    setUploadedFiles(prev => prev.filter((_, i) => i !== idx))
    // Rebuild extra context without that file's contribution isn't trivial,
    // so we clear and let the user re-upload if needed
    if (uploadedFiles.length === 1) setExtraContext('')
  }

  const handleGenerate = () => {
    if (!selectedStory) return
    generateMutation.mutate({
      story_key: selectedStory.key,
      extra_context: extraContext,
      mode: testMode,
      sources: sourceToggles,
      figma_url: figmaUrl,
    })
  }

  const removeTC  = (idx) => setTestCases(tcs => tcs.filter((_, i) => i !== idx))
  const updateTC  = (idx, updated) => setTestCases(tcs => tcs.map((tc, i) => i === idx ? updated : tc))

  const handleCreate = () => {
    if (!selectedStory || testCases.length === 0) return
    createMutation.mutate({
      story_key: selectedStory.key,
      test_cases: testCases,
      fix_version: fixVersionForCreate,
      ai_summary: contextData?.ai_summary || '',
    })
  }

  const handleReset = () => {
    setStep(1)
    setSelectedStory(null)
    setSelectedEpic(null)
    setContextData(null)
    setUploadedFiles([])
    setExtraContext('')
    setTestMode('basic')
    setTestCases([])
    setCreationReport(null)
    setWantConfluence(true)
    setWantFigma(true)
    setFigmaUrl('')
    setWantUpload(false)
    contextMutation.reset()
    generateMutation.reset()
    createMutation.reset()
  }

  const isLoadingContext  = contextMutation.isPending
  const isUploading       = uploadMutation.isPending
  const isGenerating      = generateMutation.isPending
  const isCreating        = createMutation.isPending

  return (
    <div className="flex-1 flex flex-col">
      <Header title="Automation" />

      <div className="flex-1 p-6 space-y-5 overflow-auto">

        {/* Step indicator */}
        <div className="card px-5 py-3">
          <Steps current={step} />
        </div>

        {/* ══════════════════════════════════════════════════════════
            STEP 1 — Select a story
        ══════════════════════════════════════════════════════════ */}
        {step === 1 && (
          <div className="space-y-4">
            {/* Shortcut: the selected story already has tests — skip straight to Automation */}
            {selectedStory && existingTestsQuery.isFetching && (
              <div className="flex items-center gap-2 rounded-xl px-5 py-3 bg-gray-50 border border-gray-200 text-sm text-gray-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Checking {selectedStory.key} for existing test cases…
              </div>
            )}
            {selectedStory && !existingTestsQuery.isFetching && existingTestsForSelected.length > 0 && (
              <div className="flex items-center gap-3 rounded-xl px-5 py-3 bg-blue-50 border border-blue-200">
                <PlayCircle className="h-5 w-5 text-blue-500 flex-shrink-0" />
                <p className="text-sm text-gray-700 flex-1">
                  <span className="font-mono font-semibold text-brand-600">{selectedStory.key}</span> already has{' '}
                  <strong>{existingTestsForSelected.length}</strong> test case{existingTestsForSelected.length !== 1 ? 's' : ''} in Jira.
                </p>
                <button
                  onClick={() => setStep(4)}
                  className="btn-primary px-4 py-2 text-sm flex items-center gap-2"
                >
                  <PlayCircle className="h-4 w-4" /> View &amp; Run Automation
                </button>
                <button
                  onClick={() => handleOpenContext(selectedStory)}
                  disabled={isLoadingContext}
                  className="px-4 py-2 text-sm rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2"
                >
                  {isLoadingContext
                    ? <><Loader2 className="h-4 w-4 animate-spin" /> Loading…</>
                    : <><Wand2 className="h-4 w-4" /> Generate More Test Cases</>}
                </button>
              </div>
            )}

            {/* Search by Epic — alternative entry point to the fix-version list below */}
            <div className="card p-5">
              <div className="flex items-center gap-2 mb-3">
                <Layers className="h-4 w-4 text-gray-400" />
                <h2 className="text-sm font-semibold text-gray-700">Search by Epic</h2>
                <span className="text-xs text-gray-400 font-normal">Open an epic to see its Stories/Tasks</span>
              </div>
              <EpicSearchBox onSelect={setSelectedEpic} />

              {selectedEpic && (
                <div className="mt-4">
                  <div className="flex items-center gap-2 mb-2">
                    <a href={selectedEpic.url} target="_blank" rel="noopener noreferrer"
                       className="inline-flex items-center gap-1 font-mono text-xs text-brand-600 font-semibold hover:underline">
                      {selectedEpic.key} <ExternalLink className="h-3 w-3" />
                    </a>
                    <span className="text-sm text-gray-700">{selectedEpic.summary}</span>
                  </div>

                  {epicChildrenLoading && (
                    <div className="flex items-center gap-2 text-sm text-gray-400 py-3">
                      <Loader2 className="h-4 w-4 animate-spin" /> Loading Stories/Tasks…
                    </div>
                  )}
                  {epicChildrenError && (
                    <p className="text-xs text-red-500 flex items-center gap-1 py-2">
                      <AlertCircle className="h-3.5 w-3.5" /> Could not load children for this epic.
                    </p>
                  )}
                  {!epicChildrenLoading && !epicChildrenError && epicChildren.length === 0 && (
                    <p className="text-xs text-gray-400 py-2">No Story/Task children found under this epic.</p>
                  )}
                  {epicChildren.length > 0 && (
                    <div className="overflow-x-auto rounded-lg border border-gray-100">
                      <table className="min-w-full text-sm bg-white">
                        <thead className="bg-gray-50 border-b border-gray-100">
                          <tr>
                            {['Key', 'Type', 'Summary', 'Status', 'Action'].map(h => (
                              <th key={h} className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {epicChildren.map(child => (
                            <tr key={child.key} className={`hover:bg-gray-50 ${selectedStory?.key === child.key ? 'bg-brand-50' : ''}`}>
                              <td className="px-3 py-2 whitespace-nowrap">
                                <a href={child.url} target="_blank" rel="noopener noreferrer"
                                   className="inline-flex items-center gap-1 font-mono text-xs text-brand-600 font-semibold hover:underline">
                                  {child.key} <ExternalLink className="h-3 w-3" />
                                </a>
                              </td>
                              <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500">{child.issuetype}</td>
                              <td className="px-3 py-2 text-gray-700 max-w-sm"><span className="line-clamp-2">{child.summary}</span></td>
                              <td className="px-3 py-2 whitespace-nowrap"><StatusPill status={child.status} /></td>
                              <td className="px-3 py-2 whitespace-nowrap">
                                <button
                                  onClick={() => handleSelectStory(child)}
                                  disabled={isLoadingContext || (existingTestsQuery.isFetching && selectedStory?.key === child.key)}
                                  className="inline-flex items-center gap-1.5 text-xs bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg transition-colors font-medium"
                                >
                                  {selectedStory?.key === child.key && (isLoadingContext || existingTestsQuery.isFetching)
                                    ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> {isLoadingContext ? 'Loading…' : 'Checking…'}</>
                                    : <><Wand2 className="h-3.5 w-3.5" /> Select</>}
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Version selector */}
            <div className="card p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-gray-700">Or: Fix Version</h2>
                {!versionsLoading && !versionsError && (
                  <span className="text-xs text-gray-400">{visibleVersions.length} versions available</span>
                )}
              </div>
              <div className="flex gap-3 items-center flex-wrap">
                {versionsError || (!versionsLoading && visibleVersions.length === 0) ? (
                  <input
                    className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white w-64 focus:outline-none focus:ring-2 focus:ring-brand-300"
                    placeholder="e.g. K1-S-3.1.0"
                    value={versionInput}
                    onChange={e => setVersionInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleLoadStories()}
                  />
                ) : (
                  <div className="relative">
                    <select
                      className="text-sm border border-gray-200 rounded-lg pl-3 pr-8 py-2 bg-white w-64 appearance-none focus:outline-none focus:ring-2 focus:ring-brand-300 disabled:opacity-50"
                      value={versionInput}
                      onChange={e => setVersionInput(e.target.value)}
                      disabled={versionsLoading}
                    >
                      <option value="">{versionsLoading ? 'Loading versions…' : '— Select a fix version —'}</option>
                      {visibleVersions.map(v => (
                        <option key={v.id ?? v.name} value={v.name}>
                          {v.name}{v.released ? ' ✓' : ''}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="h-4 w-4 text-gray-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  </div>
                )}
                <button
                  onClick={handleLoadStories}
                  disabled={!versionInput || storiesMutation.isPending}
                  className="btn-primary px-4 py-2 text-sm flex items-center gap-2 disabled:opacity-50"
                >
                  {storiesMutation.isPending
                    ? <><Loader2 className="h-4 w-4 animate-spin" /> Loading…</>
                    : <><FileText className="h-4 w-4" /> Load Stories</>}
                </button>
              </div>
              {versionsError && (
                <p className="mt-2 text-xs text-amber-600 flex items-center gap-1">
                  <AlertCircle className="h-3.5 w-3.5" /> Could not load versions from Jira — type the version name manually.
                </p>
              )}
              {storiesError && (
                <p className="mt-2 text-xs text-red-500 flex items-center gap-1">
                  <AlertCircle className="h-3.5 w-3.5" /> {storiesError}
                </p>
              )}
            </div>

            {/* Stories table */}
            {stories.length > 0 && (
              <div className="card p-0 overflow-hidden">
                <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 bg-gray-50">
                  <div>
                    <h2 className="text-sm font-semibold text-gray-700">
                      Stories without test cases
                      <span className="ml-2 bg-red-500 text-white text-xs rounded-full px-2 py-0.5">{stories.length}</span>
                    </h2>
                    <p className="text-xs text-gray-400 mt-0.5">Fix version: {loadedVersion}</p>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm bg-white">
                    <thead className="bg-gray-50 border-b border-gray-100">
                      <tr>
                        {['Story', 'Summary', 'Status', 'Parent Epic', 'Action'].map(h => (
                          <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {stories.map(story => (
                        <tr key={story.key} className={`hover:bg-gray-50 ${selectedStory?.key === story.key ? 'bg-brand-50' : ''}`}>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <a href={story.url} target="_blank" rel="noopener noreferrer"
                               className="inline-flex items-center gap-1 font-mono text-xs text-brand-600 font-semibold hover:underline">
                              {story.key} <ExternalLink className="h-3 w-3" />
                            </a>
                          </td>
                          <td className="px-4 py-3 text-gray-700 max-w-sm">
                            <span className="line-clamp-2">{story.summary}</span>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <StatusPill status={story.status} />
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-500">
                            {story.parent_key ? (
                              <div>
                                <span className="font-mono text-brand-500">{story.parent_key}</span>
                                {story.parent_summary && (
                                  <span className="block text-gray-400 max-w-xs truncate">{story.parent_summary}</span>
                                )}
                              </div>
                            ) : '—'}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <button
                              onClick={() => handleSelectStory(story)}
                              disabled={isLoadingContext || (existingTestsQuery.isFetching && selectedStory?.key === story.key)}
                              className="inline-flex items-center gap-1.5 text-xs bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg transition-colors font-medium"
                            >
                              {selectedStory?.key === story.key && (isLoadingContext || existingTestsQuery.isFetching)
                                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> {isLoadingContext ? 'Loading…' : 'Checking…'}</>
                                : <><Wand2 className="h-3.5 w-3.5" /> Select</>}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Context loading overlay */}
            {isLoadingContext && (
              <div className="card p-8 text-center">
                <div className="flex flex-col items-center gap-3">
                  <div className="relative">
                    <BookOpen className="h-10 w-10 text-brand-300" />
                    <Loader2 className="h-5 w-5 text-brand-600 animate-spin absolute -top-1 -right-1" />
                  </div>
                  <div>
                    <p className="font-semibold text-gray-700">Loading story context…</p>
                    <p className="text-sm text-gray-400 mt-0.5">Fetching Jira story, epic & Confluence pages</p>
                    <p className="text-xs text-brand-500 font-mono mt-1">{selectedStory?.key}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Context error */}
            {contextMutation.isError && (
              <div className="card p-4 border-red-200 bg-red-50">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-red-700">Failed to load context</p>
                    <p className="text-xs text-red-500 mt-0.5">
                      {contextMutation.error?.response?.data?.detail || contextMutation.error?.message}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Empty state */}
            {!storiesMutation.isPending && stories.length === 0 && loadedVersion && (
              <div className="card p-10 text-center">
                <CheckCircle2 className="h-12 w-12 text-green-300 mx-auto mb-3" />
                <p className="font-medium text-gray-600">All stories in {loadedVersion} have test cases!</p>
                <p className="text-sm text-gray-400 mt-1">Try a different fix version.</p>
              </div>
            )}
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════
            STEP 2 — Context & Summary
        ══════════════════════════════════════════════════════════ */}
        {step === 2 && contextData && (
          <div className="space-y-4">
            {/* Story header bar */}
            <div className="card px-5 py-3 flex items-center gap-4 flex-wrap">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-gray-400 uppercase font-semibold">Story</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <a href={selectedStory?.url} target="_blank" rel="noopener noreferrer"
                     className="font-mono text-sm font-bold text-brand-600 hover:underline flex items-center gap-1">
                    {selectedStory?.key} <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                  <span className="text-sm text-gray-700 truncate">{selectedStory?.summary}</span>
                  <StatusPill status={contextData.story_status} />
                </div>
              </div>
              <button onClick={handleReset} className="btn-secondary px-3 py-1.5 text-xs flex items-center gap-1.5">
                <RotateCcw className="h-3.5 w-3.5" /> Back
              </button>
            </div>

            {/* Source selection — which context to pull before (re)generating */}
            <div className="card p-5">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">Data Sources to Use</h2>
              <div className="flex flex-wrap items-start gap-4">
                <label className="flex items-center gap-2 text-sm text-gray-400 cursor-not-allowed">
                  <input type="checkbox" checked disabled className="rounded" />
                  <Database className="h-3.5 w-3.5" /> Jira (always included)
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={wantConfluence}
                    onChange={e => setWantConfluence(e.target.checked)}
                    className="rounded text-brand-600 focus:ring-brand-400"
                  />
                  <BookOpen className="h-3.5 w-3.5 text-teal-500" /> Confluence
                </label>
                <div>
                  <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={wantFigma}
                      onChange={e => setWantFigma(e.target.checked)}
                      className="rounded text-brand-600 focus:ring-brand-400"
                    />
                    <FigmaIcon className="h-3.5 w-3.5 text-pink-500" /> Figma
                  </label>
                  {wantFigma && (
                    <>
                      <input
                        className="mt-1.5 text-xs border border-gray-200 rounded-lg px-2 py-1.5 w-72 focus:outline-none focus:ring-1 focus:ring-brand-300"
                        placeholder="Optional: override with a specific frame URL"
                        value={figmaUrl}
                        onChange={e => setFigmaUrl(e.target.value)}
                      />
                      <p className="mt-1 text-[11px] text-gray-400 w-72">
                        Leave blank to auto-detect a Figma link already in the story/epic description.
                      </p>
                    </>
                  )}
                </div>
                <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={wantUpload}
                    onChange={e => setWantUpload(e.target.checked)}
                    className="rounded text-brand-600 focus:ring-brand-400"
                  />
                  <Upload className="h-3.5 w-3.5 text-orange-500" /> Other (upload docs)
                </label>

                <button
                  onClick={handleRefreshContext}
                  disabled={isLoadingContext}
                  className="ml-auto btn-secondary px-3 py-1.5 text-xs flex items-center gap-1.5 disabled:opacity-50"
                  title="Re-fetch sources with the current toggles"
                >
                  {isLoadingContext
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <RotateCcw className="h-3.5 w-3.5" />}
                  Refresh sources
                </button>
              </div>
            </div>

            {/* AI Summary */}
            {contextData.ai_summary && (
              <div className="card p-5 border-brand-200 bg-brand-50/30">
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 bg-brand-100 rounded-lg p-2">
                    <Sparkles className="h-5 w-5 text-brand-600" />
                  </div>
                  <div className="flex-1">
                    <p className="text-xs font-semibold text-brand-700 uppercase mb-3">AI Summary</p>
                    <div className="space-y-3">
                      {contextData.ai_summary.split(/\n\n+/).map((para, i) => {
                        // Render **bold** markers
                        const parts = para.split(/(\*\*[^*]+\*\*)/)
                        return (
                          <p key={i} className="text-sm text-gray-700 leading-relaxed">
                            {parts.map((part, j) =>
                              part.startsWith('**') && part.endsWith('**')
                                ? <strong key={j} className="text-gray-900">{part.slice(2, -2)}</strong>
                                : part
                            )}
                          </p>
                        )
                      })}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Data Sources */}
            <div className="card p-5">
              <div className="flex items-center gap-2 mb-3">
                <Info className="h-4 w-4 text-gray-400" />
                <h2 className="text-sm font-semibold text-gray-700">
                  Data Sources
                  <span className="ml-2 text-xs text-gray-400 font-normal">
                    {contextData.sources_used.length} source{contextData.sources_used.length !== 1 ? 's' : ''} found
                  </span>
                </h2>
              </div>
              <div className="space-y-2">
                {contextData.sources_used.map((source, i) => (
                  <SourceCard key={i} source={source} />
                ))}
                {contextData.sources_used.length === 0 && (
                  <p className="text-sm text-gray-400 text-center py-3">No sources found</p>
                )}
              </div>
            </div>

            {/* File upload — only shown once "Other (upload docs)" is checked above */}
            {wantUpload && (
              <div className="card p-5">
                <div className="flex items-center gap-2 mb-3">
                  <Upload className="h-4 w-4 text-gray-400" />
                  <h2 className="text-sm font-semibold text-gray-700">
                    Add More Context
                    <span className="ml-2 text-xs text-gray-400 font-normal">Optional — enrich test generation with your own files</span>
                  </h2>
                </div>

                <FileUploadZone
                  uploadedFiles={uploadedFiles}
                  onUpload={handleUploadFiles}
                  onRemove={handleRemoveFile}
                  isUploading={isUploading}
                />

                {uploadMutation.isError && (
                  <p className="mt-2 text-xs text-red-500 flex items-center gap-1">
                    <AlertCircle className="h-3.5 w-3.5" />
                    {uploadMutation.error?.response?.data?.detail || uploadMutation.error?.message}
                  </p>
                )}

                {uploadedFiles.length > 0 && (
                  <p className="mt-2 text-xs text-green-600 flex items-center gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {uploadedFiles.filter(f => f.ok).length} file{uploadedFiles.filter(f => f.ok).length !== 1 ? 's' : ''} will be included in test generation
                  </p>
                )}
              </div>
            )}

            {/* Mode selector + Generate button */}
            <div className="card px-5 py-4 space-y-4">
              {/* Mode picker */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Test Generation Mode</p>
                <div className="flex gap-3">
                  <button
                    onClick={() => setTestMode('basic')}
                    className={`flex-1 rounded-xl border-2 px-4 py-3 text-left transition-all ${
                      testMode === 'basic'
                        ? 'border-brand-500 bg-brand-50'
                        : 'border-gray-200 bg-white hover:border-gray-300'
                    }`}
                  >
                    <p className={`text-sm font-semibold ${testMode === 'basic' ? 'text-brand-700' : 'text-gray-700'}`}>
                      Basic
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">3–5 test cases · Core paths only</p>
                  </button>
                  <button
                    onClick={() => setTestMode('extended')}
                    className={`flex-1 rounded-xl border-2 px-4 py-3 text-left transition-all ${
                      testMode === 'extended'
                        ? 'border-brand-500 bg-brand-50'
                        : 'border-gray-200 bg-white hover:border-gray-300'
                    }`}
                  >
                    <p className={`text-sm font-semibold ${testMode === 'extended' ? 'text-brand-700' : 'text-gray-700'}`}>
                      Extended
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">6–10 test cases · Full coverage + edge cases</p>
                  </button>
                </div>
              </div>

              {/* Generate action */}
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-400">
                  Claude will use {contextData.sources_used.length} source{contextData.sources_used.length !== 1 ? 's' : ''}
                  {uploadedFiles.filter(f => f.ok).length > 0 && ` + ${uploadedFiles.filter(f => f.ok).length} uploaded file${uploadedFiles.filter(f => f.ok).length !== 1 ? 's' : ''}`}
                  {' '}to generate test cases.
                </p>
                <button
                  onClick={handleGenerate}
                  disabled={isGenerating}
                  className="btn-primary px-5 py-2.5 text-sm flex items-center gap-2 disabled:opacity-50"
                >
                  {isGenerating
                    ? <><Loader2 className="h-4 w-4 animate-spin" /> Generating with Claude…</>
                    : <><Sparkles className="h-4 w-4" /> Generate Test Cases</>}
                </button>
              </div>
            </div>

            {/* Generating overlay */}
            {isGenerating && (
              <div className="card p-8 text-center">
                <div className="flex flex-col items-center gap-3">
                  <div className="relative">
                    <Sparkles className="h-10 w-10 text-brand-300" />
                    <Loader2 className="h-5 w-5 text-brand-600 animate-spin absolute -top-1 -right-1" />
                  </div>
                  <div>
                    <p className="font-semibold text-gray-700">Generating test cases…</p>
                    <p className="text-sm text-gray-400 mt-0.5">Claude is reading all sources and writing test cases</p>
                    <p className="text-xs text-brand-500 font-mono mt-1">{selectedStory?.key}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Generation error */}
            {generateMutation.isError && (
              <div className="card p-4 border-red-200 bg-red-50">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-red-700">Generation failed</p>
                    <p className="text-xs text-red-500 mt-0.5">
                      {generateMutation.error?.response?.data?.detail || generateMutation.error?.message}
                    </p>
                    <button onClick={handleGenerate} className="mt-2 text-xs text-red-600 hover:text-red-800 underline">
                      Try again
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════
            STEP 3 — Review & edit generated test cases
        ══════════════════════════════════════════════════════════ */}
        {step === 3 && (
          <div className="space-y-4">
            <div className="card px-5 py-3 flex items-center gap-4 flex-wrap">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-gray-400 uppercase font-semibold">Story</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <a href={selectedStory?.url} target="_blank" rel="noopener noreferrer"
                     className="font-mono text-sm font-bold text-brand-600 hover:underline flex items-center gap-1">
                    {selectedStory?.key} <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                  <span className="text-sm text-gray-700 truncate">{selectedStory?.summary}</span>
                </div>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <div>
                  <p className="text-xs text-gray-400 uppercase font-semibold">Fix Version</p>
                  <input
                    className="mt-0.5 text-sm border border-gray-200 rounded-lg px-2 py-1 w-36"
                    value={fixVersionForCreate}
                    onChange={e => setFixVersionForCreate(e.target.value)}
                    placeholder="e.g. K1-S-3.1.0"
                  />
                </div>
                <button onClick={() => setStep(2)} className="btn-secondary px-3 py-1.5 text-xs flex items-center gap-1.5">
                  <RotateCcw className="h-3.5 w-3.5" /> Back
                </button>
              </div>
            </div>

            <div className="flex items-center gap-4 px-1">
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <Sparkles className="h-4 w-4 text-brand-500" />
                <span><strong>{testCases.length}</strong> test cases generated</span>
              </div>
              <div className="text-xs text-gray-400">
                Click any field to edit · <Trash2 className="h-3 w-3 inline" /> to remove a test
              </div>
            </div>

            <div className="space-y-3">
              {testCases.map((tc, i) => (
                <TestCaseCard key={i} tc={tc} index={i} onRemove={removeTC} onUpdate={updateTC} />
              ))}
            </div>

            {testCases.length === 0 && (
              <div className="card p-8 text-center text-gray-400">
                <p>All test cases removed. Go back and regenerate.</p>
              </div>
            )}

            {createMutation.isError && (
              <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
                <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-red-700">Creation failed</p>
                  <p className="text-xs text-red-500 mt-0.5">
                    {createMutation.error?.response?.data?.detail || createMutation.error?.message}
                  </p>
                </div>
              </div>
            )}

            <div className="card px-5 py-3 flex items-center justify-between">
              <p className="text-xs text-gray-400">
                {testCases.length} test case{testCases.length !== 1 ? 's' : ''} will be created in Jira
                {fixVersionForCreate && ` · Fix version: ${fixVersionForCreate}`}
              </p>
              <button
                onClick={handleCreate}
                disabled={testCases.length === 0 || isCreating}
                className="btn-primary px-5 py-2 text-sm flex items-center gap-2 disabled:opacity-50"
              >
                {isCreating
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating in Jira…</>
                  : <><CheckCircle2 className="h-4 w-4" /> Create {testCases.length} Tests in Jira</>}
              </button>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════
            STEP 4 — Automation (persistent: reachable either right after
            creating new tests, or as a shortcut when a story already has some)
        ══════════════════════════════════════════════════════════ */}
        {step === 4 && selectedStory && (
          <StoryAutomationPanel
            storyKey={selectedStory.key}
            storySummary={selectedStory.summary}
            newlyCreated={creationReport}
            onReset={handleReset}
          />
        )}

      </div>
    </div>
  )
}

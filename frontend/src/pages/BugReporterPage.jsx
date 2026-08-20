import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Header } from '../components/layout/Header'
import axios from 'axios'
import { BASE_URL } from '../services/api'
import {
  Bug, ChevronRight, CheckCircle2, Loader2, AlertCircle,
  RotateCcw, Sparkles, Upload, FileImage, X, XCircle,
  ExternalLink, Edit3, Check, Trash2, History, Plus,
  ChevronDown, Info, Database, Eye, Save, Send
} from 'lucide-react'

const api = axios.create({ baseURL: BASE_URL, timeout: 120000 })

const fetchMeta        = () => api.get('/bug-reporter/meta').then(r => r.data)
const fetchContext     = (d) => api.post('/bug-reporter/product-context', d).then(r => r.data)
const uploadFiles      = (f) => api.post('/bug-reporter/upload-files', f, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data)
const generateTemplate = (d) => api.post('/bug-reporter/generate', d).then(r => r.data)
const saveDraft        = (d) => api.post('/bug-reporter/draft', d).then(r => r.data)
const deleteDraft      = (id) => api.delete(`/bug-reporter/draft/${id}`).then(r => r.data)
const createBug        = (d) => api.post('/bug-reporter/create', d).then(r => r.data)
const fetchDrafts      = () => api.get('/bug-reporter/drafts').then(r => r.data)
const fetchHistory     = () => api.get('/bug-reporter/history').then(r => r.data)

const ALLOWED_EXTS = ['.txt', '.md', '.csv', '.json', '.log', '.png', '.jpg', '.jpeg', '.gif', '.webp']
const SEVERITY_COLORS = {
  Critical: 'bg-red-100 text-red-700',
  Highest:  'bg-red-100 text-red-700',
  High:     'bg-orange-100 text-orange-700',
  Medium:   'bg-yellow-100 text-yellow-700',
  Low:      'bg-blue-100 text-blue-700',
}

// ── Step indicator ─────────────────────────────────────────────────────────────
function Steps({ current }) {
  const steps = ['Select Product', 'Learn from Jira', 'Review Template', 'Created in Jira']
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

// ── Inline editable field ──────────────────────────────────────────────────────
function EditableField({ value, onChange, multiline = false, placeholder = 'click to edit', className = '' }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  const commit = () => { onChange(draft); setEditing(false) }
  const cancel = () => { setDraft(value); setEditing(false) }

  if (!editing) {
    return (
      <span
        className={`cursor-pointer hover:bg-yellow-50 rounded px-1 -mx-1 group inline ${className}`}
        onClick={() => { setDraft(value); setEditing(true) }}
      >
        {value || <span className="text-gray-300 italic">{placeholder}</span>}
        <Edit3 className="h-3 w-3 text-gray-300 group-hover:text-brand-400 inline ml-1" />
      </span>
    )
  }
  return (
    <span className="flex items-start gap-1 w-full">
      {multiline ? (
        <textarea
          autoFocus
          className="flex-1 text-sm border border-brand-300 rounded px-2 py-1 resize-none focus:outline-none focus:ring-1 focus:ring-brand-400 w-full"
          rows={4}
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
      <button onClick={commit} className="text-green-600 hover:text-green-700 mt-0.5 flex-shrink-0"><Check className="h-4 w-4" /></button>
      <button onClick={cancel} className="text-gray-400 hover:text-gray-600 mt-0.5 flex-shrink-0"><X className="h-4 w-4" /></button>
    </span>
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
            <p className="text-sm font-medium text-gray-600">Drop logs or screenshots here, or click to browse</p>
            <p className="text-xs text-gray-400">
              .txt .log .csv .json .md · .png .jpg .gif .webp · Max 10 MB each · Up to 10 files
            </p>
          </div>
        )}
      </div>
      {uploadedFiles.length > 0 && (
        <div className="space-y-2">
          {uploadedFiles.map((f, i) => (
            <div key={i} className="flex items-center gap-3 bg-white border border-gray-200 rounded-lg px-3 py-2">
              <FileImage className="h-4 w-4 text-gray-400 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-700 truncate">{f.name}</p>
                {f.ok
                  ? <p className="text-xs text-green-600">
                      {f.type === 'image' ? 'Screenshot described by AI' : `${f.chars?.toLocaleString()} characters extracted`}
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

// ── Severity badge ─────────────────────────────────────────────────────────────
function SeverityBadge({ value }) {
  const cls = SEVERITY_COLORS[value] || 'bg-gray-100 text-gray-600'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {value || '—'}
    </span>
  )
}

// ── Drafts panel ───────────────────────────────────────────────────────────────
function DraftsPanel({ onLoadDraft }) {
  const [showHistory, setShowHistory] = useState(false)
  const queryClient = useQueryClient()

  const { data: drafts = [], isLoading: draftsLoading } = useQuery({
    queryKey: ['bug-drafts'],
    queryFn: fetchDrafts,
    staleTime: 30000,
  })
  const { data: history = [], isLoading: historyLoading } = useQuery({
    queryKey: ['bug-history'],
    queryFn: fetchHistory,
    staleTime: 30000,
    enabled: showHistory,
  })

  const deleteMutation = useMutation({
    mutationFn: deleteDraft,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['bug-drafts'] }),
  })

  const draftItems = drafts.filter(d => d.status === 'draft')

  return (
    <div className="card p-0 overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-100 bg-gray-50">
        <div className="flex gap-3">
          <button
            onClick={() => setShowHistory(false)}
            className={`text-sm font-medium pb-0.5 ${!showHistory ? 'text-brand-600 border-b-2 border-brand-600' : 'text-gray-400 hover:text-gray-600'}`}
          >
            Drafts ({draftItems.length})
          </button>
          <button
            onClick={() => setShowHistory(true)}
            className={`text-sm font-medium pb-0.5 flex items-center gap-1.5 ${showHistory ? 'text-brand-600 border-b-2 border-brand-600' : 'text-gray-400 hover:text-gray-600'}`}
          >
            <History className="h-3.5 w-3.5" /> Created ({history.length})
          </button>
        </div>
      </div>

      {!showHistory ? (
        <div>
          {draftsLoading && (
            <div className="px-5 py-4 text-center text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin inline mr-1" /> Loading drafts…
            </div>
          )}
          {!draftsLoading && draftItems.length === 0 && (
            <div className="px-5 py-4 text-center text-sm text-gray-400">No drafts saved yet.</div>
          )}
          {draftItems.map(d => (
            <div key={d.id} className="flex items-start gap-3 px-5 py-3 border-b border-gray-50 hover:bg-gray-50 last:border-0">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-800 truncate">{d.summary || '(untitled)'}</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {d.product_name}
                  {d.severity && <> · <SeverityBadge value={d.severity} /></>}
                  {d.updated_at && <> · {new Date(d.updated_at).toLocaleDateString()}</>}
                </p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => onLoadDraft(d)}
                  className="text-xs text-brand-600 hover:text-brand-800 font-medium"
                >
                  Continue
                </button>
                <button
                  onClick={() => deleteMutation.mutate(d.id)}
                  disabled={deleteMutation.isPending}
                  className="text-gray-300 hover:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div>
          {historyLoading && (
            <div className="px-5 py-4 text-center text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin inline mr-1" /> Loading history…
            </div>
          )}
          {!historyLoading && history.length === 0 && (
            <div className="px-5 py-4 text-center text-sm text-gray-400">No bugs created yet.</div>
          )}
          {history.map(h => (
            <div key={h.id} className="flex items-start gap-3 px-5 py-3 border-b border-gray-50 hover:bg-gray-50 last:border-0">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <a
                    href={h.jira_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-xs font-bold text-brand-600 hover:underline flex items-center gap-1"
                  >
                    {h.jira_key} <ExternalLink className="h-3 w-3" />
                  </a>
                  {h.severity && <SeverityBadge value={h.severity} />}
                </div>
                <p className="text-sm text-gray-700 truncate mt-0.5">{h.summary}</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {h.product_name}
                  {h.fix_version_name && <> · {h.fix_version_name}</>}
                  {h.created_at && <> · {new Date(h.created_at).toLocaleDateString()}</>}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Success card ───────────────────────────────────────────────────────────────
function SuccessCard({ result, onReset }) {
  return (
    <div className="space-y-4">
      <div className="bg-green-50 border border-green-200 rounded-xl px-5 py-5">
        <div className="flex items-start gap-4">
          <CheckCircle2 className="h-8 w-8 text-green-500 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-lg font-bold text-gray-800">Bug created in Jira!</p>
            <a
              href={result.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 mt-2 text-brand-600 font-mono font-bold text-lg hover:underline"
            >
              {result.key} <ExternalLink className="h-4 w-4" />
            </a>
            {result.product_name && (
              <p className="text-sm text-gray-500 mt-1">
                Product: <span className="font-medium text-gray-700">{result.product_name}</span>
                {result.epic_key && <> · Epic: <span className="font-mono text-brand-600">{result.epic_key}</span></>}
              </p>
            )}
          </div>
          <button
            onClick={onReset}
            className="btn-secondary px-4 py-2 text-sm flex items-center gap-2"
          >
            <RotateCcw className="h-4 w-4" /> Report another bug
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Template field card ────────────────────────────────────────────────────────
function TemplateField({ label, value, onChange, multiline = false }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-semibold text-gray-500 uppercase">{label}</p>
      <div className="text-sm text-gray-800 bg-white border border-gray-200 rounded-lg px-3 py-2 min-h-[2.5rem]">
        <EditableField value={value} onChange={onChange} multiline={multiline} />
      </div>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function BugReporterPage() {
  const queryClient = useQueryClient()
  const [step, setStep] = useState(1)

  // Meta (epics, versions, sprints, etc.)
  const { data: meta = {}, isLoading: metaLoading } = useQuery({
    queryKey: ['bug-reporter-meta'],
    queryFn: fetchMeta,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  })

  // Step 1 state
  const [selectedEpic, setSelectedEpic]       = useState(null)
  const [epicSearch, setEpicSearch]           = useState('')
  const [description, setDescription]         = useState('')
  const [uploadedFiles, setUploadedFiles]     = useState([])
  const [extraContext, setExtraContext]        = useState('')

  // Step 2 state — product context
  const [contextData, setContextData]         = useState(null)

  // Step 3 state — template
  const [template, setTemplate]               = useState(null)
  const [fixVersionId, setFixVersionId]       = useState('')
  const [fixVersionName, setFixVersionName]   = useState('')
  const [foundInVersionId, setFoundInVersionId] = useState('')
  const [sprintId, setSprintId]               = useState('')
  const [environments, setEnvironments]       = useState([])

  // Step 4 state
  const [createdResult, setCreatedResult]     = useState(null)
  const [savedDraftId, setSavedDraftId]       = useState(null)

  // Filtered epics for search
  const epics = meta.epics || []
  const filteredEpics = epicSearch
    ? epics.filter(e =>
        e.name.toLowerCase().includes(epicSearch.toLowerCase()) ||
        e.key.toLowerCase().includes(epicSearch.toLowerCase())
      ).slice(0, 30)
    : epics.slice(0, 30)

  // ── Mutations ──
  const contextMutation = useMutation({
    mutationFn: fetchContext,
    onSuccess: (data) => {
      setContextData(data)
      setStep(2)
    },
  })

  const uploadMutation = useMutation({
    mutationFn: uploadFiles,
    onSuccess: (data) => {
      setUploadedFiles(prev => [...prev, ...data.files])
      setExtraContext(prev => prev ? prev + '\n\n' + data.extracted_text : data.extracted_text)
    },
  })

  const generateMutation = useMutation({
    mutationFn: generateTemplate,
    onSuccess: (data) => {
      setTemplate(data)
      setEnvironments(data.environments || [])
      setStep(3)
    },
  })

  const draftMutation = useMutation({
    mutationFn: saveDraft,
    onSuccess: (data) => {
      setSavedDraftId(data.id)
      queryClient.invalidateQueries({ queryKey: ['bug-drafts'] })
    },
  })

  const createMutation = useMutation({
    mutationFn: createBug,
    onSuccess: (data) => {
      setCreatedResult(data)
      setStep(4)
      queryClient.invalidateQueries({ queryKey: ['bug-history'] })
      queryClient.invalidateQueries({ queryKey: ['bug-drafts'] })
    },
  })

  // ── Handlers ──
  const handleLearnFromJira = () => {
    if (!selectedEpic) return
    contextMutation.mutate({ epic_key: selectedEpic.key })
  }

  const handleUploadFiles = (files) => {
    const form = new FormData()
    files.forEach(f => form.append('files', f))
    uploadMutation.mutate(form)
  }

  const handleRemoveFile = (idx) => {
    setUploadedFiles(prev => prev.filter((_, i) => i !== idx))
    if (uploadedFiles.length === 1) setExtraContext('')
  }

  const handleGenerate = () => {
    if (!selectedEpic) return
    generateMutation.mutate({
      epic_key:        selectedEpic.key,
      product_name:    selectedEpic.name,
      description,
      extra_context:   extraContext,
      context_summary: contextData?.ai_summary || '',
    })
  }

  const handleSaveDraft = () => {
    if (!template) return
    draftMutation.mutate({
      product_name:        selectedEpic?.name || '',
      epic_key:            selectedEpic?.key,
      summary:             template.summary,
      description:         template.description,
      steps_to_reproduce:  template.steps_to_reproduce,
      actual_result:       template.actual_result,
      expected_result:     template.expected_result,
      severity:            template.severity,
      priority:            template.priority,
      environments,
      fix_version_id:      fixVersionId || null,
      fix_version_name:    fixVersionName || null,
      found_in_version_id: foundInVersionId || null,
      sprint_id:           sprintId ? parseInt(sprintId, 10) : null,
      context_summary:     contextData?.ai_summary || '',
    })
  }

  const handleCreate = () => {
    if (!template) return
    createMutation.mutate({
      product_name:        selectedEpic?.name || '',
      epic_key:            selectedEpic?.key,
      summary:             template.summary,
      description:         template.description,
      steps_to_reproduce:  template.steps_to_reproduce,
      actual_result:       template.actual_result,
      expected_result:     template.expected_result,
      severity:            template.severity,
      priority:            template.priority,
      environments,
      fix_version_id:      fixVersionId || null,
      fix_version_name:    fixVersionName || null,
      found_in_version_id: foundInVersionId || null,
      sprint_id:           sprintId ? parseInt(sprintId, 10) : null,
      draft_id:            savedDraftId,
    })
  }

  const handleLoadDraft = (draft) => {
    const epicMatch = epics.find(e => e.key === draft.epic_key)
    setSelectedEpic(epicMatch || { key: draft.epic_key, name: draft.product_name })
    setDescription(draft.description || '')
    setTemplate({
      summary:             draft.summary || '',
      description:         draft.description || '',
      steps_to_reproduce:  draft.steps_to_reproduce || '',
      actual_result:       draft.actual_result || '',
      expected_result:     draft.expected_result || '',
      severity:            draft.severity || 'Medium',
      priority:            draft.priority || 'Medium',
      environments:        draft.environments || [],
      ai_confidence:       '',
    })
    setEnvironments(draft.environments || [])
    setFixVersionId(draft.fix_version_id || '')
    setFixVersionName(draft.fix_version_name || '')
    setFoundInVersionId(draft.found_in_version_id || '')
    setSprintId(draft.sprint_id ? String(draft.sprint_id) : '')
    setSavedDraftId(draft.id)
    setContextData({ ai_summary: draft.context_summary || '' })
    setStep(3)
  }

  const handleReset = () => {
    setStep(1)
    setSelectedEpic(null)
    setEpicSearch('')
    setDescription('')
    setUploadedFiles([])
    setExtraContext('')
    setContextData(null)
    setTemplate(null)
    setFixVersionId('')
    setFixVersionName('')
    setFoundInVersionId('')
    setSprintId('')
    setEnvironments([])
    setCreatedResult(null)
    setSavedDraftId(null)
    contextMutation.reset()
    generateMutation.reset()
    createMutation.reset()
  }

  const updateTemplate = (field, value) => setTemplate(prev => ({ ...prev, [field]: value }))
  const toggleEnv = (env) => setEnvironments(prev =>
    prev.includes(env) ? prev.filter(e => e !== env) : [...prev, env]
  )

  const versions   = meta.fix_versions || []
  const sprints    = meta.sprints || []
  const envOptions = meta.environments || ['Production', 'Staging', 'Development', 'QA', 'Demo']

  const isLoadingContext = contextMutation.isPending
  const isUploading      = uploadMutation.isPending
  const isGenerating     = generateMutation.isPending
  const isCreating       = createMutation.isPending

  return (
    <div className="flex-1 flex flex-col">
      <Header title="Bug Reporter" />

      <div className="flex-1 p-6 space-y-5 overflow-auto">

        {/* Step indicator */}
        <div className="card px-5 py-3">
          <Steps current={step} />
        </div>

        {/* ══════════════════════════════════════════════════════════
            STEP 1 — Select product + describe bug + upload files
        ══════════════════════════════════════════════════════════ */}
        {step === 1 && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            <div className="lg:col-span-2 space-y-4">

              {/* Product (Epic) selector */}
              <div className="card p-5">
                <h2 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                  <Database className="h-4 w-4 text-gray-400" /> 1. Select Product / Epic
                </h2>
                <div className="space-y-2">
                  <input
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-brand-300"
                    placeholder={metaLoading ? 'Loading epics…' : 'Search by epic name or key…'}
                    value={epicSearch}
                    onChange={e => setEpicSearch(e.target.value)}
                    disabled={metaLoading}
                  />
                  {filteredEpics.length > 0 && (
                    <div className="border border-gray-200 rounded-lg overflow-hidden max-h-60 overflow-y-auto">
                      {filteredEpics.map(e => (
                        <button
                          key={e.key}
                          onClick={() => { setSelectedEpic(e); setEpicSearch('') }}
                          className={`w-full text-left flex items-start gap-3 px-4 py-3 hover:bg-brand-50 transition-colors border-b border-gray-50 last:border-0
                            ${selectedEpic?.key === e.key ? 'bg-brand-50' : ''}`}
                        >
                          <div className="flex-1 min-w-0">
                            <span className="font-mono text-xs text-brand-600 font-bold">{e.key}</span>
                            <span className="text-sm text-gray-700 ml-2 truncate">{e.name}</span>
                          </div>
                          {e.status && (
                            <span className="text-xs text-gray-400 flex-shrink-0">{e.status}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                  {selectedEpic && (
                    <div className="flex items-center gap-2 bg-brand-50 border border-brand-200 rounded-lg px-3 py-2">
                      <CheckCircle2 className="h-4 w-4 text-brand-500 flex-shrink-0" />
                      <span className="font-mono text-xs font-bold text-brand-600">{selectedEpic.key}</span>
                      <span className="text-sm text-gray-700 truncate flex-1">{selectedEpic.name}</span>
                      <button onClick={() => setSelectedEpic(null)} className="text-gray-300 hover:text-red-400">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Bug description */}
              <div className="card p-5">
                <h2 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                  <Edit3 className="h-4 w-4 text-gray-400" /> 2. Describe the Bug
                </h2>
                <textarea
                  className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2.5 resize-none focus:outline-none focus:ring-2 focus:ring-brand-300 min-h-[120px]"
                  placeholder="Describe what went wrong. Include any error messages, affected feature, steps you tried, or anything unusual you noticed. The AI will use this to fill in all the Jira fields."
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                />
              </div>

              {/* File upload */}
              <div className="card p-5">
                <h2 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                  <Upload className="h-4 w-4 text-gray-400" /> 3. Attach Logs & Screenshots
                  <span className="text-xs font-normal text-gray-400">(optional)</span>
                </h2>
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
              </div>

              {/* Proceed button */}
              {contextMutation.isError && (
                <div className="card p-4 border-red-200 bg-red-50">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
                    <p className="text-sm text-red-700">
                      {contextMutation.error?.response?.data?.detail || contextMutation.error?.message}
                    </p>
                  </div>
                </div>
              )}

              <div className="card px-5 py-3 flex items-center justify-between">
                <p className="text-xs text-gray-400">
                  {selectedEpic
                    ? `Selected: ${selectedEpic.key} · ${selectedEpic.name}`
                    : 'Select a product epic to continue'}
                </p>
                <button
                  onClick={handleLearnFromJira}
                  disabled={!selectedEpic || isLoadingContext}
                  className="btn-primary px-5 py-2 text-sm flex items-center gap-2 disabled:opacity-50"
                >
                  {isLoadingContext
                    ? <><Loader2 className="h-4 w-4 animate-spin" /> Learning from Jira…</>
                    : <><Sparkles className="h-4 w-4" /> Learn from Jira & Continue</>}
                </button>
              </div>
            </div>

            {/* Drafts / history sidebar */}
            <div className="space-y-4">
              <DraftsPanel onLoadDraft={handleLoadDraft} />
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════
            STEP 2 — Jira context learned, generate template
        ══════════════════════════════════════════════════════════ */}
        {step === 2 && contextData && (
          <div className="space-y-4">
            {/* Header bar */}
            <div className="card px-5 py-3 flex items-center gap-4 flex-wrap">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-gray-400 uppercase font-semibold">Product</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="font-mono text-sm font-bold text-brand-600">{selectedEpic?.key}</span>
                  <span className="text-sm text-gray-700 truncate">{selectedEpic?.name}</span>
                </div>
              </div>
              <button onClick={() => setStep(1)} className="btn-secondary px-3 py-1.5 text-xs flex items-center gap-1.5">
                <RotateCcw className="h-3.5 w-3.5" /> Back
              </button>
            </div>

            {/* AI context summary */}
            <div className="card p-5 border-brand-200 bg-brand-50/30">
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 bg-brand-100 rounded-lg p-2">
                  <Sparkles className="h-5 w-5 text-brand-600" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-semibold text-brand-700 uppercase">AI learned from Jira</p>
                    <span className="text-xs text-gray-400">
                      {contextData.bugs_found} existing bug{contextData.bugs_found !== 1 ? 's' : ''} analysed
                    </span>
                  </div>
                  {contextData.ai_summary ? (
                    <p className="text-sm text-gray-700 leading-relaxed">{contextData.ai_summary}</p>
                  ) : (
                    <p className="text-sm text-gray-400 italic">No existing bugs found for this epic. AI will generate the template from scratch.</p>
                  )}
                </div>
              </div>
            </div>

            {/* Existing bugs quick list */}
            {contextData.bugs?.length > 0 && (
              <div className="card p-5">
                <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                  <Bug className="h-4 w-4 text-gray-400" />
                  Recent bugs in this epic
                  <span className="text-xs font-normal text-gray-400">({contextData.bugs.length})</span>
                </h3>
                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                  {contextData.bugs.map(b => (
                    <div key={b.key} className="flex items-center gap-3 text-sm">
                      <a
                        href={b.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-xs font-bold text-brand-600 hover:underline flex items-center gap-1 flex-shrink-0"
                      >
                        {b.key} <ExternalLink className="h-3 w-3" />
                      </a>
                      <span className="text-gray-700 truncate flex-1">{b.summary}</span>
                      {b.severity && <SeverityBadge value={b.severity} />}
                      <span className="text-xs text-gray-400 flex-shrink-0">{b.status}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Generate button */}
            <div className="card px-5 py-4">
              <div className="flex items-center justify-between">
                <div className="text-sm text-gray-600">
                  <p>Claude will now generate a complete bug template using:</p>
                  <ul className="text-xs text-gray-400 mt-1 space-y-0.5 list-disc list-inside">
                    <li>Your description</li>
                    {uploadedFiles.length > 0 && <li>{uploadedFiles.filter(f => f.ok).length} uploaded file(s)</li>}
                    <li>Existing bug patterns from {selectedEpic?.key}</li>
                  </ul>
                </div>
                <button
                  onClick={handleGenerate}
                  disabled={isGenerating}
                  className="btn-primary px-6 py-2.5 text-sm flex items-center gap-2 disabled:opacity-50"
                >
                  {isGenerating
                    ? <><Loader2 className="h-4 w-4 animate-spin" /> Generating with Claude…</>
                    : <><Sparkles className="h-4 w-4" /> Generate Bug Template</>}
                </button>
              </div>
              {generateMutation.isError && (
                <p className="mt-3 text-xs text-red-500 flex items-center gap-1">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {generateMutation.error?.response?.data?.detail || generateMutation.error?.message}
                </p>
              )}
            </div>

            {isGenerating && (
              <div className="card p-8 text-center">
                <div className="flex flex-col items-center gap-3">
                  <div className="relative">
                    <Bug className="h-10 w-10 text-brand-300" />
                    <Loader2 className="h-5 w-5 text-brand-600 animate-spin absolute -top-1 -right-1" />
                  </div>
                  <div>
                    <p className="font-semibold text-gray-700">Generating bug template…</p>
                    <p className="text-sm text-gray-400 mt-0.5">Claude is reading all context and writing the Jira fields</p>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════
            STEP 3 — Review and edit the generated template
        ══════════════════════════════════════════════════════════ */}
        {step === 3 && template && (
          <div className="space-y-4">
            {/* Header bar */}
            <div className="card px-5 py-3 flex items-center gap-4 flex-wrap">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-gray-400 uppercase font-semibold">Bug Template — Review & Edit</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="font-mono text-xs font-bold text-brand-600">{selectedEpic?.key}</span>
                  <span className="text-sm text-gray-600 truncate">{selectedEpic?.name}</span>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={handleSaveDraft}
                  disabled={draftMutation.isPending}
                  className="btn-secondary px-3 py-1.5 text-xs flex items-center gap-1.5"
                  title="Save draft to local DB"
                >
                  {draftMutation.isPending
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Save className="h-3.5 w-3.5" />}
                  {savedDraftId ? 'Draft saved' : 'Save draft'}
                </button>
                <button onClick={() => setStep(2)} className="btn-secondary px-3 py-1.5 text-xs flex items-center gap-1.5">
                  <RotateCcw className="h-3.5 w-3.5" /> Back
                </button>
              </div>
            </div>

            {/* AI confidence note */}
            {template.ai_confidence && (
              <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                <Info className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-amber-700">{template.ai_confidence}</p>
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Main fields */}
              <div className="lg:col-span-2 space-y-4">
                <div className="card p-5 space-y-4">
                  <TemplateField
                    label="Summary"
                    value={template.summary}
                    onChange={v => updateTemplate('summary', v)}
                  />
                  <TemplateField
                    label="Description"
                    value={template.description}
                    onChange={v => updateTemplate('description', v)}
                    multiline
                  />
                  <TemplateField
                    label="Steps to Reproduce"
                    value={template.steps_to_reproduce}
                    onChange={v => updateTemplate('steps_to_reproduce', v)}
                    multiline
                  />
                  <TemplateField
                    label="Actual Result"
                    value={template.actual_result}
                    onChange={v => updateTemplate('actual_result', v)}
                    multiline
                  />
                  <TemplateField
                    label="Expected Result"
                    value={template.expected_result}
                    onChange={v => updateTemplate('expected_result', v)}
                    multiline
                  />
                </div>
              </div>

              {/* Side fields */}
              <div className="space-y-4">
                {/* Severity + Priority */}
                <div className="card p-4 space-y-3">
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Severity</p>
                    <div className="relative">
                      <select
                        className="w-full text-sm border border-gray-200 rounded-lg pl-3 pr-8 py-2 appearance-none focus:outline-none focus:ring-2 focus:ring-brand-300"
                        value={template.severity}
                        onChange={e => updateTemplate('severity', e.target.value)}
                      >
                        {(meta.severities || ['Critical','Highest','High','Medium','Low']).map(s => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                      <ChevronDown className="h-4 w-4 text-gray-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Priority</p>
                    <div className="relative">
                      <select
                        className="w-full text-sm border border-gray-200 rounded-lg pl-3 pr-8 py-2 appearance-none focus:outline-none focus:ring-2 focus:ring-brand-300"
                        value={template.priority}
                        onChange={e => updateTemplate('priority', e.target.value)}
                      >
                        {(meta.priorities || []).length > 0
                          ? meta.priorities.map(p => <option key={p.id} value={p.name}>{p.name}</option>)
                          : ['Highest','High','Medium','Low','Lowest'].map(p => <option key={p} value={p}>{p}</option>)
                        }
                      </select>
                      <ChevronDown className="h-4 w-4 text-gray-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    </div>
                  </div>
                </div>

                {/* Versions */}
                <div className="card p-4 space-y-3">
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Fix Version</p>
                    <div className="relative">
                      <select
                        className="w-full text-sm border border-gray-200 rounded-lg pl-3 pr-8 py-2 appearance-none focus:outline-none focus:ring-2 focus:ring-brand-300"
                        value={fixVersionId}
                        onChange={e => {
                          setFixVersionId(e.target.value)
                          const v = versions.find(v => v.id === e.target.value)
                          setFixVersionName(v?.name || '')
                        }}
                      >
                        <option value="">— None —</option>
                        {versions.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                      </select>
                      <ChevronDown className="h-4 w-4 text-gray-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Found In Version</p>
                    <div className="relative">
                      <select
                        className="w-full text-sm border border-gray-200 rounded-lg pl-3 pr-8 py-2 appearance-none focus:outline-none focus:ring-2 focus:ring-brand-300"
                        value={foundInVersionId}
                        onChange={e => setFoundInVersionId(e.target.value)}
                      >
                        <option value="">— None —</option>
                        {versions.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                      </select>
                      <ChevronDown className="h-4 w-4 text-gray-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    </div>
                  </div>
                </div>

                {/* Sprint */}
                {sprints.length > 0 && (
                  <div className="card p-4">
                    <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Sprint</p>
                    <div className="relative">
                      <select
                        className="w-full text-sm border border-gray-200 rounded-lg pl-3 pr-8 py-2 appearance-none focus:outline-none focus:ring-2 focus:ring-brand-300"
                        value={sprintId}
                        onChange={e => setSprintId(e.target.value)}
                      >
                        <option value="">— None —</option>
                        {sprints.map(s => (
                          <option key={s.id} value={s.id}>
                            {s.name} {s.state === 'active' ? '(active)' : ''}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="h-4 w-4 text-gray-400 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                    </div>
                  </div>
                )}

                {/* Environments */}
                <div className="card p-4">
                  <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Environments</p>
                  <div className="flex flex-wrap gap-2">
                    {envOptions.map(env => (
                      <button
                        key={env}
                        onClick={() => toggleEnv(env)}
                        className={`text-xs px-2.5 py-1 rounded-full border transition-colors
                          ${environments.includes(env)
                            ? 'bg-brand-600 text-white border-brand-600'
                            : 'bg-white text-gray-500 border-gray-200 hover:border-brand-300'}`}
                      >
                        {env}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Create button */}
            {createMutation.isError && (
              <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
                <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-red-700">
                  {createMutation.error?.response?.data?.detail || createMutation.error?.message}
                </p>
              </div>
            )}

            <div className="card px-5 py-3 flex items-center justify-between">
              <div className="text-xs text-gray-400 space-y-0.5">
                <p>Click any field above to edit before submitting.</p>
                {savedDraftId && <p className="text-green-600">Draft saved (ID: {savedDraftId})</p>}
              </div>
              <button
                onClick={handleCreate}
                disabled={!template.summary || isCreating}
                className="btn-primary px-6 py-2.5 text-sm flex items-center gap-2 disabled:opacity-50"
              >
                {isCreating
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating in Jira…</>
                  : <><Send className="h-4 w-4" /> Create Bug in Jira</>}
              </button>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════════════════════════════
            STEP 4 — Success
        ══════════════════════════════════════════════════════════ */}
        {step === 4 && createdResult && (
          <div className="space-y-5">
            <SuccessCard result={createdResult} onReset={handleReset} />
            <DraftsPanel onLoadDraft={handleLoadDraft} />
          </div>
        )}

      </div>
    </div>
  )
}

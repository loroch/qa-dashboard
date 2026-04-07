import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Header } from '../components/layout/Header'
import axios from 'axios'
import {
  Wand2, ExternalLink, Trash2, ChevronRight, CheckCircle2,
  Loader2, AlertCircle, RotateCcw, Sparkles, FileText,
  XCircle, Edit3, Check, X, Plus, ChevronDown
} from 'lucide-react'

// Local axios with long timeout for Claude generation
const api = axios.create({ baseURL: '/api', timeout: 120000 })

const fetchVersions = () => api.get('/test-generator/versions').then(r => r.data)
const fetchStories  = (v) => api.get(`/test-generator/stories?version=${encodeURIComponent(v)}`).then(r => r.data)
const generateTC    = (k) => api.post('/test-generator/generate', { story_key: k }).then(r => r.data)
const createTC      = (d) => api.post('/test-generator/create', d).then(r => r.data)

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
  const steps = ['Select Story', 'Review & Edit', 'Created in Jira']
  return (
    <div className="flex items-center gap-2">
      {steps.map((label, i) => {
        const idx = i + 1
        const done = current > idx
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
      {/* Card header */}
      <div className={`flex items-start gap-3 px-4 py-3 ${isNeg ? 'bg-orange-50' : 'bg-gray-50'} border-b border-inherit`}>
        <span className={`flex-shrink-0 text-xs font-bold px-2 py-0.5 rounded ${isNeg ? 'bg-orange-100 text-orange-700' : 'bg-brand-100 text-brand-700'}`}>
          {index + 1}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-800">
            <EditableText
              value={tc.summary}
              onChange={v => update('summary', v)}
            />
          </p>
          {tc.description && (
            <p className="text-xs text-gray-500 mt-0.5">
              <EditableText
                value={tc.description}
                onChange={v => update('description', v)}
              />
            </p>
          )}
        </div>
        <button
          onClick={() => onRemove(index)}
          className="text-gray-300 hover:text-red-500 transition-colors flex-shrink-0"
          title="Remove this test case"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {/* Card body */}
      <div className="px-4 py-3 space-y-3 text-sm">
        {/* Steps */}
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Steps</p>
          <ol className="space-y-1 list-decimal list-inside">
            {(tc.steps || []).map((step, si) => (
              <li key={si} className="flex items-start gap-1 text-gray-700">
                <span className="flex-1">
                  <EditableText value={step} onChange={v => updateStep(si, v)} />
                </span>
                <button
                  onClick={() => removeStep(si)}
                  className="text-gray-200 hover:text-red-400 mt-0.5 flex-shrink-0"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ol>
          <button
            onClick={addStep}
            className="mt-1.5 text-xs text-brand-500 hover:text-brand-700 flex items-center gap-1"
          >
            <Plus className="h-3 w-3" /> Add step
          </button>
        </div>

        {/* Expected */}
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase mb-1">Expected Result</p>
          <p className="text-gray-700">
            <EditableText
              value={tc.expected}
              onChange={v => update('expected', v)}
              multiline
            />
          </p>
        </div>

        {/* Source */}
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
function CreationReport({ report, storyKey, onReset }) {
  const { created = [], success_count, failure_count, fix_version } = report
  return (
    <div className="space-y-4">
      {/* Summary banner */}
      <div className={`flex items-center gap-3 rounded-xl px-5 py-4 ${failure_count === 0 ? 'bg-green-50 border border-green-200' : 'bg-yellow-50 border border-yellow-200'}`}>
        {failure_count === 0
          ? <CheckCircle2 className="h-6 w-6 text-green-500 flex-shrink-0" />
          : <AlertCircle className="h-6 w-6 text-yellow-500 flex-shrink-0" />}
        <div>
          <p className="font-semibold text-gray-800">
            {success_count} test case{success_count !== 1 ? 's' : ''} created in Jira
            {failure_count > 0 && `, ${failure_count} failed`}
          </p>
          <p className="text-sm text-gray-500">
            Linked to <span className="font-mono font-medium text-brand-600">{storyKey}</span>
            {fix_version && <> · Fix version: <span className="font-medium">{fix_version}</span></>}
          </p>
        </div>
        <button
          onClick={onReset}
          className="ml-auto flex items-center gap-1.5 text-sm text-brand-600 hover:text-brand-800 font-medium"
        >
          <RotateCcw className="h-4 w-4" /> Generate for another story
        </button>
      </div>

      {/* Results table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200">
        <table className="min-w-full text-sm bg-white">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              {['Status', 'Test Key', 'Summary', 'Fix Version', 'Story'].map(h => (
                <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {created.map((row, i) => (
              <tr key={i} className="hover:bg-gray-50">
                <td className="px-4 py-2.5">
                  {row.ok
                    ? <CheckCircle2 className="h-4 w-4 text-green-500" />
                    : <XCircle className="h-4 w-4 text-red-400" />}
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap">
                  {row.key ? (
                    <a
                      href={row.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-mono text-xs text-brand-600 font-semibold hover:underline"
                    >
                      {row.key} <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : <span className="text-gray-400 text-xs">—</span>}
                </td>
                <td className="px-4 py-2.5 text-gray-700 max-w-md">
                  <span className="line-clamp-2">{row.summary}</span>
                  {row.error && <p className="text-xs text-red-500 mt-0.5">{row.error}</p>}
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap text-xs text-gray-500">
                  {report.fix_version || '—'}
                </td>
                <td className="px-4 py-2.5 whitespace-nowrap">
                  <a
                    href={`https://avite.atlassian.net/browse/${storyKey}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 font-mono text-xs text-brand-600 hover:underline"
                  >
                    {storyKey} <ExternalLink className="h-3 w-3" />
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function TestGeneratorPage() {
  // Step state
  const [step, setStep] = useState(1)          // 1=select, 2=review, 3=done

  // Fix versions dropdown
  const { data: allVersions = [], isLoading: versionsLoading, isError: versionsError } = useQuery({
    queryKey: ['fix-versions'],
    queryFn: fetchVersions,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  })
  const visibleVersions = allVersions.filter(v => !v.archived)

  // Step 1
  const [versionInput, setVersionInput] = useState('')
  const [loadedVersion, setLoadedVersion] = useState('')
  const [stories, setStories] = useState([])
  const [selectedStory, setSelectedStory] = useState(null)
  const [storiesError, setStoriesError] = useState('')

  // Step 2
  const [testCases, setTestCases] = useState([])
  const [fixVersionForCreate, setFixVersionForCreate] = useState('')

  // Step 3
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

  const generateMutation = useMutation({
    mutationFn: generateTC,
    onSuccess: (data) => {
      setTestCases(data.test_cases || [])
      setFixVersionForCreate(data.fix_versions?.[0] || loadedVersion)
      setStep(2)
    },
    onError: () => {},
  })

  const createMutation = useMutation({
    mutationFn: createTC,
    onSuccess: (data) => {
      setCreationReport(data)
      setStep(3)
    },
    onError: () => {},
  })

  // ── Handlers ──
  const handleLoadStories = () => {
    if (!versionInput) return
    storiesMutation.mutate(versionInput)
  }

  const handleGenerate = (story) => {
    setSelectedStory(story)
    generateMutation.mutate(story.key)
  }

  const removeTC = (idx) => setTestCases(tcs => tcs.filter((_, i) => i !== idx))

  const updateTC = (idx, updated) =>
    setTestCases(tcs => tcs.map((tc, i) => (i === idx ? updated : tc)))

  const handleCreate = () => {
    if (!selectedStory || testCases.length === 0) return
    createMutation.mutate({
      story_key: selectedStory.key,
      test_cases: testCases,
      fix_version: fixVersionForCreate,
    })
  }

  const handleReset = () => {
    setStep(1)
    setSelectedStory(null)
    setTestCases([])
    setCreationReport(null)
    generateMutation.reset()
    createMutation.reset()
  }

  const isGenerating = generateMutation.isPending
  const isCreating   = createMutation.isPending

  return (
    <div className="flex-1 flex flex-col">
      <Header title="Test Case Generator" />

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
            {/* Version selector */}
            <div className="card p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-gray-700">Fix Version</h2>
                {!versionsLoading && !versionsError && (
                  <span className="text-xs text-gray-400">{visibleVersions.length} versions available</span>
                )}
              </div>
              <div className="flex gap-3 items-center flex-wrap">
                {versionsError || (!versionsLoading && visibleVersions.length === 0) ? (
                  /* Fallback: plain text input if dropdown couldn't load */
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
                      <option value="">
                        {versionsLoading ? 'Loading versions…' : '— Select a fix version —'}
                      </option>
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

            {/* Stories without tests */}
            {stories.length > 0 && (
              <div className="card p-0 overflow-hidden">
                <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 bg-gray-50">
                  <div>
                    <h2 className="text-sm font-semibold text-gray-700">
                      Stories without test cases
                      <span className="ml-2 bg-red-500 text-white text-xs rounded-full px-2 py-0.5">
                        {stories.length}
                      </span>
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
                        <tr
                          key={story.key}
                          className={`hover:bg-gray-50 ${selectedStory?.key === story.key ? 'bg-brand-50' : ''}`}
                        >
                          <td className="px-4 py-3 whitespace-nowrap">
                            <a
                              href={story.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 font-mono text-xs text-brand-600 font-semibold hover:underline"
                            >
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
                              onClick={() => handleGenerate(story)}
                              disabled={isGenerating}
                              className="inline-flex items-center gap-1.5 text-xs bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg transition-colors font-medium"
                            >
                              {isGenerating && selectedStory?.key === story.key
                                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Generating…</>
                                : <><Wand2 className="h-3.5 w-3.5" /> Generate</>}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Generation loading overlay */}
            {isGenerating && (
              <div className="card p-8 text-center">
                <div className="flex flex-col items-center gap-3">
                  <div className="relative">
                    <Sparkles className="h-10 w-10 text-brand-300" />
                    <Loader2 className="h-5 w-5 text-brand-600 animate-spin absolute -top-1 -right-1" />
                  </div>
                  <div>
                    <p className="font-semibold text-gray-700">Generating test cases…</p>
                    <p className="text-sm text-gray-400 mt-0.5">
                      Reading story, epic & Confluence docs, then calling Claude AI
                    </p>
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
                    <button
                      onClick={() => selectedStory && handleGenerate(selectedStory)}
                      className="mt-2 text-xs text-red-600 hover:text-red-800 underline"
                    >
                      Try again
                    </button>
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
            STEP 2 — Review & edit generated test cases
        ══════════════════════════════════════════════════════════ */}
        {step === 2 && (
          <div className="space-y-4">
            {/* Story context bar */}
            <div className="card px-5 py-3 flex items-center gap-4 flex-wrap">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-gray-400 uppercase font-semibold">Story</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <a
                    href={selectedStory?.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-sm font-bold text-brand-600 hover:underline flex items-center gap-1"
                  >
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
                <button
                  onClick={handleReset}
                  className="btn-secondary px-3 py-1.5 text-xs flex items-center gap-1.5"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Back
                </button>
              </div>
            </div>

            {/* Summary strip */}
            <div className="flex items-center gap-4 px-1">
              <div className="flex items-center gap-2 text-sm text-gray-600">
                <Sparkles className="h-4 w-4 text-brand-500" />
                <span><strong>{testCases.length}</strong> test cases generated</span>
              </div>
              <div className="text-xs text-gray-400">
                Click any field to edit · <Trash2 className="h-3 w-3 inline" /> to remove a test
              </div>
            </div>

            {/* Test case cards */}
            <div className="space-y-3">
              {testCases.map((tc, i) => (
                <TestCaseCard
                  key={i}
                  tc={tc}
                  index={i}
                  onRemove={removeTC}
                  onUpdate={updateTC}
                />
              ))}
            </div>

            {testCases.length === 0 && (
              <div className="card p-8 text-center text-gray-400">
                <p>All test cases removed. Go back and regenerate.</p>
              </div>
            )}

            {/* Create error */}
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

            {/* Action bar */}
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
            STEP 3 — Creation report
        ══════════════════════════════════════════════════════════ */}
        {step === 3 && creationReport && (
          <CreationReport
            report={creationReport}
            storyKey={selectedStory?.key}
            onReset={handleReset}
          />
        )}
      </div>
    </div>
  )
}

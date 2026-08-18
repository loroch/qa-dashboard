import { useState, useMemo, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { Header } from '../components/layout/Header'
import { PageLoader, ErrorState } from '../components/common/LoadingSpinner'
import {
  ExternalLink, ChevronDown, ChevronRight, Search,
  Link2, CheckCircle2, XCircle, AlertTriangle, FlaskConical,
  X, Check, Wand2, Sparkles, FileText, BookOpen, Figma
} from 'lucide-react'
import axios from 'axios'

const api = axios.create({ baseURL: '/api', timeout: 120000 })

const getVersions    = ()        => api.get('/coverage/versions').then(r => r.data)
const getByVersion   = (v)       => api.get(`/coverage/by-version?version=${encodeURIComponent(v)}`).then(r => r.data)
const getUnlinked    = ()        => api.get('/coverage/unlinked-tests').then(r => r.data)
const searchStories  = (q)       => api.get(`/coverage/search-stories?q=${encodeURIComponent(q)}`).then(r => r.data)
const assignTest          = (body) => api.post('/coverage/assign-test', body).then(r => r.data)
const getRegressionTests  = (v)    => api.get(`/coverage/regression-tests${v ? `?version=${encodeURIComponent(v)}` : ''}`).then(r => r.data)
const generateStoryTests  = (body) => api.post('/coverage/generate-story-tests', body, { timeout: 120000 }).then(r => r.data)
const createStoryTests    = (body) => api.post('/coverage/create-story-tests', body).then(r => r.data)
const getTestTransitions  = (k)    => api.get(`/coverage/test-transitions/${k}`).then(r => r.data)
const postTestTransition  = (body) => api.post('/coverage/test-transition', body).then(r => r.data)

const TABS = ['By Version', 'Unlinked Tests']

const STATUS_COLORS = {
  'Done':                  'bg-green-100 text-green-700',
  'DONE':                  'bg-green-100 text-green-700',
  'In Progress':           'bg-blue-100 text-blue-700',
  'Ready for Testing':     'bg-purple-100 text-purple-700',
  'To Do':                 'bg-gray-100 text-gray-500',
  'ToDo':                  'bg-gray-100 text-gray-500',
  'Blocked':               'bg-red-100 text-red-700',
  'In Review':             'bg-indigo-100 text-indigo-700',
  'Validation':            'bg-violet-100 text-violet-700',
  'Ready For Deployment':  'bg-teal-100 text-teal-700',
  'Monitoring':            'bg-cyan-100 text-cyan-700',
  'Reopened':              'bg-orange-100 text-orange-700',
  'Known Issue':           'bg-yellow-100 text-yellow-700',
  'Removed':               'bg-gray-100 text-gray-400',
}

function TestStatusSummary({ statuses }) {
  if (!statuses || Object.keys(statuses).length === 0) return null
  const entries = Object.entries(statuses).sort((a, b) => b[1] - a[1])
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([status, count]) => {
        const cls = STATUS_COLORS[status] || 'bg-gray-100 text-gray-500'
        return (
          <span key={status}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}
            title={status}>
            <span className="font-bold">{count}</span>
            <span className="opacity-75 hidden sm:inline truncate max-w-[80px]">{status}</span>
          </span>
        )
      })}
    </div>
  )
}

function StatusPill({ status }) {
  const cls = STATUS_COLORS[status] || 'bg-gray-100 text-gray-600'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {status || '—'}
    </span>
  )
}

function CoverageBar({ covered, total }) {
  const pct = total ? Math.round(covered / total * 100) : 0
  const color = pct === 100 ? 'bg-green-500' : pct >= 50 ? 'bg-yellow-400' : 'bg-red-400'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 bg-gray-200 rounded-full h-1.5">
        <div className={`${color} h-1.5 rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500 whitespace-nowrap">{covered}/{total}</span>
    </div>
  )
}

// ── Assign Dialog ──────────────────────────────────────────────────────────────
function AssignDialog({ testKey, versions, onClose, onSuccess }) {
  const [storyQuery, setStoryQuery] = useState('')
  const [selectedStory, setSelectedStory] = useState(null)
  const [selectedVersion, setSelectedVersion] = useState('')
  const [searchDone, setSearchDone] = useState(false)
  const queryClient = useQueryClient()

  const searchQuery = useQuery({
    queryKey: ['story-search', storyQuery],
    queryFn: () => searchStories(storyQuery),
    enabled: storyQuery.length >= 2 && searchDone,
  })

  const mutation = useMutation({
    mutationFn: assignTest,
    onSuccess: (data) => {
      queryClient.invalidateQueries(['coverage-unlinked'])
      queryClient.invalidateQueries(['coverage-version'])
      onSuccess(data)
    },
  })

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h3 className="font-semibold text-gray-800">Assign Test Case to Story</h3>
            <p className="text-xs text-gray-500 mt-0.5 font-mono">{testKey}</p>
          </div>
          <button onClick={onClose}><X className="h-5 w-5 text-gray-400" /></button>
        </div>

        <div className="p-4 space-y-4">
          {/* Story search */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Search Story</label>
            <div className="flex gap-2">
              <input
                className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-2"
                placeholder="Type story key or keywords..."
                value={storyQuery}
                onChange={e => { setStoryQuery(e.target.value); setSearchDone(false) }}
                onKeyDown={e => e.key === 'Enter' && setSearchDone(true)}
              />
              <button
                className="btn-primary px-3 py-2 text-sm"
                onClick={() => setSearchDone(true)}
              >
                <Search className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Results */}
          {searchQuery.isLoading && <p className="text-sm text-gray-400">Searching...</p>}
          {searchQuery.data && (
            <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg divide-y">
              {searchQuery.data.length === 0 && (
                <p className="text-sm text-gray-400 p-3">No stories found.</p>
              )}
              {searchQuery.data.map(s => (
                <div
                  key={s.key}
                  onClick={() => setSelectedStory(s)}
                  className={`p-3 cursor-pointer hover:bg-brand-50 transition-colors ${selectedStory?.key === s.key ? 'bg-brand-50 border-l-2 border-brand-500' : ''}`}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-brand-600 font-medium">{s.key}</span>
                    {s.epic_key && <span className="text-xs text-gray-400">Epic: {s.epic_key}</span>}
                  </div>
                  <p className="text-sm text-gray-700 mt-0.5 line-clamp-1">{s.summary}</p>
                  {s.versions?.length > 0 && (
                    <p className="text-xs text-gray-400 mt-0.5">{s.versions.join(', ')}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Selected story */}
          {selectedStory && (
            <div className="bg-brand-50 border border-brand-200 rounded-lg p-3">
              <div className="flex items-center gap-2">
                <Check className="h-4 w-4 text-brand-600" />
                <span className="text-sm font-medium text-brand-700">{selectedStory.key}</span>
              </div>
              <p className="text-xs text-gray-600 mt-1">{selectedStory.summary}</p>
            </div>
          )}

          {/* Fix version */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Set Fix Version (optional)</label>
            <select
              className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
              value={selectedVersion}
              onChange={e => setSelectedVersion(e.target.value)}
            >
              <option value="">— No change —</option>
              {versions.map(v => <option key={v.id} value={v.name}>{v.name}</option>)}
            </select>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between p-4 border-t bg-gray-50 rounded-b-xl">
          {mutation.isError && (
            <p className="text-xs text-red-600">{mutation.error?.response?.data?.detail || 'Error'}</p>
          )}
          {mutation.isSuccess && (
            <p className="text-xs text-green-600">Assigned successfully!</p>
          )}
          {!mutation.isError && !mutation.isSuccess && <span />}
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-secondary px-4 py-2 text-sm">Cancel</button>
            <button
              className="btn-primary px-4 py-2 text-sm disabled:opacity-50"
              disabled={!selectedStory || mutation.isPending}
              onClick={() => mutation.mutate({
                test_key: testKey,
                story_key: selectedStory.key,
                fix_version: selectedVersion || undefined,
              })}
            >
              {mutation.isPending ? 'Assigning...' : 'Assign in Jira'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Status Changer ─────────────────────────────────────────────────────────────
function StatusChanger({ testKey, currentStatus, version, onChanged }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [transitions, setTransitions] = useState([])
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [localStatus, setLocalStatus] = useState(currentStatus)
  const containerRef = useRef(null)

  useEffect(() => { setLocalStatus(currentStatus) }, [currentStatus])

  useEffect(() => {
    if (!open) return
    const close = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const openDropdown = async (e) => {
    e.stopPropagation()
    if (open) { setOpen(false); return }
    setLoading(true)
    try {
      const data = await getTestTransitions(testKey)
      setTransitions(data.transitions || [])
      setOpen(true)
    } catch (err) {
      console.error('transitions fetch failed:', err)
    } finally {
      setLoading(false)
    }
  }

  const apply = async (e, t) => {
    e.stopPropagation()
    setOpen(false)
    setApplying(true)
    const next = t.to_status || t.name
    try {
      await postTestTransition({ test_key: testKey, transition_id: t.id, version: version || null })
      setLocalStatus(next)
      queryClient.invalidateQueries(['coverage-version'])
      queryClient.invalidateQueries(['coverage-regression', version])
      onChanged?.(next)
    } catch (err) {
      console.error('transition failed:', err)
    } finally {
      setApplying(false)
    }
  }

  const cls = STATUS_COLORS[localStatus] || 'bg-gray-100 text-gray-600'

  return (
    <div className="relative inline-block" ref={containerRef}>
      <button
        onClick={openDropdown}
        disabled={applying}
        title="Change status"
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-opacity cursor-pointer select-none
          ${cls} ${applying ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-75'}`}
      >
        {(applying || loading) && (
          <span className="h-2.5 w-2.5 border border-current border-t-transparent rounded-full animate-spin flex-shrink-0" />
        )}
        <span>{localStatus || '—'}</span>
        {!applying && !loading && <ChevronDown className="h-2.5 w-2.5 opacity-50 flex-shrink-0" />}
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 bg-white border border-gray-200 rounded-xl shadow-2xl min-w-[180px] py-1">
          <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-3 py-1.5 border-b border-gray-100">
            Transition to…
          </p>
          {transitions.length === 0 && (
            <p className="text-xs text-gray-400 px-3 py-2">No transitions available</p>
          )}
          {transitions.map(t => {
            const toCls = STATUS_COLORS[t.to_status] || 'bg-gray-100 text-gray-500'
            return (
              <button key={t.id} onClick={(e) => apply(e, t)}
                className="w-full text-left px-3 py-2 text-xs hover:bg-gray-50 transition-colors flex items-center justify-between gap-3">
                <span className="text-gray-700 font-medium">{t.name}</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${toCls}`}>{t.to_status}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Generate Test Modal ────────────────────────────────────────────────────────
function GenerateTestModal({ storyKey, storySummary, version, onClose, onCreated }) {
  const queryClient = useQueryClient()
  const [mode, setMode] = useState('basic')
  const [phase, setPhase] = useState('idle')   // idle | generating | review | creating | done
  const [testCases, setTestCases] = useState([])
  const [selected, setSelected] = useState(new Set())
  const [created, setCreated] = useState([])
  const [error, setError] = useState(null)
  const [parentKey, setParentKey] = useState('')

  const generate = async () => {
    setPhase('generating')
    setError(null)
    try {
      const result = await generateStoryTests({ story_key: storyKey, mode })
      const tcs = result.test_cases || []
      setTestCases(tcs)
      setParentKey(result.parent_key || '')
      setSelected(new Set(tcs.map((_, i) => i)))
      setPhase('review')
    } catch (e) {
      setError(e.response?.data?.detail || e.message || 'Generation failed')
      setPhase('idle')
    }
  }

  const createAll = async () => {
    const toCreate = testCases.filter((_, i) => selected.has(i))
    if (!toCreate.length) return
    setPhase('creating')
    setError(null)
    try {
      const result = await createStoryTests({ story_key: storyKey, test_cases: toCreate, fix_version: version })
      setCreated(result.created || [])
      setPhase('done')
      queryClient.invalidateQueries(['coverage-version'])
      onCreated?.()
    } catch (e) {
      setError(e.response?.data?.detail || e.message || 'Create failed')
      setPhase('review')
    }
  }

  const toggleAll = () => {
    if (selected.size === testCases.length) setSelected(new Set())
    else setSelected(new Set(testCases.map((_, i) => i)))
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">

        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b">
          <div className="flex-1 min-w-0 pr-4">
            <div className="flex items-center gap-2 mb-1">
              <Wand2 className="h-5 w-5 text-purple-600 flex-shrink-0" />
              <h3 className="font-semibold text-gray-800 text-base">Generate Test Cases</h3>
            </div>
            <p className="text-xs text-gray-500 font-mono">{storyKey}</p>
            <p className="text-sm text-gray-700 mt-0.5 line-clamp-2">{storySummary}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">

          {/* ── Idle: configure ── */}
          {phase === 'idle' && (
            <div className="p-5 space-y-5">
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Sources</p>
                <div className="flex flex-wrap gap-2">
                  {[
                    { icon: FileText, label: 'Jira Story', color: 'bg-blue-50 text-blue-700 border-blue-200' },
                    { icon: FileText, label: 'Epic Context', color: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
                    { icon: BookOpen, label: 'Confluence', color: 'bg-teal-50 text-teal-700 border-teal-200' },
                    { icon: Figma,    label: 'Figma',      color: 'bg-pink-50 text-pink-700 border-pink-200' },
                  ].map(({ icon: Icon, label, color }) => (
                    <span key={label} className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border ${color}`}>
                      <Icon className="h-3.5 w-3.5" /> {label}
                    </span>
                  ))}
                </div>
              </div>
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Mode</p>
                <div className="flex gap-2">
                  {[
                    { value: 'basic',    label: 'Basic',    sub: '3–5 tests · core paths' },
                    { value: 'extended', label: 'Extended', sub: '6–10 tests · full coverage' },
                  ].map(m => (
                    <button key={m.value} onClick={() => setMode(m.value)}
                      className={`flex-1 text-left px-4 py-3 rounded-xl border-2 transition-all ${
                        mode === m.value
                          ? 'border-purple-500 bg-purple-50'
                          : 'border-gray-200 hover:border-gray-300'
                      }`}>
                      <p className={`text-sm font-semibold ${mode === m.value ? 'text-purple-700' : 'text-gray-700'}`}>{m.label}</p>
                      <p className="text-xs text-gray-400 mt-0.5">{m.sub}</p>
                    </button>
                  ))}
                </div>
              </div>
              {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">{error}</p>}
            </div>
          )}

          {/* ── Generating ── */}
          {phase === 'generating' && (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <div className="relative">
                <div className="h-12 w-12 border-4 border-purple-100 border-t-purple-600 rounded-full animate-spin" />
                <Sparkles className="h-5 w-5 text-purple-500 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
              </div>
              <div className="text-center">
                <p className="font-medium text-gray-700">Generating test cases…</p>
                <p className="text-sm text-gray-400 mt-1">Reading Jira story, epic, Confluence & Figma</p>
              </div>
            </div>
          )}

          {/* ── Review ── */}
          {phase === 'review' && (
            <div className="p-5 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-gray-700">{testCases.length} test case{testCases.length !== 1 ? 's' : ''} generated</p>
                <button onClick={toggleAll} className="text-xs text-purple-600 hover:text-purple-800 font-medium">
                  {selected.size === testCases.length ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              {testCases.map((tc, i) => (
                <div key={i}
                  onClick={() => setSelected(s => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n })}
                  className={`border-2 rounded-xl p-4 cursor-pointer transition-all ${
                    selected.has(i) ? 'border-purple-400 bg-purple-50' : 'border-gray-200 bg-white hover:border-gray-300'
                  }`}>
                  <div className="flex items-start gap-3">
                    <div className={`mt-0.5 h-4 w-4 flex-shrink-0 rounded border-2 flex items-center justify-center transition-colors ${
                      selected.has(i) ? 'bg-purple-500 border-purple-500' : 'border-gray-300'
                    }`}>
                      {selected.has(i) && <Check className="h-2.5 w-2.5 text-white" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-gray-800">{tc.summary}</p>
                      {tc.description && <p className="text-xs text-gray-500 mt-0.5">{tc.description}</p>}
                      {tc.steps?.length > 0 && (
                        <ol className="mt-2 space-y-0.5">
                          {tc.steps.slice(0, 3).map((step, si) => (
                            <li key={si} className="text-xs text-gray-600 flex gap-1.5">
                              <span className="text-gray-400 flex-shrink-0">{si + 1}.</span>
                              <span className="line-clamp-1">{step}</span>
                            </li>
                          ))}
                          {tc.steps.length > 3 && <li className="text-xs text-gray-400">+{tc.steps.length - 3} more steps…</li>}
                        </ol>
                      )}
                      {tc.expected && (
                        <p className="text-xs text-green-600 mt-1.5">
                          <span className="font-medium">Expected: </span>{tc.expected}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-4 py-3">{error}</p>}
            </div>
          )}

          {/* ── Creating ── */}
          {phase === 'creating' && (
            <div className="flex flex-col items-center justify-center py-16 gap-4">
              <div className="h-10 w-10 border-4 border-purple-100 border-t-purple-600 rounded-full animate-spin" />
              <p className="font-medium text-gray-700">Creating test cases in Jira…</p>
            </div>
          )}

          {/* ── Done ── */}
          {phase === 'done' && (
            <div className="p-5 space-y-3">
              <div className="flex items-center gap-2 text-green-700 bg-green-50 border border-green-200 rounded-xl px-4 py-3">
                <CheckCircle2 className="h-5 w-5 flex-shrink-0" />
                <p className="text-sm font-medium">{created.filter(c => c.ok).length} test case{created.filter(c => c.ok).length !== 1 ? 's' : ''} created and linked to {storyKey}</p>
              </div>
              {created.map((c, i) => (
                <div key={i} className={`flex items-center gap-3 px-4 py-2.5 rounded-lg border ${c.ok ? 'border-green-100 bg-green-50' : 'border-red-100 bg-red-50'}`}>
                  {c.ok
                    ? <CheckCircle2 className="h-4 w-4 text-green-500 flex-shrink-0" />
                    : <XCircle className="h-4 w-4 text-red-400 flex-shrink-0" />}
                  {c.ok && c.url
                    ? <a href={c.url} target="_blank" rel="noopener noreferrer"
                        className="text-xs font-mono text-purple-600 hover:underline flex items-center gap-1">
                        {c.key} <ExternalLink className="h-3 w-3" />
                      </a>
                    : <span className="text-xs font-mono text-gray-500">{c.key || '—'}</span>}
                  <span className="text-xs text-gray-600 flex-1 line-clamp-1">{c.summary}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="border-t p-4 flex items-center justify-between gap-3 bg-gray-50 rounded-b-2xl">
          <button onClick={onClose} className="btn-secondary px-4 py-2 text-sm">
            {phase === 'done' ? 'Close' : 'Cancel'}
          </button>
          <div className="flex gap-2">
            {phase === 'idle' && (
              <button onClick={generate} className="btn-primary px-5 py-2 text-sm flex items-center gap-2">
                <Wand2 className="h-4 w-4" /> Generate
              </button>
            )}
            {phase === 'review' && (
              <>
                <button onClick={() => { setPhase('idle'); setTestCases([]) }}
                  className="btn-secondary px-4 py-2 text-sm">Regenerate</button>
                <button onClick={createAll} disabled={!selected.size}
                  className="btn-primary px-5 py-2 text-sm flex items-center gap-2 disabled:opacity-50">
                  <CheckCircle2 className="h-4 w-4" />
                  Create {selected.size > 0 ? selected.size : ''} in Jira
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Epic Row ───────────────────────────────────────────────────────────────────
function EpicRow({ epic, search, version, onGenerate }) {
  const [expanded, setExpanded] = useState(true)

  const visibleStories = useMemo(() => {
    if (!search) return epic.stories
    const q = search.toLowerCase()
    return epic.stories.filter(s =>
      s.key.toLowerCase().includes(q) ||
      s.summary.toLowerCase().includes(q)
    )
  }, [epic.stories, search])

  if (visibleStories.length === 0) return null

  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden">
      {/* Epic header */}
      <div
        className="flex items-center gap-3 bg-brand-50 px-4 py-3 cursor-pointer hover:bg-brand-100 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        {expanded ? <ChevronDown className="h-4 w-4 text-brand-500 flex-shrink-0" /> : <ChevronRight className="h-4 w-4 text-brand-500 flex-shrink-0" />}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {epic.epic_key !== 'No Epic' ? (
              <a href={epic.epic_url} target="_blank" rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="font-mono text-xs text-brand-600 font-semibold hover:underline flex items-center gap-1">
                {epic.epic_key} <ExternalLink className="h-3 w-3" />
              </a>
            ) : (
              <span className="text-xs text-gray-400 font-medium">No Epic</span>
            )}
            <span className="text-sm font-semibold text-brand-800 truncate">{epic.epic_summary}</span>
            {epic.epic_status && <StatusPill status={epic.epic_status} />}
          </div>
        </div>
        <div className="flex items-center gap-4 flex-shrink-0 ml-2">
          <div className="w-24">
            <CoverageBar covered={epic.covered_stories} total={epic.total_stories} />
          </div>
          <span className="text-xs text-gray-500 whitespace-nowrap">
            <span className="font-bold text-brand-600">{epic.total_tests}</span> tests
          </span>
        </div>
      </div>

      {/* Stories table */}
      {expanded && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm bg-white table-fixed">
            <colgroup>
              <col style={{ width: '140px' }} />
              <col />
              <col style={{ width: '160px' }} />
              <col style={{ width: '230px' }} />
              <col style={{ width: '210px' }} />
            </colgroup>
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                {['Story Key', 'Summary', 'Status', 'Test Cases', 'Test Status'].map(h => (
                  <th key={h} className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visibleStories.map(story => {
                const jiraBase = story.url.split('/browse/')[0]
                return (
                  <tr key={story.key} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5">
                      <a href={story.url} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-brand-600 font-mono text-xs font-medium hover:underline">
                        {story.key} <ExternalLink className="h-3 w-3" />
                      </a>
                    </td>
                    <td className="px-4 py-2.5 text-gray-700">
                      <span className="line-clamp-2">{story.summary}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusPill status={story.status} />
                    </td>
                    <td className="px-4 py-2.5">
                      {story.test_count > 0 ? (
                        <div className="space-y-1">
                          {(story.test_cases || (story.test_keys || []).map(k => ({ key: k, status: '' }))).slice(0, 4).map(tc => (
                            <div key={tc.key} className="flex items-center gap-1.5">
                              <a href={`${jiraBase}/browse/${tc.key}`}
                                target="_blank" rel="noopener noreferrer"
                                onClick={e => e.stopPropagation()}
                                className="text-xs font-mono text-purple-600 hover:underline flex items-center gap-0.5 flex-shrink-0">
                                {tc.key} <ExternalLink className="h-2.5 w-2.5 opacity-60" />
                              </a>
                              <StatusChanger testKey={tc.key} currentStatus={tc.status} version={version} />
                            </div>
                          ))}
                          {(story.test_cases || story.test_keys || []).length > 4 && (
                            <span className="text-xs text-gray-400">
                              +{(story.test_cases || story.test_keys).length - 4} more
                            </span>
                          )}
                        </div>
                      ) : (
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <XCircle className="h-4 w-4 text-red-400 flex-shrink-0" />
                          <span className="text-xs text-red-500 font-medium">No tests</span>
                          {onGenerate && (
                            <button
                              onClick={e => { e.stopPropagation(); onGenerate({ storyKey: story.key, storySummary: story.summary }) }}
                              className="inline-flex items-center gap-1 text-xs bg-purple-100 hover:bg-purple-200 text-purple-700 font-medium px-2 py-0.5 rounded-full transition-colors"
                              title="Generate test cases with AI"
                            >
                              <Wand2 className="h-3 w-3" /> Generate
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <TestStatusSummary statuses={story.test_statuses} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Regression Tests Section ───────────────────────────────────────────────────
const DONE_STATUSES = new Set(['Done', 'DONE', 'Passed', 'PASSED'])
const IN_PROGRESS_STATUSES = new Set(['In Progress', 'In Review', 'Validation'])
const BLOCKED_STATUSES = new Set(['Blocked', 'Reopened'])

function RegressionTestsSection({ query, version }) {
  const [expanded, setExpanded] = useState(false)
  const data = query.data

  const stats = useMemo(() => {
    if (!data || !data.total) return null
    const total = data.total
    const counts = data.status_counts || {}
    const done = Object.entries(counts)
      .filter(([s]) => DONE_STATUSES.has(s))
      .reduce((a, [, n]) => a + n, 0)
    const inProgress = Object.entries(counts)
      .filter(([s]) => IN_PROGRESS_STATUSES.has(s))
      .reduce((a, [, n]) => a + n, 0)
    const blocked = Object.entries(counts)
      .filter(([s]) => BLOCKED_STATUSES.has(s))
      .reduce((a, [, n]) => a + n, 0)
    const notRun = total - done - inProgress - blocked
    const pct = Math.round(done / total * 100)
    const barColor = pct === 100 ? 'bg-green-500' : pct >= 50 ? 'bg-yellow-400' : 'bg-red-400'
    return { total, done, inProgress, blocked, notRun: Math.max(0, notRun), pct, barColor, counts }
  }, [data])

  return (
    <div className="border border-purple-200 rounded-xl overflow-hidden">
      {/* ── Header (click to expand table) ── */}
      <div
        className="flex items-center gap-3 bg-purple-50 px-4 py-3 cursor-pointer hover:bg-purple-100 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        {expanded
          ? <ChevronDown className="h-4 w-4 text-purple-500 flex-shrink-0" />
          : <ChevronRight className="h-4 w-4 text-purple-500 flex-shrink-0" />}
        <FlaskConical className="h-4 w-4 text-purple-400 flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-semibold text-purple-800">Regression Tests</span>
          <span className="ml-2 text-xs text-purple-500">label: REGRESSION_TEST* · fixVersion: {version || 'global'} · issuetype: Test</span>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {query.isLoading && <span className="text-xs text-gray-400">Loading…</span>}
          {stats && (
            <span className="text-xs text-gray-500 whitespace-nowrap">
              <span className="font-bold text-purple-600">{stats.total}</span> tests ·{' '}
              <span className="font-bold text-green-600">{stats.pct}%</span> passed
            </span>
          )}
        </div>
      </div>

      {/* ── Summary panel — always visible when data loaded ── */}
      {query.isLoading && (
        <div className="flex items-center gap-3 px-5 py-4 bg-white border-t border-purple-100">
          <div className="h-5 w-5 border-2 border-purple-200 border-t-purple-500 rounded-full animate-spin" />
          <span className="text-sm text-gray-400">Loading regression suite…</span>
        </div>
      )}
      {query.isError && (
        <p className="text-sm text-red-500 px-5 py-4 border-t border-purple-100">{query.error?.message}</p>
      )}
      {stats && (
        <div className="bg-white border-t border-purple-100 px-5 py-4 space-y-4">
          {/* Coverage bar */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Pass Rate</span>
              <span className="text-sm font-bold text-purple-700">{stats.pct}%</span>
            </div>
            <div className="relative bg-gray-200 rounded-full h-3">
              <div
                className={`${stats.barColor} h-3 rounded-full transition-all`}
                style={{ width: `${stats.pct}%` }}
              />
            </div>
            <div className="flex justify-between text-xs text-gray-400 mt-1">
              <span>{stats.done} passed</span>
              <span>{stats.total - stats.done} remaining</span>
            </div>
          </div>

          {/* Status breakdown grid */}
          <div>
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Status Breakdown</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div className="bg-green-50 border border-green-100 rounded-lg px-3 py-2 text-center">
                <p className="text-xl font-bold text-green-600">{stats.done}</p>
                <p className="text-xs text-green-500 font-medium mt-0.5">Passed</p>
                <p className="text-xs text-gray-400">{stats.total ? Math.round(stats.done / stats.total * 100) : 0}%</p>
              </div>
              <div className="bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 text-center">
                <p className="text-xl font-bold text-blue-600">{stats.inProgress}</p>
                <p className="text-xs text-blue-500 font-medium mt-0.5">In Progress</p>
                <p className="text-xs text-gray-400">{stats.total ? Math.round(stats.inProgress / stats.total * 100) : 0}%</p>
              </div>
              <div className="bg-red-50 border border-red-100 rounded-lg px-3 py-2 text-center">
                <p className="text-xl font-bold text-red-500">{stats.blocked}</p>
                <p className="text-xs text-red-400 font-medium mt-0.5">Blocked</p>
                <p className="text-xs text-gray-400">{stats.total ? Math.round(stats.blocked / stats.total * 100) : 0}%</p>
              </div>
              <div className="bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-center">
                <p className="text-xl font-bold text-gray-500">{stats.notRun}</p>
                <p className="text-xs text-gray-400 font-medium mt-0.5">Not Run</p>
                <p className="text-xs text-gray-400">{stats.total ? Math.round(stats.notRun / stats.total * 100) : 0}%</p>
              </div>
            </div>
          </div>

          {/* All statuses with exact counts */}
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(stats.counts)
              .sort((a, b) => b[1] - a[1])
              .map(([status, count]) => {
                const cls = STATUS_COLORS[status] || 'bg-gray-100 text-gray-500'
                const pct = stats.total ? Math.round(count / stats.total * 100) : 0
                return (
                  <span key={status}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${cls}`}>
                    <span className="font-bold">{count}</span>
                    <span>{status}</span>
                    <span className="opacity-60">({pct}%)</span>
                  </span>
                )
              })}
          </div>
        </div>
      )}

      {/* ── Test table — only when expanded ── */}
      {expanded && stats && data.tests.length > 0 && (
        <div className="overflow-x-auto border-t border-purple-100">
          <table className="min-w-full text-sm bg-white">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                {['Test Key', 'Summary', 'Status', 'Labels'].map(h => (
                  <th key={h} className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.tests.map(test => (
                <tr key={test.key} className="hover:bg-gray-50">
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <a href={test.url} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-purple-600 font-mono text-xs font-medium hover:underline">
                      {test.key} <ExternalLink className="h-3 w-3" />
                    </a>
                  </td>
                  <td className="px-4 py-2.5 text-gray-700 max-w-md">
                    <span className="line-clamp-2">{test.summary}</span>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <StatusChanger testKey={test.key} currentStatus={test.status} version={version} />
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {test.labels.length > 0
                        ? test.labels.map(l => (
                            <span key={l} className="px-1.5 py-0.5 bg-gray-100 text-gray-600 text-xs rounded">{l}</span>
                          ))
                        : <span className="text-xs text-gray-300">—</span>
                      }
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {expanded && stats && data.tests.length === 0 && (
        <p className="text-sm text-gray-400 text-center py-8 border-t border-purple-100">No tests with label REGRESSION_TEST found.</p>
      )}
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────────
export default function TestCoveragePage() {
  const [tab, setTab] = useState('By Version')
  const [selectedVersion, setSelectedVersion] = useState('')
  const [storySearch, setStorySearch] = useState('')
  const [assignTarget, setAssignTarget] = useState(null)
  const [assignSuccess, setAssignSuccess] = useState(null)
  const [generateTarget, setGenerateTarget] = useState(null)
  const [unlinkedSearch, setUnlinkedSearch] = useState('')

  const versionsQuery = useQuery({
    queryKey: ['coverage-versions'],
    queryFn: getVersions,
    staleTime: 60 * 60 * 1000,
  })

  const coverageQuery = useQuery({
    queryKey: ['coverage-version', selectedVersion],
    queryFn: () => getByVersion(selectedVersion),
    enabled: !!selectedVersion,
    refetchInterval: 5 * 60 * 1000,
  })

  const unlinkedQuery = useQuery({
    queryKey: ['coverage-unlinked'],
    queryFn: getUnlinked,
    enabled: tab === 'Unlinked Tests',
    refetchInterval: 5 * 60 * 1000,
  })

  const regressionQuery = useQuery({
    queryKey: ['coverage-regression', selectedVersion],
    queryFn: () => getRegressionTests(selectedVersion),
    enabled: !!selectedVersion,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  })

  const { lastRefresh, isRefreshing, refresh } = useAutoRefresh([
    ['coverage-version', selectedVersion],
    ['coverage-regression', selectedVersion],
    ['coverage-unlinked'],
  ])

  const data = coverageQuery.data
  const summary = data?.summary || {}

  // Filter epics by story search
  const filteredEpics = useMemo(() => {
    if (!data?.by_epic) return []
    if (!storySearch) return data.by_epic
    const q = storySearch.toLowerCase()
    return data.by_epic.filter(e =>
      e.epic_summary.toLowerCase().includes(q) ||
      e.epic_key.toLowerCase().includes(q) ||
      e.stories.some(s => s.key.toLowerCase().includes(q) || s.summary.toLowerCase().includes(q))
    )
  }, [data, storySearch])

  const filteredUnlinked = useMemo(() => {
    if (!unlinkedQuery.data) return []
    if (!unlinkedSearch) return unlinkedQuery.data
    const q = unlinkedSearch.toLowerCase()
    return unlinkedQuery.data.filter(t =>
      t.key.toLowerCase().includes(q) || t.summary.toLowerCase().includes(q)
    )
  }, [unlinkedQuery.data, unlinkedSearch])

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Test Coverage"
        lastRefresh={lastRefresh}
        isRefreshing={isRefreshing}
        onRefresh={() => refresh(true)}
      />

      <div className="flex-1 p-6 space-y-4 overflow-auto">
        <div className="card p-0 overflow-hidden">
          {/* Tabs */}
          <div className="flex border-b border-gray-200 bg-gray-50">
            {TABS.map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-6 py-3 text-sm font-medium whitespace-nowrap transition-colors ${
                  tab === t ? 'bg-white text-brand-600 border-b-2 border-brand-600' : 'text-gray-500 hover:text-gray-700'
                }`}>
                {t}
                {t === 'Unlinked Tests' && unlinkedQuery.data?.length > 0 && (
                  <span className="ml-1.5 bg-orange-500 text-white text-xs rounded-full px-1.5 py-0.5">
                    {unlinkedQuery.data.length}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* ═══ TAB 1: By Version ═══ */}
          {tab === 'By Version' && (
            <div className="p-5 space-y-4">
              {/* Version picker */}
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <label className="text-sm font-medium text-gray-600">Fix Version:</label>
                  {versionsQuery.isLoading ? (
                    <span className="text-sm text-gray-400">Loading...</span>
                  ) : (
                    <select
                      className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white min-w-[200px]"
                      value={selectedVersion}
                      onChange={e => setSelectedVersion(e.target.value)}
                    >
                      <option value="">— Select a version —</option>
                      {(versionsQuery.data || []).map(v => (
                        <option key={v.id} value={v.name}>
                          {v.name}{v.released ? ' ✓' : ''}
                        </option>
                      ))}
                    </select>
                  )}
                </div>

                {selectedVersion && (
                  <input
                    className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white w-56"
                    placeholder="Search epic / story..."
                    value={storySearch}
                    onChange={e => setStorySearch(e.target.value)}
                  />
                )}
              </div>

              {!selectedVersion && (
                <div className="text-center py-16 text-gray-400">
                  <FlaskConical className="h-12 w-12 mx-auto mb-3 text-gray-200" />
                  <p className="font-medium">Select a fix version to see test coverage</p>
                </div>
              )}

              {selectedVersion && coverageQuery.isLoading && (
                <div className="text-center py-12">
                  <div className="h-8 w-8 border-2 border-brand-200 border-t-brand-600 rounded-full animate-spin mx-auto mb-3" />
                  <p className="text-sm text-gray-500">Loading test coverage for {selectedVersion}…</p>
                </div>
              )}

              {selectedVersion && coverageQuery.isError && (
                <ErrorState message={coverageQuery.error?.message} onRetry={coverageQuery.refetch} />
              )}

              {selectedVersion && data && !coverageQuery.isLoading && (
                <>
                  {/* Summary cards */}
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                    <SummaryTile label="Total Stories" value={summary.total_stories} color="blue" />
                    <SummaryTile label="Covered" value={summary.covered_stories} color="green"
                      sub={`${summary.coverage_pct}%`} />
                    <SummaryTile label="Uncovered" value={summary.uncovered_stories} color="red" />
                    <SummaryTile label="Story Tests" value={summary.total_tests} color="purple" />
                    <SummaryTile label="Regression Tests" value={regressionQuery.data?.total ?? '…'} color="indigo" />
                  </div>

                  {/* Coverage progress */}
                  <div className="bg-gray-50 rounded-xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-gray-600">Overall Coverage</span>
                      <span className="text-sm font-bold text-brand-600">{summary.coverage_pct}%</span>
                    </div>
                    <div className="bg-gray-200 rounded-full h-3">
                      <div
                        className={`h-3 rounded-full transition-all ${
                          summary.coverage_pct === 100 ? 'bg-green-500' :
                          summary.coverage_pct >= 50 ? 'bg-yellow-400' : 'bg-red-400'
                        }`}
                        style={{ width: `${summary.coverage_pct}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-xs text-gray-400 mt-1">
                      <span>{summary.covered_stories} stories covered</span>
                      <span>{summary.uncovered_stories} stories need tests</span>
                    </div>
                  </div>

                  {/* Epic/Story list */}
                  <div className="space-y-3">
                    {filteredEpics.map(epic => (
                      <EpicRow key={epic.epic_key} epic={epic} search={storySearch} version={selectedVersion} onGenerate={setGenerateTarget} />
                    ))}
                    {filteredEpics.length === 0 && (
                      <p className="text-center py-8 text-gray-400 text-sm">No results found.</p>
                    )}
                    <RegressionTestsSection query={regressionQuery} version={selectedVersion} />
                  </div>
                </>
              )}
            </div>
          )}

          {/* ═══ TAB 2: Unlinked Tests ═══ */}
          {tab === 'Unlinked Tests' && (
            <div className="p-5 space-y-4">
              {unlinkedQuery.isLoading && (
                <div className="text-center py-12">
                  <div className="h-8 w-8 border-2 border-brand-200 border-t-brand-600 rounded-full animate-spin mx-auto mb-3" />
                  <p className="text-sm text-gray-500">Loading unlinked tests (last 4 months)…</p>
                </div>
              )}
              {unlinkedQuery.isError && <ErrorState message={unlinkedQuery.error?.message} onRetry={unlinkedQuery.refetch} />}

              {!unlinkedQuery.isLoading && !unlinkedQuery.isError && (
                <>
                  <div className="flex items-center justify-between flex-wrap gap-3">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="h-5 w-5 text-orange-500" />
                      <span className="font-medium text-gray-700">
                        {unlinkedQuery.data?.length || 0} test cases not linked to any story
                      </span>
                    </div>
                    <input
                      className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white w-56"
                      placeholder="Search by key or title..."
                      value={unlinkedSearch}
                      onChange={e => setUnlinkedSearch(e.target.value)}
                    />
                  </div>

                  {assignSuccess && (
                    <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded-lg px-4 py-3 text-sm text-green-700">
                      <CheckCircle2 className="h-4 w-4" />
                      {assignSuccess.actions?.join(' · ')}
                      <button className="ml-auto" onClick={() => setAssignSuccess(null)}><X className="h-4 w-4" /></button>
                    </div>
                  )}

                  <div className="overflow-x-auto rounded-lg border border-gray-200">
                    <table className="min-w-full text-sm bg-white">
                      <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                          {['Test Key', 'Summary', 'Status', 'Version(s)', 'Actions'].map(h => (
                            <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {filteredUnlinked.map(test => (
                          <tr key={test.key} className="hover:bg-gray-50">
                            <td className="px-4 py-2.5 whitespace-nowrap">
                              <a href={test.url} target="_blank" rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-brand-600 font-mono text-xs font-medium hover:underline">
                                {test.key} <ExternalLink className="h-3 w-3" />
                              </a>
                            </td>
                            <td className="px-4 py-2.5 text-gray-700 max-w-sm">
                              <span className="line-clamp-2">{test.summary}</span>
                            </td>
                            <td className="px-4 py-2.5 whitespace-nowrap">
                              <StatusChanger testKey={test.key} currentStatus={test.status} />
                            </td>
                            <td className="px-4 py-2.5 whitespace-nowrap text-xs text-gray-500">
                              {test.versions?.length > 0 ? test.versions.join(', ') : (
                                <span className="text-orange-500 font-medium">No version</span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 whitespace-nowrap">
                              <button
                                onClick={() => setAssignTarget(test.key)}
                                className="inline-flex items-center gap-1.5 text-xs bg-brand-600 hover:bg-brand-700 text-white px-3 py-1.5 rounded-lg transition-colors"
                              >
                                <Link2 className="h-3.5 w-3.5" />
                                Assign to Story
                              </button>
                            </td>
                          </tr>
                        ))}
                        {filteredUnlinked.length === 0 && (
                          <tr>
                            <td colSpan={5} className="text-center py-10 text-gray-400 text-sm">
                              {unlinkedQuery.data?.length === 0
                                ? '🎉 All test cases are linked to stories!'
                                : 'No results match your search.'}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Assign Dialog */}
      {assignTarget && (
        <AssignDialog
          testKey={assignTarget}
          versions={versionsQuery.data || []}
          onClose={() => setAssignTarget(null)}
          onSuccess={(data) => { setAssignTarget(null); setAssignSuccess(data) }}
        />
      )}

      {/* Generate Test Cases Modal */}
      {generateTarget && (
        <GenerateTestModal
          storyKey={generateTarget.storyKey}
          storySummary={generateTarget.storySummary}
          version={selectedVersion}
          onClose={() => setGenerateTarget(null)}
          onCreated={() => { setGenerateTarget(null) }}
        />
      )}
    </div>
  )
}

function SummaryTile({ label, value, color, sub }) {
  const colors = {
    blue:   'text-blue-600',
    green:  'text-green-600',
    red:    'text-red-500',
    purple: 'text-purple-600',
    indigo: 'text-indigo-600',
  }
  return (
    <div className="bg-gray-50 rounded-xl p-4 text-center">
      <p className={`text-3xl font-bold ${colors[color]}`}>{value ?? '—'}</p>
      {sub && <p className="text-sm font-semibold text-gray-500">{sub}</p>}
      <p className="text-xs text-gray-400 mt-0.5">{label}</p>
    </div>
  )
}

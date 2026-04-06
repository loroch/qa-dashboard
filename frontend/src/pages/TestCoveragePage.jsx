import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { Header } from '../components/layout/Header'
import { PageLoader, ErrorState } from '../components/common/LoadingSpinner'
import {
  ExternalLink, ChevronDown, ChevronRight, Search,
  Link2, CheckCircle2, XCircle, AlertTriangle, FlaskConical,
  X, Check
} from 'lucide-react'
import axios from 'axios'

const api = axios.create({ baseURL: '/api', timeout: 60000 })

const getVersions    = ()        => api.get('/coverage/versions').then(r => r.data)
const getByVersion   = (v)       => api.get(`/coverage/by-version?version=${encodeURIComponent(v)}`).then(r => r.data)
const getUnlinked    = ()        => api.get('/coverage/unlinked-tests').then(r => r.data)
const searchStories  = (q)       => api.get(`/coverage/search-stories?q=${encodeURIComponent(q)}`).then(r => r.data)
const assignTest     = (body)    => api.post('/coverage/assign-test', body).then(r => r.data)

const TABS = ['By Version', 'Unlinked Tests']

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

// ── Epic Row ───────────────────────────────────────────────────────────────────
function EpicRow({ epic, search }) {
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
          <table className="min-w-full text-sm bg-white">
            <thead className="bg-gray-50 border-b border-gray-100">
              <tr>
                {['Story Key', 'Summary', 'Status', 'Test Cases'].map(h => (
                  <th key={h} className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visibleStories.map(story => (
                <tr key={story.key} className="hover:bg-gray-50">
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <a href={story.url} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-brand-600 font-mono text-xs font-medium hover:underline">
                      {story.key} <ExternalLink className="h-3 w-3" />
                    </a>
                  </td>
                  <td className="px-4 py-2.5 text-gray-700 max-w-md">
                    <span className="line-clamp-2">{story.summary}</span>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <StatusPill status={story.status} />
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    {story.test_count > 0 ? (
                      <div className="flex items-center gap-1.5">
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                        <span className="font-bold text-green-600">{story.test_count}</span>
                        <span className="text-xs text-gray-400">test{story.test_count > 1 ? 's' : ''}</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <XCircle className="h-4 w-4 text-red-400" />
                        <span className="text-xs text-red-500 font-medium">No tests</span>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

  const { lastRefresh, isRefreshing, refresh } = useAutoRefresh([
    ['coverage-version', selectedVersion],
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
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <SummaryTile label="Total Stories" value={summary.total_stories} color="blue" />
                    <SummaryTile label="Covered" value={summary.covered_stories} color="green"
                      sub={`${summary.coverage_pct}%`} />
                    <SummaryTile label="Uncovered" value={summary.uncovered_stories} color="red" />
                    <SummaryTile label="Total Tests" value={summary.total_tests} color="purple" />
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
                      <EpicRow key={epic.epic_key} epic={epic} search={storySearch} />
                    ))}
                    {filteredEpics.length === 0 && (
                      <p className="text-center py-8 text-gray-400 text-sm">No results found.</p>
                    )}
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
                  <p className="text-sm text-gray-500">Loading unlinked tests…</p>
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
                              <StatusPill status={test.status} />
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
    </div>
  )
}

function SummaryTile({ label, value, color, sub }) {
  const colors = {
    blue:   'text-blue-600',
    green:  'text-green-600',
    red:    'text-red-500',
    purple: 'text-purple-600',
  }
  return (
    <div className="bg-gray-50 rounded-xl p-4 text-center">
      <p className={`text-3xl font-bold ${colors[color]}`}>{value ?? '—'}</p>
      {sub && <p className="text-sm font-semibold text-gray-500">{sub}</p>}
      <p className="text-xs text-gray-400 mt-0.5">{label}</p>
    </div>
  )
}

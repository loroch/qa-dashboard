import { useState, useMemo, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Header } from '../components/layout/Header'
import { PageLoader, ErrorState } from '../components/common/LoadingSpinner'
import { FileText, Tag, Layers, Pencil, Check, X, ClipboardCopy } from 'lucide-react'
import axios from 'axios'

const api = axios.create({ baseURL: '/api', timeout: 60000 })

const getVersions   = () => api.get('/coverage/versions').then(r => r.data)
const getEpics      = () => api.get('/dashboard/epics').then(r => r.data)
const getIssues     = (params, sig) => api.get('/release-notes', { params, signal: sig }).then(r => r.data)
const putReleaseNote = (key, text) => api.put(`/release-notes/${key}`, { text }).then(r => r.data)

const PRIORITY_COLOR = {
  Highest:  'text-red-700 bg-red-50 border-red-200',
  Critical: 'text-red-700 bg-red-50 border-red-200',
  High:     'text-orange-700 bg-orange-50 border-orange-200',
  Medium:   'text-yellow-700 bg-yellow-50 border-yellow-200',
  Low:      'text-green-700 bg-green-50 border-green-200',
  Lowest:   'text-gray-500 bg-gray-50 border-gray-200',
}

const STATUS_COLOR = {
  'DONE':                 'text-green-700 bg-green-50',
  'Done':                 'text-green-700 bg-green-50',
  'In Progress':          'text-blue-700 bg-blue-50',
  'In Review':            'text-indigo-700 bg-indigo-50',
  'Ready for Testing':    'text-purple-700 bg-purple-50',
  'Validation':           'text-violet-700 bg-violet-50',
  'Known Issue':          'text-yellow-700 bg-yellow-50',
  'Blocked':              'text-red-700 bg-red-50',
  'Reopened':             'text-orange-700 bg-orange-50',
  'Removed':              'text-gray-400 bg-gray-50',
}

// ── Inline release-notes editor cell ──────────────────────────────────────────
function ReleaseNotesCell({ issueKey, value, description, onSaved }) {
  const [editing, setEditing]   = useState(false)
  const [draft,   setDraft]     = useState(value || '')
  const [saving,  setSaving]    = useState(false)
  const [error,   setError]     = useState('')

  function startEdit() {
    setDraft(value || description || '')
    setEditing(true)
    setError('')
  }

  function cancel() {
    setEditing(false)
    setError('')
  }

  async function save() {
    setSaving(true)
    setError('')
    try {
      await putReleaseNote(issueKey, draft)
      onSaved(issueKey, draft)
      setEditing(false)
    } catch (e) {
      setError(e?.response?.data?.detail || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-1 min-w-[280px]">
        <textarea
          className="w-full border border-brand-400 rounded-lg px-2 py-1.5 text-xs resize-y focus:outline-none focus:ring-2 focus:ring-brand-500"
          rows={4}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          autoFocus
        />
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex gap-1">
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1 px-2 py-1 bg-brand-600 text-white rounded text-xs hover:bg-brand-700 disabled:opacity-50"
          >
            <Check className="h-3 w-3" />
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={cancel}
            className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 text-gray-600 rounded text-xs hover:bg-gray-200"
          >
            <X className="h-3 w-3" />
            Cancel
          </button>
        </div>
      </div>
    )
  }

  if (value) {
    return (
      <div className="flex items-start gap-2 group">
        <p className="text-xs text-gray-700 flex-1 whitespace-pre-wrap leading-relaxed">{value}</p>
        <button
          onClick={startEdit}
          className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-brand-600"
          title="Edit release notes"
        >
          <Pencil className="h-3 w-3" />
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={startEdit}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-dashed border-gray-300 rounded-lg text-xs text-gray-400 hover:border-brand-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
    >
      <ClipboardCopy className="h-3 w-3" />
      {description ? 'Fill from description' : 'Add release notes'}
    </button>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function ReleaseNotesPage() {
  const [mode,            setMode]            = useState('version')
  const [selectedVersion, setSelectedVersion] = useState('')
  const [selectedEpic,    setSelectedEpic]    = useState('')
  const [epicSearch,      setEpicSearch]      = useState('')
  const [isRefreshing,    setIsRefreshing]    = useState(false)
  const [lastRefresh,     setLastRefresh]     = useState(null)
  // Local overrides after inline saves (key → new text)
  const [localNotes,      setLocalNotes]      = useState({})

  const queryClient = useQueryClient()

  const { data: versions = [], isLoading: versionsLoading } = useQuery({
    queryKey: ['rn-versions'],
    queryFn: getVersions,
    staleTime: 10 * 60 * 1000,
  })

  const { data: epics = [], isLoading: epicsLoading } = useQuery({
    queryKey: ['rn-epics'],
    queryFn: getEpics,
    staleTime: 30 * 60 * 1000,
  })

  const params = useMemo(() => {
    if (mode === 'version' && selectedVersion) return { version: selectedVersion }
    if (mode === 'epic'    && selectedEpic)    return { epic_key: selectedEpic }
    return null
  }, [mode, selectedVersion, selectedEpic])

  const issuesQuery = useQuery({
    queryKey: ['release-notes-issues', params],
    queryFn:  ({ signal }) => getIssues(params, signal),
    enabled:  !!params,
    staleTime: 5 * 60 * 1000,
  })

  const issues = useMemo(() => {
    const raw = issuesQuery.data?.issues || []
    return raw.map(issue => ({
      ...issue,
      release_notes: localNotes[issue.key] !== undefined
        ? localNotes[issue.key]
        : issue.release_notes,
    }))
  }, [issuesQuery.data, localNotes])

  const handleSaved = useCallback((key, text) => {
    setLocalNotes(prev => ({ ...prev, [key]: text }))
  }, [])

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true)
    setLocalNotes({})
    try {
      const refreshParams = params ? { ...params, refresh: true } : null
      if (refreshParams) {
        const data = await getIssues(refreshParams)
        queryClient.setQueryData(['release-notes-issues', params], data)
      }
      setLastRefresh(new Date())
    } finally {
      setIsRefreshing(false)
    }
  }, [params, queryClient])

  const filteredEpics = useMemo(() => {
    if (!epicSearch.trim()) return epics
    const q = epicSearch.toLowerCase()
    return epics.filter(e => e.name.toLowerCase().includes(q) || e.key.toLowerCase().includes(q))
  }, [epics, epicSearch])

  const selectedEpicName = useMemo(
    () => epics.find(e => e.key === selectedEpic)?.name || selectedEpic,
    [epics, selectedEpic]
  )

  const filledCount = issues.filter(i => i.release_notes).length
  const emptyCount  = issues.length - filledCount

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Release Notes"
        lastRefresh={lastRefresh}
        isRefreshing={isRefreshing}
        onRefresh={handleRefresh}
      />

      <div className="flex-1 p-6 space-y-5 overflow-auto">

        {/* Selector card */}
        <div className="card space-y-4">
          <div className="flex gap-2">
            <button
              onClick={() => setMode('version')}
              className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                mode === 'version'
                  ? 'bg-brand-600 text-white border-brand-600'
                  : 'bg-white text-gray-600 border-gray-300 hover:border-brand-400'
              }`}
            >
              <Tag className="h-4 w-4" />
              By Fix Version
            </button>
            <button
              onClick={() => setMode('epic')}
              className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                mode === 'epic'
                  ? 'bg-brand-600 text-white border-brand-600'
                  : 'bg-white text-gray-600 border-gray-300 hover:border-brand-400'
              }`}
            >
              <Layers className="h-4 w-4" />
              By Epic
            </button>
          </div>

          {mode === 'version' && (
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-gray-700 shrink-0">Fix Version</label>
              {versionsLoading ? (
                <span className="text-sm text-gray-400">Loading…</span>
              ) : (
                <select
                  className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 min-w-[280px]"
                  value={selectedVersion}
                  onChange={e => { setSelectedVersion(e.target.value); setLocalNotes({}) }}
                >
                  <option value="">— Select a version —</option>
                  {versions.map(v => (
                    <option key={v.id} value={v.name}>
                      {v.name}{v.released ? ' (released)' : ''}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {mode === 'epic' && (
            <div className="flex items-start gap-3">
              <label className="text-sm font-medium text-gray-700 shrink-0 pt-1.5">Epic</label>
              {epicsLoading ? (
                <span className="text-sm text-gray-400">Loading…</span>
              ) : (
                <div className="flex flex-col gap-2 flex-1 max-w-md">
                  <input
                    type="text"
                    placeholder="Search epic…"
                    value={epicSearch}
                    onChange={e => setEpicSearch(e.target.value)}
                    className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 w-full"
                  />
                  <select
                    className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 w-full"
                    size={Math.min(8, filteredEpics.length + 1)}
                    value={selectedEpic}
                    onChange={e => { setSelectedEpic(e.target.value); setLocalNotes({}) }}
                  >
                    <option value="">— Select an epic —</option>
                    {filteredEpics.map(e => (
                      <option key={e.key} value={e.key}>{e.key} — {e.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Loading */}
        {issuesQuery.isLoading && params && (
          <div className="flex justify-center py-16"><PageLoader /></div>
        )}

        {/* Error */}
        {issuesQuery.isError && (
          <ErrorState message={issuesQuery.error?.message} onRetry={issuesQuery.refetch} />
        )}

        {/* Results */}
        {!issuesQuery.isLoading && issues.length > 0 && (
          <>
            {/* Summary bar */}
            <div className="flex items-center gap-4 text-sm">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-brand-500" />
                {mode === 'version'
                  ? <strong className="text-gray-800">{selectedVersion}</strong>
                  : <><strong className="text-gray-800">{selectedEpicName}</strong> <span className="text-gray-400 font-mono text-xs">({selectedEpic})</span></>
                }
              </div>
              <span className="text-gray-300">|</span>
              <span className="text-gray-500">{issues.length} issues</span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-50 text-green-700 rounded-full text-xs font-medium border border-green-200">
                {filledCount} filled
              </span>
              {emptyCount > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-orange-50 text-orange-700 rounded-full text-xs font-medium border border-orange-200">
                  {emptyCount} empty
                </span>
              )}
            </div>

            {/* Table */}
            <div className="card p-0 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 bg-gray-50">
                    <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs w-28">Key</th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs">Summary</th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs w-28">Status</th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs w-24">Priority</th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs w-32">Fix Version</th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs w-28">Labels</th>
                    <th className="text-left px-4 py-3 font-semibold text-gray-600 text-xs min-w-[300px]">Release Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {issues.map(issue => (
                    <tr key={issue.key} className="hover:bg-gray-50 transition-colors align-top">
                      <td className="px-4 py-3">
                        <a
                          href={issue.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-xs text-brand-600 hover:underline font-medium"
                        >
                          {issue.key}
                        </a>
                      </td>
                      <td className="px-4 py-3">
                        <p className="text-xs text-gray-800 leading-snug">{issue.summary}</p>
                        {issue.assignee && (
                          <p className="text-xs text-gray-400 mt-0.5">{issue.assignee}</p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLOR[issue.status] || 'text-gray-600 bg-gray-50'}`}>
                          {issue.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {issue.priority && (
                          <span className={`inline-block px-2 py-0.5 rounded border text-xs font-medium ${PRIORITY_COLOR[issue.priority] || 'text-gray-600 bg-gray-50 border-gray-200'}`}>
                            {issue.priority}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-0.5">
                          {issue.fix_versions.map(v => (
                            <span key={v} className="text-xs text-gray-600 bg-gray-100 rounded px-1.5 py-0.5 inline-block">{v}</span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-1">
                          {issue.labels.map(l => (
                            <span key={l} className="text-xs bg-blue-50 text-blue-700 border border-blue-100 rounded px-1.5 py-0.5">{l}</span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <ReleaseNotesCell
                          issueKey={issue.key}
                          value={issue.release_notes}
                          description={issue.description}
                          onSaved={handleSaved}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* Empty results */}
        {!issuesQuery.isLoading && params && issues.length === 0 && !issuesQuery.isError && (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400">
            <FileText className="h-12 w-12 mb-3 opacity-30" />
            <p className="text-sm">No bugs with labels FromHaim or Prod_Zoho found for this selection.</p>
          </div>
        )}

        {/* No selection state */}
        {!params && !issuesQuery.isLoading && (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400">
            <FileText className="h-12 w-12 mb-3 opacity-30" />
            <p className="text-sm">
              {mode === 'version' ? 'Select a fix version to see release notes.' : 'Select an epic to see release notes.'}
            </p>
          </div>
        )}

      </div>
    </div>
  )
}

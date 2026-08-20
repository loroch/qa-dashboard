import { useState, useMemo, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Header } from '../components/layout/Header'
import { PageLoader, ErrorState } from '../components/common/LoadingSpinner'
import {
  FileText, Tag, Layers, Pencil, Check, X, ClipboardCopy,
  FileDown, FileCode2, Newspaper,
} from 'lucide-react'
import axios from 'axios'
import { BASE_URL } from '../services/api'

const api = axios.create({ baseURL: BASE_URL, timeout: 60000 })

const getVersions    = () => api.get('/coverage/versions').then(r => r.data)
const getEpics       = () => api.get('/dashboard/epics').then(r => r.data)
const getIssues      = (params, sig) => api.get('/release-notes', { params, signal: sig }).then(r => r.data)
const getReport      = (version, sig) => api.get('/release-notes/report', { params: { version }, signal: sig }).then(r => r.data)
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
      const detail = e?.response?.data?.detail
      setError(detail || `Save failed (${e?.response?.status ?? 'network error'})`)
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

// ── Report helpers ─────────────────────────────────────────────────────────────
const STATUS_BADGE = {
  'Done':                 'bg-green-100 text-green-700',
  'DONE':                 'bg-green-100 text-green-700',
  'In Progress':          'bg-blue-100 text-blue-700',
  'In Review':            'bg-indigo-100 text-indigo-700',
  'Ready for Testing':    'bg-purple-100 text-purple-700',
  'Validation':           'bg-violet-100 text-violet-700',
  'Monitoring':           'bg-yellow-100 text-yellow-700',
  'Known Issue':          'bg-yellow-100 text-yellow-700',
  'Blocked':              'bg-red-100 text-red-700',
  'Reopened':             'bg-orange-100 text-orange-700',
  'Ready For Deployment': 'bg-teal-100 text-teal-700',
  'Removed':              'bg-gray-100 text-gray-500',
  'To Do':                'bg-gray-100 text-gray-600',
}

function StatusPill({ status }) {
  const cls = STATUS_BADGE[status] || 'bg-gray-100 text-gray-600'
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium whitespace-nowrap ${cls}`}>
      {status || '—'}
    </span>
  )
}

function countAll(report) {
  let n = 0
  for (const epic of report.epics || []) {
    n += 1
    for (const story of epic.stories || []) { n += 1 + story.bugs.length }
    n += epic.bugs.length
  }
  n += (report.orphan_stories || []).reduce((s, st) => s + 1 + st.bugs.length, 0)
  n += (report.orphan_bugs || []).length
  return n
}

function downloadBlob(content, mimeType, filename) {
  const blob = new Blob([content], { type: mimeType })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function buildXLS(report) {
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const v   = esc(report.version)
  const COL = 5

  const epicRow  = (e)  => `<tr style="background:#1e3a8a;color:#fff;font-weight:bold">
    <td>Epic</td><td>${esc(e.key)}</td><td colspan="3">${esc(e.summary)}</td></tr>
    <tr style="background:#1e3a8a;color:#dbeafe;font-size:11px">
    <td></td><td colspan="4">Status: ${esc(e.status)}</td></tr>`

  const storyRow = (s)  => `<tr style="background:#eff6ff;font-weight:600">
    <td style="padding-left:16px">Story</td><td>${esc(s.key)}</td><td colspan="2">${esc(s.summary)}</td><td>${esc(s.status)}</td></tr>`

  const bugRow   = (b, indent) => `<tr>
    <td style="padding-left:${indent}px;color:#6b7280;font-size:11px">Bug</td>
    <td style="font-family:monospace;color:#1e40af">${esc(b.key)}</td>
    <td>${esc(b.summary)}</td>
    <td>${esc(b.status)}</td>
    <td>${esc(b.release_notes)}</td></tr>`

  let rows = `<tr style="background:#1e3a8a"><td colspan="${COL}" style="color:#fff;font-size:15px;font-weight:bold;padding:10px 12px">Release Notes — ${v}</td></tr>
  <tr style="background:#dbeafe;font-weight:bold">
    <td>Type</td><td>Key</td><td>Summary</td><td>Status</td><td>Release Notes</td></tr>`

  const allEpics = [...(report.epics || []), ...(report.orphan_stories || []).map(s => ({ key:'', summary:'No Epic', status:'', stories:[s], bugs:[] })), { key:'', summary:'', status:'', stories:[], bugs: report.orphan_bugs || [] }]

  for (const epic of report.epics || []) {
    rows += epicRow(epic)
    for (const story of epic.stories || []) {
      rows += storyRow(story)
      for (const bug of story.bugs || []) rows += bugRow(bug, 28)
    }
    for (const bug of epic.bugs || []) rows += bugRow(bug, 16)
  }
  for (const story of report.orphan_stories || []) {
    rows += storyRow(story)
    for (const bug of story.bugs || []) rows += bugRow(bug, 16)
  }
  for (const bug of report.orphan_bugs || []) rows += bugRow(bug, 8)

  return `<html><head><meta charset="utf-8"></head><body>
    <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px">
      ${rows}</table></body></html>`
}

function buildHTML(report) {
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const v = esc(report.version)
  const total = countAll(report)

  const bugRows = (bugs, indent) => bugs.map(b => `
    <tr class="bug-row">
      <td class="type-cell" style="padding-left:${indent}px"><span class="badge bug">Bug</span></td>
      <td><a href="${esc(b.url)}" target="_blank" class="key">${esc(b.key)}</a></td>
      <td class="summary">${esc(b.summary)}</td>
      <td><span class="status">${esc(b.status)}</span></td>
      <td class="rn">${esc(b.release_notes) || '<span class="empty">—</span>'}</td>
    </tr>`).join('')

  let sections = ''
  for (const epic of report.epics || []) {
    let inner = ''
    for (const story of epic.stories || []) {
      inner += `<tr class="story-row">
        <td class="type-cell" style="padding-left:16px"><span class="badge story">Story</span></td>
        <td><a href="${esc(story.url)}" target="_blank" class="key">${esc(story.key)}</a></td>
        <td class="summary">${esc(story.summary)}</td>
        <td><span class="status">${esc(story.status)}</span></td>
        <td class="rn"></td>
      </tr>${bugRows(story.bugs || [], 28)}`
    }
    inner += bugRows(epic.bugs || [], 16)
    sections += `<section>
      <div class="epic-header">
        <span class="badge epic">Epic</span>
        <a href="${esc(epic.url)}" target="_blank" class="epic-key">${esc(epic.key)}</a>
        <span class="epic-title">${esc(epic.summary)}</span>
        <span class="status ml">${esc(epic.status)}</span>
      </div>
      <table><thead><tr>
        <th style="width:70px">Type</th><th style="width:110px">Key</th>
        <th>Summary</th><th style="width:140px">Status</th><th style="width:30%">Release Notes</th>
      </tr></thead><tbody>${inner}</tbody></table>
    </section>`
  }
  // orphans
  if ((report.orphan_stories || []).length || (report.orphan_bugs || []).length) {
    let inner = ''
    for (const s of report.orphan_stories || []) {
      inner += `<tr class="story-row"><td><span class="badge story">Story</span></td>
        <td><a href="${esc(s.url)}" target="_blank" class="key">${esc(s.key)}</a></td>
        <td>${esc(s.summary)}</td><td><span class="status">${esc(s.status)}</span></td><td></td></tr>
        ${bugRows(s.bugs || [], 16)}`
    }
    inner += bugRows(report.orphan_bugs || [], 8)
    sections += `<section><div class="epic-header"><span class="badge" style="background:#e5e7eb;color:#374151">No Epic</span></div>
      <table><thead><tr><th>Type</th><th>Key</th><th>Summary</th><th>Status</th><th>Release Notes</th></tr></thead><tbody>${inner}</tbody></table></section>`
  }

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Release Notes — ${v}</title>
<style>
  body{font-family:Arial,sans-serif;max-width:1200px;margin:40px auto;color:#1f2937;line-height:1.5}
  header{border-bottom:3px solid #1e40af;padding-bottom:12px;margin-bottom:28px}
  h1{margin:0;color:#1e3a8a;font-size:24px}.meta{color:#6b7280;font-size:13px;margin-top:4px}
  section{margin-bottom:32px}
  .epic-header{display:flex;align-items:center;gap:10px;background:#1e3a8a;color:#fff;padding:10px 14px;border-radius:6px 6px 0 0}
  .epic-key{font-family:monospace;color:#93c5fd;font-size:13px;text-decoration:none}
  .epic-key:hover{text-decoration:underline}
  .epic-title{font-weight:600;font-size:14px;flex:1}
  .ml{margin-left:auto}
  .badge{display:inline-block;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
  .badge.epic{background:#1e40af;color:#fff}
  .badge.story{background:#7c3aed;color:#fff}
  .badge.bug{background:#dc2626;color:#fff}
  table{width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e2e8f0}
  th{text-align:left;padding:7px 10px;background:#f8fafc;color:#475569;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em;border-bottom:2px solid #e2e8f0}
  td{padding:6px 10px;border-bottom:1px solid #f1f5f9;vertical-align:top}
  .story-row td{background:#faf5ff}
  .key{font-family:monospace;color:#1e40af;font-weight:600;text-decoration:none;font-size:12px}
  .key:hover{text-decoration:underline}
  .summary{color:#374151}.rn{color:#065f46;font-style:italic}
  .status{font-size:11px;background:#f3f4f6;border-radius:4px;padding:2px 6px;color:#374151}
  .empty{color:#9ca3af}.type-cell{color:#6b7280}
</style></head>
<body>
  <header>
    <h1>Release Notes — ${v}</h1>
    <p class="meta">Generated ${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})} &nbsp;·&nbsp; ${total} issues</p>
  </header>
  ${sections}
</body></html>`
}

// ── Bug row inside the generate report ────────────────────────────────────────
function BugRow({ bug, indent }) {
  return (
    <div className={`flex gap-4 border-b border-gray-50 py-2.5 pr-5 hover:bg-gray-50 transition-colors items-start ${indent}`}>
      <span className="text-xs font-bold bg-red-100 text-red-700 px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0 mt-0.5">Bug</span>
      <a href={bug.url} target="_blank" rel="noopener noreferrer"
        className="font-mono text-xs text-brand-600 hover:underline font-semibold shrink-0 w-24 pt-0.5">{bug.key}</a>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-gray-500 truncate">{bug.summary}</p>
        {bug.release_notes && (
          <p className="text-sm text-gray-700 leading-relaxed mt-0.5">{bug.release_notes}</p>
        )}
      </div>
      <StatusPill status={bug.status} />
    </div>
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

  const tableParams = useMemo(() => {
    if (mode === 'version' && selectedVersion) return { version: selectedVersion }
    if (mode === 'epic'    && selectedEpic)    return { epic_key: selectedEpic }
    return null
  }, [mode, selectedVersion, selectedEpic])

  const issuesQuery = useQuery({
    queryKey: ['release-notes-issues', tableParams],
    queryFn:  ({ signal }) => getIssues(tableParams, signal),
    enabled:  !!tableParams && mode !== 'generate',
    staleTime: 5 * 60 * 1000,
  })

  const reportQuery = useQuery({
    queryKey: ['release-notes-report', selectedVersion],
    queryFn:  ({ signal }) => getReport(selectedVersion, signal),
    enabled:  mode === 'generate' && !!selectedVersion,
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
      if (mode === 'generate' && selectedVersion) {
        const data = await getReport(selectedVersion)
        queryClient.setQueryData(['release-notes-report', selectedVersion], data)
      } else if (tableParams) {
        const data = await getIssues({ ...tableParams, refresh: true })
        queryClient.setQueryData(['release-notes-issues', tableParams], data)
      }
      setLastRefresh(new Date())
    } finally {
      setIsRefreshing(false)
    }
  }, [mode, selectedVersion, tableParams, queryClient])

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

  const report = reportQuery.data

  function handleExportXLS() {
    if (!report) return
    downloadBlob(buildXLS(report), 'application/vnd.ms-excel', `release-notes-${selectedVersion}.xls`)
  }
  function handleExportHTML() {
    if (!report) return
    downloadBlob(buildHTML(report), 'text/html', `release-notes-${selectedVersion}.html`)
  }

  const tabBtn = (id, Icon, label) => (
    <button
      onClick={() => setMode(id)}
      className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
        mode === id
          ? 'bg-brand-600 text-white border-brand-600'
          : 'bg-white text-gray-600 border-gray-300 hover:border-brand-400'
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  )

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
          <div className="flex gap-2 flex-wrap">
            {tabBtn('version',  Tag,       'By Fix Version')}
            {tabBtn('epic',     Layers,    'By Epic')}
            {tabBtn('generate', Newspaper, 'Generate Report')}
          </div>

          {/* Version selector — shared between 'version' and 'generate' */}
          {(mode === 'version' || mode === 'generate') && (
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

        {/* Loading — table tabs */}
        {issuesQuery.isLoading && tableParams && mode !== 'generate' && (
          <div className="flex justify-center py-16"><PageLoader /></div>
        )}
        {/* Loading — generate tab */}
        {mode === 'generate' && reportQuery.isLoading && selectedVersion && (
          <div className="flex justify-center py-16"><PageLoader /></div>
        )}

        {/* Error */}
        {issuesQuery.isError && mode !== 'generate' && (
          <ErrorState message={issuesQuery.error?.message} onRetry={issuesQuery.refetch} />
        )}
        {reportQuery.isError && mode === 'generate' && (
          <ErrorState message={reportQuery.error?.message} onRetry={reportQuery.refetch} />
        )}

        {/* ── GENERATE REPORT VIEW ───────────────────────────────────────── */}
        {mode === 'generate' && report && !reportQuery.isLoading && (
          <div className="space-y-4">
            {/* Toolbar */}
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-3 text-sm">
                <Newspaper className="h-4 w-4 text-brand-500" />
                <strong className="text-gray-800">{selectedVersion}</strong>
                <span className="text-gray-400">|</span>
                <span className="text-gray-500">{countAll(report)} issues</span>
                <span className="text-gray-400">·</span>
                <span className="text-gray-500">{(report.epics || []).length} epics</span>
              </div>
              <div className="flex gap-2">
                <button onClick={handleExportXLS}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-green-600 text-white rounded-lg text-xs font-medium hover:bg-green-700 transition-colors">
                  <FileDown className="h-3.5 w-3.5" /> Export XLS
                </button>
                <button onClick={handleExportHTML}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 transition-colors">
                  <FileCode2 className="h-3.5 w-3.5" /> Export HTML
                </button>
              </div>
            </div>

            {/* Report header */}
            <div className="rounded-xl overflow-hidden border border-gray-200 shadow-sm">
              <div className="bg-brand-800 text-white px-6 py-4">
                <h2 className="text-base font-bold tracking-wide">Release Notes — {selectedVersion}</h2>
                <p className="text-brand-200 text-xs mt-0.5">
                  {new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}
                  &nbsp;·&nbsp; {countAll(report)} issues
                </p>
              </div>

              {/* Epics */}
              {(report.epics || []).map(epic => (
                <div key={epic.key} className="border-t border-gray-100">
                  {/* Epic row */}
                  <div className="flex items-center gap-3 bg-blue-900 px-5 py-3">
                    <span className="text-xs font-bold bg-blue-500 text-white px-2 py-0.5 rounded uppercase tracking-wide">Epic</span>
                    <a href={epic.url} target="_blank" rel="noopener noreferrer"
                      className="font-mono text-xs text-blue-300 hover:underline font-semibold shrink-0">{epic.key}</a>
                    <span className="text-sm font-semibold text-white flex-1">{epic.summary}</span>
                    <StatusPill status={epic.status} />
                  </div>

                  {/* Stories under this epic */}
                  {(epic.stories || []).map(story => (
                    <div key={story.key}>
                      {/* Story row */}
                      <div className="flex items-center gap-3 bg-purple-50 border-b border-purple-100 px-5 py-2.5 pl-10">
                        <span className="text-xs font-bold bg-purple-500 text-white px-2 py-0.5 rounded uppercase tracking-wide">Story</span>
                        <a href={story.url} target="_blank" rel="noopener noreferrer"
                          className="font-mono text-xs text-purple-700 hover:underline font-semibold shrink-0">{story.key}</a>
                        <span className="text-sm text-purple-900 flex-1">{story.summary}</span>
                        <StatusPill status={story.status} />
                      </div>
                      {/* Bugs under story */}
                      {(story.bugs || []).map(bug => (
                        <BugRow key={bug.key} bug={bug} indent="pl-16" />
                      ))}
                    </div>
                  ))}

                  {/* Bugs directly under epic */}
                  {(epic.bugs || []).map(bug => (
                    <BugRow key={bug.key} bug={bug} indent="pl-12" />
                  ))}
                </div>
              ))}

              {/* Orphan stories */}
              {(report.orphan_stories || []).length > 0 && (
                <div className="border-t border-gray-100">
                  <div className="bg-gray-100 px-5 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">No Epic</div>
                  {report.orphan_stories.map(story => (
                    <div key={story.key}>
                      <div className="flex items-center gap-3 bg-purple-50 border-b border-purple-100 px-5 py-2.5">
                        <span className="text-xs font-bold bg-purple-500 text-white px-2 py-0.5 rounded uppercase">Story</span>
                        <a href={story.url} target="_blank" rel="noopener noreferrer"
                          className="font-mono text-xs text-purple-700 hover:underline font-semibold">{story.key}</a>
                        <span className="text-sm text-purple-900 flex-1">{story.summary}</span>
                        <StatusPill status={story.status} />
                      </div>
                      {(story.bugs || []).map(bug => <BugRow key={bug.key} bug={bug} indent="pl-10" />)}
                    </div>
                  ))}
                </div>
              )}

              {/* Orphan bugs */}
              {(report.orphan_bugs || []).length > 0 && (
                <div className="border-t border-gray-100">
                  <div className="bg-gray-100 px-5 py-2 text-xs font-semibold text-gray-500 uppercase tracking-wide">Standalone Bugs</div>
                  {report.orphan_bugs.map(bug => <BugRow key={bug.key} bug={bug} indent="pl-5" />)}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Generate mode — no version selected */}
        {mode === 'generate' && !selectedVersion && (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400">
            <Newspaper className="h-12 w-12 mb-3 opacity-30" />
            <p className="text-sm">Select a fix version to generate the report.</p>
          </div>
        )}

        {/* ── TABLE VIEW (By Version / By Epic) ─────────────────────────── */}
        {mode !== 'generate' && !issuesQuery.isLoading && issues.length > 0 && tableParams && (
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
        {mode !== 'generate' && !issuesQuery.isLoading && tableParams && issues.length === 0 && !issuesQuery.isError && (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400">
            <FileText className="h-12 w-12 mb-3 opacity-30" />
            <p className="text-sm">No bugs with labels FromHaim or Prod_Zoho found for this selection.</p>
          </div>
        )}

        {/* No selection state */}
        {!tableParams && !issuesQuery.isLoading && mode !== 'generate' && (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400">
            <FileText className="h-12 w-12 mb-3 opacity-30" />
            <p className="text-sm">
              {mode === 'epic'
                ? 'Select an epic to see release notes.'
                : 'Select a fix version to see release notes.'}
            </p>
          </div>
        )}

      </div>
    </div>
  )
}

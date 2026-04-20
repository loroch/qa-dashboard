import { useState, useEffect, useMemo } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Header } from '../components/layout/Header'
import { SummaryCard } from '../components/cards/SummaryCard'
import {
  ClipboardList, ExternalLink, AlertTriangle, CheckCircle2,
  FlaskConical, Loader2, Search, PlayCircle, ChevronDown, ChevronRight, User
} from 'lucide-react'
import axios from 'axios'

const api = axios.create({ baseURL: '/api', timeout: 300000 })

const fetchVersions     = ()     => api.get('/test-plans/versions').then(r => r.data)
const resolveIds        = (body) => api.post('/test-plans/resolve-ids', body).then(r => r.data)
const postCreate        = (body) => api.post('/test-plans/create', body).then(r => r.data)
const postExecCreate    = (body) => api.post('/test-plans/create-executions', body).then(r => r.data)

// ── QA team (from field_mapping.yaml) ─────────────────────────────────────────
const QA_TEAM = [
  { id: '712020:d844f1ce-4a41-46b1-8524-b93bbb948a84', name: 'Anat Serban' },
  { id: '63d64903491b20ef64b750db',                    name: 'Ron Levy' },
  { id: '712020:93e7d8d1-93fd-472c-85ba-031b64d96f16', name: 'Jorge Alquicira' },
  { id: '712020:4eefeaaf-e7fb-407c-8c32-2adef07c15bc', name: 'Loro Chichportich' },
  { id: '712020:dcf5b82a-4cb5-444a-9946-cab93de073fa', name: 'Jonathan Cohen' },
]

// ── Domain extraction ──────────────────────────────────────────────────────────
function extractDomain(summary) {
  // Strip leading [TAG] prefix: "[PROC] Translation - ..." → "Translation - ..."
  const clean = summary.replace(/^\[.*?\]\s*/, '').trim()
  // Take text before first " - " if it's short enough to be a domain label
  const dashIdx = clean.indexOf(' - ')
  if (dashIdx > 1 && dashIdx <= 40) return clean.substring(0, dashIdx).trim()
  // Otherwise use first 3 words
  return clean.split(' ').slice(0, 3).join(' ')
}

const MIN_GROUP_SIZE = 3   // groups smaller than this get merged into "Other"

function groupByDomain(tests) {
  const map = {}
  for (const t of tests) {
    const domain = extractDomain(t.summary)
    if (!map[domain]) map[domain] = []
    map[domain].push(t)
  }

  const groups = []
  const other  = []

  for (const [domain, items] of Object.entries(map)) {
    if (items.length >= MIN_GROUP_SIZE) {
      groups.push({ domain, tests: items })
    } else {
      other.push(...items)
    }
  }

  // Sort main groups by size desc
  groups.sort((a, b) => b.tests.length - a.tests.length)

  // Merge all small groups into a single "Other" group
  if (other.length > 0) {
    groups.push({ domain: 'Other', tests: other })
  }

  return groups
}

function parseIds(raw) {
  return raw.split(/[\s,]+/).map(s => s.trim()).filter(s => s.length > 0)
}

// ── Group row component ────────────────────────────────────────────────────────
function GroupRow({ group, version, assigneeId, onAssigneeChange, expanded, onToggle }) {
  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-3 px-4 py-2.5 bg-gray-50 cursor-pointer hover:bg-gray-100 select-none"
        onClick={onToggle}
      >
        <button className="text-gray-400">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <span className="flex-1 text-sm font-medium text-gray-700">{group.domain}</span>
        <span className="text-xs text-gray-400 mr-3">{group.tests.length} tests</span>
        {/* Assignee picker */}
        <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
          <User className="h-3.5 w-3.5 text-gray-400" />
          <select
            className="border border-gray-300 rounded px-2 py-1 text-xs
                       focus:outline-none focus:ring-1 focus:ring-brand-500"
            value={assigneeId}
            onChange={e => onAssigneeChange(e.target.value)}
          >
            <option value="">— Unassigned —</option>
            {QA_TEAM.map(m => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>
      </div>
      {expanded && (
        <div className="divide-y divide-gray-100 max-h-40 overflow-auto">
          {group.tests.map(t => (
            <div key={t.key} className="flex items-center gap-3 px-4 py-1.5 text-xs">
              <a
                href={t.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-brand-600 hover:underline whitespace-nowrap flex items-center gap-1"
              >
                {t.key} <ExternalLink className="h-3 w-3 opacity-40" />
              </a>
              <span className="text-gray-600 truncate">{t.summary}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function TestPlansPage() {
  const [mode, setMode]                       = useState('new')   // 'new' | 'existing'
  const [existingEpic, setExistingEpic]       = useState('')
  const [selectedVersion, setSelectedVersion] = useState('')
  const [planName, setPlanName]               = useState('')
  const [idInput, setIdInput]                 = useState('')
  const [loadedTests, setLoadedTests]         = useState(null)
  const [planResult, setPlanResult]           = useState(null)

  // Execution state
  const [assignees, setAssignees]   = useState({})   // domain → accountId
  const [expandedGroups, setExpanded] = useState({})
  const [execResult, setExecResult] = useState(null)

  const { data: versions = [], isLoading: versionsLoading } = useQuery({
    queryKey:  ['test-plan-versions'],
    queryFn:   fetchVersions,
    staleTime: 60 * 60 * 1000,
  })

  useEffect(() => {
    if (selectedVersion) {
      setPlanName(`${selectedVersion} Regression Test Plan`)
      setPlanResult(null)
      setExecResult(null)
    }
  }, [selectedVersion])

  const resolveMutation = useMutation({
    mutationFn: resolveIds,
    onSuccess:  (data) => { setLoadedTests(data); setPlanResult(null); setExecResult(null) },
  })

  const createMutation = useMutation({
    mutationFn: postCreate,
    onSuccess:  (data) => setPlanResult(data),
  })

  const execMutation = useMutation({
    mutationFn: postExecCreate,
    onSuccess:  (data) => setExecResult(data),
  })

  // Auto-group tests by domain (memoised)
  const groups = useMemo(() => {
    if (!loadedTests?.tests?.length) return []
    return groupByDomain(loadedTests.tests)
  }, [loadedTests])

  const handleLoadTests = () => {
    const ids = parseIds(idInput)
    if (!ids.length) return
    resolveMutation.mutate({ issue_ids: ids })
  }

  const handleCreate = () => {
    const issue_keys = (loadedTests?.tests || []).map(t => t.key)
    createMutation.mutate({ name: planName, version: selectedVersion, issue_keys })
  }


  // In "existing" mode, treat the entered epic key as the plan result
  const effectivePlanResult = mode === 'existing' && existingEpic.trim()
    ? { epic_key: existingEpic.trim().toUpperCase(), epic_url: null, linked: '?', total: '?' }
    : planResult

  const canLoad        = idInput.trim().length > 0 && !resolveMutation.isPending
  const canCreate      = planName.trim() && selectedVersion && loadedTests?.count > 0 && !createMutation.isPending
  const canCreateExec  = effectivePlanResult?.epic_key && groups.length > 0 && !execMutation.isPending

  const handleCreateExecutions = () => {
    const executions = groups.map(g => ({
      name:        `${selectedVersion || existingEpic.trim()} - ${g.domain} - Test Execution`,
      assignee_id: assignees[g.domain] || null,
      test_keys:   g.tests.map(t => t.key),
    }))
    execMutation.mutate({
      epic_key:   effectivePlanResult.epic_key,
      version:    selectedVersion,
      executions,
    })
  }

  return (
    <div className="flex-1 flex flex-col">
      <Header title="Test Plans" />

      <div className="flex-1 p-6 space-y-5 overflow-auto">

        {/* ── Mode toggle ── */}
        <div className="flex gap-2">
          <button
            onClick={() => setMode('new')}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium border transition-colors
              ${mode === 'new' ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-gray-600 border-gray-300 hover:border-brand-400'}`}
          >
            Create New Plan
          </button>
          <button
            onClick={() => setMode('existing')}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium border transition-colors
              ${mode === 'existing' ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-gray-600 border-gray-300 hover:border-brand-400'}`}
          >
            Use Existing Plan
          </button>
        </div>

        {/* ── Existing plan shortcut ── */}
        {mode === 'existing' && (
          <div className="card space-y-3">
            <p className="text-sm text-gray-600">
              Already have a test plan Epic? Enter its key to go straight to creating executions.
            </p>
            <div className="flex gap-3 items-center">
              <input
                type="text"
                className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono w-48
                           focus:outline-none focus:ring-2 focus:ring-brand-500"
                value={existingEpic}
                onChange={e => setExistingEpic(e.target.value)}
                placeholder="e.g. TMT0-41260"
              />
              <div>
                <label className="block text-xs text-gray-500 mb-0.5">Fix Version (for task labels)</label>
                <select
                  className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm
                             focus:outline-none focus:ring-2 focus:ring-brand-500"
                  value={selectedVersion}
                  onChange={e => setSelectedVersion(e.target.value)}
                >
                  <option value="">— Select version —</option>
                  {versions.map(v => (
                    <option key={v.id} value={v.name}>{v.name}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        )}

        {/* ── Step 1 & 2: version + name ── */}
        {mode === 'new' && (
          <div className="card space-y-4">
            <div className="grid grid-cols-2 gap-4 max-w-2xl">
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">1. Fix Version</label>
                {versionsLoading ? (
                  <span className="text-sm text-gray-400">Loading…</span>
                ) : (
                  <select
                    className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-full
                               focus:outline-none focus:ring-2 focus:ring-brand-500"
                    value={selectedVersion}
                    onChange={e => setSelectedVersion(e.target.value)}
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
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">2. Plan Name</label>
                <input
                  type="text"
                  className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-full
                             focus:outline-none focus:ring-2 focus:ring-brand-500"
                  value={planName}
                  onChange={e => setPlanName(e.target.value)}
                  placeholder="e.g. CI-MG-5.3.5 Regression Test Plan"
                />
              </div>
            </div>
          </div>
        )}

        {/* ── Step 3: paste IDs ── */}
        <div className="card space-y-3">
          <label className="block text-sm font-semibold text-gray-700">
            3. Paste Issue IDs
            <span className="font-normal text-gray-400 ml-2">comma, space, or newline separated</span>
          </label>
          <textarea
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-full font-mono
                       focus:outline-none focus:ring-2 focus:ring-brand-500 resize-y"
            rows={4}
            value={idInput}
            onChange={e => setIdInput(e.target.value)}
            placeholder={"48240, 42803, 43979, 43963...\nor one per line"}
          />
          <div className="flex items-center gap-3">
            <button
              className="btn-secondary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleLoadTests}
              disabled={!canLoad}
            >
              {resolveMutation.isPending
                ? <><Loader2 className="h-4 w-4 animate-spin" /> Resolving…</>
                : <><Search className="h-4 w-4" /> Load Tests</>
              }
            </button>
            {idInput.trim() && (
              <span className="text-xs text-gray-400">{parseIds(idInput).length} IDs detected</span>
            )}
          </div>
          {resolveMutation.isError && (
            <p className="text-sm text-red-600">
              {resolveMutation.error?.response?.data?.detail || resolveMutation.error?.message}
            </p>
          )}
        </div>

        {/* ── Loaded tests preview + create plan ── */}
        {loadedTests && (
          <>
            <div className="grid grid-cols-2 gap-4 max-w-md">
              <SummaryCard
                title="Tests Loaded"
                value={loadedTests.count}
                icon={FlaskConical}
                color="blue"
                subtitle={`${parseIds(idInput).length - loadedTests.count} not found / skipped`}
              />
            </div>

            <div className="card">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-700">Test Issues ({loadedTests.count})</h3>
                <button
                  className="btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={handleCreate}
                  disabled={!canCreate}
                >
                  {createMutation.isPending
                    ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating…</>
                    : <><ClipboardList className="h-4 w-4" /> Create Test Plan</>
                  }
                </button>
              </div>
              {createMutation.isError && (
                <p className="text-sm text-red-600 mb-2">
                  {createMutation.error?.response?.data?.detail || createMutation.error?.message}
                </p>
              )}
              {loadedTests.count === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">No issues found.</p>
              ) : (
                <div className="overflow-auto max-h-[300px]">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-gray-50 text-gray-500 uppercase">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium">Key</th>
                        <th className="text-left px-3 py-2 font-medium">Summary</th>
                        <th className="text-left px-3 py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {loadedTests.tests.map(t => (
                        <tr key={t.key} className="hover:bg-gray-50">
                          <td className="px-3 py-2 font-mono whitespace-nowrap">
                            <a href={t.url} target="_blank" rel="noopener noreferrer"
                               className="text-brand-600 hover:underline flex items-center gap-1">
                              {t.key} <ExternalLink className="h-3 w-3 opacity-50" />
                            </a>
                          </td>
                          <td className="px-3 py-2 text-gray-700">{t.summary}</td>
                          <td className="px-3 py-2">
                            <span className="px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600">
                              {t.status || '—'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}

        {/* ── Plan created banner ── */}
        {planResult && (
          <div className={`card border-2 ${planResult.failed > 0 ? 'border-yellow-300 bg-yellow-50' : 'border-green-300 bg-green-50'}`}>
            <div className="flex items-start gap-3">
              {planResult.failed > 0
                ? <AlertTriangle className="h-5 w-5 text-yellow-600 shrink-0 mt-0.5" />
                : <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0 mt-0.5" />
              }
              <div className="flex-1">
                <p className={`font-semibold text-sm ${planResult.failed > 0 ? 'text-yellow-800' : 'text-green-800'}`}>
                  {planResult.failed > 0
                    ? `Test Plan created with ${planResult.failed} link failure(s)`
                    : 'Test Plan created successfully'}
                </p>
                <p className="text-xs mt-1 text-gray-600">
                  Epic:{' '}
                  <a href={planResult.epic_url} target="_blank" rel="noopener noreferrer"
                     className="font-mono font-semibold text-brand-700 hover:underline">
                    {planResult.epic_key}
                  </a>
                  {' · '}Linked: {planResult.linked}/{planResult.total}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* ── Step 4: Create Test Executions ── */}
        {effectivePlanResult?.epic_key && groups.length > 0 && (
          <div className="card space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-gray-700">
                  4. Create Test Executions
                </h2>
                <p className="text-xs text-gray-400 mt-0.5">
                  {groups.length} domain groups · assign each to a QA member · one Task per group under {effectivePlanResult.epic_key}
                </p>
              </div>
              <button
                className="btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={handleCreateExecutions}
                disabled={!canCreateExec}
              >
                {execMutation.isPending
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> Creating…</>
                  : <><PlayCircle className="h-4 w-4" /> Create Executions</>
                }
              </button>
            </div>

            {execMutation.isError && (
              <p className="text-sm text-red-600">
                {execMutation.error?.response?.data?.detail || execMutation.error?.message}
              </p>
            )}

            <div className="space-y-2">
              {groups.map(g => (
                <GroupRow
                  key={g.domain}
                  group={g}
                  version={selectedVersion}
                  assigneeId={assignees[g.domain] || ''}
                  onAssigneeChange={id => setAssignees(prev => ({ ...prev, [g.domain]: id }))}
                  expanded={!!expandedGroups[g.domain]}
                  onToggle={() => setExpanded(prev => ({ ...prev, [g.domain]: !prev[g.domain] }))}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── Executions result ── */}
        {execResult && (
          <div className="card space-y-2">
            <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              Executions Created ({execResult.results.length})
            </h3>
            <div className="space-y-1">
              {execResult.results.map((r, i) => (
                <div key={i} className={`flex items-center gap-3 text-xs px-3 py-2 rounded-lg
                  ${r.task_key ? 'bg-green-50' : 'bg-red-50'}`}>
                  {r.task_key ? (
                    <>
                      <CheckCircle2 className="h-3.5 w-3.5 text-green-600 shrink-0" />
                      <a href={r.task_url} target="_blank" rel="noopener noreferrer"
                         className="font-mono font-semibold text-brand-700 hover:underline whitespace-nowrap">
                        {r.task_key}
                      </a>
                      <span className="text-gray-600 truncate">{r.name}</span>
                      <span className="ml-auto text-gray-400 whitespace-nowrap">
                        {r.linked}/{r.total} linked
                        {r.failed > 0 && <span className="text-yellow-600 ml-1">({r.failed} failed)</span>}
                      </span>
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="h-3.5 w-3.5 text-red-500 shrink-0" />
                      <span className="text-red-700">{r.name}: {r.error}</span>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

      </div>
    </div>
  )
}

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { Header } from '../components/layout/Header'
import { PageLoader, ErrorState } from '../components/common/LoadingSpinner'
import {
  ExternalLink, Zap, AlertCircle, ChevronDown, ChevronRight,
  X, Check
} from 'lucide-react'
import axios from 'axios'

const api = axios.create({ baseURL: '/api', timeout: 120000 })

const getTestsWithoutParent = (refresh) =>
  api.get(`/anomaly/tests-without-parent${refresh ? '?refresh=true' : ''}`).then(r => r.data)
const assignParent = (body) =>
  api.post('/anomaly/assign-parent', body).then(r => r.data)
const getIncompleteBugs = (days, refresh) =>
  api.get(`/anomaly/incomplete-bugs?days=${days}${refresh ? '&refresh=true' : ''}`).then(r => r.data)
const getDuplicateBugs = (days, refresh) =>
  api.get(`/anomaly/duplicate-bugs?days=${days}${refresh ? '&refresh=true' : ''}`).then(r => r.data)

const TABS = ['Tests Without Parent', 'Incomplete Bugs', 'Duplicate Bugs']

const STATUS_COLORS = {
  'Done':              'bg-green-100 text-green-700',
  'In Progress':       'bg-blue-100 text-blue-700',
  'Ready for Testing': 'bg-purple-100 text-purple-700',
  'To Do':             'bg-gray-100 text-gray-500',
  'Blocked':           'bg-red-100 text-red-700',
  'Open':              'bg-orange-100 text-orange-700',
}

function StatusPill({ status }) {
  const cls = STATUS_COLORS[status] || 'bg-gray-100 text-gray-600'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {status || '—'}
    </span>
  )
}

function IssueLink({ issueKey, url }) {
  if (!issueKey) return <span className="text-gray-400">—</span>
  return (
    <a
      href={url || '#'}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-mono text-sm text-brand-600 hover:text-brand-800 hover:underline"
    >
      {issueKey}
      <ExternalLink size={11} />
    </a>
  )
}

function DaysPicker({ value, options, onChange }) {
  return (
    <div className="flex gap-2">
      {options.map(d => (
        <button
          key={d}
          onClick={() => onChange(d)}
          className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
            value === d
              ? 'bg-brand-600 text-white'
              : 'border border-gray-300 text-gray-600 hover:bg-gray-50'
          }`}
        >
          {d}d
        </button>
      ))}
    </div>
  )
}

function Badge({ count, color = 'gray' }) {
  const colors = {
    gray:   'bg-gray-100 text-gray-600',
    red:    'bg-red-100 text-red-700',
    orange: 'bg-orange-100 text-orange-700',
    blue:   'bg-blue-100 text-blue-700',
  }
  return (
    <span className={`ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-xs font-semibold ${colors[color]}`}>
      {count}
    </span>
  )
}

// ── Section 1: Tests Without Parent ───────────────────────────────────────────

/**
 * Single-test assign dialog — used when clicking "Assign Parent" on one row,
 * or for tests in a bulk selection that have no recommended parent.
 */
function AssignParentDialog({ testKey, recommended, onClose, onSuccess }) {
  const [parentKey, setParentKey] = useState(recommended || '')
  const [isPending, setIsPending] = useState(false)
  const [error, setError] = useState('')
  const queryClient = useQueryClient()

  const handleConfirm = async () => {
    const key = parentKey.trim().toUpperCase()
    if (!key) { setError('Parent key is required.'); return }
    setError('')
    setIsPending(true)
    try {
      await assignParent({ test_key: testKey, parent_key: key })
      queryClient.invalidateQueries(['anomaly-tests-without-parent'])
      onSuccess({ total: 1, errors: [] })
    } catch (e) {
      setError(e?.response?.data?.detail || 'Failed to assign parent.')
    } finally {
      setIsPending(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="font-semibold text-gray-900">Assign Parent to {testKey}</h3>
          <button onClick={onClose} disabled={isPending} className="text-gray-400 hover:text-gray-600 disabled:opacity-40">
            <X size={18} />
          </button>
        </div>
        <div className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Parent Issue Key (Epic / Story)
            </label>
            <input
              type="text"
              value={parentKey}
              onChange={e => setParentKey(e.target.value)}
              placeholder="e.g. TMT0-1234"
              disabled={isPending}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-gray-50"
            />
            {recommended && (
              <p className="mt-1 text-xs text-gray-500">
                Recommended: <span className="font-mono font-medium text-brand-700">{recommended}</span>
              </p>
            )}
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 px-4 pb-4">
          <button onClick={onClose} disabled={isPending} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40">
            Cancel
          </button>
          <button onClick={handleConfirm} disabled={isPending} className="px-4 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 flex items-center gap-1.5">
            <Check size={14} />
            {isPending ? 'Saving…' : 'Assign Parent'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Bulk assign dialog — each test gets its own recommended parent.
 * Shows a preview table: Test Key → Recommended Parent (editable).
 * Tests with no recommendation show an input for manual entry.
 */
function BulkAssignDialog({ assignments, onClose, onSuccess }) {
  // assignments: [{key, summary, recommended_parent_key, recommended_parent_summary}]
  const [overrides, setOverrides] = useState(
    () => Object.fromEntries(assignments.map(a => [a.key, a.recommended_parent_key || '']))
  )
  const [progress, setProgress] = useState(null)  // {done, total, statuses: {key: 'ok'|'error'|'pending'}}
  const queryClient = useQueryClient()

  const withoutParent = assignments.filter(a => !overrides[a.key]?.trim())
  const canConfirm = withoutParent.length === 0

  const isPending = progress !== null && progress.done < progress.total

  const handleConfirm = async () => {
    const statuses = Object.fromEntries(assignments.map(a => [a.key, 'pending']))
    setProgress({ done: 0, total: assignments.length, statuses })

    let done = 0
    const errors = []
    for (const a of assignments) {
      const parentKey = overrides[a.key]?.trim().toUpperCase()
      try {
        await assignParent({ test_key: a.key, parent_key: parentKey })
        statuses[a.key] = 'ok'
      } catch {
        statuses[a.key] = 'error'
        errors.push(a.key)
      }
      done++
      setProgress({ done, total: assignments.length, statuses: { ...statuses } })
    }

    queryClient.invalidateQueries(['anomaly-tests-without-parent'])
    onSuccess({ total: assignments.length, errors })
  }

  const rowStatus = (key) => {
    if (!progress) return null
    return progress.statuses[key]
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b shrink-0">
          <div>
            <h3 className="font-semibold text-gray-900">Bulk Assign Recommended Parents</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Each test will be assigned its own recommended parent. You can edit any entry before confirming.
            </p>
          </div>
          <button onClick={onClose} disabled={isPending} className="text-gray-400 hover:text-gray-600 disabled:opacity-40 ml-4">
            <X size={18} />
          </button>
        </div>

        {/* Progress bar */}
        {progress && (
          <div className="px-4 pt-3 shrink-0 space-y-1">
            <div className="flex justify-between text-xs text-gray-500">
              <span>Assigning… {progress.done}/{progress.total}</span>
              {Object.values(progress.statuses).filter(s => s === 'error').length > 0 && (
                <span className="text-red-600">
                  {Object.values(progress.statuses).filter(s => s === 'error').length} failed
                </span>
              )}
            </div>
            <div className="w-full bg-gray-100 rounded-full h-1.5">
              <div
                className="bg-brand-600 h-1.5 rounded-full transition-all duration-300"
                style={{ width: `${(progress.done / progress.total) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Table */}
        <div className="overflow-y-auto flex-1 px-4 py-3">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500 sticky top-0">
              <tr>
                <th className="px-3 py-2 text-left w-8">#</th>
                <th className="px-3 py-2 text-left">Test Key</th>
                <th className="px-3 py-2 text-left">Test Summary</th>
                <th className="px-3 py-2 text-left">Parent to Assign</th>
                <th className="px-3 py-2 w-8"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {assignments.map((a, idx) => {
                const st = rowStatus(a.key)
                const val = overrides[a.key] || ''
                const missing = !val.trim()
                return (
                  <tr key={a.key} className={
                    st === 'ok' ? 'bg-green-50' :
                    st === 'error' ? 'bg-red-50' :
                    missing ? 'bg-yellow-50' : ''
                  }>
                    <td className="px-3 py-2 text-gray-400 text-xs">{idx + 1}</td>
                    <td className="px-3 py-2 whitespace-nowrap font-mono text-brand-600 text-xs">{a.key}</td>
                    <td className="px-3 py-2 text-gray-600 max-w-[220px] truncate text-xs">{a.summary}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col gap-0.5">
                        <input
                          type="text"
                          value={val}
                          onChange={e => setOverrides(prev => ({ ...prev, [a.key]: e.target.value }))}
                          disabled={isPending}
                          placeholder="e.g. TMT0-1234"
                          className={`border rounded px-2 py-1 text-xs font-mono w-36 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-gray-50 ${
                            missing ? 'border-yellow-400 bg-yellow-50' : 'border-gray-300'
                          }`}
                        />
                        {a.recommended_parent_summary && (
                          <span className="text-xs text-gray-400 truncate max-w-[144px]">{a.recommended_parent_summary}</span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-center">
                      {st === 'ok'    && <Check size={14} className="text-green-600 mx-auto" />}
                      {st === 'error' && <X size={14} className="text-red-500 mx-auto" />}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {withoutParent.length > 0 && !progress && (
            <p className="text-xs text-yellow-700 bg-yellow-50 border border-yellow-200 rounded px-3 py-2 mt-3">
              {withoutParent.length} test{withoutParent.length > 1 ? 's' : ''} highlighted in yellow have no parent key — fill them in before confirming.
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50 shrink-0">
          <span className="text-xs text-gray-500">
            {assignments.length} tests · {assignments.filter(a => overrides[a.key]?.trim()).length} with parent assigned
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} disabled={isPending} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-100 disabled:opacity-40">
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={isPending || !canConfirm}
              className="px-4 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-700 disabled:opacity-50 flex items-center gap-1.5"
            >
              <Check size={14} />
              {isPending
                ? `Assigning ${progress.done}/${progress.total}…`
                : `Assign ${assignments.length} Tests`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function TestsWithoutParentTab() {
  const [selected, setSelected]       = useState(new Set())  // Set of test keys
  const [singleTarget, setSingleTarget] = useState(null)     // one test object for single-assign dialog
  const [bulkOpen, setBulkOpen]       = useState(false)      // bulk assign dialog
  const [successMsg, setSuccessMsg]   = useState('')

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['anomaly-tests-without-parent'],
    queryFn: () => getTestsWithoutParent(false),
    staleTime: 5 * 60 * 1000,
  })

  if (isLoading) return <PageLoader />
  if (isError) return <ErrorState message={error?.message} />

  const tests = data?.tests || []
  const allKeys = tests.map(t => t.key)
  const allSelected = allKeys.length > 0 && allKeys.every(k => selected.has(k))
  const someSelected = allKeys.some(k => selected.has(k)) && !allSelected

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(allKeys))
  }

  const toggleOne = (key) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  // Build assignment list for bulk dialog: each test keeps its own recommended parent
  const bulkAssignments = [...selected].map(k => tests.find(t => t.key === k)).filter(Boolean)

  const handleSuccess = ({ total, errors }) => {
    setSingleTarget(null)
    setBulkOpen(false)
    setSelected(new Set())
    if (errors.length === 0) {
      setSuccessMsg(`Parent assigned to ${total} test${total !== 1 ? 's' : ''} successfully.`)
    } else {
      setSuccessMsg(`Done: ${total - errors.length} assigned, ${errors.length} failed (${errors.join(', ')}).`)
    }
    setTimeout(() => setSuccessMsg(''), 6000)
  }

  const selectedCount = selected.size

  return (
    <div className="space-y-3">
      {successMsg && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-800 rounded-lg px-4 py-2 text-sm">
          <Check size={15} />
          {successMsg}
        </div>
      )}

      {/* Bulk action bar — only visible when items are selected */}
      {selectedCount > 0 && (
        <div className="flex items-center justify-between bg-brand-50 border border-brand-200 rounded-lg px-4 py-2.5">
          <span className="text-sm font-medium text-brand-800">
            {selectedCount} test{selectedCount !== 1 ? 's' : ''} selected
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs text-brand-600 hover:text-brand-800 underline"
            >
              Clear selection
            </button>
            <button
              onClick={() => setBulkOpen(true)}
              className="px-3 py-1.5 text-xs font-semibold bg-brand-600 text-white rounded-lg hover:bg-brand-700 flex items-center gap-1.5"
            >
              <Check size={13} />
              Assign Recommended Parents ({selectedCount})
            </button>
          </div>
        </div>
      )}

      {tests.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <Zap size={40} className="mx-auto mb-3 opacity-30" />
          <p className="text-base font-medium">No orphaned tests found</p>
          <p className="text-sm mt-1">All test cases have a parent assigned.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3 w-10">
                  {/* Select-all checkbox */}
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={el => { if (el) el.indeterminate = someSelected }}
                    onChange={toggleAll}
                    className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500 cursor-pointer"
                  />
                </th>
                <th className="px-4 py-3 text-left">Test Key</th>
                <th className="px-4 py-3 text-left">Summary</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-left">Linked Story</th>
                <th className="px-4 py-3 text-left">Recommended Parent</th>
                <th className="px-4 py-3 text-left">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 bg-white">
              {tests.map(t => {
                const isChecked = selected.has(t.key)
                return (
                  <tr
                    key={t.key}
                    className={`hover:bg-gray-50 transition-colors ${isChecked ? 'bg-brand-50/40' : ''}`}
                    onClick={() => toggleOne(t.key)}
                    style={{ cursor: 'pointer' }}
                  >
                    <td className="px-4 py-3 w-10" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleOne(t.key)}
                        className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500 cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap" onClick={e => e.stopPropagation()}>
                      <IssueLink issueKey={t.key} url={t.url} />
                    </td>
                    <td className="px-4 py-3 text-gray-700 max-w-xs truncate">{t.summary}</td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <StatusPill status={t.status} />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap" onClick={e => e.stopPropagation()}>
                      {t.linked_story_key ? (
                        <div>
                          <IssueLink issueKey={t.linked_story_key} url={`/browse/${t.linked_story_key}`} />
                          {t.linked_story_summary && (
                            <p className="text-xs text-gray-400 mt-0.5 truncate max-w-[160px]">{t.linked_story_summary}</p>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-400 text-xs">No linked story</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {t.recommended_parent_key ? (
                        <div>
                          <span className="font-mono text-sm text-orange-600 font-medium">{t.recommended_parent_key}</span>
                          {t.recommended_parent_summary && (
                            <p className="text-xs text-gray-400 mt-0.5 truncate max-w-[160px]">{t.recommended_parent_summary}</p>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-400 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap" onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => setSingleTarget(t)}
                        className="px-3 py-1 text-xs font-medium bg-brand-50 text-brand-700 border border-brand-200 rounded-lg hover:bg-brand-100 transition-colors"
                      >
                        Assign Parent
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {singleTarget && (
        <AssignParentDialog
          testKey={singleTarget.key}
          recommended={singleTarget.recommended_parent_key}
          onClose={() => setSingleTarget(null)}
          onSuccess={handleSuccess}
        />
      )}

      {bulkOpen && (
        <BulkAssignDialog
          assignments={bulkAssignments}
          onClose={() => setBulkOpen(false)}
          onSuccess={handleSuccess}
        />
      )}
    </div>
  )
}

// ── Section 2: Incomplete Bugs ─────────────────────────────────────────────────

function BugTable({ bugs, emptyMsg }) {
  if (!bugs || bugs.length === 0) {
    return <p className="text-sm text-gray-400 italic py-3">{emptyMsg}</p>
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="min-w-full text-sm">
        <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-3 py-2 text-left whitespace-nowrap">Key</th>
            <th className="px-3 py-2 text-left">Summary</th>
            <th className="px-3 py-2 text-left whitespace-nowrap">Status</th>
            <th className="px-3 py-2 text-left whitespace-nowrap">Priority</th>
            <th className="px-3 py-2 text-left whitespace-nowrap">Parent</th>
            <th className="px-3 py-2 text-left">Labels</th>
            <th className="px-3 py-2 text-left whitespace-nowrap">Created</th>
            <th className="px-3 py-2 text-left whitespace-nowrap">Found In Version</th>
            <th className="px-3 py-2 text-left">Product / Component</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 bg-white">
          {bugs.map(b => (
            <tr key={b.key} className="hover:bg-gray-50">
              <td className="px-3 py-2 whitespace-nowrap">
                <IssueLink issueKey={b.key} url={b.url} />
              </td>
              <td className="px-3 py-2 text-gray-700 max-w-[220px] truncate">{b.summary}</td>
              <td className="px-3 py-2 whitespace-nowrap"><StatusPill status={b.status} /></td>
              <td className="px-3 py-2 whitespace-nowrap text-gray-600 text-xs">{b.priority || '—'}</td>
              <td className="px-3 py-2 whitespace-nowrap">
                {b.parent_key
                  ? <div>
                      <IssueLink issueKey={b.parent_key} url={`/browse/${b.parent_key}`} />
                      {b.parent_summary && (
                        <p className="text-xs text-gray-400 truncate max-w-[140px]">{b.parent_summary}</p>
                      )}
                    </div>
                  : <span className="text-gray-300 text-xs">—</span>}
              </td>
              <td className="px-3 py-2">
                {b.labels && b.labels.length > 0
                  ? <div className="flex flex-wrap gap-1">
                      {b.labels.map(l => (
                        <span key={l} className="inline-block bg-gray-100 text-gray-600 text-xs px-1.5 py-0.5 rounded">{l}</span>
                      ))}
                    </div>
                  : <span className="text-gray-300 text-xs">—</span>}
              </td>
              <td className="px-3 py-2 whitespace-nowrap text-xs text-gray-500">{b.created || '—'}</td>
              <td className="px-3 py-2">
                {b.found_in_versions && b.found_in_versions.length > 0
                  ? <div className="flex flex-wrap gap-1">
                      {b.found_in_versions.map(v => (
                        <span key={v} className="inline-block bg-blue-50 text-blue-700 text-xs px-1.5 py-0.5 rounded">{v}</span>
                      ))}
                    </div>
                  : <span className="text-gray-300 text-xs">—</span>}
              </td>
              <td className="px-3 py-2">
                {b.components && b.components.length > 0
                  ? <div className="flex flex-wrap gap-1">
                      {b.components.map(c => (
                        <span key={c} className="inline-block bg-purple-50 text-purple-700 text-xs px-1.5 py-0.5 rounded">{c}</span>
                      ))}
                    </div>
                  : <span className="text-gray-300 text-xs">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SubSection({ title, bugs, color }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold text-gray-800">{title}</h3>
        <Badge count={bugs?.length ?? 0} color={color} />
      </div>
      <BugTable bugs={bugs} emptyMsg={`No bugs missing ${title.toLowerCase()} in this window.`} />
    </div>
  )
}

function IncompleteBugsTab() {
  const [days, setDays] = useState(30)

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['anomaly-incomplete-bugs', days],
    queryFn: () => getIncompleteBugs(days, false),
    staleTime: 5 * 60 * 1000,
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          Bugs created in the last <strong>{days} days</strong> that are missing required fields.
        </p>
        <DaysPicker value={days} options={[8, 30, 60]} onChange={setDays} />
      </div>

      {isLoading && <PageLoader />}
      {isError && <ErrorState message={error?.message} />}

      {data && (
        <>
          <div className="text-xs text-gray-400">
            {data.total_bugs_fetched} bugs fetched · a bug may appear in multiple groups
          </div>
          <div className="space-y-8">
            <SubSection title="No Fix Version" bugs={data.no_fix_version} color="red" />
            <SubSection title="No Parent" bugs={data.no_parent} color="orange" />
            <SubSection title="No Sprint" bugs={data.no_sprint} color="blue" />
          </div>
        </>
      )}
    </div>
  )
}

// ── Section 3: Duplicate Bugs ──────────────────────────────────────────────────

function DuplicateBugsTab() {
  const [days, setDays] = useState(60)
  const [expanded, setExpanded] = useState(new Set())

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['anomaly-duplicate-bugs', days],
    queryFn: () => getDuplicateBugs(days, false),
    staleTime: 5 * 60 * 1000,
  })

  const toggleCluster = (idx) => {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(idx) ? next.delete(idx) : next.add(idx)
      return next
    })
  }

  const simColor = (score) => {
    if (score >= 90) return 'bg-red-100 text-red-700'
    if (score >= 75) return 'bg-orange-100 text-orange-700'
    return 'bg-yellow-100 text-yellow-700'
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          Bugs created in the last <strong>{days} days</strong> with similar summaries (
          similarity &gt; 60%).
        </p>
        <DaysPicker value={days} options={[30, 60, 90]} onChange={setDays} />
      </div>

      {isLoading && <PageLoader />}
      {isError && <ErrorState message={error?.message} />}

      {data && (
        <>
          {data.total_clusters === 0 ? (
            <div className="text-center py-16 text-gray-400">
              <AlertCircle size={40} className="mx-auto mb-3 opacity-30" />
              <p className="text-base font-medium">No duplicate clusters detected</p>
              <p className="text-sm mt-1">No similar bug pairs found in the last {days} days.</p>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-gray-400">
                {data.total_clusters} cluster{data.total_clusters !== 1 ? 's' : ''} found
              </p>
              {data.clusters.map((cluster, idx) => {
                const isOpen = expanded.has(idx)
                return (
                  <div key={idx} className="border border-gray-200 rounded-lg overflow-hidden">
                    <button
                      onClick={() => toggleCluster(idx)}
                      className="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
                    >
                      <div className="flex items-center gap-3">
                        <AlertCircle size={16} className="text-orange-500 shrink-0" />
                        <span className="font-medium text-gray-800 text-sm">
                          Cluster {idx + 1} — {cluster.bugs.length} potential duplicate{cluster.bugs.length !== 1 ? 's' : ''}
                        </span>
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${simColor(cluster.max_similarity)}`}>
                          {cluster.max_similarity}% similar
                        </span>
                      </div>
                      {isOpen ? <ChevronDown size={16} className="text-gray-400" /> : <ChevronRight size={16} className="text-gray-400" />}
                    </button>

                    {isOpen && (
                      <div className="overflow-x-auto">
                        <table className="min-w-full text-sm">
                          <thead className="bg-white border-b border-gray-100 text-xs uppercase tracking-wide text-gray-500">
                            <tr>
                              <th className="px-4 py-2 text-left">Key</th>
                              <th className="px-4 py-2 text-left">Summary</th>
                              <th className="px-4 py-2 text-left">Status</th>
                              <th className="px-4 py-2 text-left">Priority</th>
                              <th className="px-4 py-2 text-left">Created</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100 bg-white">
                            {cluster.bugs.map(b => (
                              <tr key={b.key} className="hover:bg-gray-50">
                                <td className="px-4 py-2 whitespace-nowrap">
                                  <IssueLink issueKey={b.key} url={b.url} />
                                </td>
                                <td className="px-4 py-2 text-gray-700 max-w-sm truncate">{b.summary}</td>
                                <td className="px-4 py-2 whitespace-nowrap"><StatusPill status={b.status} /></td>
                                <td className="px-4 py-2 whitespace-nowrap text-gray-600">{b.priority || '—'}</td>
                                <td className="px-4 py-2 whitespace-nowrap text-gray-500 text-xs">
                                  {b.created ? b.created.slice(0, 10) : '—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function AnomalyPage() {
  const [activeTab, setActiveTab] = useState(TABS[0])
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [lastRefresh, setLastRefresh] = useState(null)
  const queryClient = useQueryClient()

  const { data: testsData } = useQuery({
    queryKey: ['anomaly-tests-without-parent'],
    queryFn: () => getTestsWithoutParent(false),
    staleTime: 5 * 60 * 1000,
  })
  const { data: bugsData } = useQuery({
    queryKey: ['anomaly-incomplete-bugs', 30],
    queryFn: () => getIncompleteBugs(30, false),
    staleTime: 5 * 60 * 1000,
  })
  const { data: dupData } = useQuery({
    queryKey: ['anomaly-duplicate-bugs', 60],
    queryFn: () => getDuplicateBugs(60, false),
    staleTime: 5 * 60 * 1000,
  })

  useAutoRefresh([
    ['anomaly-tests-without-parent'],
    ['anomaly-incomplete-bugs', 30],
    ['anomaly-duplicate-bugs', 60],
  ])

  const tabCounts = {
    'Tests Without Parent': testsData?.total ?? null,
    'Incomplete Bugs': bugsData
      ? (bugsData.no_fix_version?.length ?? 0) +
        (bugsData.no_parent?.length ?? 0) +
        (bugsData.no_sprint?.length ?? 0)
      : null,
    'Duplicate Bugs': dupData?.total_clusters ?? null,
  }

  const tabColors = {
    'Tests Without Parent': 'orange',
    'Incomplete Bugs': 'red',
    'Duplicate Bugs': 'orange',
  }

  const handleRefresh = async () => {
    setIsRefreshing(true)
    await Promise.allSettled([
      queryClient.invalidateQueries({ queryKey: ['anomaly-tests-without-parent'] }),
      queryClient.invalidateQueries({ queryKey: ['anomaly-incomplete-bugs'] }),
      queryClient.invalidateQueries({ queryKey: ['anomaly-duplicate-bugs'] }),
    ])
    setLastRefresh(new Date())
    setIsRefreshing(false)
  }

  return (
    <div className="flex flex-col h-full">
      <Header
        title="Anomalies"
        lastRefresh={lastRefresh}
        isRefreshing={isRefreshing}
        onRefresh={handleRefresh}
      />

      <div className="flex-1 overflow-auto p-6 space-y-6">
        {/* Tab bar */}
        <div className="flex border-b border-gray-200">
          {TABS.map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex items-center px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
                activeTab === tab
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab}
              {tabCounts[tab] !== null && tabCounts[tab] !== undefined && (
                <Badge
                  count={tabCounts[tab]}
                  color={tabCounts[tab] > 0 ? tabColors[tab] : 'gray'}
                />
              )}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div>
          {activeTab === 'Tests Without Parent' && <TestsWithoutParentTab />}
          {activeTab === 'Incomplete Bugs'       && <IncompleteBugsTab />}
          {activeTab === 'Duplicate Bugs'        && <DuplicateBugsTab />}
        </div>
      </div>
    </div>
  )
}

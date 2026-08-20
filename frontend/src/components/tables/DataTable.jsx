import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ChevronUp, ChevronDown, ExternalLink, Loader2, User, Filter } from 'lucide-react'
import { AgingBadge, PriorityBadge, Badge } from '../common/Badge'
import { getIssueTransitions, transitionIssue, getTeamMembers, reassignQaOwner, setQaEstimate } from '../../services/api'
import { format, parseISO } from 'date-fns'

// Team roster rarely changes and is shared by every row's dropdown — fetch once per session.
let teamMembersPromise = null
function loadTeamMembers() {
  if (!teamMembersPromise) teamMembersPromise = getTeamMembers().catch(e => { teamMembersPromise = null; throw e })
  return teamMembersPromise
}

function fmtDate(str) {
  if (!str) return '—'
  try { return format(parseISO(str), 'MMM d, yyyy') }
  catch { return str }
}

const ISSUE_TYPE_COLORS = {
  'Bug':         'bg-red-100 text-red-700',
  'Story':       'bg-green-100 text-green-700',
  'Task':        'bg-blue-100 text-blue-700',
  'Sub-task':    'bg-gray-100 text-gray-600',
  'Epic':        'bg-purple-100 text-purple-700',
  'Improvement': 'bg-teal-100 text-teal-700',
}

const STATUS_COLORS = {
  'To Do':                 'bg-gray-100 text-gray-700',
  'ToDo':                  'bg-gray-100 text-gray-700',
  'Open':                  'bg-gray-100 text-gray-700',
  'In Progress':           'bg-blue-100 text-blue-700',
  'In Review':             'bg-indigo-100 text-indigo-700',
  'Ready for Testing':     'bg-purple-100 text-purple-700',
  'Validation':            'bg-violet-100 text-violet-700',
  'Ready For Deployment':  'bg-teal-100 text-teal-700',
  'Monitoring':            'bg-cyan-100 text-cyan-700',
  'Done':                  'bg-green-100 text-green-700',
  'DONE':                  'bg-green-100 text-green-700',
  'Reopened':              'bg-orange-100 text-orange-700',
  'Known Issue':           'bg-yellow-100 text-yellow-700',
  'Blocked':               'bg-red-100 text-red-700',
  'Removed':               'bg-gray-100 text-gray-400',
}

function IssueTypeBadge({ type }) {
  if (!type) return <span className="text-gray-400 text-xs">—</span>
  const cls = ISSUE_TYPE_COLORS[type] || 'bg-gray-100 text-gray-600'
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{type}</span>
}

function StatusBadge({ status }) {
  if (!status) return <span className="text-gray-400 text-xs">—</span>
  const cls = STATUS_COLORS[status] || 'bg-gray-100 text-gray-600'
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{status}</span>
}

function StatusCell({ issue, editable, onChanged }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const [transitions, setTransitions] = useState(null)
  const [loadingTransitions, setLoadingTransitions] = useState(false)
  const [applying, setApplying] = useState(null)
  const [error, setError] = useState(null)
  const triggerRef = useRef(null)
  const dropdownRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const h = (e) => {
      if (triggerRef.current?.contains(e.target) || dropdownRef.current?.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  if (!editable) return <StatusBadge status={issue.status} />

  const openDropdown = async () => {
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 4, left: r.left })
    setOpen(true)
    setError(null)
    if (!transitions) {
      setLoadingTransitions(true)
      try {
        const res = await getIssueTransitions(issue.key)
        setTransitions(res.transitions || [])
      } catch (e) {
        setError(e.message || 'Failed to load transitions')
      } finally {
        setLoadingTransitions(false)
      }
    }
  }

  const pick = async (t) => {
    setApplying(t.id)
    setError(null)
    try {
      await transitionIssue(issue.key, t.id)
      setOpen(false)
      onChanged?.(issue.key, t.to_status)
    } catch (e) {
      setError(e.message || 'Transition failed')
    } finally {
      setApplying(null)
    }
  }

  return (
    <>
      <button ref={triggerRef} type="button" onClick={openDropdown} className="cursor-pointer">
        <StatusBadge status={issue.status} />
      </button>
      {open && pos && createPortal(
        <div ref={dropdownRef}
          className="fixed z-[9999] bg-white border border-gray-200 rounded-lg shadow-2xl min-w-[180px] max-h-72 overflow-y-auto"
          style={{ top: pos.top, left: pos.left }}>
          {loadingTransitions && (
            <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-gray-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading transitions…
            </div>
          )}
          {!loadingTransitions && transitions?.length === 0 && (
            <div className="px-3 py-2.5 text-xs text-gray-400">No transitions available.</div>
          )}
          {!loadingTransitions && transitions?.map(t => (
            <div key={t.id}
              onMouseDown={() => pick(t)}
              className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50 cursor-pointer">
              <span>{t.name}</span>
              {applying === t.id && <Loader2 className="h-3 w-3 animate-spin text-gray-400" />}
            </div>
          ))}
          {error && <div className="px-3 py-2 text-xs text-red-600 border-t border-gray-100">{error}</div>}
        </div>,
        document.body
      )}
    </>
  )
}

function QaOwnerCell({ issue, editable, onChanged }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const [members, setMembers] = useState(null)
  const [loadingMembers, setLoadingMembers] = useState(false)
  const [applying, setApplying] = useState(null)
  const [error, setError] = useState(null)
  const triggerRef = useRef(null)
  const dropdownRef = useRef(null)

  const currentName = issue.qa_owner?.display_name || issue.assignee?.display_name || '—'

  useEffect(() => {
    if (!open) return
    const h = (e) => {
      if (triggerRef.current?.contains(e.target) || dropdownRef.current?.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  if (!editable) return <span className="text-gray-600 text-xs">{currentName}</span>

  const openDropdown = async () => {
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 4, left: r.left })
    setOpen(true)
    setError(null)
    if (!members) {
      setLoadingMembers(true)
      try {
        setMembers(await loadTeamMembers())
      } catch (e) {
        setError(e.message || 'Failed to load team members')
      } finally {
        setLoadingMembers(false)
      }
    }
  }

  const pick = async (member) => {
    const id = member?.id || null
    setApplying(id || 'unassign')
    setError(null)
    try {
      await reassignQaOwner(issue.key, id)
      setOpen(false)
      onChanged?.(issue.key, member)
    } catch (e) {
      setError(e.message || 'Reassign failed')
    } finally {
      setApplying(null)
    }
  }

  return (
    <>
      <button ref={triggerRef} type="button" onClick={openDropdown}
        className="inline-flex items-center gap-1 text-gray-600 text-xs hover:text-brand-600 cursor-pointer">
        <User className="h-3 w-3 text-gray-400" />{currentName}
      </button>
      {open && pos && createPortal(
        <div ref={dropdownRef}
          className="fixed z-[9999] bg-white border border-gray-200 rounded-lg shadow-2xl min-w-[200px] max-h-72 overflow-y-auto"
          style={{ top: pos.top, left: pos.left }}>
          {loadingMembers && (
            <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-gray-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading team…
            </div>
          )}
          {!loadingMembers && (
            <div onMouseDown={() => pick(null)}
              className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-gray-400 hover:bg-gray-50 cursor-pointer border-b border-gray-100">
              <span>— Unassign —</span>
              {applying === 'unassign' && <Loader2 className="h-3 w-3 animate-spin text-gray-400" />}
            </div>
          )}
          {!loadingMembers && members?.map(m => (
            <div key={m.id}
              onMouseDown={() => pick(m)}
              className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50 cursor-pointer">
              <span>{m.name}</span>
              {applying === m.id && <Loader2 className="h-3 w-3 animate-spin text-gray-400" />}
            </div>
          ))}
          {error && <div className="px-3 py-2 text-xs text-red-600 border-t border-gray-100">{error}</div>}
        </div>,
        document.body
      )}
    </>
  )
}

function ColumnFilter({ options, selected, onChange }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const triggerRef = useRef(null)
  const dropdownRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const h = (e) => {
      if (triggerRef.current?.contains(e.target) || dropdownRef.current?.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const isActive = selected.size > 0
  const toggle = (val) => {
    const next = new Set(selected)
    if (next.has(val)) next.delete(val); else next.add(val)
    onChange(next)
  }

  return (
    <>
      <button ref={triggerRef} type="button"
        onClick={(e) => {
          e.stopPropagation()
          const r = triggerRef.current?.getBoundingClientRect()
          if (r) setPos({ top: r.bottom + 4, left: r.left })
          setOpen(o => !o)
        }}
        className={`p-0.5 rounded hover:bg-gray-200 ${isActive ? 'text-brand-600' : 'text-gray-300'}`}>
        <Filter className="h-3 w-3" />
      </button>
      {open && pos && createPortal(
        <div ref={dropdownRef} onClick={e => e.stopPropagation()}
          className="fixed z-[9999] bg-white border border-gray-200 rounded-lg shadow-2xl min-w-[170px] max-h-64 overflow-y-auto py-1 normal-case"
          style={{ top: pos.top, left: pos.left }}>
          {isActive && (
            <div onMouseDown={() => onChange(new Set())}
              className="px-3 py-1.5 text-xs text-brand-600 hover:bg-gray-50 cursor-pointer border-b border-gray-100 font-medium">
              Clear filter
            </div>
          )}
          {options.map(opt => (
            <label key={opt} onMouseDown={(e) => e.preventDefault()}
              className="flex items-center gap-2 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 cursor-pointer font-normal">
              <input type="checkbox" className="h-3 w-3 text-blue-600 rounded"
                checked={selected.has(opt)} onChange={() => toggle(opt)} />
              {opt}
            </label>
          ))}
          {options.length === 0 && <div className="px-3 py-1.5 text-xs text-gray-400">No values</div>}
        </div>,
        document.body
      )}
    </>
  )
}

function QaEstimateCell({ issue, editable, onChanged }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const [customValue, setCustomValue] = useState('')
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState(null)
  const triggerRef = useRef(null)
  const dropdownRef = useRef(null)

  const PRESETS = [0.5, 1, 5, 8]
  const value = issue.qa_estimate_hours
  const display = value != null ? `${value}h` : '—'

  useEffect(() => {
    if (!open) return
    const h = (e) => {
      if (triggerRef.current?.contains(e.target) || dropdownRef.current?.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  if (!editable) return <span className="text-gray-600 text-xs">{display}</span>

  const openDropdown = () => {
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 4, left: r.left })
    setOpen(true); setError(null); setCustomValue('')
  }

  const apply = async (hours) => {
    setApplying(true); setError(null)
    try {
      await setQaEstimate(issue.key, hours)
      setOpen(false)
      onChanged?.(issue.key, hours)
    } catch (e) {
      setError(e.message || 'Failed to update estimate')
    } finally {
      setApplying(false)
    }
  }

  const submitCustom = (e) => {
    e.preventDefault()
    const n = parseFloat(customValue)
    if (!isNaN(n) && n >= 0) apply(n)
  }

  return (
    <>
      <button ref={triggerRef} type="button" onClick={openDropdown}
        className="text-gray-600 text-xs hover:text-brand-600 cursor-pointer">
        {display}
      </button>
      {open && pos && createPortal(
        <div ref={dropdownRef}
          className="fixed z-[9999] bg-white border border-gray-200 rounded-lg shadow-2xl min-w-[170px]"
          style={{ top: pos.top, left: pos.left }}>
          {PRESETS.map(p => (
            <div key={p} onMouseDown={() => apply(p)}
              className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50 cursor-pointer">
              <span>{p}h</span>
              {applying && <Loader2 className="h-3 w-3 animate-spin text-gray-400" />}
            </div>
          ))}
          <form onSubmit={submitCustom} onMouseDown={(e) => e.stopPropagation()}
            className="flex items-center gap-1.5 px-3 py-2 border-t border-gray-100">
            <span className="text-xs text-gray-400 shrink-0">Other:</span>
            <input type="number" step="0.25" min="0" value={customValue}
              onChange={e => setCustomValue(e.target.value)}
              className="w-16 text-xs border border-gray-200 rounded px-1.5 py-1 focus:outline-none focus:border-blue-400"
              placeholder="hrs" />
            <button type="submit" disabled={!customValue}
              className="text-xs text-brand-600 font-medium px-1.5 hover:underline disabled:opacity-40 disabled:no-underline">
              Set
            </button>
          </form>
          <div onMouseDown={() => apply(null)}
            className="px-3 py-2 text-xs text-gray-400 hover:bg-gray-50 cursor-pointer border-t border-gray-100">
            — Use default —
          </div>
          {error && <div className="px-3 py-2 text-xs text-red-600 border-t border-gray-100">{error}</div>}
        </div>,
        document.body
      )}
    </>
  )
}

function SortIcon({ field, sortField, sortDir }) {
  if (sortField !== field) return <ChevronUp className="h-3 w-3 text-gray-300" />
  return sortDir === 'asc'
    ? <ChevronUp className="h-3 w-3 text-brand-600" />
    : <ChevronDown className="h-3 w-3 text-brand-600" />
}

export function IssueTable({
  issues = [], loading = false, compact = false,
  editableStatus = false, onStatusChanged,
  editableQaOwner = false, onQaOwnerChanged,
  editableQaEstimate = false, onQaEstimateChanged,
}) {
  const [sortField, setSortField] = useState('days_in_status')
  const [sortDir, setSortDir] = useState('desc')
  const [page, setPage] = useState(1)
  const [typeFilter, setTypeFilter] = useState(new Set())
  const [statusFilter, setStatusFilter] = useState(new Set())
  const pageSize = compact ? 10 : 25

  const toggleSort = (field) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(field); setSortDir('desc') }
    setPage(1)
  }

  const typeOptions = [...new Set(issues.map(i => i.issue_type).filter(Boolean))].sort()
  const statusOptions = [...new Set(issues.map(i => i.status).filter(Boolean))].sort()

  const applyTypeFilter = (next) => { setTypeFilter(next); setPage(1) }
  const applyStatusFilter = (next) => { setStatusFilter(next); setPage(1) }

  const filtered = issues.filter(i =>
    (typeFilter.size === 0 || typeFilter.has(i.issue_type)) &&
    (statusFilter.size === 0 || statusFilter.has(i.status))
  )

  const sorted = [...filtered].sort((a, b) => {
    let av = a[sortField], bv = b[sortField]
    if (typeof av === 'string') av = av.toLowerCase()
    if (typeof bv === 'string') bv = bv.toLowerCase()
    if (av == null) return 1
    if (bv == null) return -1
    if (av < bv) return sortDir === 'asc' ? -1 : 1
    if (av > bv) return sortDir === 'asc' ? 1 : -1
    return 0
  })

  const totalPages = Math.ceil(sorted.length / pageSize)
  const paged = sorted.slice((page - 1) * pageSize, page * pageSize)

  const col = (label, field, filterConfig) => (
    <th className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide select-none whitespace-nowrap">
      <span className="inline-flex items-center gap-1">
        <span className="inline-flex items-center gap-1 cursor-pointer hover:text-gray-800" onClick={() => toggleSort(field)}>
          {label}
          <SortIcon field={field} sortField={sortField} sortDir={sortDir} />
        </span>
        {filterConfig && (
          <ColumnFilter options={filterConfig.options} selected={filterConfig.selected} onChange={filterConfig.onChange} />
        )}
      </span>
    </th>
  )

  if (loading) return (
    <div className="text-center py-8 text-gray-400 text-sm">Loading issues...</div>
  )

  if (!issues.length) return (
    <div className="text-center py-8 text-gray-400 text-sm">No issues found.</div>
  )

  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              {col('Key', 'key')}
              {col('Summary', 'summary')}
              {col('Type', 'issue_type', { options: typeOptions, selected: typeFilter, onChange: applyTypeFilter })}
              {col('Status', 'status', { options: statusOptions, selected: statusFilter, onChange: applyStatusFilter })}
              {col('QA Owner', 'qa_owner')}
              {col('Priority', 'priority')}
              {col('QA Est.', 'qa_estimate_hours')}
              {col('Version', 'fix_versions')}
              {col('Bundle', 'bundle')}
              {col('Activity', 'activity')}
              {col('Aging', 'days_in_status')}
              {col('Updated', 'updated')}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {paged.map((issue) => (
              <tr
                key={issue.key}
                className={`hover:bg-gray-50 transition-colors ${
                  issue.aging_level === 'overdue' ? 'bg-red-50/30' :
                  issue.aging_level === 'critical' ? 'bg-orange-50/20' : ''
                }`}
              >
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <a
                    href={issue.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-brand-600 font-mono font-medium hover:underline text-xs"
                  >
                    {issue.key}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </td>
                <td className="px-3 py-2.5 max-w-xs">
                  <span className="line-clamp-2 text-gray-800">{issue.summary}</span>
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <IssueTypeBadge type={issue.issue_type} />
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <StatusCell issue={issue} editable={editableStatus} onChanged={onStatusChanged} />
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap text-gray-600 text-xs">
                  <QaOwnerCell issue={issue} editable={editableQaOwner} onChanged={onQaOwnerChanged} />
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <PriorityBadge priority={issue.priority} />
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <QaEstimateCell issue={issue} editable={editableQaEstimate} onChanged={onQaEstimateChanged} />
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap text-gray-500 text-xs">
                  {issue.fix_versions?.map(v => v.name).join(', ') || '—'}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap text-gray-500 text-xs max-w-[120px] truncate">
                  {issue.epic_name || issue.bundle || '—'}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  {issue.activity
                    ? <Badge label={issue.activity} variant="default" />
                    : <span className="text-gray-400 text-xs">—</span>
                  }
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <AgingBadge level={issue.aging_level} days={issue.days_in_status} />
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap text-gray-400 text-xs">
                  {fmtDate(issue.updated)}
                </td>
              </tr>
            ))}
            {sorted.length === 0 && (
              <tr><td colSpan={12} className="text-center py-8 text-gray-400 text-sm">No issues match the current filter.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {(totalPages > 1 || sorted.length !== issues.length) && (
        <div className="flex items-center justify-between mt-3 text-xs text-gray-500">
          <span>
            {sorted.length !== issues.length ? `${sorted.length} of ${issues.length} items (filtered)` : `${issues.length} total items`}
          </span>
          {totalPages > 1 && (
            <div className="flex items-center gap-2">
              <button
                className="btn-secondary py-1 px-2 text-xs disabled:opacity-40"
                disabled={page === 1}
                onClick={() => setPage(p => p - 1)}
              >← Prev</button>
              <span>Page {page} of {totalPages}</span>
              <button
                className="btn-secondary py-1 px-2 text-xs disabled:opacity-40"
                disabled={page === totalPages}
                onClick={() => setPage(p => p + 1)}
              >Next →</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

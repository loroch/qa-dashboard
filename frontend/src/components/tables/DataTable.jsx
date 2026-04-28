import { useState } from 'react'
import { ChevronUp, ChevronDown, ExternalLink } from 'lucide-react'
import { AgingBadge, PriorityBadge, Badge } from '../common/Badge'
import { format, parseISO } from 'date-fns'

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

function SortIcon({ field, sortField, sortDir }) {
  if (sortField !== field) return <ChevronUp className="h-3 w-3 text-gray-300" />
  return sortDir === 'asc'
    ? <ChevronUp className="h-3 w-3 text-brand-600" />
    : <ChevronDown className="h-3 w-3 text-brand-600" />
}

export function IssueTable({ issues = [], loading = false, compact = false }) {
  const [sortField, setSortField] = useState('days_in_status')
  const [sortDir, setSortDir] = useState('desc')
  const [page, setPage] = useState(1)
  const pageSize = compact ? 10 : 25

  const toggleSort = (field) => {
    if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(field); setSortDir('desc') }
    setPage(1)
  }

  const sorted = [...issues].sort((a, b) => {
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

  const col = (label, field) => (
    <th
      className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide cursor-pointer hover:text-gray-800 select-none whitespace-nowrap"
      onClick={() => toggleSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <SortIcon field={field} sortField={sortField} sortDir={sortDir} />
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
              {col('Type', 'issue_type')}
              {col('Status', 'status')}
              {col('QA Owner', 'qa_owner')}
              {col('Priority', 'priority')}
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
                  <StatusBadge status={issue.status} />
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap text-gray-600 text-xs">
                  {issue.qa_owner?.display_name || issue.assignee?.display_name || '—'}
                </td>
                <td className="px-3 py-2.5 whitespace-nowrap">
                  <PriorityBadge priority={issue.priority} />
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
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 text-xs text-gray-500">
          <span>{issues.length} total items</span>
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
        </div>
      )}
    </div>
  )
}

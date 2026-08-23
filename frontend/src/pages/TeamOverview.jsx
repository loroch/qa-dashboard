import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { getDashboard, BASE_URL } from '../services/api'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { Header } from '../components/layout/Header'
import { PageLoader, ErrorState } from '../components/common/LoadingSpinner'
import { Badge, AgingBadge } from '../components/common/Badge'
import { Users, ExternalLink, Loader2, Bug, ClipboardList, ChevronDown, ChevronUp } from 'lucide-react'
import { format, parseISO } from 'date-fns'

const STATUS_CLS = {
  'To Do':             'bg-gray-100 text-gray-600',
  'Open':              'bg-gray-100 text-gray-600',
  'In Progress':       'bg-blue-100 text-blue-700',
  'In Review':         'bg-indigo-100 text-indigo-700',
  'Ready for Testing': 'bg-purple-100 text-purple-700',
  'Done':              'bg-green-100 text-green-700',
  'DONE':              'bg-green-100 text-green-700',
  'Reopened':          'bg-orange-100 text-orange-700',
  'Blocked':           'bg-red-100 text-red-700',
  'Known Issue':       'bg-yellow-100 text-yellow-700',
}

const TYPE_CLS = {
  Bug:     'bg-red-100 text-red-700',
  Story:   'bg-green-100 text-green-700',
  Task:    'bg-blue-100 text-blue-700',
  'Test Case': 'bg-teal-100 text-teal-700',
  'Test Set':  'bg-cyan-100 text-cyan-700',
  Epic:    'bg-purple-100 text-purple-700',
}

const PRIORITY_CLS = {
  Highest: 'text-red-700 font-bold',
  High:    'text-red-500 font-semibold',
  Medium:  'text-amber-600',
  Low:     'text-blue-400',
  Lowest:  'text-slate-400',
}

const ROLE_CLS = {
  'QA Engineer': 'text-gray-500',
  'Mexico QA':   'text-emerald-600 font-semibold',
}

function fmtDate(s) {
  if (!s) return '—'
  try { return format(parseISO(s), 'MMM d') } catch { return s }
}

function StatusBadge({ status }) {
  const cls = STATUS_CLS[status] || 'bg-gray-100 text-gray-600'
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${cls}`}>{status || '—'}</span>
}

function TypeBadge({ type }) {
  const cls = TYPE_CLS[type] || 'bg-gray-100 text-gray-600'
  return <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${cls}`}>{type || '?'}</span>
}

/* ── Member Work Table ─────────────────────────────────────── */
function MemberWorkTable({ memberId, memberName, days, onDaysChange }) {
  const [statusFilter, setStatusFilter] = useState('')
  const [sortField, setSortField]       = useState('updated')
  const [sortDir, setSortDir]           = useState('desc')

  const { data, isFetching, error } = useQuery({
    queryKey: ['member-work', memberId, days],
    queryFn: ({ signal }) =>
      axios.get(`${BASE_URL}/dashboard/member-work`, { params: { member_id: memberId, days }, signal })
           .then(r => r.data.issues),
    enabled: !!memberId,
    staleTime: 120_000,
  })

  const issues = data || []
  const statuses = [...new Set(issues.map(i => i.status).filter(Boolean))].sort()

  const visible = (statusFilter ? issues.filter(i => i.status === statusFilter) : issues)
    .slice()
    .sort((a, b) => {
      let av = a[sortField] ?? '', bv = b[sortField] ?? ''
      if (typeof av === 'string') av = av.toLowerCase()
      if (typeof bv === 'string') bv = bv.toLowerCase()
      return sortDir === 'asc' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1)
    })

  const toggleSort = (f) => {
    if (sortField === f) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortField(f); setSortDir('desc') }
  }

  const SortIcon = ({ field }) => {
    if (sortField !== field) return <ChevronUp className="h-3 w-3 text-gray-300 inline" />
    return sortDir === 'asc'
      ? <ChevronUp className="h-3 w-3 text-brand-600 inline" />
      : <ChevronDown className="h-3 w-3 text-brand-600 inline" />
  }

  return (
    <div className="card mt-6">
      {/* Panel header */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <Users className="h-5 w-5 text-brand-600 shrink-0" />
        <h2 className="font-semibold text-gray-800">{memberName} — Work</h2>
        {isFetching
          ? <Loader2 className="h-4 w-4 animate-spin text-brand-400" />
          : <span className="text-xs text-gray-400 bg-gray-100 rounded-full px-2 py-0.5">{issues.length} items</span>
        }

        {/* Days selector */}
        <div className="flex items-center gap-1 ml-2">
          {[14, 30, 60, 90].map(d => (
            <button key={d} onClick={() => onDaysChange(d)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                days === d ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}>
              {d}d
            </button>
          ))}
        </div>

        {/* Status filter */}
        <select
          className="ml-auto text-xs border border-gray-200 rounded-lg px-2 py-1.5 bg-white focus:outline-none"
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
        >
          <option value="">All statuses</option>
          {statuses.map(s => <option key={s} value={s}>{s}</option>)}
        </select>

        {statusFilter && (
          <span className="text-xs text-gray-500">{visible.length} shown</span>
        )}
      </div>

      {error && (
        <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2 mb-3">
          Failed to load: {error?.response?.data?.detail || error.message}
        </div>
      )}

      {!isFetching && visible.length === 0 && (
        <p className="text-center py-8 text-gray-400 text-sm">No issues found in the last {days} days.</p>
      )}

      {visible.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="min-w-full text-xs bg-white">
            <thead className="bg-gray-50 border-b border-gray-200 text-[11px] font-semibold text-gray-500 uppercase">
              <tr>
                <th className="px-3 py-2.5 text-left cursor-pointer whitespace-nowrap" onClick={() => toggleSort('key')}>
                  Key <SortIcon field="key" />
                </th>
                <th className="px-3 py-2.5 text-left">Summary</th>
                <th className="px-2 py-2.5 text-left whitespace-nowrap">Type</th>
                <th className="px-2 py-2.5 text-left cursor-pointer whitespace-nowrap" onClick={() => toggleSort('status')}>
                  Status <SortIcon field="status" />
                </th>
                <th className="px-2 py-2.5 text-left cursor-pointer whitespace-nowrap" onClick={() => toggleSort('priority')}>
                  Priority <SortIcon field="priority" />
                </th>
                <th className="px-3 py-2.5 text-left whitespace-nowrap">Assignee</th>
                <th className="px-3 py-2.5 text-left whitespace-nowrap">Reporter</th>
                <th className="px-3 py-2.5 text-left whitespace-nowrap">Fix Version</th>
                <th className="px-3 py-2.5 text-left cursor-pointer whitespace-nowrap" onClick={() => toggleSort('updated')}>
                  Updated <SortIcon field="updated" />
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visible.map(issue => {
                const jiraBase = 'https://avite.atlassian.net/browse'
                const url = issue.url || `${jiraBase}/${issue.key}`
                const assigneeName = issue.assignee?.display_name || issue.assignee?.name || '—'
                const reporterName = issue.reporter?.display_name || issue.reporter?.name || '—'
                const fixVersions  = (issue.fix_versions || []).map(v => v.name || v).filter(Boolean)
                return (
                  <tr key={issue.key} className="hover:bg-gray-50 transition-colors">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <a href={url} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-brand-600 font-mono font-medium hover:underline">
                        {issue.key} <ExternalLink className="h-2.5 w-2.5 opacity-50" />
                      </a>
                    </td>
                    <td className="px-3 py-2 max-w-xs">
                      <p className="line-clamp-2 text-gray-800" title={issue.summary}>{issue.summary}</p>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <TypeBadge type={issue.issue_type || issue.type} />
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap">
                      <StatusBadge status={issue.status} />
                    </td>
                    <td className={`px-2 py-2 whitespace-nowrap ${PRIORITY_CLS[issue.priority] || 'text-gray-500'}`}>
                      {issue.priority || '—'}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-600">{assigneeName}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-500">{reporterName}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-500">
                      {fixVersions[0] || '—'}
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-400">{fmtDate(issue.updated)}</td>
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

/* ── TeamOverview ──────────────────────────────────────────── */
export default function TeamOverview() {
  const [filters, setFilters] = useState({})
  const [selected, setSelected] = useState(null)
  const [workDays, setWorkDays] = useState(30)

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['dashboard-team', filters],
    queryFn: () => getDashboard({ ...filters }),
    refetchInterval: 5 * 60 * 1000,
  })

  const { lastRefresh, isRefreshing, refresh } = useAutoRefresh([['dashboard-team', filters]])

  if (isLoading) return <PageLoader />
  if (isError) return <div className="flex-1 p-6"><ErrorState message={error?.message} onRetry={refetch} /></div>

  const byMember = data?.by_member || []
  const selectedMember = selected ? byMember.find(m => m.member_id === selected) : null

  /* Split into main QA and Mexico QA */
  const mainQA   = byMember.filter(m => m.member_role !== 'Mexico QA')
  const mexicoQA = byMember.filter(m => m.member_role === 'Mexico QA')

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Team Overview"
        lastRefresh={lastRefresh}
        isRefreshing={isRefreshing}
        onRefresh={() => refresh(true)}
        onFilter={setFilters}
      />
      <div className="flex-1 p-6 overflow-auto">

        {/* Main QA Team */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-6">
          {byMember.map((member) => (
            <MemberCard
              key={member.member_id}
              member={member}
              selected={selected === member.member_id}
              onClick={() => setSelected(selected === member.member_id ? null : member.member_id)}
            />
          ))}
        </div>

        {/* Selected member detail */}
        {selectedMember && (
          <MemberWorkTable
            memberId={selectedMember.member_id}
            memberName={selectedMember.member_name}
            days={workDays}
            onDaysChange={setWorkDays}
          />
        )}
      </div>
    </div>
  )
}

function MemberCard({ member, selected, onClick }) {
  const roleCls = ROLE_CLS[member.member_role] || 'text-gray-500'
  return (
    <div
      className={`card cursor-pointer transition-all ${selected ? 'ring-2 ring-brand-500' : 'hover:shadow-md'}`}
      onClick={onClick}
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-semibold text-gray-800">{member.member_name}</h3>
          <p className={`text-xs mt-0.5 ${roleCls}`}>{member.member_role || 'QA Engineer'}</p>
        </div>
        <div className="flex gap-1.5">
          {member.has_no_work && <Badge label="Idle" variant="warning" />}
          {member.overloaded && <Badge label="Overloaded" variant="critical" />}
          {!member.has_no_work && !member.overloaded && <Badge label="Active" variant="ok" />}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-3">
        <Stat label="RFT" value={member.ready_for_testing_count} highlight />
        <Stat label="Total" value={member.total_assigned} />
        <Stat label="Avg Age" value={`${member.avg_days_in_status}d`} />
      </div>

      {member.versions?.length > 0 && (
        <div className="text-xs text-gray-500">
          <span className="font-medium">Versions: </span>
          {member.versions.slice(0, 3).join(', ')}
          {member.versions.length > 3 && ` +${member.versions.length - 3} more`}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, highlight }) {
  return (
    <div className="bg-gray-50 rounded-lg p-2 text-center">
      <p className={`text-xl font-bold ${highlight ? 'text-brand-600' : 'text-gray-700'}`}>{value}</p>
      <p className="text-xs text-gray-400">{label}</p>
    </div>
  )
}

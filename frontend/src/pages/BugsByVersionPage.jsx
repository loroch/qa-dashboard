import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Header } from '../components/layout/Header'
import { IssueTable } from '../components/tables/DataTable'
import { SummaryCard } from '../components/cards/SummaryCard'
import { PageLoader, ErrorState } from '../components/common/LoadingSpinner'
import { Bug, AlertTriangle, CheckCircle2, Filter, X } from 'lucide-react'
import axios from 'axios'

const api = axios.create({ baseURL: '/api', timeout: 60000 })

const getVersions = () =>
  api.get('/coverage/versions').then(r => r.data)

const getBugsByVersion = (version, signal) =>
  api.get('/dashboard/bugs-by-version', { params: { version }, signal }).then(r => r.data)

// All known Jira statuses we want to offer as filters
const STATUS_OPTIONS = [
  'Open',
  'In Progress',
  'Ready for Testing',
  'In Review',
  'Done',
  'Closed',
  'Reopened',
  'Blocked',
]

const STATUS_COLORS = {
  'Done':              'bg-green-100 text-green-700 border-green-200',
  'Closed':            'bg-green-100 text-green-700 border-green-200',
  'In Progress':       'bg-blue-100 text-blue-700 border-blue-200',
  'Ready for Testing': 'bg-purple-100 text-purple-700 border-purple-200',
  'In Review':         'bg-indigo-100 text-indigo-700 border-indigo-200',
  'Open':              'bg-gray-100 text-gray-600 border-gray-200',
  'Reopened':          'bg-orange-100 text-orange-700 border-orange-200',
  'Blocked':           'bg-red-100 text-red-700 border-red-200',
}

function StatusPill({ label, active, onClick }) {
  const base = STATUS_COLORS[label] || 'bg-gray-100 text-gray-600 border-gray-200'
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium border transition-all ${
        active ? base + ' ring-2 ring-offset-1 ring-current opacity-100' : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400'
      }`}
    >
      {active && <X className="h-3 w-3" />}
      {label}
    </button>
  )
}

function MiniBar({ label, count, total, color = 'bg-blue-500' }) {
  const pct = total ? Math.round(count / total * 100) : 0
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-36 text-gray-600 truncate shrink-0">{label}</span>
      <div className="flex-1 bg-gray-100 rounded-full h-2">
        <div className={`${color} h-2 rounded-full`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right font-medium text-gray-700">{count}</span>
    </div>
  )
}

export default function BugsByVersionPage() {
  const [selectedVersion, setSelectedVersion] = useState('')
  const [activeStatuses, setActiveStatuses] = useState(new Set())

  // Fetch all versions (reuse coverage endpoint)
  const { data: versions = [], isLoading: versionsLoading } = useQuery({
    queryKey: ['bug-versions'],
    queryFn: getVersions,
    staleTime: 10 * 60 * 1000,
  })

  // Fetch bugs for selected version
  const {
    data,
    isLoading: bugsLoading,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ['bugs-by-version', selectedVersion],
    queryFn: ({ signal }) => getBugsByVersion(selectedVersion, signal),
    enabled: !!selectedVersion,
    staleTime: 5 * 60 * 1000,
  })

  const stats = data?.stats || {}
  const allBugs = data?.bugs || []

  // Statuses actually present in this version's data
  const presentStatuses = useMemo(() => {
    const s = new Set(allBugs.map(b => b.status).filter(Boolean))
    return STATUS_OPTIONS.filter(o => s.has(o))
  }, [allBugs])

  // Apply status filter
  const visibleBugs = useMemo(() => {
    if (activeStatuses.size === 0) return allBugs
    return allBugs.filter(b => activeStatuses.has(b.status))
  }, [allBugs, activeStatuses])

  function toggleStatus(s) {
    setActiveStatuses(prev => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }

  function clearFilters() {
    setActiveStatuses(new Set())
  }

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Bugs by Version"
        onRefresh={() => refetch()}
      />

      <div className="flex-1 p-6 space-y-5 overflow-auto">
        {/* Version selector */}
        <div className="card flex items-center gap-4">
          <label className="text-sm font-medium text-gray-700 shrink-0">Fix Version</label>
          {versionsLoading ? (
            <span className="text-sm text-gray-400">Loading versions…</span>
          ) : (
            <select
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 min-w-[260px]"
              value={selectedVersion}
              onChange={e => { setSelectedVersion(e.target.value); setActiveStatuses(new Set()) }}
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

        {/* Loading */}
        {bugsLoading && selectedVersion && (
          <div className="flex justify-center py-16"><PageLoader /></div>
        )}

        {/* Error */}
        {isError && (
          <ErrorState message={error?.message} onRetry={refetch} />
        )}

        {/* Results */}
        {data && !bugsLoading && (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-4 gap-4">
              <SummaryCard title="Total Bugs" value={stats.total ?? 0} icon={Bug} color="red" />
              <SummaryCard title="Open Bugs" value={stats.open ?? 0} icon={AlertTriangle} color="orange" />
              <SummaryCard title="High / Critical" value={stats.high_critical ?? 0} icon={AlertTriangle} color="red" />
              <SummaryCard
                title="Showing"
                value={visibleBugs.length}
                icon={CheckCircle2}
                color={activeStatuses.size > 0 ? 'blue' : 'green'}
              />
            </div>

            {/* Status filter pills */}
            {presentStatuses.length > 0 && (
              <div className="card">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="flex items-center gap-1 text-xs font-medium text-gray-500 mr-1">
                    <Filter className="h-3.5 w-3.5" /> Filter by status:
                  </span>
                  {presentStatuses.map(s => (
                    <StatusPill
                      key={s}
                      label={s}
                      active={activeStatuses.has(s)}
                      onClick={() => toggleStatus(s)}
                    />
                  ))}
                  {activeStatuses.size > 0 && (
                    <button
                      onClick={clearFilters}
                      className="text-xs text-gray-400 hover:text-gray-600 ml-2 underline"
                    >
                      Clear all
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Charts row */}
            <div className="grid grid-cols-2 gap-4">
              {/* By Status */}
              {stats.by_status?.length > 0 && (
                <div className="card">
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">By Status</h3>
                  <div className="space-y-2">
                    {stats.by_status.map(({ status, count }) => (
                      <MiniBar
                        key={status}
                        label={status}
                        count={count}
                        total={stats.total}
                        color={
                          status === 'Done' || status === 'Closed' ? 'bg-green-500' :
                          status === 'In Progress' ? 'bg-blue-500' :
                          status === 'Ready for Testing' ? 'bg-purple-500' :
                          status === 'Blocked' ? 'bg-red-500' : 'bg-gray-400'
                        }
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* By Priority */}
              {stats.by_priority?.length > 0 && (
                <div className="card">
                  <h3 className="text-sm font-semibold text-gray-700 mb-3">By Priority</h3>
                  <div className="space-y-2">
                    {stats.by_priority.map(({ priority, count }) => (
                      <MiniBar
                        key={priority}
                        label={priority}
                        count={count}
                        total={stats.total}
                        color={
                          priority === 'Highest' || priority === 'Critical' ? 'bg-red-600' :
                          priority === 'High' ? 'bg-orange-500' :
                          priority === 'Medium' ? 'bg-yellow-500' :
                          priority === 'Low' || priority === 'Lowest' ? 'bg-green-400' : 'bg-gray-300'
                        }
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* By Reporter */}
            {stats.by_reporter?.length > 0 && (
              <div className="card">
                <h3 className="text-sm font-semibold text-gray-700 mb-3">By Reporter</h3>
                <div className="flex flex-wrap gap-3">
                  {stats.by_reporter.map(({ reporter, count }) => (
                    <div
                      key={reporter}
                      className="bg-red-50 border border-red-100 rounded-lg px-4 py-3 text-center min-w-[90px]"
                    >
                      <p className="text-2xl font-bold text-red-600">{count}</p>
                      <p className="text-xs text-gray-600 mt-1">{reporter}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Bug table */}
            <div className="card">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-gray-700">
                  All Bugs
                  {activeStatuses.size > 0 && (
                    <span className="ml-2 text-xs font-normal text-gray-400">
                      — filtered: {[...activeStatuses].join(', ')}
                    </span>
                  )}
                </h3>
                <span className="text-xs text-gray-400">{visibleBugs.length} bug{visibleBugs.length !== 1 ? 's' : ''}</span>
              </div>
              {visibleBugs.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">No bugs match the selected filters.</p>
              ) : (
                <IssueTable issues={visibleBugs} />
              )}
            </div>
          </>
        )}

        {/* Empty state — no version selected */}
        {!selectedVersion && !versionsLoading && (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400">
            <Bug className="h-12 w-12 mb-3 opacity-30" />
            <p className="text-sm">Select a fix version above to see its bugs.</p>
          </div>
        )}
      </div>
    </div>
  )
}

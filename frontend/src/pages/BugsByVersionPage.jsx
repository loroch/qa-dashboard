import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Header } from '../components/layout/Header'
import { IssueTable } from '../components/tables/DataTable'
import { SummaryCard } from '../components/cards/SummaryCard'
import { PageLoader, ErrorState } from '../components/common/LoadingSpinner'
import { Bug, AlertTriangle, CheckCircle2, LayoutList } from 'lucide-react'
import axios from 'axios'

const api = axios.create({ baseURL: '/api', timeout: 60000 })

const getVersions = () =>
  api.get('/coverage/versions').then(r => r.data)

const getBugsByVersion = (version, signal) =>
  api.get('/dashboard/bugs-by-version', { params: { version }, signal }).then(r => r.data)

// Visual config per status — exact Jira status names, in workflow order
const STATUS_CONFIG = [
  { key: 'ToDo',                 label: 'To Do',                 bg: 'bg-gray-50',     border: 'border-gray-300',   text: 'text-gray-700',    activeBg: 'bg-gray-600',    activeText: 'text-white' },
  { key: 'In Progress',          label: 'In Progress',           bg: 'bg-blue-50',     border: 'border-blue-300',   text: 'text-blue-700',    activeBg: 'bg-blue-600',    activeText: 'text-white' },
  { key: 'In Review',            label: 'In Review',             bg: 'bg-indigo-50',   border: 'border-indigo-300', text: 'text-indigo-700',  activeBg: 'bg-indigo-600',  activeText: 'text-white' },
  { key: 'Ready for Testing',    label: 'Ready for Testing',     bg: 'bg-purple-50',   border: 'border-purple-300', text: 'text-purple-700',  activeBg: 'bg-purple-600',  activeText: 'text-white' },
  { key: 'Validation',           label: 'Validation',            bg: 'bg-violet-50',   border: 'border-violet-300', text: 'text-violet-700',  activeBg: 'bg-violet-600',  activeText: 'text-white' },
  { key: 'Ready For Deployment', label: 'Ready for Deployment',  bg: 'bg-teal-50',     border: 'border-teal-300',   text: 'text-teal-700',    activeBg: 'bg-teal-600',    activeText: 'text-white' },
  { key: 'Monitoring',           label: 'Monitoring',            bg: 'bg-cyan-50',     border: 'border-cyan-300',   text: 'text-cyan-700',    activeBg: 'bg-cyan-600',    activeText: 'text-white' },
  { key: 'DONE',                 label: 'Done',                  bg: 'bg-green-50',    border: 'border-green-300',  text: 'text-green-700',   activeBg: 'bg-green-600',   activeText: 'text-white' },
  { key: 'Reopened',             label: 'Reopened',              bg: 'bg-orange-50',   border: 'border-orange-300', text: 'text-orange-700',  activeBg: 'bg-orange-500',  activeText: 'text-white' },
  { key: 'Known Issue',          label: 'Known Issue',           bg: 'bg-yellow-50',   border: 'border-yellow-300', text: 'text-yellow-700',  activeBg: 'bg-yellow-500',  activeText: 'text-white' },
  { key: 'Blocked',              label: 'Blocked',               bg: 'bg-red-50',      border: 'border-red-300',    text: 'text-red-700',     activeBg: 'bg-red-600',     activeText: 'text-white' },
  { key: 'Removed',              label: 'Removed',               bg: 'bg-gray-50',     border: 'border-gray-200',   text: 'text-gray-400',    activeBg: 'bg-gray-400',    activeText: 'text-white' },
]

function StatusToggle({ cfg, count, active, onClick }) {
  const { label, bg, border, text, activeBg, activeText } = cfg
  return (
    <button
      onClick={onClick}
      className={`
        flex flex-col items-center justify-center px-4 py-3 rounded-xl border-2 font-medium
        transition-all duration-150 select-none min-w-[120px]
        ${active
          ? `${activeBg} ${activeText} border-transparent shadow-md scale-[1.03]`
          : `${bg} ${text} ${border} hover:shadow-sm hover:scale-[1.01] opacity-80 hover:opacity-100`
        }
      `}
    >
      <span className={`text-2xl font-bold leading-none ${active ? activeText : text}`}>{count}</span>
      <span className={`text-xs mt-1 leading-tight text-center ${active ? 'opacity-90' : 'opacity-75'}`}>{label}</span>
    </button>
  )
}

function MiniBar({ label, count, total, color = 'bg-blue-500' }) {
  const pct = total ? Math.round(count / total * 100) : 0
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-40 text-gray-600 truncate shrink-0">{label}</span>
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

  const { data: versions = [], isLoading: versionsLoading } = useQuery({
    queryKey: ['bug-versions'],
    queryFn: getVersions,
    staleTime: 10 * 60 * 1000,
  })

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

  // Count bugs per status (for toggle buttons)
  const countByStatus = useMemo(() => {
    const m = {}
    for (const b of allBugs) {
      const s = b.status || 'Unknown'
      m[s] = (m[s] || 0) + 1
    }
    return m
  }, [allBugs])

  // Only show statuses that actually have bugs
  const presentConfigs = useMemo(
    () => STATUS_CONFIG.filter(c => countByStatus[c.key] > 0),
    [countByStatus]
  )

  // Apply multi-status filter
  const visibleBugs = useMemo(() => {
    if (activeStatuses.size === 0) return allBugs
    return allBugs.filter(b => activeStatuses.has(b.status))
  }, [allBugs, activeStatuses])

  function toggleStatus(key) {
    setActiveStatuses(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function clearFilters() {
    setActiveStatuses(new Set())
  }

  const isFiltered = activeStatuses.size > 0

  return (
    <div className="flex-1 flex flex-col">
      <Header title="Bugs by Version" onRefresh={() => refetch()} />

      <div className="flex-1 p-6 space-y-5 overflow-auto">

        {/* Version selector */}
        <div className="card flex items-center gap-4">
          <label className="text-sm font-medium text-gray-700 shrink-0">Fix Version</label>
          {versionsLoading ? (
            <span className="text-sm text-gray-400">Loading versions…</span>
          ) : (
            <select
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 min-w-[280px]"
              value={selectedVersion}
              onChange={e => {
                setSelectedVersion(e.target.value)
                setActiveStatuses(new Set())
              }}
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

        {bugsLoading && selectedVersion && (
          <div className="flex justify-center py-16"><PageLoader /></div>
        )}

        {isError && <ErrorState message={error?.message} onRetry={refetch} />}

        {data && !bugsLoading && (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-4 gap-4">
              <SummaryCard title="Total Bugs" value={stats.total ?? 0} icon={Bug} color="red" />
              <SummaryCard title="Open Bugs" value={stats.open ?? 0} icon={AlertTriangle} color="orange" />
              <SummaryCard title="High / Critical" value={stats.high_critical ?? 0} icon={AlertTriangle} color="red" />
              <SummaryCard
                title={isFiltered ? 'Showing (filtered)' : 'Showing (all)'}
                value={visibleBugs.length}
                icon={isFiltered ? CheckCircle2 : LayoutList}
                color={isFiltered ? 'blue' : 'green'}
              />
            </div>

            {/* Status filter toggles */}
            {presentConfigs.length > 0 && (
              <div className="card">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm font-semibold text-gray-700">
                    Filter by Status
                    <span className="ml-2 text-xs font-normal text-gray-400">— click one or more to combine</span>
                  </p>
                  {isFiltered && (
                    <button
                      onClick={clearFilters}
                      className="text-xs text-brand-600 hover:text-brand-800 font-medium underline"
                    >
                      Show all ({allBugs.length})
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-3">
                  {presentConfigs.map(cfg => (
                    <StatusToggle
                      key={cfg.key}
                      cfg={cfg}
                      count={countByStatus[cfg.key] || 0}
                      active={activeStatuses.has(cfg.key)}
                      onClick={() => toggleStatus(cfg.key)}
                    />
                  ))}
                </div>
                {isFiltered && (
                  <p className="mt-3 text-xs text-gray-500">
                    Showing <strong>{visibleBugs.length}</strong> of <strong>{allBugs.length}</strong> bugs
                    for: {[...activeStatuses].join(' + ')}
                  </p>
                )}
              </div>
            )}

            {/* Charts row */}
            <div className="grid grid-cols-2 gap-4">
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
                          status === 'DONE'                  ? 'bg-green-500'  :
                          status === 'In Progress'           ? 'bg-blue-500'   :
                          status === 'In Review'             ? 'bg-indigo-500' :
                          status === 'Ready for Testing'     ? 'bg-purple-500' :
                          status === 'Validation'            ? 'bg-violet-500' :
                          status === 'Ready For Deployment'  ? 'bg-teal-500'   :
                          status === 'Monitoring'            ? 'bg-cyan-500'   :
                          status === 'Blocked'               ? 'bg-red-500'    :
                          status === 'Reopened'              ? 'bg-orange-500' :
                          status === 'Known Issue'           ? 'bg-yellow-500' :
                          status === 'Removed'               ? 'bg-gray-300'   :
                          'bg-gray-400'
                        }
                      />
                    ))}
                  </div>
                </div>
              )}

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
                          priority === 'Highest' || priority === 'Critical' ? 'bg-red-600'    :
                          priority === 'High'                                ? 'bg-orange-500' :
                          priority === 'Medium'                              ? 'bg-yellow-500' :
                          priority === 'Low' || priority === 'Lowest'        ? 'bg-green-400'  :
                          'bg-gray-300'
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
                  {isFiltered
                    ? `Bugs — ${[...activeStatuses].join(' + ')}`
                    : 'All Bugs'}
                </h3>
                <span className="text-xs text-gray-400">
                  {visibleBugs.length} bug{visibleBugs.length !== 1 ? 's' : ''}
                </span>
              </div>
              {visibleBugs.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">
                  No bugs match the selected statuses.
                </p>
              ) : (
                <IssueTable issues={visibleBugs} />
              )}
            </div>
          </>
        )}

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

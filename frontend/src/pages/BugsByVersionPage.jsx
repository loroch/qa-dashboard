import { useState, useMemo, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Header } from '../components/layout/Header'
import { IssueTable } from '../components/tables/DataTable'
import { SummaryCard } from '../components/cards/SummaryCard'
import { PageLoader, ErrorState } from '../components/common/LoadingSpinner'
import { Bug, AlertTriangle, CheckCircle2, LayoutList, Layers, Tag, BookOpen } from 'lucide-react'
import axios from 'axios'

const api = axios.create({ baseURL: '/api', timeout: 60000 })

const getVersions  = (refresh)       => api.get('/coverage/versions', { params: refresh ? { refresh: true } : {} }).then(r => r.data)
const getEpics     = (refresh)       => api.get('/dashboard/epics',   { params: refresh ? { refresh: true } : {} }).then(r => r.data)
const getByVersion = (v, refresh, sig) => api.get('/dashboard/bugs-by-version', { params: { version: v, ...(refresh ? { refresh: true } : {}) }, signal: sig }).then(r => r.data)
const getByEpic    = (k, refresh, sig) => api.get('/dashboard/bugs-by-epic',    { params: { epic_key: k, ...(refresh ? { refresh: true } : {}) }, signal: sig }).then(r => r.data)

// Exact Jira status names in workflow order
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

const STORY_STATUS_COLOR = {
  'Done':                 'bg-green-100 text-green-800 border-green-200',
  'DONE':                 'bg-green-100 text-green-800 border-green-200',
  'In Progress':          'bg-blue-100 text-blue-800 border-blue-200',
  'In Review':            'bg-indigo-100 text-indigo-800 border-indigo-200',
  'Ready for Testing':    'bg-purple-100 text-purple-800 border-purple-200',
  'Validation':           'bg-violet-100 text-violet-800 border-violet-200',
  'Ready For Deployment': 'bg-teal-100 text-teal-800 border-teal-200',
  'Monitoring':           'bg-cyan-100 text-cyan-800 border-cyan-200',
  'Blocked':              'bg-red-100 text-red-800 border-red-200',
  'Reopened':             'bg-orange-100 text-orange-800 border-orange-200',
  'Known Issue':          'bg-yellow-100 text-yellow-800 border-yellow-200',
  'Removed':              'bg-gray-100 text-gray-500 border-gray-200',
  'To Do':                'bg-gray-50 text-gray-600 border-gray-200',
  'Open':                 'bg-gray-50 text-gray-600 border-gray-200',
}

function StoryStatusPanel({ stats }) {
  const total = stats?.stories_total ?? 0
  const done  = stats?.stories_done  ?? 0
  const byStatus = stats?.stories_by_status || []
  if (total === 0) return null
  const pct = total ? Math.round(done / total * 100) : 0

  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-3">
        <BookOpen className="h-4 w-4 text-indigo-500" />
        <h3 className="text-sm font-semibold text-gray-700">Story Resolution Status</h3>
        <span className="ml-auto text-xs text-gray-400">{total} stories · {pct}% done</span>
      </div>
      {/* Progress bar */}
      <div className="w-full bg-gray-100 rounded-full h-2 mb-4">
        <div className="bg-green-500 h-2 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
      {/* Status pills */}
      <div className="flex flex-wrap gap-2">
        {byStatus.map(({ status, count }) => (
          <span
            key={status}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-medium
              ${STORY_STATUS_COLOR[status] || 'bg-gray-100 text-gray-600 border-gray-200'}`}
          >
            {status}
            <span className="font-bold">{count}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

function BugResults({ data, refetch }) {
  const [activeStatuses, setActiveStatuses] = useState(new Set())
  const allBugs = data?.bugs || []
  const stats   = data?.stats || {}

  const countByStatus = useMemo(() => {
    const m = {}
    for (const b of allBugs) { const s = b.status || 'Unknown'; m[s] = (m[s] || 0) + 1 }
    return m
  }, [allBugs])

  const presentConfigs = useMemo(
    () => STATUS_CONFIG.filter(c => countByStatus[c.key] > 0),
    [countByStatus]
  )

  const visibleBugs = useMemo(() => {
    if (activeStatuses.size === 0) return allBugs
    return allBugs.filter(b => activeStatuses.has(b.status))
  }, [allBugs, activeStatuses])

  function toggleStatus(key) {
    setActiveStatuses(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  const isFiltered = activeStatuses.size > 0

  return (
    <>
      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-4">
        <SummaryCard title="Total Bugs"      value={stats.total ?? 0}        icon={Bug}          color="red" />
        <SummaryCard title="Open Bugs"       value={stats.open ?? 0}         icon={AlertTriangle} color="orange" />
        <SummaryCard title="High / Critical" value={stats.high_critical ?? 0} icon={AlertTriangle} color="red" />
        <SummaryCard
          title={isFiltered ? 'Showing (filtered)' : 'Showing (all)'}
          value={visibleBugs.length}
          icon={isFiltered ? CheckCircle2 : LayoutList}
          color={isFiltered ? 'blue' : 'green'}
        />
      </div>

      {/* Story resolution status */}
      <StoryStatusPanel stats={stats} />

      {/* Status filter toggles */}
      {presentConfigs.length > 0 && (
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-gray-700">
              Filter by Status
              <span className="ml-2 text-xs font-normal text-gray-400">— click one or more to combine</span>
            </p>
            {isFiltered && (
              <button onClick={() => setActiveStatuses(new Set())}
                className="text-xs text-brand-600 hover:text-brand-800 font-medium underline">
                Show all ({allBugs.length})
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-3">
            {presentConfigs.map(cfg => (
              <StatusToggle
                key={cfg.key} cfg={cfg}
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
                <MiniBar key={status} label={status} count={count} total={stats.total}
                  color={
                    status === 'DONE' || status === 'Closed'         ? 'bg-green-500'  :
                    status === 'In Progress'                          ? 'bg-blue-500'   :
                    status === 'In Review'                            ? 'bg-indigo-500' :
                    status === 'Ready for Testing'                    ? 'bg-purple-500' :
                    status === 'Validation'                           ? 'bg-violet-500' :
                    status === 'Ready For Deployment'                 ? 'bg-teal-500'   :
                    status === 'Monitoring'                           ? 'bg-cyan-500'   :
                    status === 'Blocked'                              ? 'bg-red-500'    :
                    status === 'Reopened'                             ? 'bg-orange-500' :
                    status === 'Known Issue'                          ? 'bg-yellow-500' :
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
                <MiniBar key={priority} label={priority} count={count} total={stats.total}
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
              <div key={reporter} className="bg-red-50 border border-red-100 rounded-lg px-4 py-3 text-center min-w-[90px]">
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
            {isFiltered ? `Bugs — ${[...activeStatuses].join(' + ')}` : 'All Bugs'}
          </h3>
          <span className="text-xs text-gray-400">{visibleBugs.length} bug{visibleBugs.length !== 1 ? 's' : ''}</span>
        </div>
        {visibleBugs.length === 0
          ? <p className="text-sm text-gray-400 text-center py-8">No bugs match the selected filters.</p>
          : <IssueTable issues={visibleBugs} />
        }
      </div>
    </>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function BugsByVersionPage() {
  const [mode, setMode]               = useState('version') // 'version' | 'epic'
  const [selectedVersion, setSelectedVersion] = useState('')
  const [selectedEpic, setSelectedEpic]       = useState('')
  const [epicSearch, setEpicSearch]           = useState('')
  const [isRefreshing, setIsRefreshing]       = useState(false)
  const [lastRefresh, setLastRefresh]         = useState(null)
  const queryClient = useQueryClient()

  const { data: versions = [], isLoading: versionsLoading } = useQuery({
    queryKey: ['bug-versions'],
    queryFn: () => getVersions(false),
    staleTime: 10 * 60 * 1000,
  })

  const { data: epics = [], isLoading: epicsLoading } = useQuery({
    queryKey: ['dashboard-epics'],
    queryFn: () => getEpics(false),
    staleTime: 30 * 60 * 1000,
  })

  const versionQuery = useQuery({
    queryKey: ['bugs-by-version', selectedVersion],
    queryFn: ({ signal }) => getByVersion(selectedVersion, false, signal),
    enabled: mode === 'version' && !!selectedVersion,
    staleTime: 5 * 60 * 1000,
  })

  const epicQuery = useQuery({
    queryKey: ['bugs-by-epic', selectedEpic],
    queryFn: ({ signal }) => getByEpic(selectedEpic, false, signal),
    enabled: mode === 'epic' && !!selectedEpic,
    staleTime: 5 * 60 * 1000,
  })

  const activeQuery  = mode === 'version' ? versionQuery : epicQuery
  const activeData   = activeQuery.data
  const activeKey    = mode === 'version' ? selectedVersion : selectedEpic
  const isLoading    = activeQuery.isLoading
  const isError      = activeQuery.isError

  // Force-refresh: bust backend cache + re-run all queries
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true)
    try {
      // Invalidate TanStack Query caches
      queryClient.invalidateQueries({ queryKey: ['bug-versions'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-epics'] })
      queryClient.invalidateQueries({ queryKey: ['bugs-by-version', selectedVersion] })
      queryClient.invalidateQueries({ queryKey: ['bugs-by-epic', selectedEpic] })

      // Re-fetch with refresh=true to bust the backend cache
      const promises = [
        getVersions(true).then(data => queryClient.setQueryData(['bug-versions'], data)),
        getEpics(true).then(data => queryClient.setQueryData(['dashboard-epics'], data)),
      ]
      if (mode === 'version' && selectedVersion) {
        promises.push(
          getByVersion(selectedVersion, true).then(data =>
            queryClient.setQueryData(['bugs-by-version', selectedVersion], data)
          )
        )
      } else if (mode === 'epic' && selectedEpic) {
        promises.push(
          getByEpic(selectedEpic, true).then(data =>
            queryClient.setQueryData(['bugs-by-epic', selectedEpic], data)
          )
        )
      }
      await Promise.all(promises)
      setLastRefresh(new Date())
    } finally {
      setIsRefreshing(false)
    }
  }, [mode, selectedVersion, selectedEpic, queryClient])

  // Epic search filter
  const filteredEpics = useMemo(() => {
    if (!epicSearch.trim()) return epics
    const q = epicSearch.toLowerCase()
    return epics.filter(e =>
      e.name.toLowerCase().includes(q) || e.key.toLowerCase().includes(q)
    )
  }, [epics, epicSearch])

  // Label for selected epic
  const selectedEpicName = useMemo(
    () => epics.find(e => e.key === selectedEpic)?.name || selectedEpic,
    [epics, selectedEpic]
  )

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Bugs by Version / Epic"
        lastRefresh={lastRefresh}
        isRefreshing={isRefreshing}
        onRefresh={handleRefresh}
      />

      <div className="flex-1 p-6 space-y-5 overflow-auto">

        {/* Selector card */}
        <div className="card space-y-4">
          {/* Mode toggle */}
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

          {/* Version selector */}
          {mode === 'version' && (
            <div className="flex items-center gap-3">
              <label className="text-sm font-medium text-gray-700 shrink-0">Fix Version</label>
              {versionsLoading ? (
                <span className="text-sm text-gray-400">Loading versions…</span>
              ) : (
                <select
                  className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 min-w-[280px]"
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
          )}

          {/* Epic selector */}
          {mode === 'epic' && (
            <div className="flex items-start gap-3">
              <label className="text-sm font-medium text-gray-700 shrink-0 pt-1.5">Epic</label>
              {epicsLoading ? (
                <span className="text-sm text-gray-400">Loading epics…</span>
              ) : (
                <div className="flex flex-col gap-2 flex-1 max-w-md">
                  <input
                    type="text"
                    placeholder="Search epic name or key…"
                    value={epicSearch}
                    onChange={e => setEpicSearch(e.target.value)}
                    className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 w-full"
                  />
                  <select
                    className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 w-full"
                    size={Math.min(8, filteredEpics.length + 1)}
                    value={selectedEpic}
                    onChange={e => setSelectedEpic(e.target.value)}
                  >
                    <option value="">— Select an epic —</option>
                    {filteredEpics.map(e => (
                      <option key={e.key} value={e.key}>
                        {e.key} — {e.name}
                      </option>
                    ))}
                  </select>
                  {filteredEpics.length === 0 && epicSearch && (
                    <p className="text-xs text-gray-400">No epics match "{epicSearch}"</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Loading */}
        {isLoading && activeKey && (
          <div className="flex justify-center py-16"><PageLoader /></div>
        )}

        {/* Error */}
        {isError && <ErrorState message={activeQuery.error?.message} onRetry={activeQuery.refetch} />}

        {/* Results */}
        {activeData && !isLoading && (
          <>
            {/* Breadcrumb label */}
            <div className="flex items-center gap-2 text-sm text-gray-500">
              {mode === 'version'
                ? <><Tag className="h-4 w-4 text-brand-500" /> Fix Version: <strong className="text-gray-800">{selectedVersion}</strong></>
                : <><Layers className="h-4 w-4 text-brand-500" /> Epic: <strong className="text-gray-800">{selectedEpicName}</strong> <span className="text-gray-400 font-mono text-xs">({selectedEpic})</span></>
              }
            </div>
            <BugResults data={activeData} refetch={activeQuery.refetch} />
          </>
        )}

        {/* Empty state */}
        {!activeKey && !isLoading && (
          <div className="flex flex-col items-center justify-center py-24 text-gray-400">
            <Bug className="h-12 w-12 mb-3 opacity-30" />
            <p className="text-sm">
              {mode === 'version' ? 'Select a fix version above to see its bugs.' : 'Select an epic above to see its bugs.'}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

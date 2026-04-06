import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { Header } from '../components/layout/Header'
import { PageLoader, ErrorState } from '../components/common/LoadingSpinner'
import { AgingBadge } from '../components/common/Badge'
import { ExternalLink, Link, BarChart2, ChevronUp, ChevronDown, X } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import axios from 'axios'

const api = axios.create({ baseURL: '/api', timeout: 60000 })
const getProjectReport = () => api.get('/zoho/reports/by-project?refresh=true').then(r => r.data)
const getLinkedReport  = () => api.get('/zoho/reports/linked?refresh=true').then(r => r.data)

const JIRA_STATUS_COLORS = {
  'Done':               'bg-green-100 text-green-700',
  'In Progress':        'bg-blue-100 text-blue-700',
  'Ready for Testing':  'bg-purple-100 text-purple-700',
  'In Review':          'bg-indigo-100 text-indigo-700',
  'Blocked':            'bg-red-100 text-red-700',
  'Open':               'bg-gray-100 text-gray-600',
  'Reopened':           'bg-orange-100 text-orange-700',
  'Not found':          'bg-gray-50 text-gray-400',
}

const ZOHO_STATUS_COLORS = {
  'Open':               'bg-blue-100 text-blue-700',
  'Closed':             'bg-gray-100 text-gray-500',
  'On Hold':            'bg-yellow-100 text-yellow-700',
  'Pending':            'bg-orange-100 text-orange-700',
  'Resolved':           'bg-green-100 text-green-700',
  'New':                'bg-teal-100 text-teal-700',
  'In Process':         'bg-blue-100 text-blue-700',
  'RND Investigation':  'bg-purple-100 text-purple-700',
  'Pending Delivery':   'bg-indigo-100 text-indigo-700',
  'Closed – Delivered': 'bg-green-100 text-green-600',
  'Pending Customer Approval': 'bg-orange-100 text-orange-600',
  'Pending Fix':        'bg-red-100 text-red-600',
}

function StatusPill({ status, colorMap }) {
  const cls = colorMap?.[status] || 'bg-gray-100 text-gray-600'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {status || '—'}
    </span>
  )
}

function SortIcon({ active, dir }) {
  if (!active) return <ChevronUp className="h-3 w-3 text-gray-300" />
  return dir === 'asc'
    ? <ChevronUp className="h-3 w-3 text-brand-600" />
    : <ChevronDown className="h-3 w-3 text-brand-600" />
}

function FilterChip({ label, onRemove }) {
  return (
    <span className="inline-flex items-center gap-1 bg-brand-100 text-brand-700 text-xs px-2 py-1 rounded-full">
      {label}
      <button onClick={onRemove}><X className="h-3 w-3" /></button>
    </span>
  )
}

const TABS = ['By Project & Status', 'Zoho ↔ Jira Linked']
const PAGE_SIZE = 30

export default function ZohoReportsPage() {
  const [tab, setTab] = useState('By Project & Status')

  // ── By Project filters & sort ──
  const [projSearch, setProjSearch] = useState('')
  const [projStatusFilter, setProjStatusFilter] = useState('')
  const [projSort, setProjSort] = useState({ field: 'total', dir: 'desc' })

  // ── Linked filters & sort ──
  const [linkedPage, setLinkedPage] = useState(1)
  const [filterProject, setFilterProject]       = useState('')
  const [filterZohoStatus, setFilterZohoStatus] = useState('')
  const [filterJiraStatus, setFilterJiraStatus] = useState('')
  const [filterBugId, setFilterBugId]           = useState('')
  const [sort, setSort] = useState({ field: 'zoho_ticket_number', dir: 'desc' })

  const projectQuery = useQuery({
    queryKey: ['zoho-project-report'],
    queryFn: getProjectReport,
    refetchInterval: 5 * 60 * 1000,
  })

  const linkedQuery = useQuery({
    queryKey: ['zoho-linked-report'],
    queryFn: getLinkedReport,
    refetchInterval: 5 * 60 * 1000,
    enabled: tab === 'Zoho ↔ Jira Linked',
  })

  const { lastRefresh, isRefreshing, refresh } = useAutoRefresh([
    ['zoho-project-report'], ['zoho-linked-report'],
  ])

  // ── By Project: filter + sort ──
  const byProject = useMemo(() => {
    let rows = projectQuery.data?.by_project || []
    if (projSearch) {
      rows = rows.filter(p => p.project_name.toLowerCase().includes(projSearch.toLowerCase()))
    }
    if (projStatusFilter) {
      rows = rows.filter(p => p.statuses.some(s => s.status === projStatusFilter))
    }
    return [...rows].sort((a, b) => {
      const av = projSort.field === 'total' ? a.total : a.project_name.toLowerCase()
      const bv = projSort.field === 'total' ? b.total : b.project_name.toLowerCase()
      return projSort.dir === 'asc' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1)
    })
  }, [projectQuery.data, projSearch, projStatusFilter, projSort])

  const allZohoStatuses = useMemo(() => {
    const all = projectQuery.data?.by_project || []
    const set = new Set()
    all.forEach(p => p.statuses.forEach(s => set.add(s.status)))
    return [...set].sort()
  }, [projectQuery.data])

  // ── Linked: filter + sort ──
  const allLinked = linkedQuery.data || []

  const uniqueProjects    = [...new Set(allLinked.map(r => r.zoho_project_name).filter(Boolean))].sort()
  const uniqueZohoStatus  = [...new Set(allLinked.map(r => r.zoho_status).filter(Boolean))].sort()
  const uniqueJiraStatus  = [...new Set(allLinked.map(r => r.jira_status).filter(Boolean))].sort()

  const filteredLinked = useMemo(() => {
    let rows = allLinked
    if (filterProject)    rows = rows.filter(r => r.zoho_project_name === filterProject)
    if (filterZohoStatus) rows = rows.filter(r => r.zoho_status === filterZohoStatus)
    if (filterJiraStatus) rows = rows.filter(r => r.jira_status === filterJiraStatus)
    if (filterBugId)      rows = rows.filter(r => (r.bug_id || '').includes(filterBugId) || (r.jira_key || '').toLowerCase().includes(filterBugId.toLowerCase()))

    return [...rows].sort((a, b) => {
      let av = a[sort.field] ?? ''
      let bv = b[sort.field] ?? ''
      if (typeof av === 'string') av = av.toLowerCase()
      if (typeof bv === 'string') bv = bv.toLowerCase()
      return sort.dir === 'asc' ? (av > bv ? 1 : -1) : (av < bv ? 1 : -1)
    })
  }, [allLinked, filterProject, filterZohoStatus, filterJiraStatus, filterBugId, sort])

  const totalPages  = Math.ceil(filteredLinked.length / PAGE_SIZE)
  const pagedLinked = filteredLinked.slice((linkedPage - 1) * PAGE_SIZE, linkedPage * PAGE_SIZE)

  const toggleSort = (field) => {
    setSort(s => s.field === field ? { field, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { field, dir: 'asc' })
    setLinkedPage(1)
  }

  const toggleProjSort = (field) => {
    setProjSort(s => s.field === field ? { field, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { field, dir: 'desc' })
  }

  const activeFilters = [
    filterProject    && { label: `Project: ${filterProject}`,        clear: () => setFilterProject('') },
    filterZohoStatus && { label: `Zoho: ${filterZohoStatus}`,        clear: () => setFilterZohoStatus('') },
    filterJiraStatus && { label: `Jira: ${filterJiraStatus}`,        clear: () => setFilterJiraStatus('') },
    filterBugId      && { label: `Bug ID: ${filterBugId}`,           clear: () => setFilterBugId('') },
  ].filter(Boolean)

  const clearAllFilters = () => {
    setFilterProject(''); setFilterZohoStatus(''); setFilterJiraStatus(''); setFilterBugId('')
    setLinkedPage(1)
  }

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Zoho Reports"
        lastRefresh={lastRefresh}
        isRefreshing={isRefreshing}
        onRefresh={() => refresh(true)}
        exportOptions={[
          { label: 'Linked CSV',   href: '/api/zoho/reports/linked/export/csv' },
          { label: 'Linked Excel', href: '/api/zoho/reports/linked/export/excel' },
          { label: 'All Tickets CSV', href: '/api/zoho/tickets/export/csv' },
        ]}
      />

      <div className="flex-1 p-6 space-y-4 overflow-auto">
        <div className="card p-0 overflow-hidden">
          {/* Tabs */}
          <div className="flex border-b border-gray-200 bg-gray-50">
            {TABS.map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-6 py-3 text-sm font-medium whitespace-nowrap transition-colors ${
                  tab === t ? 'bg-white text-brand-600 border-b-2 border-brand-600' : 'text-gray-500 hover:text-gray-700'
                }`}>
                {t}
              </button>
            ))}
          </div>

          {/* ═══ TAB 1: By Project & Status ═══ */}
          {tab === 'By Project & Status' && (
            <div className="p-5">
              {projectQuery.isLoading && <PageLoader />}
              {projectQuery.isError && <ErrorState message={projectQuery.error?.message} onRetry={projectQuery.refetch} />}

              {!projectQuery.isLoading && (
                <>
                  {/* Filters + sort bar */}
                  <div className="flex flex-wrap gap-3 mb-4 items-center">
                    <input
                      className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white w-48"
                      placeholder="Search project..."
                      value={projSearch}
                      onChange={e => setProjSearch(e.target.value)}
                    />
                    <select
                      className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                      value={projStatusFilter}
                      onChange={e => setProjStatusFilter(e.target.value)}
                    >
                      <option value="">All statuses</option>
                      {allZohoStatuses.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>

                    {/* Sort */}
                    <div className="flex items-center gap-1 ml-auto text-xs text-gray-500">
                      <span>Sort by:</span>
                      <button
                        onClick={() => toggleProjSort('project_name')}
                        className={`flex items-center gap-0.5 px-2 py-1 rounded border ${projSort.field === 'project_name' ? 'border-brand-400 text-brand-600 bg-brand-50' : 'border-gray-200'}`}
                      >
                        Name <SortIcon active={projSort.field === 'project_name'} dir={projSort.dir} />
                      </button>
                      <button
                        onClick={() => toggleProjSort('total')}
                        className={`flex items-center gap-0.5 px-2 py-1 rounded border ${projSort.field === 'total' ? 'border-brand-400 text-brand-600 bg-brand-50' : 'border-gray-200'}`}
                      >
                        Count <SortIcon active={projSort.field === 'total'} dir={projSort.dir} />
                      </button>
                    </div>

                    <span className="text-sm text-gray-400">{byProject.length} projects · {byProject.reduce((s, p) => s + p.total, 0)} tickets</span>
                  </div>

                  {/* Project cards */}
                  <div className="space-y-4">
                    {byProject.map(project => {
                      const visibleStatuses = projStatusFilter
                        ? project.statuses.filter(s => s.status === projStatusFilter)
                        : project.statuses
                      return (
                        <div key={project.project_name} className="border border-gray-200 rounded-xl overflow-hidden">
                          <div className="flex items-center justify-between bg-brand-50 px-4 py-3 border-b border-gray-200">
                            <h3 className="font-semibold text-brand-800">{project.project_name}</h3>
                            <span className="text-2xl font-bold text-brand-600">{project.total}</span>
                          </div>
                          <div className="p-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
                            {visibleStatuses.map(s => (
                              <div key={s.status} className="bg-white border border-gray-100 rounded-lg p-3 text-center shadow-sm cursor-pointer hover:border-brand-300"
                                onClick={() => { setFilterZohoStatus(s.status); setFilterProject(project.project_name); setTab('Zoho ↔ Jira Linked') }}>
                                <p className="text-xl font-bold text-gray-800">{s.count}</p>
                                <StatusPill status={s.status} colorMap={ZOHO_STATUS_COLORS} />
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                    {byProject.length === 0 && (
                      <p className="text-center py-10 text-gray-400 text-sm">No projects found.</p>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ═══ TAB 2: Zoho ↔ Jira Linked ═══ */}
          {tab === 'Zoho ↔ Jira Linked' && (
            <div className="p-5">
              {linkedQuery.isLoading && (
                <div className="text-center py-12 text-gray-500">
                  <div className="h-8 w-8 border-2 border-brand-200 border-t-brand-600 rounded-full animate-spin mx-auto mb-3" />
                  <p className="text-sm">Cross-referencing Zoho tickets with Jira…</p>
                  <p className="text-xs text-gray-400 mt-1">May take 10–30 seconds on first load</p>
                </div>
              )}
              {linkedQuery.isError && <ErrorState message={linkedQuery.error?.message} onRetry={linkedQuery.refetch} />}

              {!linkedQuery.isLoading && !linkedQuery.isError && (
                <>
                  {/* Filter bar */}
                  <div className="flex flex-wrap gap-2 mb-3">
                    <select className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                      value={filterProject} onChange={e => { setFilterProject(e.target.value); setLinkedPage(1) }}>
                      <option value="">All Projects</option>
                      {uniqueProjects.map(p => <option key={p} value={p}>{p}</option>)}
                    </select>

                    <select className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                      value={filterZohoStatus} onChange={e => { setFilterZohoStatus(e.target.value); setLinkedPage(1) }}>
                      <option value="">All Zoho Statuses</option>
                      {uniqueZohoStatus.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>

                    <select className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                      value={filterJiraStatus} onChange={e => { setFilterJiraStatus(e.target.value); setLinkedPage(1) }}>
                      <option value="">All Jira Statuses</option>
                      {uniqueJiraStatus.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>

                    <input className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white w-36"
                      placeholder="Bug ID / Jira key"
                      value={filterBugId}
                      onChange={e => { setFilterBugId(e.target.value); setLinkedPage(1) }}
                    />

                    {activeFilters.length > 0 && (
                      <button onClick={clearAllFilters} className="text-xs text-red-500 hover:text-red-700 px-2">
                        Clear all
                      </button>
                    )}

                    <span className="self-center text-sm text-gray-400 ml-auto">
                      {filteredLinked.length} of {allLinked.length} tickets
                    </span>
                  </div>

                  {/* Active filter chips */}
                  {activeFilters.length > 0 && (
                    <div className="flex flex-wrap gap-2 mb-3">
                      {activeFilters.map((f, i) => (
                        <FilterChip key={i} label={f.label} onRemove={f.clear} />
                      ))}
                    </div>
                  )}

                  {/* Jira status summary pills */}
                  <div className="flex flex-wrap gap-2 mb-4">
                    {uniqueJiraStatus.map(status => {
                      const count = filteredLinked.filter(r => r.jira_status === status).length
                      if (!count) return null
                      return (
                        <button key={status}
                          onClick={() => { setFilterJiraStatus(status === filterJiraStatus ? '' : status); setLinkedPage(1) }}
                          className={`flex items-center gap-2 border rounded-lg px-3 py-1.5 transition-colors ${filterJiraStatus === status ? 'border-brand-400 bg-brand-50' : 'border-gray-200 bg-white hover:border-brand-300'}`}>
                          <StatusPill status={status} colorMap={JIRA_STATUS_COLORS} />
                          <span className="font-bold text-gray-700 text-sm">{count}</span>
                        </button>
                      )
                    })}
                  </div>

                  {/* Table */}
                  <div className="overflow-x-auto rounded-lg border border-gray-200">
                    <table className="min-w-full text-sm bg-white">
                      <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                          {[
                            { label: 'Zoho #',       field: 'zoho_ticket_number' },
                            { label: 'Subject',      field: 'zoho_subject' },
                            { label: 'Project',      field: 'zoho_project_name' },
                            { label: 'Zoho Status',  field: 'zoho_status' },
                            { label: 'Bug ID → Jira',field: 'jira_key' },
                            { label: 'Jira Status',  field: 'jira_status' },
                            { label: 'Fix Versions', field: null },
                            { label: 'Parent',       field: 'jira_parent_key' },
                            { label: 'Days Open',    field: 'zoho_days_open' },
                            { label: 'Created',      field: 'zoho_created' },
                          ].map(({ label, field }) => (
                            <th key={label}
                              className={`px-3 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap ${field ? 'cursor-pointer hover:text-gray-800 select-none' : ''}`}
                              onClick={() => field && toggleSort(field)}>
                              <span className="inline-flex items-center gap-1">
                                {label}
                                {field && <SortIcon active={sort.field === field} dir={sort.dir} />}
                              </span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {pagedLinked.map(row => (
                          <tr key={row.zoho_id}
                            className={`hover:bg-gray-50 transition-colors ${
                              row.zoho_aging_level === 'overdue'  ? 'bg-red-50/30' :
                              row.zoho_aging_level === 'critical' ? 'bg-orange-50/20' : ''
                            }`}>
                            <td className="px-3 py-2.5 whitespace-nowrap">
                              <a href={row.zoho_url} target="_blank" rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-brand-600 font-mono text-xs font-medium hover:underline">
                                {row.zoho_ticket_number} <ExternalLink className="h-3 w-3" />
                              </a>
                            </td>
                            <td className="px-3 py-2.5 max-w-[200px]">
                              <span className="line-clamp-2 text-gray-800">{row.zoho_subject}</span>
                            </td>
                            <td className="px-3 py-2.5 whitespace-nowrap text-gray-600 text-xs">{row.zoho_project_name}</td>
                            <td className="px-3 py-2.5 whitespace-nowrap">
                              <StatusPill status={row.zoho_status} colorMap={ZOHO_STATUS_COLORS} />
                            </td>
                            <td className="px-3 py-2.5 whitespace-nowrap">
                              <a href={row.jira_url} target="_blank" rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-indigo-600 font-mono text-xs font-medium hover:underline">
                                {row.jira_key} <ExternalLink className="h-3 w-3" />
                              </a>
                            </td>
                            <td className="px-3 py-2.5 whitespace-nowrap">
                              <StatusPill status={row.jira_status} colorMap={JIRA_STATUS_COLORS} />
                            </td>
                            <td className="px-3 py-2.5 whitespace-nowrap text-gray-500 text-xs">
                              {row.jira_fix_versions?.join(', ') || '—'}
                            </td>
                            <td className="px-3 py-2.5 whitespace-nowrap text-gray-500 text-xs">
                              {row.jira_parent_key
                                ? <span title={row.jira_parent_summary}>{row.jira_parent_key}</span>
                                : row.jira_epic || '—'}
                            </td>
                            <td className="px-3 py-2.5 whitespace-nowrap">
                              <AgingBadge level={row.zoho_aging_level} days={row.zoho_days_open} />
                            </td>
                            <td className="px-3 py-2.5 whitespace-nowrap text-gray-400 text-xs">
                              {row.zoho_created ? format(parseISO(row.zoho_created), 'MMM d') : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Pagination */}
                  {totalPages > 1 && (
                    <div className="flex items-center justify-between mt-3 text-xs text-gray-500">
                      <span>{filteredLinked.length} tickets</span>
                      <div className="flex items-center gap-2">
                        <button className="btn-secondary py-1 px-2 text-xs disabled:opacity-40"
                          disabled={linkedPage === 1} onClick={() => setLinkedPage(p => p - 1)}>← Prev</button>
                        <span>Page {linkedPage} of {totalPages}</span>
                        <button className="btn-secondary py-1 px-2 text-xs disabled:opacity-40"
                          disabled={linkedPage === totalPages} onClick={() => setLinkedPage(p => p + 1)}>Next →</button>
                      </div>
                    </div>
                  )}

                  {filteredLinked.length === 0 && (
                    <p className="text-center py-10 text-gray-400 text-sm">No tickets match the current filters.</p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

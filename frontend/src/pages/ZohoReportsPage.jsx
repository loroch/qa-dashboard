import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { Header } from '../components/layout/Header'
import { PageLoader, ErrorState } from '../components/common/LoadingSpinner'
import { Badge, AgingBadge } from '../components/common/Badge'
import { ExternalLink, Link, BarChart2 } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import axios from 'axios'

const api = axios.create({ baseURL: '/api', timeout: 60000 })
const getProjectReport = () => api.get('/zoho/reports/by-project').then(r => r.data)
const getLinkedReport  = () => api.get('/zoho/reports/linked').then(r => r.data)

const JIRA_STATUS_COLORS = {
  'Done':               'bg-green-100 text-green-700',
  'In Progress':        'bg-blue-100 text-blue-700',
  'Ready for Testing':  'bg-purple-100 text-purple-700',
  'In Review':          'bg-indigo-100 text-indigo-700',
  'Blocked':            'bg-red-100 text-red-700',
  'Open':               'bg-gray-100 text-gray-600',
  'Reopened':           'bg-orange-100 text-orange-700',
  'Not found':          'bg-gray-50 text-gray-400 italic',
}

const ZOHO_STATUS_COLORS = {
  'Open':        'bg-blue-100 text-blue-700',
  'Closed':      'bg-gray-100 text-gray-600',
  'On Hold':     'bg-yellow-100 text-yellow-700',
  'Pending':     'bg-orange-100 text-orange-700',
  'Resolved':    'bg-green-100 text-green-700',
  'New':         'bg-teal-100 text-teal-700',
  'In Process':  'bg-blue-100 text-blue-700',
  'RND Investigation': 'bg-purple-100 text-purple-700',
}

function StatusPill({ status, colorMap }) {
  const cls = colorMap[status] || 'bg-gray-100 text-gray-600'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {status || '—'}
    </span>
  )
}

const TABS = ['By Project & Status', 'Zoho ↔ Jira Linked']

export default function ZohoReportsPage() {
  const [tab, setTab] = useState('By Project & Status')
  const [linkedPage, setLinkedPage] = useState(1)
  const [projectFilter, setProjectFilter] = useState('')
  const [jiraStatusFilter, setJiraStatusFilter] = useState('')
  const PAGE_SIZE = 30

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
    ['zoho-project-report'], ['zoho-linked-report']
  ])

  const byProject = projectQuery.data?.by_project || []

  // Filter + paginate linked report
  const allLinked = linkedQuery.data || []
  const filteredLinked = allLinked.filter(r => {
    const matchProject = !projectFilter || (r.zoho_project_name || '').toLowerCase().includes(projectFilter.toLowerCase())
    const matchStatus = !jiraStatusFilter || (r.jira_status || '').toLowerCase().includes(jiraStatusFilter.toLowerCase())
    return matchProject && matchStatus
  })
  const totalPages = Math.ceil(filteredLinked.length / PAGE_SIZE)
  const pagedLinked = filteredLinked.slice((linkedPage - 1) * PAGE_SIZE, linkedPage * PAGE_SIZE)

  // Unique Jira statuses for filter dropdown
  const jiraStatuses = [...new Set(allLinked.map(r => r.jira_status).filter(Boolean))].sort()

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Zoho Reports"
        lastRefresh={lastRefresh}
        isRefreshing={isRefreshing}
        onRefresh={() => refresh(true)}
        exportOptions={[
          { label: 'Linked Report CSV',   href: '/api/zoho/reports/linked/export/csv' },
          { label: 'Linked Report Excel', href: '/api/zoho/reports/linked/export/excel' },
          { label: 'All Tickets CSV',     href: '/api/zoho/tickets/export/csv' },
        ]}
      />

      <div className="flex-1 p-6 space-y-4 overflow-auto">
        {/* Tabs */}
        <div className="card p-0 overflow-hidden">
          <div className="flex border-b border-gray-200 bg-gray-50">
            {TABS.map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-6 py-3 text-sm font-medium whitespace-nowrap transition-colors ${
                  tab === t ? 'bg-white text-brand-600 border-b-2 border-brand-600' : 'text-gray-500 hover:text-gray-700'
                }`}>
                {t === 'By Project & Status' ? <><BarChart2 className="inline h-3.5 w-3.5 mr-1.5" />{t}</> : <><Link className="inline h-3.5 w-3.5 mr-1.5" />{t}</>}
              </button>
            ))}
          </div>

          {/* ─── TAB 1: By Project & Status ─── */}
          {tab === 'By Project & Status' && (
            <div className="p-5">
              {projectQuery.isLoading && <PageLoader />}
              {projectQuery.isError && <ErrorState message={projectQuery.error?.message} onRetry={projectQuery.refetch} />}
              {!projectQuery.isLoading && (
                <>
                  <p className="text-sm text-gray-500 mb-4">{byProject.length} projects · {byProject.reduce((s, p) => s + p.total, 0)} total tickets</p>

                  {/* Project cards grid */}
                  <div className="space-y-4">
                    {byProject.map(project => (
                      <div key={project.project_name} className="border border-gray-200 rounded-xl overflow-hidden">
                        {/* Project header */}
                        <div className="flex items-center justify-between bg-brand-50 px-4 py-3 border-b border-gray-200">
                          <div className="flex items-center gap-3">
                            <h3 className="font-semibold text-brand-800">{project.project_name}</h3>
                          </div>
                          <span className="text-2xl font-bold text-brand-600">{project.total}</span>
                        </div>

                        {/* Status breakdown */}
                        <div className="p-4">
                          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
                            {project.statuses.map(s => (
                              <div key={s.status}
                                className="bg-white border border-gray-100 rounded-lg p-3 text-center shadow-sm">
                                <p className="text-xl font-bold text-gray-800">{s.count}</p>
                                <StatusPill status={s.status} colorMap={ZOHO_STATUS_COLORS} />
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    ))}

                    {byProject.length === 0 && (
                      <div className="text-center py-12 text-gray-400">
                        No project data found. Make sure the "Project Name" custom field is filled in Zoho Desk.
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* ─── TAB 2: Zoho ↔ Jira Linked ─── */}
          {tab === 'Zoho ↔ Jira Linked' && (
            <div className="p-5">
              {linkedQuery.isLoading && (
                <div className="text-center py-12 text-gray-500">
                  <div className="h-8 w-8 border-2 border-brand-200 border-t-brand-600 rounded-full animate-spin mx-auto mb-3" />
                  <p className="text-sm">Fetching Zoho tickets and cross-referencing Jira issues…</p>
                  <p className="text-xs text-gray-400 mt-1">This may take 10–30 seconds on first load</p>
                </div>
              )}
              {linkedQuery.isError && <ErrorState message={linkedQuery.error?.message} onRetry={linkedQuery.refetch} />}

              {!linkedQuery.isLoading && !linkedQuery.isError && (
                <>
                  {/* Filters */}
                  <div className="flex flex-wrap gap-3 mb-4">
                    <input
                      className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                      placeholder="Filter by project..."
                      value={projectFilter}
                      onChange={e => { setProjectFilter(e.target.value); setLinkedPage(1) }}
                    />
                    <select
                      className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white"
                      value={jiraStatusFilter}
                      onChange={e => { setJiraStatusFilter(e.target.value); setLinkedPage(1) }}
                    >
                      <option value="">All Jira statuses</option>
                      {jiraStatuses.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <span className="self-center text-sm text-gray-500">
                      {filteredLinked.length} of {allLinked.length} linked tickets
                    </span>
                  </div>

                  {/* Summary stats */}
                  <div className="flex flex-wrap gap-3 mb-4">
                    {[...new Set(filteredLinked.map(r => r.jira_status))].map(status => {
                      const count = filteredLinked.filter(r => r.jira_status === status).length
                      return (
                        <div key={status} className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-2">
                          <StatusPill status={status} colorMap={JIRA_STATUS_COLORS} />
                          <span className="font-bold text-gray-700 text-sm">{count}</span>
                        </div>
                      )
                    })}
                  </div>

                  {/* Table */}
                  <div className="overflow-x-auto rounded-lg border border-gray-200">
                    <table className="min-w-full text-sm bg-white">
                      <thead className="bg-gray-50 border-b border-gray-200">
                        <tr>
                          {['Zoho #', 'Subject', 'Project', 'Zoho Status',
                            'Bug ID → Jira', 'Jira Status', 'Fix Versions',
                            'Parent', 'Days Open', 'Created'].map(h => (
                            <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {pagedLinked.map(row => (
                          <tr key={row.zoho_id}
                            className={`hover:bg-gray-50 ${
                              row.zoho_aging_level === 'overdue' ? 'bg-red-50/30' :
                              row.zoho_aging_level === 'critical' ? 'bg-orange-50/20' : ''
                            }`}>
                            {/* Zoho ticket link */}
                            <td className="px-3 py-2.5 whitespace-nowrap">
                              <a href={row.zoho_url} target="_blank" rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-brand-600 font-mono text-xs font-medium hover:underline">
                                {row.zoho_ticket_number} <ExternalLink className="h-3 w-3" />
                              </a>
                            </td>
                            {/* Subject */}
                            <td className="px-3 py-2.5 max-w-[200px]">
                              <span className="line-clamp-2 text-gray-800">{row.zoho_subject}</span>
                            </td>
                            {/* Project */}
                            <td className="px-3 py-2.5 whitespace-nowrap text-gray-600 text-xs">
                              {row.zoho_project_name}
                            </td>
                            {/* Zoho status */}
                            <td className="px-3 py-2.5 whitespace-nowrap">
                              <StatusPill status={row.zoho_status} colorMap={ZOHO_STATUS_COLORS} />
                            </td>
                            {/* Jira key link */}
                            <td className="px-3 py-2.5 whitespace-nowrap">
                              <a href={row.jira_url} target="_blank" rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-indigo-600 font-mono text-xs font-medium hover:underline">
                                {row.jira_key} <ExternalLink className="h-3 w-3" />
                              </a>
                            </td>
                            {/* Jira status */}
                            <td className="px-3 py-2.5 whitespace-nowrap">
                              <StatusPill status={row.jira_status} colorMap={JIRA_STATUS_COLORS} />
                            </td>
                            {/* Fix versions */}
                            <td className="px-3 py-2.5 whitespace-nowrap text-gray-500 text-xs">
                              {row.jira_fix_versions?.join(', ') || '—'}
                            </td>
                            {/* Parent */}
                            <td className="px-3 py-2.5 whitespace-nowrap text-gray-500 text-xs max-w-[120px] truncate">
                              {row.jira_parent_key
                                ? <span title={row.jira_parent_summary}>{row.jira_parent_key}</span>
                                : row.jira_epic || '—'
                              }
                            </td>
                            {/* Days open */}
                            <td className="px-3 py-2.5 whitespace-nowrap">
                              <AgingBadge level={row.zoho_aging_level} days={row.zoho_days_open} />
                            </td>
                            {/* Created */}
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
                      <span>{filteredLinked.length} linked tickets</span>
                      <div className="flex items-center gap-2">
                        <button className="btn-secondary py-1 px-2 text-xs disabled:opacity-40"
                          disabled={linkedPage === 1} onClick={() => setLinkedPage(p => p - 1)}>← Prev</button>
                        <span>Page {linkedPage} of {totalPages}</span>
                        <button className="btn-secondary py-1 px-2 text-xs disabled:opacity-40"
                          disabled={linkedPage === totalPages} onClick={() => setLinkedPage(p => p + 1)}>Next →</button>
                      </div>
                    </div>
                  )}

                  {filteredLinked.length === 0 && !linkedQuery.isLoading && (
                    <div className="text-center py-12 text-gray-400">
                      No linked tickets found. Make sure the "Bug ID" custom field is filled with Jira issue numbers in Zoho Desk.
                    </div>
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

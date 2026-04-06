import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { Header } from '../components/layout/Header'
import { SummaryCard } from '../components/cards/SummaryCard'
import { PageLoader, ErrorState } from '../components/common/LoadingSpinner'
import { Badge, AgingBadge, PriorityBadge } from '../components/common/Badge'
import { ExternalLink, Ticket, AlertTriangle, Users, Building2, Calendar } from 'lucide-react'
import { format, parseISO, subMonths } from 'date-fns'
import axios from 'axios'

const api = axios.create({ baseURL: '/api', timeout: 30000 })
const getZohoDashboard = (params) => api.get('/zoho/dashboard', { params }).then(r => r.data)

const TABS = ['By Department', 'By Assignee', 'By Status', 'All Tickets', 'Overdue']

const STATUS_COLORS = {
  'Open':     'bg-blue-100 text-blue-700',
  'Closed':   'bg-gray-100 text-gray-600',
  'On Hold':  'bg-yellow-100 text-yellow-700',
  'Pending':  'bg-orange-100 text-orange-700',
  'Resolved': 'bg-green-100 text-green-700',
}

const DATE_RANGE_OPTIONS = [
  { label: 'All time', value: 0 },
  { label: 'Last month', value: 1 },
  { label: 'Last 2 months', value: 2 },
  { label: 'Last 3 months', value: 3 },
]

function StatusBadge({ status }) {
  const cls = STATUS_COLORS[status] || 'bg-gray-100 text-gray-600'
  return <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{status || '—'}</span>
}

function TicketRow({ ticket }) {
  return (
    <tr className={`hover:bg-gray-50 transition-colors ${ticket.aging_level === 'overdue' ? 'bg-red-50/30' : ticket.aging_level === 'critical' ? 'bg-orange-50/20' : ''}`}>
      <td className="px-3 py-2.5 whitespace-nowrap">
        <a href={ticket.url} target="_blank" rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-brand-600 font-mono text-xs font-medium hover:underline">
          {ticket.ticket_number} <ExternalLink className="h-3 w-3" />
        </a>
      </td>
      <td className="px-3 py-2.5 max-w-xs">
        <span className="line-clamp-2 text-gray-800 text-sm">{ticket.subject}</span>
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap"><StatusBadge status={ticket.status} /></td>
      <td className="px-3 py-2.5 whitespace-nowrap"><PriorityBadge priority={ticket.priority} /></td>
      <td className="px-3 py-2.5 whitespace-nowrap text-gray-600 text-xs">{ticket.assignee_name || '—'}</td>
      <td className="px-3 py-2.5 whitespace-nowrap text-gray-500 text-xs">{ticket.department_name || '—'}</td>
      <td className="px-3 py-2.5 whitespace-nowrap text-gray-500 text-xs">{ticket.contact_name || '—'}</td>
      <td className="px-3 py-2.5 whitespace-nowrap">
        <AgingBadge level={ticket.aging_level} days={ticket.days_open} />
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap text-gray-400 text-xs">
        {ticket.created ? format(parseISO(ticket.created), 'MMM d') : '—'}
      </td>
    </tr>
  )
}

function TicketTable({ tickets = [] }) {
  const [page, setPage] = useState(1)
  const pageSize = 25
  const totalPages = Math.ceil(tickets.length / pageSize)
  const paged = tickets.slice((page - 1) * pageSize, page * pageSize)

  if (!tickets.length) return <p className="text-gray-400 text-sm text-center py-8">No tickets found.</p>

  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full text-sm bg-white">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              {['#', 'Subject', 'Status', 'Priority', 'Assignee', 'Department', 'Contact', 'Age', 'Created'].map(h => (
                <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {paged.map(t => <TicketRow key={t.id} ticket={t} />)}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-3 text-xs text-gray-500">
          <span>{tickets.length} total tickets</span>
          <div className="flex items-center gap-2">
            <button className="btn-secondary py-1 px-2 text-xs disabled:opacity-40" disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</button>
            <span>Page {page} of {totalPages}</span>
            <button className="btn-secondary py-1 px-2 text-xs disabled:opacity-40" disabled={page === totalPages} onClick={() => setPage(p => p + 1)}>Next →</button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function ZohoDeskPage() {
  const [tab, setTab] = useState('By Department')
  const [monthRange, setMonthRange] = useState(0)

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['zoho-dashboard'],
    queryFn: () => getZohoDashboard({}),
    refetchInterval: 5 * 60 * 1000,
  })

  const { lastRefresh, isRefreshing, refresh } = useAutoRefresh([['zoho-dashboard']])

  // Filter all tickets by created date
  const filteredTickets = useMemo(() => {
    const tickets = data?.all_tickets || []
    if (!monthRange) return tickets
    const cutoff = subMonths(new Date(), monthRange)
    return tickets.filter(t => t.created && parseISO(t.created) >= cutoff)
  }, [data, monthRange])

  // Re-derive aggregated views from filtered tickets
  const byDept = useMemo(() => {
    const map = {}
    filteredTickets.forEach(t => {
      const dept = t.department_name || 'Unknown'
      if (!map[dept]) map[dept] = { department: dept, count: 0, open: 0, overdue: 0, tickets: [] }
      map[dept].count++
      if (t.status === 'Open') map[dept].open++
      if (t.aging_level === 'overdue' || t.is_overdue) map[dept].overdue++
      map[dept].tickets.push(t)
    })
    return Object.values(map).sort((a, b) => b.count - a.count)
  }, [filteredTickets])

  const byAssignee = useMemo(() => {
    const map = {}
    filteredTickets.forEach(t => {
      const name = t.assignee_name || 'Unassigned'
      if (!map[name]) map[name] = { assignee: name, count: 0, overdue: 0 }
      map[name].count++
      if (t.aging_level === 'overdue' || t.is_overdue) map[name].overdue++
    })
    return Object.values(map).sort((a, b) => b.count - a.count)
  }, [filteredTickets])

  const byStatus = useMemo(() => {
    const map = {}
    filteredTickets.forEach(t => {
      const s = t.status || 'Unknown'
      map[s] = (map[s] || 0) + 1
    })
    return Object.entries(map).map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count)
  }, [filteredTickets])

  const overdue = useMemo(() =>
    filteredTickets.filter(t => t.aging_level === 'overdue' || t.is_overdue),
    [filteredTickets]
  )

  const summary = useMemo(() => ({
    total_tickets: filteredTickets.length,
    open_tickets: filteredTickets.filter(t => t.status === 'Open').length,
    overdue_tickets: overdue.length,
    departments: byDept.length,
  }), [filteredTickets, overdue, byDept])

  if (isLoading) return <PageLoader />
  if (isError) return <div className="flex-1 p-6"><ErrorState message={error?.message} onRetry={refetch} /></div>

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Zoho Desk — Tickets"
        lastRefresh={lastRefresh}
        isRefreshing={isRefreshing}
        onRefresh={() => refresh(true)}
        exportOptions={[
          { label: 'Export CSV', href: '/api/zoho/tickets/export/csv' },
        ]}
      />
      <div className="flex-1 p-6 space-y-5 overflow-auto">

        {/* Date range filter */}
        <div className="flex items-center gap-2">
          <Calendar className="h-4 w-4 text-gray-400" />
          <span className="text-sm text-gray-500">Created:</span>
          <div className="flex gap-1">
            {DATE_RANGE_OPTIONS.map(opt => (
              <button key={opt.value}
                onClick={() => setMonthRange(opt.value)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  monthRange === opt.value
                    ? 'bg-brand-600 text-white'
                    : 'bg-white border border-gray-200 text-gray-600 hover:border-brand-300'
                }`}>
                {opt.label}
              </button>
            ))}
          </div>
          {monthRange > 0 && (
            <span className="text-xs text-gray-400 ml-1">
              Showing {filteredTickets.length} of {data?.all_tickets?.length || 0} tickets
            </span>
          )}
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <SummaryCard title="Total Tickets" value={summary.total_tickets} icon={Ticket} color="blue" />
          <SummaryCard title="Open" value={summary.open_tickets} icon={Ticket} color="green" />
          <SummaryCard title="Overdue" value={summary.overdue_tickets} icon={AlertTriangle} color="red" />
          <SummaryCard title="Departments" value={summary.departments} icon={Building2} color="purple" />
        </div>

        {/* Status summary pills */}
        <div className="flex flex-wrap gap-2">
          {byStatus.map(s => (
            <div key={s.status} className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-3 py-2">
              <StatusBadge status={s.status} />
              <span className="font-bold text-gray-800">{s.count}</span>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div className="card p-0 overflow-hidden">
          <div className="flex border-b border-gray-200 bg-gray-50 overflow-x-auto">
            {TABS.map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-5 py-3 text-sm font-medium whitespace-nowrap transition-colors ${
                  tab === t ? 'bg-white text-brand-600 border-b-2 border-brand-600' : 'text-gray-500 hover:text-gray-700'
                }`}>
                {t}
                {t === 'Overdue' && overdue.length > 0 && (
                  <span className="ml-1.5 bg-red-500 text-white text-xs rounded-full px-1.5 py-0.5">{overdue.length}</span>
                )}
              </button>
            ))}
          </div>

          <div className="p-5">
            {/* By Department */}
            {tab === 'By Department' && (
              <div className="space-y-6">
                {byDept.map(dept => (
                  <div key={dept.department}>
                    <div className="flex items-center gap-3 mb-3">
                      <Building2 className="h-4 w-4 text-brand-500" />
                      <h3 className="font-semibold text-gray-800">{dept.department}</h3>
                      <Badge label={`${dept.count} tickets`} variant="default" />
                      {dept.open > 0 && <Badge label={`${dept.open} open`} variant="ok" />}
                      {dept.overdue > 0 && <Badge label={`${dept.overdue} overdue`} variant="overdue" />}
                    </div>
                    <TicketTable tickets={dept.tickets} />
                  </div>
                ))}
                {byDept.length === 0 && <p className="text-gray-400 text-sm text-center py-8">No tickets found.</p>}
              </div>
            )}

            {/* By Assignee */}
            {tab === 'By Assignee' && (
              <div className="space-y-3">
                {byAssignee.map(a => (
                  <div key={a.assignee} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                    <div className="flex items-center gap-3">
                      <Users className="h-4 w-4 text-gray-400" />
                      <span className="font-medium text-gray-800">{a.assignee}</span>
                      {a.overdue > 0 && <Badge label={`${a.overdue} overdue`} variant="overdue" />}
                    </div>
                    <span className="text-2xl font-bold text-brand-600">{a.count}</span>
                  </div>
                ))}
                {byAssignee.length === 0 && <p className="text-gray-400 text-sm text-center py-8">No tickets found.</p>}
              </div>
            )}

            {/* By Status */}
            {tab === 'By Status' && (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {byStatus.map(s => (
                  <div key={s.status} className="card border border-gray-100 text-center">
                    <p className="text-3xl font-bold text-brand-600">{s.count}</p>
                    <StatusBadge status={s.status} />
                  </div>
                ))}
                {byStatus.length === 0 && <p className="text-gray-400 text-sm text-center py-8">No tickets found.</p>}
              </div>
            )}

            {/* All Tickets */}
            {tab === 'All Tickets' && <TicketTable tickets={filteredTickets} />}

            {/* Overdue */}
            {tab === 'Overdue' && (
              overdue.length === 0
                ? <div className="text-center py-12 text-gray-400">
                    <AlertTriangle className="h-10 w-10 mx-auto mb-3 text-green-300" />
                    <p className="font-medium text-green-600">No overdue tickets!</p>
                  </div>
                : <TicketTable tickets={overdue} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getDashboard, exportUrl } from '../services/api'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { Header } from '../components/layout/Header'
import { SummaryCard } from '../components/cards/SummaryCard'
import { PageLoader, ErrorState } from '../components/common/LoadingSpinner'
import { AgingBadge, PriorityBadge, Badge } from '../components/common/Badge'
import { ExternalLink, Clock } from 'lucide-react'
import { format, parseISO } from 'date-fns'

const LEVELS = [
  { key: 'overdue',  label: 'Overdue (14+ days)',   color: 'bg-red-50 border-red-200 text-red-700' },
  { key: 'critical', label: 'Critical (7-13 days)',  color: 'bg-orange-50 border-orange-200 text-orange-700' },
  { key: 'warning',  label: 'Warning (3-6 days)',    color: 'bg-yellow-50 border-yellow-200 text-yellow-700' },
]

export default function AgingReport() {
  const [filters, setFilters] = useState({})

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['dashboard-aging', filters],
    queryFn: () => getDashboard({ ...filters }),
    refetchInterval: 5 * 60 * 1000,
  })

  const { lastRefresh, isRefreshing, refresh } = useAutoRefresh([['dashboard-aging', filters]])

  if (isLoading) return <PageLoader />
  if (isError) return <div className="flex-1 p-6"><ErrorState message={error?.message} onRetry={refetch} /></div>

  const aging = data?.aging_report || []
  const overdue = aging.filter(a => a.aging_level === 'overdue')
  const critical = aging.filter(a => a.aging_level === 'critical')
  const warning = aging.filter(a => a.aging_level === 'warning')

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Aging Report"
        lastRefresh={lastRefresh}
        isRefreshing={isRefreshing}
        onRefresh={() => refresh(true)}
        onFilter={setFilters}
        exportOptions={[
          { label: 'Export CSV', href: exportUrl('ready-for-testing/csv') },
          { label: 'Export Excel', href: exportUrl('ready-for-testing/excel') },
        ]}
      />
      <div className="flex-1 p-6 space-y-5 overflow-auto">
        <div className="grid grid-cols-3 gap-4">
          <SummaryCard title="Overdue (14+ days)" value={overdue.length} color="red" icon={Clock} />
          <SummaryCard title="Critical (7-13 days)" value={critical.length} color="orange" icon={Clock} />
          <SummaryCard title="Warning (3-6 days)" value={warning.length} color="gray" icon={Clock} />
        </div>

        {LEVELS.map(({ key, label, color }) => {
          const items = aging.filter(a => a.aging_level === key)
          if (items.length === 0) return null
          return (
            <div key={key}>
              <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-semibold mb-3 ${color}`}>
                <Clock className="h-3.5 w-3.5" />
                {label} — {items.length} items
              </div>
              <div className="overflow-x-auto rounded-lg border border-gray-200">
                <table className="min-w-full text-sm bg-white">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      {['Key', 'Summary', 'QA Owner', 'Priority', 'Days in Status', 'Versions', 'Epic/Bundle', 'Last Updated'].map(h => (
                        <th key={h} className="px-3 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {items.map(({ issue, days_in_status, aging_level }) => (
                      <tr key={issue.key} className="hover:bg-gray-50">
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <a href={issue.url} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-brand-600 font-mono text-xs hover:underline">
                            {issue.key} <ExternalLink className="h-3 w-3" />
                          </a>
                        </td>
                        <td className="px-3 py-2.5 max-w-xs">
                          <span className="line-clamp-2 text-gray-800">{issue.summary}</span>
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-gray-600 text-xs">
                          {issue.qa_owner?.display_name || issue.assignee?.display_name || '—'}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <PriorityBadge priority={issue.priority} />
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <AgingBadge level={aging_level} days={days_in_status} />
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-gray-500 text-xs">
                          {issue.fix_versions?.map(v => v.name).join(', ') || '—'}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-gray-500 text-xs">
                          {issue.epic_name || issue.bundle || '—'}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap text-gray-400 text-xs">
                          {issue.updated ? format(parseISO(issue.updated), 'MMM d') : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )
        })}

        {aging.length === 0 && (
          <div className="card text-center py-12 text-gray-400">
            <Clock className="h-10 w-10 mx-auto mb-3 text-green-300" />
            <p className="font-medium text-green-600">No aging items!</p>
            <p className="text-sm mt-1">All items are within the 3-day threshold.</p>
          </div>
        )}
      </div>
    </div>
  )
}

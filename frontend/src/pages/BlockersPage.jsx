import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getDashboard } from '../services/api'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { Header } from '../components/layout/Header'
import { IssueTable } from '../components/tables/DataTable'
import { SummaryCard } from '../components/cards/SummaryCard'
import { PageLoader, ErrorState } from '../components/common/LoadingSpinner'
import { AlertTriangle } from 'lucide-react'

export default function BlockersPage() {
  const [filters, setFilters] = useState({})

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['dashboard-blockers', filters],
    queryFn: () => getDashboard({ ...filters }),
    refetchInterval: 5 * 60 * 1000,
  })

  const { lastRefresh, isRefreshing, refresh } = useAutoRefresh([['dashboard-blockers', filters]])

  if (isLoading) return <PageLoader />
  if (isError) return <div className="flex-1 p-6"><ErrorState message={error?.message} onRetry={refetch} /></div>

  const blockers = data?.blockers || []
  const highest = blockers.filter(i => i.priority === 'Highest' || i.priority === 'Critical')
  const high = blockers.filter(i => i.priority === 'High')

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Blockers & Critical Items"
        lastRefresh={lastRefresh}
        isRefreshing={isRefreshing}
        onRefresh={() => refresh(true)}
        onFilter={setFilters}
      />
      <div className="flex-1 p-6 space-y-5 overflow-auto">
        <div className="grid grid-cols-3 gap-4">
          <SummaryCard title="Total Blockers" value={blockers.length} icon={AlertTriangle} color="red" />
          <SummaryCard title="Highest / Critical" value={highest.length} icon={AlertTriangle} color="red" />
          <SummaryCard title="High Priority" value={high.length} icon={AlertTriangle} color="orange" />
        </div>

        {blockers.length === 0 ? (
          <div className="card text-center py-12 text-gray-400">
            <AlertTriangle className="h-10 w-10 mx-auto mb-3 text-green-300" />
            <p className="font-medium text-green-600">No blockers!</p>
            <p className="text-sm mt-1">No critical or highest priority items assigned to the team.</p>
          </div>
        ) : (
          <div className="card">
            <h2 className="font-semibold text-gray-800 text-sm mb-4">All Blockers</h2>
            <IssueTable issues={blockers} />
          </div>
        )}
      </div>
    </div>
  )
}

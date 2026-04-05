import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getDashboard, exportUrl } from '../services/api'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { Header } from '../components/layout/Header'
import { IssueTable } from '../components/tables/DataTable'
import { SummaryCard } from '../components/cards/SummaryCard'
import { PageLoader, ErrorState } from '../components/common/LoadingSpinner'
import { Bug } from 'lucide-react'

export default function BugsReport() {
  const [filters, setFilters] = useState({})

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['dashboard-bugs', filters],
    queryFn: () => getDashboard({ ...filters }),
    refetchInterval: 5 * 60 * 1000,
  })

  const { lastRefresh, isRefreshing, refresh } = useAutoRefresh([['dashboard-bugs', filters]])

  if (isLoading) return <PageLoader />
  if (isError) return <div className="flex-1 p-6"><ErrorState message={error?.message} onRetry={refetch} /></div>

  const bugs = data?.bugs_30d || []
  const highest = bugs.filter(b => b.priority === 'Highest' || b.priority === 'Critical').length
  const open = bugs.filter(b => b.status_category !== 'Done').length

  // Group by creator
  const byCreator = {}
  bugs.forEach(b => {
    const name = b.reporter?.display_name || 'Unknown'
    byCreator[name] = (byCreator[name] || 0) + 1
  })

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Bugs — Last 30 Days"
        lastRefresh={lastRefresh}
        isRefreshing={isRefreshing}
        onRefresh={() => refresh(true)}
        onFilter={setFilters}
        exportOptions={[
          { label: 'Export CSV', href: exportUrl('bugs/csv') },
          { label: 'Export Excel', href: exportUrl('bugs/excel') },
        ]}
      />
      <div className="flex-1 p-6 space-y-5 overflow-auto">
        <div className="grid grid-cols-3 gap-4">
          <SummaryCard title="Total Bugs (30d)" value={bugs.length} icon={Bug} color="red" />
          <SummaryCard title="Highest / Critical" value={highest} icon={Bug} color="red" />
          <SummaryCard title="Still Open" value={open} icon={Bug} color="orange" />
        </div>

        {/* By creator summary */}
        {Object.keys(byCreator).length > 0 && (
          <div className="card">
            <h2 className="font-semibold text-gray-800 text-sm mb-3">Bugs by Reporter</h2>
            <div className="flex flex-wrap gap-3">
              {Object.entries(byCreator)
                .sort(([, a], [, b]) => b - a)
                .map(([name, count]) => (
                  <div key={name} className="bg-red-50 border border-red-100 rounded-lg px-4 py-3 text-center min-w-[100px]">
                    <p className="text-2xl font-bold text-red-600">{count}</p>
                    <p className="text-xs text-gray-600 mt-1">{name}</p>
                  </div>
                ))
              }
            </div>
          </div>
        )}

        <div className="card">
          <h2 className="font-semibold text-gray-800 text-sm mb-4">All Bugs</h2>
          <IssueTable issues={bugs} />
        </div>
      </div>
    </div>
  )
}

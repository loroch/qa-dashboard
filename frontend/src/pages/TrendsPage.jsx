import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getDashboard } from '../services/api'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { Header } from '../components/layout/Header'
import { TrendAreaChart, MemberBarChart, PriorityBarChart } from '../components/charts/TrendChart'
import { PageLoader, ErrorState } from '../components/common/LoadingSpinner'
import { TrendingUp } from 'lucide-react'
import { Badge } from '../components/common/Badge'

export default function TrendsPage() {
  const [filters, setFilters] = useState({})

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['dashboard-trends', filters],
    queryFn: () => getDashboard({ ...filters }),
    refetchInterval: 5 * 60 * 1000,
  })

  const { lastRefresh, isRefreshing, refresh } = useAutoRefresh([['dashboard-trends', filters]])

  if (isLoading) return <PageLoader />
  if (isError) return <div className="flex-1 p-6"><ErrorState message={error?.message} onRetry={refetch} /></div>

  const trend = data?.trend_data || []
  const byMember = data?.by_member || []
  const byPriority = data?.by_priority || []
  const activeAreas = data?.active_areas || []

  const totalCreated = trend.reduce((s, d) => s + d.created, 0)
  const totalRFT = trend.reduce((s, d) => s + d.ready_for_testing, 0)
  const totalBugs = trend.reduce((s, d) => s + d.bugs, 0)

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Trends — Last 7 Days"
        lastRefresh={lastRefresh}
        isRefreshing={isRefreshing}
        onRefresh={() => refresh(true)}
        onFilter={setFilters}
      />
      <div className="flex-1 p-6 space-y-5 overflow-auto">
        {/* Summary */}
        <div className="grid grid-cols-3 gap-4">
          <div className="card text-center">
            <p className="text-3xl font-bold text-brand-600">{totalCreated}</p>
            <p className="text-xs text-gray-500 mt-1">Items Created</p>
          </div>
          <div className="card text-center">
            <p className="text-3xl font-bold text-green-600">{totalRFT}</p>
            <p className="text-xs text-gray-500 mt-1">Moved to RFT</p>
          </div>
          <div className="card text-center">
            <p className="text-3xl font-bold text-red-600">{totalBugs}</p>
            <p className="text-xs text-gray-500 mt-1">Bugs Created</p>
          </div>
        </div>

        {/* Area chart */}
        <div className="card">
          <h2 className="font-semibold text-gray-800 text-sm mb-4">Daily Activity Trend</h2>
          <TrendAreaChart data={trend} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Member workload */}
          <div className="card">
            <h2 className="font-semibold text-gray-800 text-sm mb-4">Workload by Member</h2>
            <MemberBarChart data={byMember} />
          </div>

          {/* Active areas */}
          <div className="card">
            <h2 className="font-semibold text-gray-800 text-sm mb-3">Most Active Areas</h2>
            <div className="space-y-2">
              {activeAreas.slice(0, 10).map((area, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-24 shrink-0">
                    <Badge label={area.area_type} variant="default" />
                  </div>
                  <div className="flex-1 bg-gray-100 rounded-full h-2">
                    <div
                      className="bg-brand-500 h-2 rounded-full"
                      style={{ width: `${Math.min((area.count / (activeAreas[0]?.count || 1)) * 100, 100)}%` }}
                    />
                  </div>
                  <span className="text-sm font-semibold text-gray-700 w-8 text-right">{area.count}</span>
                  <span className="text-xs text-gray-500 truncate max-w-[100px]">{area.area}</span>
                </div>
              ))}
              {activeAreas.length === 0 && <p className="text-gray-400 text-sm">No activity data</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

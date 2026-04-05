import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  CheckSquare, Bug, Users, AlertTriangle, Clock, TrendingUp, Shield, Zap
} from 'lucide-react'
import { getDashboard, exportUrl } from '../services/api'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { Header } from '../components/layout/Header'
import { SummaryCard } from '../components/cards/SummaryCard'
import { TrendAreaChart, MemberBarChart } from '../components/charts/TrendChart'
import { IssueTable } from '../components/tables/DataTable'
import { PageLoader, ErrorState } from '../components/common/LoadingSpinner'
import { Badge } from '../components/common/Badge'

export default function Dashboard() {
  const [filters, setFilters] = useState({})

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['dashboard', filters],
    queryFn: () => getDashboard({ ...filters, refresh: false }),
    refetchInterval: 5 * 60 * 1000,
  })

  const { lastRefresh, isRefreshing, refresh } = useAutoRefresh([['dashboard', filters]])

  if (isLoading) return <PageLoader />
  if (isError) return (
    <div className="flex-1 p-6">
      <ErrorState message={error?.message} onRetry={refetch} />
    </div>
  )

  const s = data?.summary || {}
  const rft = data?.ready_for_testing || []
  const byMember = data?.by_member || []
  const trend = data?.trend_data || []
  const activeAreas = data?.active_areas || []
  const blockers = data?.blockers || []
  const recentActivity = data?.recent_activity || []

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="QA Overview"
        lastRefresh={lastRefresh}
        isRefreshing={isRefreshing}
        onRefresh={() => refresh(true)}
        onFilter={setFilters}
        exportOptions={[
          { label: 'RFT as CSV', href: exportUrl('ready-for-testing/csv') },
          { label: 'RFT as Excel', href: exportUrl('ready-for-testing/excel') },
          { label: 'Bugs as CSV', href: exportUrl('bugs/csv') },
        ]}
      />

      <div className="flex-1 p-6 space-y-6 overflow-auto">
        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <SummaryCard
            title="Ready for Testing"
            value={s.total_ready_for_testing}
            subtitle="Items awaiting QA"
            icon={CheckSquare}
            color="blue"
          />
          <SummaryCard
            title="Bugs (30 days)"
            value={s.total_bugs_30d}
            subtitle="Created by QA team"
            icon={Bug}
            color="red"
          />
          <SummaryCard
            title="Critical / Overdue"
            value={s.critical_items}
            subtitle={`${s.overdue_items} overdue`}
            icon={AlertTriangle}
            color="orange"
          />
          <SummaryCard
            title="Tests Written"
            value={s.total_tests_written || '—'}
            subtitle="Across all RFT items"
            icon={Shield}
            color="green"
          />
          <SummaryCard
            title="Overloaded Members"
            value={s.overloaded_members}
            subtitle="> 10 assigned items"
            icon={Users}
            color={s.overloaded_members > 0 ? 'orange' : 'gray'}
          />
          <SummaryCard
            title="No Work Assigned"
            value={s.members_with_no_work}
            subtitle="Team members idle"
            icon={Users}
            color={s.members_with_no_work > 0 ? 'red' : 'gray'}
          />
          <SummaryCard
            title="Active Blockers"
            value={blockers.length}
            subtitle="High/Highest priority"
            icon={Zap}
            color={blockers.length > 0 ? 'red' : 'gray'}
          />
          <SummaryCard
            title="Team Size"
            value={byMember.length}
            subtitle="QA engineers tracked"
            icon={TrendingUp}
            color="purple"
          />
        </div>

        {/* Charts row */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="card">
            <h2 className="font-semibold text-gray-800 text-sm mb-4">7-Day Activity Trend</h2>
            <TrendAreaChart data={trend} />
          </div>
          <div className="card">
            <h2 className="font-semibold text-gray-800 text-sm mb-4">Workload by QA Member</h2>
            <MemberBarChart data={byMember} />
          </div>
        </div>

        {/* Most active areas + member summary */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Active areas */}
          <div className="card">
            <h2 className="font-semibold text-gray-800 text-sm mb-3">Most Active Areas (7d)</h2>
            {activeAreas.length === 0
              ? <p className="text-gray-400 text-xs">No data</p>
              : (
                <div className="space-y-2">
                  {activeAreas.slice(0, 8).map((area, i) => (
                    <div key={i} className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <Badge label={area.area_type} variant="default" className="shrink-0" />
                        <span className="text-sm text-gray-700 truncate">{area.area}</span>
                      </div>
                      <span className="text-sm font-semibold text-gray-900 ml-2">{area.count}</span>
                    </div>
                  ))}
                </div>
              )
            }
          </div>

          {/* QA member summary */}
          <div className="card col-span-2">
            <h2 className="font-semibold text-gray-800 text-sm mb-3">Team Status</h2>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-xs text-gray-500 uppercase">
                    <th className="text-left py-1.5 pr-3">Member</th>
                    <th className="text-right py-1.5 px-3">RFT</th>
                    <th className="text-right py-1.5 px-3">Total</th>
                    <th className="text-right py-1.5 px-3">Avg Age</th>
                    <th className="text-left py-1.5 pl-3">Versions</th>
                    <th className="text-left py-1.5 pl-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {byMember.map((m) => (
                    <tr key={m.member_id} className="hover:bg-gray-50">
                      <td className="py-2 pr-3 font-medium text-gray-800">{m.member_name}</td>
                      <td className="py-2 px-3 text-right font-bold text-brand-600">{m.ready_for_testing_count}</td>
                      <td className="py-2 px-3 text-right text-gray-600">{m.total_assigned}</td>
                      <td className="py-2 px-3 text-right text-gray-500">{m.avg_days_in_status}d</td>
                      <td className="py-2 pl-3 text-gray-500 text-xs">
                        {m.versions.slice(0, 2).join(', ') || '—'}
                      </td>
                      <td className="py-2 pl-3">
                        {m.has_no_work
                          ? <Badge label="Idle" variant="warning" />
                          : m.overloaded
                            ? <Badge label="Overloaded" variant="critical" />
                            : <Badge label="Active" variant="ok" />
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Ready for Testing table */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-800 text-sm">
              Ready for Testing
              <span className="ml-2 text-brand-600 font-bold">{rft.length}</span>
            </h2>
          </div>
          <IssueTable issues={rft} compact />
        </div>

        {/* Recent activity */}
        {recentActivity.length > 0 && (
          <div className="card">
            <h2 className="font-semibold text-gray-800 text-sm mb-3">Recent QA Activity</h2>
            <IssueTable issues={recentActivity.slice(0, 20)} compact />
          </div>
        )}
      </div>
    </div>
  )
}

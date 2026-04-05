import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { getDashboard, exportUrl } from '../services/api'
import { Header } from '../components/layout/Header'
import { IssueTable } from '../components/tables/DataTable'
import { SummaryCard } from '../components/cards/SummaryCard'
import { PageLoader, ErrorState } from '../components/common/LoadingSpinner'
import { Badge } from '../components/common/Badge'
import { CheckSquare } from 'lucide-react'

const TABS = ['All', 'By Member', 'By Version', 'By Activity', 'By Priority']

export default function ReadyForTesting() {
  const [filters, setFilters] = useState({})
  const [tab, setTab] = useState('All')

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['dashboard-rft', filters],
    queryFn: () => getDashboard({ ...filters }),
    refetchInterval: 5 * 60 * 1000,
  })

  const { lastRefresh, isRefreshing, refresh } = useAutoRefresh([['dashboard-rft', filters]])

  if (isLoading) return <PageLoader />
  if (isError) return <div className="flex-1 p-6"><ErrorState message={error?.message} onRetry={refetch} /></div>

  const rft = data?.ready_for_testing || []
  const byMember = data?.by_member || []
  const byVersion = data?.by_version || []
  const byActivity = data?.by_activity || []
  const byPriority = data?.by_priority || []

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Ready for Testing"
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
        {/* Summary row */}
        <div className="grid grid-cols-4 gap-4">
          <SummaryCard title="Total RFT" value={rft.length} icon={CheckSquare} color="blue" />
          <SummaryCard title="Versions" value={new Set(rft.flatMap(i => i.fix_versions.map(v=>v.name))).size} color="purple" />
          <SummaryCard title="Overdue Items" value={rft.filter(i=>i.aging_level==='overdue').length} color="red" />
          <SummaryCard title="Avg Days in Status"
            value={(rft.reduce((s,i)=>s+i.days_in_status,0) / (rft.length || 1)).toFixed(1) + 'd'}
            color="orange" />
        </div>

        {/* Tabs */}
        <div className="card p-0 overflow-hidden">
          <div className="flex border-b border-gray-200 bg-gray-50">
            {TABS.map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-5 py-3 text-sm font-medium transition-colors ${
                  tab === t
                    ? 'bg-white text-brand-600 border-b-2 border-brand-600'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="p-5">
            {tab === 'All' && <IssueTable issues={rft} />}

            {tab === 'By Member' && (
              <div className="space-y-6">
                {byMember.filter(m => m.issues.length > 0).map(member => (
                  <div key={member.member_id}>
                    <div className="flex items-center gap-3 mb-3">
                      <h3 className="font-semibold text-gray-800">{member.member_name}</h3>
                      <Badge label={`${member.ready_for_testing_count} RFT`} variant="ok" />
                      <Badge label={`${member.total_assigned} total`} variant="default" />
                      {member.overloaded && <Badge label="Overloaded" variant="critical" />}
                      {member.has_no_work && <Badge label="Idle" variant="warning" />}
                    </div>
                    <IssueTable issues={member.issues} compact />
                  </div>
                ))}
                {byMember.every(m => m.issues.length === 0) && (
                  <p className="text-gray-400 text-sm text-center py-8">No issues found for team members.</p>
                )}
              </div>
            )}

            {tab === 'By Version' && (
              <div className="space-y-6">
                {byVersion.map(v => (
                  <div key={v.version}>
                    <div className="flex items-center gap-3 mb-3">
                      <h3 className="font-semibold text-gray-800">{v.version}</h3>
                      <Badge label={`${v.count} items`} variant="default" />
                    </div>
                    <IssueTable issues={v.issues} compact />
                  </div>
                ))}
              </div>
            )}

            {tab === 'By Activity' && (
              <div className="space-y-6">
                {byActivity.map(a => (
                  <div key={a.activity}>
                    <div className="flex items-center gap-3 mb-3">
                      <h3 className="font-semibold text-gray-800">{a.activity}</h3>
                      <Badge label={`${a.count} items`} variant="default" />
                    </div>
                    <IssueTable issues={a.issues} compact />
                  </div>
                ))}
              </div>
            )}

            {tab === 'By Priority' && (
              <div className="space-y-4">
                {byPriority.map(p => (
                  <div key={p.priority} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                    <span className="font-medium text-gray-700">{p.priority}</span>
                    <span className="text-2xl font-bold text-brand-600">{p.count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

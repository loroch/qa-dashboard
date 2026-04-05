import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getDashboard } from '../services/api'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { Header } from '../components/layout/Header'
import { IssueTable } from '../components/tables/DataTable'
import { PageLoader, ErrorState } from '../components/common/LoadingSpinner'
import { Badge, AgingBadge } from '../components/common/Badge'
import { Users } from 'lucide-react'

export default function TeamOverview() {
  const [filters, setFilters] = useState({})
  const [selected, setSelected] = useState(null)

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['dashboard-team', filters],
    queryFn: () => getDashboard({ ...filters }),
    refetchInterval: 5 * 60 * 1000,
  })

  const { lastRefresh, isRefreshing, refresh } = useAutoRefresh([['dashboard-team', filters]])

  if (isLoading) return <PageLoader />
  if (isError) return <div className="flex-1 p-6"><ErrorState message={error?.message} onRetry={refetch} /></div>

  const byMember = data?.by_member || []
  const selectedMember = selected ? byMember.find(m => m.member_id === selected) : null

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Team Overview"
        lastRefresh={lastRefresh}
        isRefreshing={isRefreshing}
        onRefresh={() => refresh(true)}
        onFilter={setFilters}
      />
      <div className="flex-1 p-6 overflow-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-6">
          {byMember.map((member) => (
            <div
              key={member.member_id}
              className={`card cursor-pointer transition-all ${
                selected === member.member_id ? 'ring-2 ring-brand-500' : 'hover:shadow-md'
              }`}
              onClick={() => setSelected(selected === member.member_id ? null : member.member_id)}
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-gray-800">{member.member_name}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">QA Engineer</p>
                </div>
                <div className="flex gap-1.5">
                  {member.has_no_work && <Badge label="Idle" variant="warning" />}
                  {member.overloaded && <Badge label="Overloaded" variant="critical" />}
                  {!member.has_no_work && !member.overloaded && <Badge label="Active" variant="ok" />}
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 mb-3">
                <Stat label="RFT" value={member.ready_for_testing_count} highlight />
                <Stat label="Total" value={member.total_assigned} />
                <Stat label="Avg Age" value={`${member.avg_days_in_status}d`} />
              </div>

              {member.versions.length > 0 && (
                <div className="text-xs text-gray-500">
                  <span className="font-medium">Versions: </span>
                  {member.versions.slice(0, 3).join(', ')}
                  {member.versions.length > 3 && ` +${member.versions.length - 3} more`}
                </div>
              )}
            </div>
          ))}
        </div>

        {selectedMember && (
          <div className="card">
            <div className="flex items-center gap-3 mb-4">
              <Users className="h-5 w-5 text-brand-600" />
              <h2 className="font-semibold text-gray-800">
                {selectedMember.member_name} — Issues
              </h2>
              <Badge label={`${selectedMember.issues.length} items`} variant="default" />
            </div>
            <IssueTable issues={selectedMember.issues} />
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, highlight }) {
  return (
    <div className="bg-gray-50 rounded-lg p-2 text-center">
      <p className={`text-xl font-bold ${highlight ? 'text-brand-600' : 'text-gray-700'}`}>{value}</p>
      <p className="text-xs text-gray-400">{label}</p>
    </div>
  )
}

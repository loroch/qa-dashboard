import { useState, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAutoRefresh } from '../hooks/useAutoRefresh'
import { getDashboard, exportUrl, getDefaultBugQaHours, setDefaultBugQaHours } from '../services/api'
import { Header } from '../components/layout/Header'
import { IssueTable } from '../components/tables/DataTable'
import { SummaryCard } from '../components/cards/SummaryCard'
import { PageLoader, ErrorState } from '../components/common/LoadingSpinner'
import { Badge } from '../components/common/Badge'
import { CheckSquare, Download, Settings } from 'lucide-react'

const TABS = ['All', 'By Member', 'By Version', 'By Activity', 'By Priority']

function GroupExportLinks({ params }) {
  return (
    <span className="inline-flex items-center gap-2 ml-auto">
      <a href={exportUrl('ready-for-testing/csv', params)}
        className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-brand-600">
        <Download className="h-3 w-3" /> CSV
      </a>
      <a href={exportUrl('ready-for-testing/excel', params)}
        className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-brand-600">
        <Download className="h-3 w-3" /> Excel
      </a>
    </span>
  )
}

function BugDefaultControl() {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const ref = useRef(null)
  const queryClient = useQueryClient()

  const { data } = useQuery({
    queryKey: ['default-bug-qa-hours'],
    queryFn: () => getDefaultBugQaHours(),
    staleTime: 60 * 1000,
  })

  useEffect(() => {
    if (!open) return
    const h = (e) => { if (!ref.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])

  const openPopover = () => {
    setValue(String(data?.hours ?? 0.5))
    setError(null)
    setOpen(true)
  }

  const save = async (e) => {
    e.preventDefault()
    const n = parseFloat(value)
    if (isNaN(n) || n < 0) { setError('Enter a valid number'); return }
    setSaving(true); setError(null)
    try {
      await setDefaultBugQaHours(n)
      queryClient.invalidateQueries({ queryKey: ['default-bug-qa-hours'] })
      queryClient.invalidateQueries({ queryKey: ['dashboard-rft'] })
      setOpen(false)
    } catch (err) {
      setError(err.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button onClick={openPopover} className="btn-secondary flex items-center gap-1.5" title="Default QA estimate applied to Bugs">
        <Settings className="h-3.5 w-3.5" />
        Bug default: {data?.hours ?? '…'}h
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-50 bg-white border border-gray-200 rounded-lg shadow-lg p-3 w-64">
          <label className="block text-xs font-semibold text-gray-600 mb-1.5">Default Bug QA estimate (hours)</label>
          <form onSubmit={save} className="flex items-center gap-2">
            <input type="number" step="0.25" min="0" value={value} onChange={e => setValue(e.target.value)}
              className="w-20 text-sm border border-gray-200 rounded px-2 py-1 focus:outline-none focus:border-blue-400" autoFocus />
            <button type="submit" disabled={saving} className="btn-primary text-xs px-3 py-1.5">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </form>
          <p className="text-xs text-gray-400 mt-2">
            Applies to every Bug that doesn't already have its own custom estimate — totals recalculate immediately.
          </p>
          {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
        </div>
      )}
    </div>
  )
}

export default function ReadyForTesting() {
  const [filters, setFilters] = useState({})
  const [tab, setTab] = useState('All')
  const queryClient = useQueryClient()

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['dashboard-rft', filters],
    queryFn: () => getDashboard({ ...filters }),
    refetchInterval: 5 * 60 * 1000,
  })

  const { lastRefresh, isRefreshing, refresh } = useAutoRefresh([['dashboard-rft', filters]])

  // A status transition or QA owner reassignment can move an issue out of a
  // bucket entirely (RFT, a member's list, ...) — refetch so counts/totals
  // stay correct instead of showing a stale row.
  const handleIssueChanged = () => queryClient.invalidateQueries({ queryKey: ['dashboard-rft'] })

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
        extraActions={<BugDefaultControl />}
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
            {tab === 'All' && (
              <IssueTable issues={rft} editableStatus onStatusChanged={handleIssueChanged} editableQaOwner onQaOwnerChanged={handleIssueChanged} editableQaEstimate onQaEstimateChanged={handleIssueChanged} />
            )}

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
                      <GroupExportLinks params={{ member_id: member.member_id, member_name: member.member_name }} />
                    </div>
                    <IssueTable issues={member.issues} compact editableStatus onStatusChanged={handleIssueChanged} editableQaOwner onQaOwnerChanged={handleIssueChanged} editableQaEstimate onQaEstimateChanged={handleIssueChanged} />
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
                      <Badge label={`${v.total_qa_hours || 0}h QA est.`} variant="ok" />
                      <GroupExportLinks params={{ version: v.version }} />
                    </div>
                    <IssueTable issues={v.issues} compact editableStatus onStatusChanged={handleIssueChanged} editableQaOwner onQaOwnerChanged={handleIssueChanged} editableQaEstimate onQaEstimateChanged={handleIssueChanged} />
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
                    <IssueTable issues={a.issues} compact editableStatus onStatusChanged={handleIssueChanged} editableQaOwner onQaOwnerChanged={handleIssueChanged} editableQaEstimate onQaEstimateChanged={handleIssueChanged} />
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

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getChangelog, exportUrl } from '../services/api'
import { Header } from '../components/layout/Header'
import { PageLoader, ErrorState } from '../components/common/LoadingSpinner'
import { Badge } from '../components/common/Badge'
import { format, parseISO } from 'date-fns'

const TYPE_COLORS = {
  config:   'bg-blue-100 text-blue-700',
  query:    'bg-purple-100 text-purple-700',
  widget:   'bg-green-100 text-green-700',
  design:   'bg-pink-100 text-pink-700',
  backend:  'bg-orange-100 text-orange-700',
  jira:     'bg-yellow-100 text-yellow-700',
  system:   'bg-gray-100 text-gray-600',
}

function TypeBadge({ type }) {
  const cls = TYPE_COLORS[type] || TYPE_COLORS.system
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      {type}
    </span>
  )
}

export default function Changelog() {
  const [page, setPage] = useState(1)
  const [changeType, setChangeType] = useState('')

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['changelog', page, changeType],
    queryFn: () => getChangelog({ page, page_size: 50, change_type: changeType || undefined }),
  })

  if (isLoading) return <PageLoader />
  if (isError) return <div className="flex-1 p-6"><ErrorState message={error?.message} onRetry={refetch} /></div>

  const entries = data?.entries || []
  const totalPages = data?.total_pages || 1

  return (
    <div className="flex-1 flex flex-col">
      <Header
        title="Changelog & Audit Trail"
        isRefreshing={false}
        onRefresh={refetch}
        exportOptions={[
          { label: 'Export CSV', href: exportUrl('changelog/csv') },
          { label: 'Export Excel', href: exportUrl('changelog/excel') },
        ]}
      />
      <div className="flex-1 p-6 space-y-4 overflow-auto">
        {/* Filters */}
        <div className="flex items-center gap-3">
          <select
            className="text-sm border border-gray-200 rounded-lg px-3 py-2 bg-white text-gray-700"
            value={changeType}
            onChange={e => { setChangeType(e.target.value); setPage(1) }}
          >
            <option value="">All types</option>
            {Object.keys(TYPE_COLORS).map(t => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <span className="text-sm text-gray-500">{data?.total ?? 0} entries</span>
        </div>

        {/* Timeline */}
        <div className="space-y-3">
          {entries.map((entry) => (
            <div key={entry.id} className="card flex gap-4">
              <div className="flex flex-col items-center">
                <div className="w-2 h-2 rounded-full bg-brand-500 mt-1.5" />
                <div className="w-px flex-1 bg-gray-200 mt-1" />
              </div>
              <div className="flex-1 pb-2">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <TypeBadge type={entry.change_type} />
                  <span className="text-xs font-mono text-gray-500 bg-gray-50 px-2 py-0.5 rounded">
                    {entry.component}
                  </span>
                  <span className="text-xs text-gray-400 ml-auto">
                    {entry.changed_at
                      ? format(parseISO(entry.changed_at), 'MMM d, yyyy HH:mm')
                      : '—'
                    }
                  </span>
                </div>
                <p className="text-sm text-gray-800 font-medium">{entry.description}</p>
                <div className="flex items-center gap-3 mt-1.5">
                  <span className="text-xs text-gray-400">by {entry.changed_by}</span>
                  <span className="text-xs text-gray-300">·</span>
                  <span className="text-xs text-gray-400">v{entry.version}</span>
                </div>
                {(entry.old_value || entry.new_value) && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {entry.old_value && (
                      <div className="bg-red-50 border border-red-100 rounded p-2">
                        <p className="text-xs font-medium text-red-600 mb-0.5">Before</p>
                        <pre className="text-xs text-gray-700 overflow-auto max-h-20">
                          {typeof entry.old_value === 'object'
                            ? JSON.stringify(entry.old_value, null, 2)
                            : String(entry.old_value)}
                        </pre>
                      </div>
                    )}
                    {entry.new_value && (
                      <div className="bg-green-50 border border-green-100 rounded p-2">
                        <p className="text-xs font-medium text-green-600 mb-0.5">After</p>
                        <pre className="text-xs text-gray-700 overflow-auto max-h-20">
                          {typeof entry.new_value === 'object'
                            ? JSON.stringify(entry.new_value, null, 2)
                            : String(entry.new_value)}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}

          {entries.length === 0 && (
            <div className="card text-center py-12 text-gray-400">
              No changelog entries found.
            </div>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-3 text-sm">
            <button
              className="btn-secondary py-1 px-3 disabled:opacity-40"
              disabled={page === 1}
              onClick={() => setPage(p => p - 1)}
            >← Prev</button>
            <span className="text-gray-500">Page {page} of {totalPages}</span>
            <button
              className="btn-secondary py-1 px-3 disabled:opacity-40"
              disabled={page === totalPages}
              onClick={() => setPage(p => p + 1)}
            >Next →</button>
          </div>
        )}
      </div>
    </div>
  )
}

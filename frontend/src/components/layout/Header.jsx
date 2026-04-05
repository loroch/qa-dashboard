import { useState } from 'react'
import { RefreshCw, Filter, Download } from 'lucide-react'
import { format } from 'date-fns'
import { FilterPanel } from '../filters/FilterPanel'

export function Header({ title, lastRefresh, isRefreshing, onRefresh, onFilter, onExport, exportOptions }) {
  const [showFilter, setShowFilter] = useState(false)

  return (
    <header className="bg-white border-b border-gray-200 px-6 py-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-gray-900">{title}</h1>
          {lastRefresh && (
            <p className="text-xs text-gray-400 mt-0.5">
              Last updated {format(lastRefresh, 'MMM d, HH:mm')} · Auto-refresh every 5 min
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {onFilter && (
            <div className="relative">
              <button
                className="btn-secondary flex items-center gap-1.5"
                onClick={() => setShowFilter(v => !v)}
              >
                <Filter className="h-3.5 w-3.5" />
                Filters
              </button>
              {showFilter && (
                <div className="absolute right-0 top-10 z-50">
                  <FilterPanel
                    onApply={(f) => { onFilter(f); setShowFilter(false) }}
                    onClose={() => setShowFilter(false)}
                  />
                </div>
              )}
            </div>
          )}

          {exportOptions && exportOptions.length > 0 && (
            <div className="relative group">
              <button className="btn-secondary flex items-center gap-1.5">
                <Download className="h-3.5 w-3.5" />
                Export
              </button>
              <div className="absolute right-0 top-9 z-50 hidden group-hover:block bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[140px]">
                {exportOptions.map(opt => (
                  <a
                    key={opt.label}
                    href={opt.href}
                    className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                    download
                  >
                    {opt.label}
                  </a>
                ))}
              </div>
            </div>
          )}

          <button
            className="btn-primary flex items-center gap-1.5"
            onClick={onRefresh}
            disabled={isRefreshing}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            {isRefreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>
    </header>
  )
}

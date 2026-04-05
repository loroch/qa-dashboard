import { X } from 'lucide-react'
import { useFilterStore } from '../../store/filterStore'

const PRIORITIES = ['Highest', 'High', 'Medium', 'Low', 'Lowest']
const STATUSES = ['Ready for Testing', 'In Progress', 'In Review', 'Blocked', 'Open']

export function FilterPanel({ onApply, onClose }) {
  const { filters, setFilter, resetFilters } = useFilterStore()

  const handleApply = () => {
    const active = Object.fromEntries(
      Object.entries(filters).filter(([, v]) => v)
    )
    onApply?.(active)
    onClose?.()
  }

  return (
    <div className="card border border-gray-200 w-80 shadow-lg">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-gray-800 text-sm">Filters</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-3">
        <Field label="Projects (comma separated)">
          <input
            className="input"
            placeholder="e.g. PROJ, APP"
            value={filters.projects}
            onChange={(e) => setFilter('projects', e.target.value)}
          />
        </Field>

        <Field label="Assignee IDs (comma separated)">
          <input
            className="input"
            placeholder="Jira account IDs"
            value={filters.assignee_ids}
            onChange={(e) => setFilter('assignee_ids', e.target.value)}
          />
        </Field>

        <Field label="Version">
          <input
            className="input"
            placeholder="e.g. v2.1.0"
            value={filters.version}
            onChange={(e) => setFilter('version', e.target.value)}
          />
        </Field>

        <Field label="Status">
          <select className="input" value={filters.status} onChange={(e) => setFilter('status', e.target.value)}>
            <option value="">All statuses</option>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>

        <Field label="Priority">
          <select className="input" value={filters.priority} onChange={(e) => setFilter('priority', e.target.value)}>
            <option value="">All priorities</option>
            {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>

        <Field label="Date from">
          <input
            type="date"
            className="input"
            value={filters.date_from}
            onChange={(e) => setFilter('date_from', e.target.value)}
          />
        </Field>

        <Field label="Date to">
          <input
            type="date"
            className="input"
            value={filters.date_to}
            onChange={(e) => setFilter('date_to', e.target.value)}
          />
        </Field>
      </div>

      <div className="flex gap-2 mt-4">
        <button className="btn-primary flex-1" onClick={handleApply}>Apply</button>
        <button className="btn-secondary" onClick={() => { resetFilters(); onApply?.({}) }}>
          Reset
        </button>
      </div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  )
}

export function Badge({ label, variant = 'default', className = '' }) {
  const variants = {
    default:  'bg-gray-100 text-gray-700',
    ok:       'bg-green-100 text-green-800',
    warning:  'bg-yellow-100 text-yellow-800',
    critical: 'bg-orange-100 text-orange-800',
    overdue:  'bg-red-100 text-red-800',
    highest:  'bg-red-100 text-red-800',
    high:     'bg-orange-100 text-orange-800',
    medium:   'bg-yellow-100 text-yellow-800',
    low:      'bg-blue-100 text-blue-800',
    bug:      'bg-red-100 text-red-700',
    task:     'bg-blue-100 text-blue-700',
    story:    'bg-green-100 text-green-700',
  }
  const cls = variants[variant?.toLowerCase()] || variants.default
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls} ${className}`}>
      {label}
    </span>
  )
}

export function AgingBadge({ level, days }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium badge-${level}`}>
      {days}d
    </span>
  )
}

export function PriorityBadge({ priority }) {
  const map = {
    Highest: 'highest', Critical: 'highest',
    High: 'high',
    Medium: 'medium',
    Low: 'low', Lowest: 'low',
  }
  return <Badge label={priority || '—'} variant={map[priority] || 'default'} />
}

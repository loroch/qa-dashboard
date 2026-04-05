import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { format, parseISO } from 'date-fns'

function formatDay(dateStr) {
  try { return format(parseISO(dateStr), 'MMM d') }
  catch { return dateStr }
}

const COLORS = {
  ready_for_testing: '#3C6ECB',
  created: '#10B981',
  resolved: '#6366F1',
  bugs: '#EF4444',
}

export function TrendAreaChart({ data = [] }) {
  const formatted = data.map((d) => ({ ...d, day: formatDay(d.date) }))
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={formatted} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
        <defs>
          {Object.entries(COLORS).map(([key, color]) => (
            <linearGradient key={key} id={`grad_${key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={color} stopOpacity={0.3} />
              <stop offset="95%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#F0F0F0" />
        <XAxis dataKey="day" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
        <Tooltip contentStyle={{ fontSize: 12 }} />
        <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
        <Area type="monotone" dataKey="ready_for_testing" name="Ready for Testing"
          stroke={COLORS.ready_for_testing} fill={`url(#grad_ready_for_testing)`} strokeWidth={2} />
        <Area type="monotone" dataKey="created" name="Created"
          stroke={COLORS.created} fill={`url(#grad_created)`} strokeWidth={2} />
        <Area type="monotone" dataKey="bugs" name="Bugs"
          stroke={COLORS.bugs} fill={`url(#grad_bugs)`} strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

export function MemberBarChart({ data = [] }) {
  const formatted = data.map((m) => ({
    name: m.member_name.split(' ').slice(-1)[0],  // last name for brevity
    'Ready for Testing': m.ready_for_testing_count,
    'Total': m.total_assigned,
  }))
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={formatted} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#F0F0F0" />
        <XAxis dataKey="name" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
        <Tooltip contentStyle={{ fontSize: 12 }} />
        <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
        <Bar dataKey="Ready for Testing" fill="#3C6ECB" radius={[4, 4, 0, 0]} />
        <Bar dataKey="Total" fill="#A5BCE6" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}

export function PriorityBarChart({ data = [] }) {
  const colorMap = {
    Highest: '#EF4444', Critical: '#EF4444',
    High: '#F97316', Medium: '#EAB308', Low: '#3B82F6', Lowest: '#6B7280',
  }
  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 20, left: 20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#F0F0F0" />
        <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
        <YAxis type="category" dataKey="priority" tick={{ fontSize: 11 }} width={60} />
        <Tooltip contentStyle={{ fontSize: 12 }} />
        <Bar dataKey="count" radius={[0, 4, 4, 0]}>
          {data.map((entry, i) => (
            <rect key={i} fill={colorMap[entry.priority] || '#6B7280'} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

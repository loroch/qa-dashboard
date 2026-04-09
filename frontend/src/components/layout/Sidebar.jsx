import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard, CheckSquare, Users, AlertTriangle,
  Bug, Clock, TrendingUp, History, Ticket, BarChart2, FlaskConical, Wand2
} from 'lucide-react'

const nav = [
  { to: '/',               label: 'Overview',         icon: LayoutDashboard },
  { to: '/ready-for-testing', label: 'Ready for Testing', icon: CheckSquare },
  { to: '/team',           label: 'Team Overview',    icon: Users },
  { to: '/aging',          label: 'Aging Report',     icon: Clock },
  { to: '/blockers',       label: 'Blockers',         icon: AlertTriangle },
  { to: '/bugs',           label: 'Bugs (30d)',       icon: Bug },
  { to: '/trends',         label: 'Trends',           icon: TrendingUp },
  { to: '/zoho',           label: 'Zoho Desk',        icon: Ticket },
  { to: '/zoho-reports',  label: 'Zoho Reports',     icon: BarChart2 },
  { to: '/coverage',       label: 'Test Coverage',    icon: FlaskConical },
  { to: '/test-generator', label: 'Test Generator',   icon: Wand2 },
  { to: '/changelog',      label: 'Changelog',        icon: History },
]

export function Sidebar() {
  return (
    <aside className="w-56 bg-brand-600 text-white flex flex-col min-h-screen shrink-0">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-brand-700">
        <div className="flex items-center gap-2.5">
          <div className="bg-white/20 rounded-lg p-1.5">
            <CheckSquare className="h-5 w-5" />
          </div>
          <div>
            <p className="font-bold text-sm leading-tight">QA Dashboard</p>
            <p className="text-brand-200 text-xs">Loro.C Manager View</p>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {nav.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
                isActive
                  ? 'bg-white/20 text-white font-medium'
                  : 'text-brand-100 hover:bg-white/10 hover:text-white'
              }`
            }
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="px-3 py-3 border-t border-brand-700">
        <p className="text-brand-300 text-xs px-3">v1.0.0</p>
      </div>
    </aside>
  )
}

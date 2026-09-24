import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard, CheckSquare, Users, AlertTriangle,
  Bug, Clock, TrendingUp, History, Ticket, BarChart2, FlaskConical, PlayCircle, Zap, Layers, ClipboardList, FileText, GitBranch, PenLine, Target, Globe, CalendarDays,
  Moon, Sun, LogOut, ShieldCheck, UserCircle2
} from 'lucide-react'
import { useDarkMode } from '../../hooks/useDarkMode'

const ALL_NAV = [
  { to: '/',               label: 'Overview',         icon: LayoutDashboard, roles: ['admin'] },
  { to: '/ready-for-testing', label: 'Ready for Testing', icon: CheckSquare,  roles: ['admin'] },
  { to: '/team',           label: 'Team Overview',    icon: Users,           roles: ['admin'] },
  { to: '/aging',          label: 'Aging Report',     icon: Clock,           roles: ['admin'] },
  { to: '/blockers',       label: 'Blockers',         icon: AlertTriangle,   roles: ['admin'] },
  { to: '/bugs',           label: 'Bugs (30d)',        icon: Bug,             roles: ['admin'] },
  { to: '/bugs-by-version', label: 'Bugs by Version', icon: Layers,          roles: ['admin', 'qa'] },
  { to: '/trends',         label: 'Trends',           icon: TrendingUp,      roles: ['admin'] },
  { to: '/zoho',           label: 'Zoho Desk',        icon: Ticket,          roles: ['admin'] },
  { to: '/zoho-reports',   label: 'Zoho Reports',     icon: BarChart2,       roles: ['admin'] },
  { to: '/coverage',       label: 'Test Coverage',    icon: FlaskConical,    roles: ['admin', 'qa'] },
  { to: '/automation',     label: 'Automation',       icon: PlayCircle,      roles: ['admin'] },
  { to: '/test-plans',     label: 'Test Plans',       icon: ClipboardList,   roles: ['admin'] },
  { to: '/release-notes',  label: 'Release Notes',    icon: FileText,        roles: ['admin'] },
  { to: '/investigation',  label: 'Investigation',    icon: GitBranch,       roles: ['admin'] },
  { to: '/sprint-planning', label: 'Sprint Planning', icon: CalendarDays,    roles: ['admin'] },
  { to: '/bug-triage',     label: 'Bug Priority Mtg', icon: Target,          roles: ['admin'] },
  { to: '/mexico-qa',      label: 'Mexico QA Team',   icon: Globe,           roles: ['admin'] },
  { to: '/kone',           label: 'K1-Support',       icon: Ticket,          roles: ['admin', 'qa'] },
  { to: '/bug-reporter',   label: 'Bug Reporter',     icon: PenLine,         roles: ['admin'] },
  { to: '/anomaly',        label: 'Anomalies',        icon: Zap,             roles: ['admin'] },
  { to: '/changelog',      label: 'Changelog',        icon: History,         roles: ['admin'] },
]

export function Sidebar({ user, onLogout }) {
  const [isDark, toggleDark] = useDarkMode()
  const role = user?.role || 'admin'
  const nav = ALL_NAV.filter(n => n.roles.includes(role))

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

      {/* User info */}
      <div className="px-4 py-3 border-b border-brand-700 flex items-center gap-2.5">
        <div className="bg-white/10 rounded-full p-1.5 shrink-0">
          {role === 'admin'
            ? <ShieldCheck className="h-3.5 w-3.5 text-yellow-300" />
            : <UserCircle2 className="h-3.5 w-3.5 text-brand-200" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-white truncate capitalize">{user?.display || user?.username}</p>
          <p className="text-brand-300 text-xs capitalize">{role}</p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
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

      {/* Footer */}
      <div className="px-3 py-3 border-t border-brand-700 flex items-center justify-between">
        <div className="flex items-center gap-1">
          <p className="text-brand-300 text-xs px-3">v1.0.0</p>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={toggleDark}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            className="p-2 rounded-lg text-brand-200 hover:bg-white/10 hover:text-white transition-colors"
          >
            {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
          <button
            onClick={onLogout}
            title="Sign out"
            className="p-2 rounded-lg text-brand-200 hover:bg-white/10 hover:text-red-300 transition-colors"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  )
}

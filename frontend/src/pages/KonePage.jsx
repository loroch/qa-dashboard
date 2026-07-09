import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import axios from 'axios'
import { RefreshCw, ExternalLink, ChevronDown, ChevronRight } from 'lucide-react'

const API = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000'

// ── Status color helpers ────────────────────────────────────────────────────
const STATUS_COLORS = {
  'Open':        'bg-blue-100 text-blue-800',
  'In Progress': 'bg-yellow-100 text-yellow-800',
  'Waiting for customer': 'bg-purple-100 text-purple-800',
  'Resolved':    'bg-green-100 text-green-800',
  'Closed':      'bg-gray-100 text-gray-700',
}
const statusColor = (s) => STATUS_COLORS[s] || 'bg-gray-100 text-gray-700'

const PRIORITY_COLORS = {
  'Critical': 'text-red-600 font-bold',
  'High':     'text-orange-500 font-semibold',
  'Medium':   'text-yellow-600',
  'Low':      'text-gray-500',
}
const priorityColor = (p) => PRIORITY_COLORS[p] || 'text-gray-500'

// ── Fixed-position tooltip cell ─────────────────────────────────────────────
function TooltipCell({ text, className, children }) {
  const [pos, setPos] = useState(null)
  return (
    <td
      className={className}
      onMouseEnter={e => {
        if (!text || text.length < 40) return
        const r = e.currentTarget.getBoundingClientRect()
        setPos({ top: r.bottom + 6, left: Math.min(r.left, window.innerWidth - 400) })
      }}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos && (
        <div
          className="fixed z-[9999] bg-slate-800 text-white text-xs rounded-lg px-3 py-2 shadow-xl pointer-events-none leading-relaxed whitespace-pre-wrap"
          style={{ top: pos.top, left: pos.left, maxWidth: 380 }}
        >
          {text}
          <div className="absolute -top-1.5 left-4 w-3 h-3 bg-slate-800 rotate-45" />
        </div>
      )}
    </td>
  )
}

// ── By Cliente view ─────────────────────────────────────────────────────────
function ClienteCard({ group, onSelect, selected }) {
  const isSelected = selected === group.cliente
  return (
    <div
      className={`border rounded-xl p-4 cursor-pointer transition-all ${
        isSelected ? 'border-blue-500 bg-blue-50 shadow-md' : 'border-gray-200 bg-white hover:border-blue-300 hover:shadow-sm'
      }`}
      onClick={() => onSelect(isSelected ? null : group.cliente)}
    >
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-semibold text-gray-900 text-sm">{group.cliente || 'Unknown'}</h3>
          {group.cuentas?.length > 0 && (
            <p className="text-xs text-gray-500 mt-0.5">{group.cuentas.join(' · ')}</p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-2xl font-bold text-blue-600">{group.total}</span>
          {isSelected ? <ChevronDown className="h-4 w-4 text-gray-400 mt-1" /> : <ChevronRight className="h-4 w-4 text-gray-400 mt-1" />}
        </div>
      </div>
      <div className="flex flex-wrap gap-1 mt-3">
        {group.statuses?.map(s => (
          <span
            key={s.status}
            className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${statusColor(s.status)}`}
          >
            {s.status}: {s.count}
          </span>
        ))}
      </div>
    </div>
  )
}

function ByClienteTab({ tickets, clienteGroups }) {
  const [selectedCliente, setSelectedCliente] = useState(null)
  const [statusFilter, setStatusFilter] = useState('All')
  const [sortCol, setSortCol] = useState('created')
  const [sortDir, setSortDir] = useState('desc')

  const filteredTickets = useMemo(() => {
    let list = tickets
    if (selectedCliente) list = list.filter(t => t.cliente === selectedCliente)
    if (statusFilter !== 'All') list = list.filter(t => t.status === statusFilter)
    return [...list].sort((a, b) => {
      let av = a[sortCol] || ''
      let bv = b[sortCol] || ''
      if (sortCol === 'days_open') { av = Number(av); bv = Number(bv) }
      const cmp = typeof av === 'number' ? av - bv : av < bv ? -1 : av > bv ? 1 : 0
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [tickets, selectedCliente, statusFilter, sortCol, sortDir])

  const allStatuses = useMemo(() => {
    const s = new Set(tickets.map(t => t.status).filter(Boolean))
    return ['All', ...Array.from(s).sort()]
  }, [tickets])

  const toggleSort = col => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('desc') }
  }
  const sortIcon = col => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''

  return (
    <div className="space-y-6">
      {/* Cliente grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {clienteGroups.map(g => (
          <ClienteCard
            key={g.cliente}
            group={g}
            onSelect={setSelectedCliente}
            selected={selectedCliente}
          />
        ))}
      </div>

      {/* Ticket table */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <span className="text-sm font-medium text-gray-700">
            {selectedCliente ? `${selectedCliente} — ` : 'All clients — '}
            {filteredTickets.length} ticket{filteredTickets.length !== 1 ? 's' : ''}
          </span>
          <div className="flex items-center gap-2">
            <select
              className="text-xs border border-gray-200 rounded px-2 py-1"
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
            >
              {allStatuses.map(s => <option key={s}>{s}</option>)}
            </select>
            {selectedCliente && (
              <button
                onClick={() => setSelectedCliente(null)}
                className="text-xs text-blue-500 hover:underline"
              >
                Clear filter
              </button>
            )}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                {[
                  ['key',         'Key'],
                  ['summary',     'Summary'],
                  ['status',      'Status'],
                  ['priority',    'Priority'],
                  ['cliente',     'Cliente'],
                  ['cuenta',      'Cuenta'],
                  ['producto',    'Producto'],
                  ['assignee',    'Assignee'],
                  ['days_open',   'Days Open'],
                ].map(([col, label]) => (
                  <th
                    key={col}
                    className="text-left px-3 py-2 text-gray-600 font-medium cursor-pointer hover:text-gray-900 whitespace-nowrap"
                    onClick={() => toggleSort(col)}
                  >
                    {label}{sortIcon(col)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredTickets.map(t => (
                <tr key={t.key} className="border-t border-gray-50 hover:bg-gray-50">
                  <td className="px-3 py-2 whitespace-nowrap">
                    <a
                      href={t.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline font-mono"
                    >
                      {t.key}
                    </a>
                  </td>
                  <TooltipCell
                    text={t.summary}
                    className="px-3 py-2 max-w-[260px] cursor-default"
                  >
                    <span className="block truncate">{t.summary}</span>
                  </TooltipCell>
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className={`px-1.5 py-0.5 rounded text-xs ${statusColor(t.status)}`}>
                      {t.status}
                    </span>
                  </td>
                  <td className={`px-3 py-2 whitespace-nowrap ${priorityColor(t.priority)}`}>
                    {t.priority}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-700">{t.cliente}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-700">{t.cuenta}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-700">{t.producto}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-gray-700">{t.assignee}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={t.days_open > 14 ? 'text-red-600 font-semibold' : 'text-gray-500'}>
                      {t.days_open}d
                    </span>
                  </td>
                </tr>
              ))}
              {filteredTickets.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-center py-8 text-gray-400">
                    No tickets
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ── All Tickets tab ─────────────────────────────────────────────────────────
function AllTicketsTab({ tickets }) {
  const [search, setSearch]       = useState('')
  const [statusFilter, setStatus] = useState('All')
  const [clienteFilter, setCliente] = useState('All')
  const [cuentaFilter, setCuenta]  = useState('All')
  const [productoFilter, setProducto] = useState('All')
  const [assigneeFilter, setAssignee] = useState('All')
  const [sortCol, setSortCol]     = useState('created')
  const [sortDir, setSortDir]     = useState('desc')
  const [page, setPage]           = useState(1)
  const PAGE_SIZE = 50

  const options = useMemo(() => ({
    statuses:  ['All', ...Array.from(new Set(tickets.map(t => t.status).filter(Boolean))).sort()],
    clientes:  ['All', ...Array.from(new Set(tickets.map(t => t.cliente).filter(Boolean))).sort()],
    cuentas:   ['All', ...Array.from(new Set(tickets.map(t => t.cuenta).filter(Boolean))).sort()],
    productos: ['All', ...Array.from(new Set(tickets.map(t => t.producto).filter(Boolean))).sort()],
    assignees: ['All', ...Array.from(new Set(tickets.map(t => t.assignee).filter(Boolean))).sort()],
  }), [tickets])

  const filtered = useMemo(() => {
    let list = tickets
    if (search)           list = list.filter(t => `${t.key} ${t.summary} ${t.assignee} ${t.reporter}`.toLowerCase().includes(search.toLowerCase()))
    if (statusFilter !== 'All')   list = list.filter(t => t.status  === statusFilter)
    if (clienteFilter !== 'All')  list = list.filter(t => t.cliente === clienteFilter)
    if (cuentaFilter !== 'All')   list = list.filter(t => t.cuenta  === cuentaFilter)
    if (productoFilter !== 'All') list = list.filter(t => t.producto === productoFilter)
    if (assigneeFilter !== 'All') list = list.filter(t => t.assignee === assigneeFilter)
    return [...list].sort((a, b) => {
      let av = a[sortCol] || ''
      let bv = b[sortCol] || ''
      if (sortCol === 'days_open') { av = Number(av); bv = Number(bv) }
      const cmp = typeof av === 'number' ? av - bv : av < bv ? -1 : av > bv ? 1 : 0
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [tickets, search, statusFilter, clienteFilter, cuentaFilter, productoFilter, assigneeFilter, sortCol, sortDir])

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE)
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const toggleSort = col => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('desc') }
    setPage(1)
  }
  const sortIcon = col => sortCol === col ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''

  const Sel = ({ label, value, onChange, options: opts }) => (
    <select
      className="text-xs border border-gray-200 rounded px-2 py-1"
      value={value}
      onChange={e => { onChange(e.target.value); setPage(1) }}
      title={label}
    >
      {opts.map(o => <option key={o}>{o}</option>)}
    </select>
  )

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-gray-100">
        <input
          type="text"
          placeholder="Search key / summary / assignee…"
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1) }}
          className="text-xs border border-gray-200 rounded px-2 py-1 w-52"
        />
        <Sel label="Status"   value={statusFilter}   onChange={setStatus}   options={options.statuses} />
        <Sel label="Cliente"  value={clienteFilter}  onChange={setCliente}  options={options.clientes} />
        <Sel label="Cuenta"   value={cuentaFilter}   onChange={setCuenta}   options={options.cuentas} />
        <Sel label="Producto" value={productoFilter} onChange={setProducto} options={options.productos} />
        <Sel label="Assignee" value={assigneeFilter} onChange={setAssignee} options={options.assignees} />
        <span className="ml-auto text-xs text-gray-500">{filtered.length} tickets</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-50">
            <tr>
              {[
                ['key',         'Key'],
                ['summary',     'Summary'],
                ['status',      'Status'],
                ['priority',    'Priority'],
                ['cliente',     'Cliente'],
                ['cliente_site','Site'],
                ['cuenta',      'Cuenta'],
                ['producto',    'Producto'],
                ['modulo',      'Módulo'],
                ['urgency',     'Urgency'],
                ['assignee',    'Assignee'],
                ['reporter',    'Reporter'],
                ['days_open',   'Days Open'],
                ['created',     'Created'],
              ].map(([col, label]) => (
                <th
                  key={col}
                  className="text-left px-3 py-2 text-gray-600 font-medium cursor-pointer hover:text-gray-900 whitespace-nowrap"
                  onClick={() => toggleSort(col)}
                >
                  {label}{sortIcon(col)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paged.map(t => (
              <tr key={t.key} className="border-t border-gray-50 hover:bg-gray-50">
                <td className="px-3 py-2 whitespace-nowrap">
                  <a
                    href={t.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-600 hover:underline font-mono flex items-center gap-1"
                  >
                    {t.key}
                    <ExternalLink className="h-2.5 w-2.5 opacity-60" />
                  </a>
                </td>
                <TooltipCell text={t.summary} className="px-3 py-2 max-w-[260px] cursor-default">
                  <span className="block truncate">{t.summary}</span>
                </TooltipCell>
                <td className="px-3 py-2 whitespace-nowrap">
                  <span className={`px-1.5 py-0.5 rounded text-xs ${statusColor(t.status)}`}>
                    {t.status}
                  </span>
                </td>
                <td className={`px-3 py-2 whitespace-nowrap ${priorityColor(t.priority)}`}>{t.priority}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-700">{t.cliente}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-500">{t.cliente_site}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-700">{t.cuenta}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-700">{t.producto}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-500">{t.modulo}</td>
                <td className={`px-3 py-2 whitespace-nowrap ${priorityColor(t.urgency)}`}>{t.urgency}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-700">{t.assignee}</td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-500">{t.reporter}</td>
                <td className="px-3 py-2 text-center">
                  <span className={t.days_open > 14 ? 'text-red-600 font-semibold' : 'text-gray-500'}>
                    {t.days_open}d
                  </span>
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-gray-500">
                  {t.created ? t.created.slice(0, 10) : ''}
                </td>
              </tr>
            ))}
            {paged.length === 0 && (
              <tr>
                <td colSpan={14} className="text-center py-8 text-gray-400">No tickets match filters</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 text-xs">
          <button
            disabled={page === 1}
            onClick={() => setPage(p => p - 1)}
            className="px-3 py-1 border rounded disabled:opacity-40 hover:bg-gray-50"
          >
            Previous
          </button>
          <span className="text-gray-500">Page {page} of {totalPages}</span>
          <button
            disabled={page === totalPages}
            onClick={() => setPage(p => p + 1)}
            className="px-3 py-1 border rounded disabled:opacity-40 hover:bg-gray-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}

// ── Main page ───────────────────────────────────────────────────────────────
export default function KonePage() {
  const [tab, setTab] = useState('cliente')
  const [refreshKey, setRefreshKey] = useState(0)

  const { data: ticketsData, isLoading: loadingTickets, error: ticketsError, refetch: refetchTickets } =
    useQuery({
      queryKey: ['kone-tickets', refreshKey],
      queryFn: () => axios.get(`${API}/api/kone/tickets`).then(r => r.data),
      staleTime: 5 * 60 * 1000,
    })

  const { data: clienteData, isLoading: loadingCliente, refetch: refetchCliente } =
    useQuery({
      queryKey: ['kone-by-cliente', refreshKey],
      queryFn: () => axios.get(`${API}/api/kone/by-cliente`).then(r => r.data),
      staleTime: 5 * 60 * 1000,
    })

  const handleRefresh = async () => {
    setRefreshKey(k => k + 1)
    await Promise.all([
      axios.get(`${API}/api/kone/tickets?refresh=true`),
      axios.get(`${API}/api/kone/by-cliente?refresh=true`),
    ])
    await Promise.all([refetchTickets(), refetchCliente()])
  }

  const tickets      = ticketsData?.tickets || []
  const clienteGroups = clienteData?.groups  || []
  const isLoading    = loadingTickets || loadingCliente

  // Summary stats
  const totalOpen = tickets.length
  const openCount = tickets.filter(t => t.status === 'Open').length
  const inProgress = tickets.filter(t => t.status === 'In Progress').length
  const waiting    = tickets.filter(t => t.status === 'Waiting for customer').length
  const overdue    = tickets.filter(t => t.days_open > 14).length
  const uniqueClientes = new Set(tickets.map(t => t.cliente).filter(Boolean)).size

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">K-1 KONE Service Desk</h1>
          <p className="text-sm text-gray-500 mt-0.5">kabatone-ops-it.atlassian.net · All open tickets</p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={isLoading}
          className="flex items-center gap-2 px-3 py-2 text-sm bg-white border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40"
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
        {[
          { label: 'Total Open', value: totalOpen,      color: 'text-blue-600' },
          { label: 'Open',       value: openCount,      color: 'text-blue-500' },
          { label: 'In Progress',value: inProgress,     color: 'text-yellow-600' },
          { label: 'Waiting',    value: waiting,        color: 'text-purple-600' },
          { label: '>14d Open',  value: overdue,        color: 'text-red-600' },
          { label: 'Clientes',   value: uniqueClientes, color: 'text-gray-700' },
        ].map(s => (
          <div key={s.label} className="bg-white rounded-xl border border-gray-200 p-4 text-center shadow-sm">
            <div className={`text-2xl font-bold ${s.color}`}>
              {isLoading ? '—' : s.value}
            </div>
            <div className="text-xs text-gray-500 mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Error */}
      {ticketsError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
          Failed to load KONE tickets: {ticketsError.message}
        </div>
      )}

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-gray-200">
        {[
          { id: 'cliente', label: 'By Cliente' },
          { id: 'all',     label: `All Tickets (${totalOpen})` },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t.id
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center h-48 text-gray-400">
          <RefreshCw className="h-6 w-6 animate-spin mr-2" />
          Loading K-1 tickets (fetching ~{clienteGroups.length > 0 ? ticketsData?.total : '…'} tickets)…
        </div>
      ) : (
        <>
          {tab === 'cliente' && (
            <ByClienteTab tickets={tickets} clienteGroups={clienteGroups} />
          )}
          {tab === 'all' && (
            <AllTicketsTab tickets={tickets} />
          )}
        </>
      )}
    </div>
  )
}

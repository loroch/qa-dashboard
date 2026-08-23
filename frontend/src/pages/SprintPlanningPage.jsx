import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { BASE_URL } from '../services/api'
import {
  CalendarDays, ChevronDown, RefreshCw, Plus, Trash2, Edit2, Save, X,
  ArrowUp, ArrowDown, ExternalLink, CheckCircle2, Clock, AlertTriangle,
  Layers, BarChart2, Target, Zap, ChevronRight, PlusCircle, XCircle,
  Search, Bug, BookOpen, Info
} from 'lucide-react'

const API = `${BASE_URL}/sprint-planning`

// ── Constants ─────────────────────────────────────────────────────────────

const ACTIVITY_TYPE_LABELS = {
  qa_testing: 'QA Testing',
  regression: 'Regression',
  smoke_test: 'Smoke Test',
  review: 'Review',
  exploratory: 'Exploratory',
  other: 'Other',
}

const ACTIVITY_STATUS_LABELS = {
  planned: 'Planned',
  in_progress: 'In Progress',
  done: 'Done',
  blocked: 'Blocked',
}

const DELAY_REASON_LABELS = {
  environment_issue: 'Environment Issue',
  dependency_issue: 'Dependency / Integration Issue',
  capacity_overload: 'Capacity Overload',
  dev_delay: 'Dev Not Done',
  scope_change: 'Scope Change',
  missing_requirements: 'Missing Requirements',
  other: 'Other',
}

const TYPE_COLORS = {
  qa_testing: 'bg-blue-100 text-blue-700',
  regression: 'bg-purple-100 text-purple-700',
  smoke_test: 'bg-teal-100 text-teal-700',
  review: 'bg-orange-100 text-orange-700',
  exploratory: 'bg-pink-100 text-pink-700',
  other: 'bg-slate-100 text-slate-600',
}

const STATUS_COLORS = {
  planned: 'bg-slate-100 text-slate-600',
  in_progress: 'bg-blue-100 text-blue-700',
  done: 'bg-green-100 text-green-700',
  blocked: 'bg-red-100 text-red-700',
}

const PRIORITY_DOT = {
  Highest: 'bg-red-600', High: 'bg-orange-500', Medium: 'bg-yellow-400',
  Low: 'bg-blue-400', Lowest: 'bg-slate-400',
}

const JIRA_STATUS_COLORS = {
  'ToDo':                  'bg-gray-100 text-gray-600',
  'To Do':                 'bg-gray-100 text-gray-600',
  'Open':                  'bg-gray-100 text-gray-600',
  'In Progress':           'bg-blue-100 text-blue-700',
  'In Review':             'bg-indigo-100 text-indigo-700',
  'Ready for Testing':     'bg-purple-100 text-purple-700',
  'Validation':            'bg-violet-100 text-violet-700',
  'Ready For Deployment':  'bg-teal-100 text-teal-700',
  'Monitoring':            'bg-cyan-100 text-cyan-700',
  'DONE':                  'bg-green-100 text-green-700',
  'Done':                  'bg-green-100 text-green-700',
  'Reopened':              'bg-orange-100 text-orange-700',
  'Known Issue':           'bg-yellow-100 text-yellow-700',
  'Blocked':               'bg-red-100 text-red-700',
  'Removed':               'bg-gray-100 text-gray-400',
}

function StatusBadge({ status }) {
  const cls = JIRA_STATUS_COLORS[status] || 'bg-slate-100 text-slate-600'
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${cls}`}>{status || '—'}</span>
}

function TypeBadge({ type }) {
  if (!type) return <span className="text-slate-300 text-xs">—</span>
  const isBug = type === 'Bug'
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium ${isBug ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'}`}>
      {isBug ? <Bug className="h-3 w-3" /> : <BookOpen className="h-3 w-3" />}
      {type}
    </span>
  )
}

const SPRINT_HEADER_COLORS = [
  'border-l-brand-500 bg-brand-50',
  'border-l-purple-400 bg-purple-50',
]
const SPRINT_BADGE_COLORS = ['bg-brand-600 text-white', 'bg-purple-600 text-white']

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) }
  catch { return iso.slice(0, 10) }
}

function sprintDateRange(sprint) {
  const start = fmtDate(sprint.start_date)
  const end = fmtDate(sprint.end_date)
  if (start === '—' && end === '—') return ''
  return `${start} – ${end}`
}

function daysRemaining(sprint) {
  if (sprint.state === 'closed') return null
  const target = sprint.state === 'future' ? sprint.start_date : sprint.end_date
  if (!target) return null
  const diff = Math.ceil((new Date(target) - Date.now()) / 86400000)
  if (sprint.state === 'future') return { label: `Starts in ${diff}d`, cls: 'text-blue-600' }
  if (diff < 0) return { label: 'Overdue', cls: 'text-red-600 font-semibold' }
  if (diff === 0) return { label: 'Ends today', cls: 'text-orange-600 font-semibold' }
  return { label: `${diff}d left`, cls: diff <= 3 ? 'text-orange-500 font-semibold' : 'text-green-600' }
}

function dateDelta(planned, actual) {
  if (!planned || !actual) return null
  const diff = Math.round((new Date(actual) - new Date(planned)) / 86400000)
  if (diff === 0) return { label: 'On time', cls: 'text-green-600' }
  if (diff > 0) return { label: `+${diff}d late`, cls: 'text-red-600 font-semibold' }
  return { label: `${diff}d early`, cls: 'text-green-600' }
}

// ── Small UI pieces ────────────────────────────────────────────────────────

function Badge({ children, className = '' }) {
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${className}`}>{children}</span>
}

function StatCard({ icon: Icon, label, value, color = 'text-slate-700' }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3 flex items-start gap-2.5">
      <div className="p-1.5 rounded-lg bg-slate-50"><Icon className={`h-4 w-4 ${color}`} /></div>
      <div>
        <p className="text-xl font-bold text-slate-800">{value}</p>
        <p className="text-xs text-slate-500 mt-0.5">{label}</p>
      </div>
    </div>
  )
}

function IssueLink({ issueKey, url, summary }) {
  if (!issueKey) return <span className="text-slate-400 text-xs italic">No story</span>
  return (
    <a href={url || `https://avite.atlassian.net/browse/${issueKey}`} target="_blank" rel="noreferrer"
       className="inline-flex items-center gap-1 text-blue-600 hover:text-blue-800 text-xs font-medium">
      {issueKey}
      {summary && <span className="text-slate-500 font-normal truncate max-w-[160px]"> – {summary}</span>}
      <ExternalLink className="h-3 w-3 shrink-0" />
    </a>
  )
}

function SprintSectionHeader({ sprint, colorIdx }) {
  const rem = daysRemaining(sprint)
  const stateChip = { active: 'bg-green-100 text-green-700', future: 'bg-blue-100 text-blue-700', closed: 'bg-slate-100 text-slate-500' }
  return (
    <div className={`flex items-center gap-3 px-4 py-2.5 border-l-4 rounded-lg mb-3 ${SPRINT_HEADER_COLORS[colorIdx]}`}>
      <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${SPRINT_BADGE_COLORS[colorIdx]}`}>
        Sprint {colorIdx + 1}
      </span>
      <span className="font-semibold text-slate-800 text-sm">{sprint.name}</span>
      <Badge className={stateChip[sprint.state] || 'bg-slate-100 text-slate-500'}>{sprint.state}</Badge>
      {sprintDateRange(sprint) && <span className="text-xs text-slate-500">{sprintDateRange(sprint)}</span>}
      {rem && <span className={`text-xs font-medium ${rem.cls}`}>{rem.label}</span>}
    </div>
  )
}

// ── Tabs ───────────────────────────────────────────────────────────────────

const TABS = ['stories', 'activities', 'tracking', 'timeline']
const TAB_LABELS = { stories: 'Stories', activities: 'QA Activities', tracking: 'RTF Tracking', timeline: 'Timeline' }
const TAB_ICONS = { stories: Layers, activities: Target, tracking: CalendarDays, timeline: BarChart2 }

// ── Stories panel (one sprint) ─────────────────────────────────────────────

const TABLE_COLS = (
  <colgroup>
    <col style={{ width: 92 }} />
    <col />
    <col style={{ width: 44 }} />
    <col style={{ width: 60 }} />
    <col style={{ width: 148 }} />
    <col style={{ width: 144 }} />
  </colgroup>
)

const TABLE_HEAD = (
  <thead className="bg-slate-50/80">
    <tr className="text-xs text-slate-500 uppercase tracking-wide">
      <th className="px-3 py-2 text-left font-medium">Key</th>
      <th className="px-3 py-2 text-left font-medium">Summary</th>
      <th className="px-3 py-2 text-center font-medium">SP</th>
      <th className="px-3 py-2 text-center font-medium">Est.h</th>
      <th className="px-3 py-2 text-left font-medium">Status</th>
      <th className="px-3 py-2 text-left font-medium">Assignee</th>
    </tr>
  </thead>
)

function StoriesPanel({ storiesData }) {
  const [search, setSearch] = useState('')
  if (!storiesData) return <div className="p-6 text-slate-400 text-sm text-center">Loading…</div>
  const { stories = [], total_story_points, total_estimated_hours, total_stories } = storiesData

  const filtered = useMemo(() => {
    if (!search.trim()) return stories
    const q = search.toLowerCase()
    return stories.filter(s => s.key.toLowerCase().includes(q) || (s.summary || '').toLowerCase().includes(q) || (s.assignee || '').toLowerCase().includes(q))
  }, [stories, search])

  const grouped = useMemo(() => {
    const map = {}
    for (const s of filtered) {
      const epic = s.epic_key || s.parent_key || 'No Epic'
      if (!map[epic]) map[epic] = { epic_key: s.epic_key || s.parent_key, parent_summary: s.parent_summary, stories: [] }
      map[epic].stories.push(s)
    }
    return Object.values(map)
  }, [filtered])

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <StatCard icon={Layers} label="Stories" value={total_stories} color="text-blue-600" />
        <StatCard icon={Zap} label="Story Points" value={total_story_points ? total_story_points.toFixed(0) : '—'} color="text-purple-600" />
        <StatCard icon={Clock} label="Estimated" value={total_estimated_hours ? `${total_estimated_hours.toFixed(0)}h` : '—'} color="text-teal-600" />
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search by key, summary or assignee…"
          className="w-full pl-8 pr-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-400"
        />
        {search && <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500"><X className="h-3.5 w-3.5" /></button>}
      </div>

      {filtered.length === 0 && search && (
        <div className="text-center text-slate-400 text-sm py-4">No stories match "{search}"</div>
      )}

      {grouped.map(group => (
        <div key={group.epic_key || 'no-epic'} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="bg-slate-50 px-3 py-2 border-b border-slate-200 flex items-center gap-2">
            <ChevronRight className="h-3 w-3 text-slate-400" />
            <span className="text-xs font-semibold text-slate-600">
              {group.epic_key ? `${group.epic_key}${group.parent_summary ? ' – ' + group.parent_summary : ''}` : 'No Epic'}
            </span>
            <Badge className="bg-slate-200 text-slate-600">{group.stories.length}</Badge>
          </div>
          <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
            {TABLE_COLS}
            {TABLE_HEAD}
            <tbody className="divide-y divide-slate-100">
              {group.stories.map(s => (
                <tr key={s.key} className="hover:bg-slate-50/60">
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      {PRIORITY_DOT[s.priority] && <span className={`w-2 h-2 rounded-full shrink-0 ${PRIORITY_DOT[s.priority]}`} title={s.priority} />}
                      <a href={s.url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline font-medium text-xs truncate">{s.key}</a>
                    </div>
                  </td>
                  <td className="px-3 py-2"><span className="text-slate-700 text-xs line-clamp-2">{s.summary}</span></td>
                  <td className="px-3 py-2 text-slate-600 text-xs text-center">{s.story_points != null ? s.story_points : '—'}</td>
                  <td className="px-3 py-2 text-slate-600 text-xs text-center">{s.original_estimate_hours ? `${s.original_estimate_hours}h` : '—'}</td>
                  <td className="px-3 py-2"><StatusBadge status={s.status} /></td>
                  <td className="px-3 py-2 text-slate-500 text-xs truncate" title={s.assignee}>{s.assignee || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {stories.length === 0 && <div className="text-center text-slate-400 text-sm py-6">No stories found in this sprint.</div>}
    </div>
  )
}

// ── Activities panel (one sprint) ──────────────────────────────────────────

const BLANK_ACTIVITY = { activity_name: '', activity_type: 'qa_testing', story_key: '', story_summary: '', estimation_hours: '', status: 'planned', description: '' }

function ActivitiesPanel({ sprintId, sprintName, activities = [], storiesData }) {
  const qc = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState({ ...BLANK_ACTIVITY })
  const [editId, setEditId] = useState(null)
  const [editForm, setEditForm] = useState({})
  const stories = storiesData?.stories || []

  const addMutation = useMutation({
    mutationFn: (data) => axios.post(`${API}/sprint/${sprintId}/activities`, data).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries(['sprint-plan:activities', sprintId]); setShowAdd(false); setForm({ ...BLANK_ACTIVITY }) },
  })
  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => axios.patch(`${API}/activity/${id}`, data).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries(['sprint-plan:activities', sprintId]); setEditId(null) },
  })
  const deleteMutation = useMutation({
    mutationFn: (id) => axios.delete(`${API}/activity/${id}`).then(r => r.data),
    onSuccess: () => qc.invalidateQueries(['sprint-plan:activities', sprintId]),
  })
  const pushJiraMutation = useMutation({
    mutationFn: (id) => axios.post(`${API}/activity/${id}/push-to-jira`).then(r => r.data),
    onSuccess: (data) => alert(`Created Jira task: ${data.jira_key}\n${data.jira_url}`),
    onError: (err) => alert(`Error: ${err.response?.data?.detail || err.message}`),
  })

  const totalHours = activities.reduce((s, a) => s + (a.estimation_hours || 0), 0)

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-slate-600">
          <span className="font-semibold text-slate-800">{activities.length}</span> activities
          {totalHours > 0 && <> · <span className="font-semibold text-teal-700">{totalHours.toFixed(1)}h</span></>}
        </span>
        <button onClick={() => setShowAdd(v => !v)}
          className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-xs font-medium">
          <Plus className="h-3.5 w-3.5" /> Add Activity
        </button>
      </div>

      {showAdd && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 space-y-2">
          <p className="text-xs font-semibold text-blue-800">New QA Activity</p>
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2">
              <input value={form.activity_name} onChange={e => setForm(f => ({ ...f, activity_name: e.target.value }))}
                placeholder="Activity name *"
                className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-300" />
            </div>
            <select value={form.activity_type} onChange={e => setForm(f => ({ ...f, activity_type: e.target.value }))}
              className="border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-300">
              {Object.entries(ACTIVITY_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <input type="number" min="0" step="0.5" value={form.estimation_hours}
              onChange={e => setForm(f => ({ ...f, estimation_hours: e.target.value }))}
              placeholder="Hours (e.g. 4)"
              className="border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-300" />
            <select value={form.story_key}
              onChange={e => { const s = stories.find(x => x.key === e.target.value); setForm(f => ({ ...f, story_key: e.target.value, story_summary: s?.summary || '' })) }}
              className="border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-300">
              <option value="">— story (optional) —</option>
              {stories.map(s => <option key={s.key} value={s.key}>{s.key}: {s.summary}</option>)}
            </select>
            <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
              className="border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs bg-white focus:outline-none focus:ring-2 focus:ring-blue-300">
              {Object.entries(ACTIVITY_STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="flex gap-2">
            <button disabled={!form.activity_name || addMutation.isPending}
              onClick={() => addMutation.mutate({ ...form, sprint_name: sprintName, estimation_hours: form.estimation_hours ? parseFloat(form.estimation_hours) : null })}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-3 py-1 rounded-lg text-xs font-medium">
              {addMutation.isPending ? 'Adding…' : 'Add'}
            </button>
            <button onClick={() => setShowAdd(false)} className="bg-white border border-slate-200 text-slate-600 px-3 py-1 rounded-lg text-xs">Cancel</button>
          </div>
        </div>
      )}

      {activities.length > 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-slate-50">
              <tr className="text-slate-500 uppercase tracking-wide">
                <th className="px-3 py-2 text-left font-medium w-6">#</th>
                <th className="px-3 py-2 text-left font-medium">Activity</th>
                <th className="px-3 py-2 text-left font-medium">Type</th>
                <th className="px-3 py-2 text-left font-medium">Story</th>
                <th className="px-3 py-2 text-center font-medium">Hours</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {activities.map((a, idx) => editId === a.id ? (
                <tr key={a.id} className="bg-blue-50">
                  <td className="px-3 py-2 text-slate-400">{idx + 1}</td>
                  <td className="px-3 py-2">
                    <input value={editForm.activity_name ?? a.activity_name}
                      onChange={e => setEditForm(f => ({ ...f, activity_name: e.target.value }))}
                      className="border border-blue-300 rounded px-1.5 py-1 text-xs w-full focus:outline-none" />
                  </td>
                  <td className="px-3 py-2">
                    <select value={editForm.activity_type ?? a.activity_type}
                      onChange={e => setEditForm(f => ({ ...f, activity_type: e.target.value }))}
                      className="border border-blue-300 rounded px-1.5 py-1 text-xs bg-white focus:outline-none">
                      {Object.entries(ACTIVITY_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <select value={editForm.story_key ?? a.story_key}
                      onChange={e => { const s = stories.find(x => x.key === e.target.value); setEditForm(f => ({ ...f, story_key: e.target.value, story_summary: s?.summary || '' })) }}
                      className="border border-blue-300 rounded px-1.5 py-1 text-xs bg-white focus:outline-none w-28">
                      <option value="">— none —</option>
                      {stories.map(s => <option key={s.key} value={s.key}>{s.key}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input type="number" min="0" step="0.5" value={editForm.estimation_hours ?? (a.estimation_hours ?? '')}
                      onChange={e => setEditForm(f => ({ ...f, estimation_hours: e.target.value ? parseFloat(e.target.value) : null }))}
                      className="border border-blue-300 rounded px-1.5 py-1 text-xs w-14 focus:outline-none" />
                  </td>
                  <td className="px-3 py-2">
                    <select value={editForm.status ?? a.status}
                      onChange={e => setEditForm(f => ({ ...f, status: e.target.value }))}
                      className="border border-blue-300 rounded px-1.5 py-1 text-xs bg-white focus:outline-none">
                      {Object.entries(ACTIVITY_STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => updateMutation.mutate({ id: a.id, data: editForm })} className="p-1 text-green-600 hover:bg-green-100 rounded"><Save className="h-3.5 w-3.5" /></button>
                      <button onClick={() => setEditId(null)} className="p-1 text-slate-400 hover:bg-slate-100 rounded"><X className="h-3.5 w-3.5" /></button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={a.id} className="hover:bg-slate-50/60">
                  <td className="px-3 py-2 text-slate-400">{idx + 1}</td>
                  <td className="px-3 py-2">
                    <p className="font-medium text-slate-800">{a.activity_name}</p>
                    {a.description && <p className="text-slate-400 text-xs mt-0.5">{a.description}</p>}
                  </td>
                  <td className="px-3 py-2"><Badge className={TYPE_COLORS[a.activity_type] || 'bg-slate-100 text-slate-600'}>{ACTIVITY_TYPE_LABELS[a.activity_type] || a.activity_type}</Badge></td>
                  <td className="px-3 py-2"><IssueLink issueKey={a.story_key} summary={a.story_summary} /></td>
                  <td className="px-3 py-2 text-center font-medium text-slate-700">{a.estimation_hours != null ? `${a.estimation_hours}h` : '—'}</td>
                  <td className="px-3 py-2"><Badge className={STATUS_COLORS[a.status] || 'bg-slate-100 text-slate-500'}>{ACTIVITY_STATUS_LABELS[a.status] || a.status}</Badge></td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      {a.story_key && <button onClick={() => pushJiraMutation.mutate(a.id)} disabled={pushJiraMutation.isPending} className="px-1.5 py-0.5 text-blue-500 hover:bg-blue-50 rounded font-medium">Jira</button>}
                      <button onClick={() => { setEditId(a.id); setEditForm({}) }} className="p-1 text-slate-400 hover:bg-slate-100 rounded"><Edit2 className="h-3.5 w-3.5" /></button>
                      <button onClick={() => { if (confirm('Delete?')) deleteMutation.mutate(a.id) }} className="p-1 text-red-400 hover:bg-red-50 rounded"><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !showAdd && (
          <div className="bg-white rounded-xl border border-slate-200 p-6 text-center">
            <p className="text-slate-400 text-xs">No QA activities yet.</p>
            <button onClick={() => setShowAdd(true)} className="mt-2 text-blue-600 hover:text-blue-800 text-xs font-medium">+ Add first activity</button>
          </div>
        )
      )}
    </div>
  )
}

// ── Tracking panel (one sprint) ────────────────────────────────────────────

function TrackingPanel({ sprintId, sprintName = '', stories = [], tracking = [] }) {
  const qc = useQueryClient()
  const [editKey, setEditKey] = useState(null)
  const [editForm, setEditForm] = useState({})
  const [search, setSearch] = useState('')

  const trackingByKey = useMemo(() => {
    const m = {}
    for (const t of tracking) m[t.story_key] = t
    return m
  }, [tracking])

  const merged = useMemo(() => {
    const rows = stories.map(s => ({ story: s, tracking: trackingByKey[s.key] || null }))
    for (const t of tracking) {
      if (!stories.find(s => s.key === t.story_key))
        rows.push({ story: { key: t.story_key, summary: t.story_summary, url: `https://avite.atlassian.net/browse/${t.story_key}` }, tracking: t })
    }
    return rows
  }, [stories, trackingByKey])

  const visible = useMemo(() => {
    if (!search.trim()) return merged
    const q = search.toLowerCase()
    return merged.filter(({ story }) =>
      story.key.toLowerCase().includes(q) || (story.summary || '').toLowerCase().includes(q)
    )
  }, [merged, search])

  const upsertMutation = useMutation({
    mutationFn: ({ key, data }) => axios.put(`${API}/sprint/${sprintId}/tracking/${key}`, data).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries(['sprint-plan:tracking', sprintId]); setEditKey(null) },
  })

  const onTimeCount    = merged.filter(r => r.tracking?.planned_rft_date && r.tracking?.actual_rft_date && new Date(r.tracking.actual_rft_date) <= new Date(r.tracking.planned_rft_date)).length
  const delayedCount   = merged.filter(r => r.tracking?.planned_rft_date && r.tracking?.actual_rft_date && new Date(r.tracking.actual_rft_date) > new Date(r.tracking.planned_rft_date)).length
  const untrackedCount = merged.filter(r => !r.tracking?.planned_rft_date).length

  return (
    <div className="space-y-3">
      {/* RTF explanation */}
      <div className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
        <Info className="h-3.5 w-3.5 text-blue-400 mt-0.5 shrink-0" />
        <p className="text-xs text-blue-700">
          <span className="font-semibold">RFT = Ready For Testing.</span> Track when each story was planned to reach QA vs. when it actually did. Fill in <em>Planned RFT</em> at sprint start; update <em>Actual RFT</em> when the story lands in your queue.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <StatCard icon={CheckCircle2} label="On time"    value={onTimeCount}    color="text-green-600" />
        <StatCard icon={AlertTriangle} label="Delayed"   value={delayedCount}   color="text-red-500" />
        <StatCard icon={Clock}         label="Not tracked" value={untrackedCount} color="text-slate-400" />
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search by key or summary…"
          className="w-full pl-8 pr-3 py-2 text-sm border border-slate-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-brand-400"
        />
        {search && <button onClick={() => setSearch('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500"><X className="h-3.5 w-3.5" /></button>}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
        <table className="w-full text-xs" style={{ tableLayout: 'fixed', minWidth: 900 }}>
          <colgroup>
            <col style={{ width: 130 }} />
            <col style={{ width: 80 }} />
            <col style={{ width: 120 }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 90 }} />
            <col style={{ width: 70 }} />
            <col style={{ width: 150 }} />
            <col />
            <col style={{ width: 40 }} />
          </colgroup>
          <thead className="bg-slate-50">
            <tr className="text-slate-500 uppercase tracking-wide">
              <th className="px-3 py-2 text-left font-medium">Story</th>
              <th className="px-3 py-2 text-left font-medium">Type</th>
              <th className="px-3 py-2 text-left font-medium">Status</th>
              <th className="px-3 py-2 text-left font-medium">Sprint</th>
              <th className="px-3 py-2 text-left font-medium">Planned RFT</th>
              <th className="px-3 py-2 text-left font-medium">Actual RFT</th>
              <th className="px-3 py-2 text-left font-medium">Delta</th>
              <th className="px-3 py-2 text-left font-medium">Delay Reason</th>
              <th className="px-3 py-2 text-right font-medium">Edit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visible.map(({ story, tracking: t }) => {
              const isEditing = editKey === story.key
              const delta = t ? dateDelta(t.planned_rft_date, t.actual_rft_date) : null
              return isEditing ? (
                <tr key={story.key} className="bg-blue-50">
                  <td className="px-3 py-2"><IssueLink issueKey={story.key} url={story.url} summary={story.summary} /></td>
                  <td className="px-3 py-2"><TypeBadge type={story.issue_type} /></td>
                  <td className="px-3 py-2"><StatusBadge status={story.status} /></td>
                  <td className="px-3 py-2 text-slate-500 truncate" title={sprintName}>{sprintName || '—'}</td>
                  <td className="px-3 py-2"><input type="date" value={editForm.planned_rft_date ?? (t?.planned_rft_date || '')} onChange={e => setEditForm(f => ({ ...f, planned_rft_date: e.target.value }))} className="border border-blue-300 rounded px-1.5 py-0.5 text-xs focus:outline-none w-full" /></td>
                  <td className="px-3 py-2"><input type="date" value={editForm.actual_rft_date ?? (t?.actual_rft_date || '')} onChange={e => setEditForm(f => ({ ...f, actual_rft_date: e.target.value }))} className="border border-blue-300 rounded px-1.5 py-0.5 text-xs focus:outline-none w-full" /></td>
                  <td className="px-3 py-2 text-slate-400">—</td>
                  <td className="px-3 py-2">
                    <select value={editForm.delay_reason ?? (t?.delay_reason || '')} onChange={e => setEditForm(f => ({ ...f, delay_reason: e.target.value }))} className="border border-blue-300 rounded px-1.5 py-0.5 text-xs bg-white focus:outline-none w-full">
                      <option value="">— none —</option>
                      {Object.entries(DELAY_REASON_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => upsertMutation.mutate({ key: story.key, data: { ...editForm, story_summary: story.summary } })} className="p-1 text-green-600 hover:bg-green-100 rounded"><Save className="h-3.5 w-3.5" /></button>
                      <button onClick={() => setEditKey(null)} className="p-1 text-slate-400 hover:bg-slate-100 rounded"><X className="h-3.5 w-3.5" /></button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={story.key} className={`hover:bg-slate-50/60 ${delta?.label.includes('late') ? 'bg-red-50/30' : ''}`}>
                  <td className="px-3 py-2"><IssueLink issueKey={story.key} url={story.url} summary={story.summary} /></td>
                  <td className="px-3 py-2"><TypeBadge type={story.issue_type} /></td>
                  <td className="px-3 py-2"><StatusBadge status={story.status} /></td>
                  <td className="px-3 py-2 text-slate-500 truncate text-xs" title={sprintName}>{sprintName || '—'}</td>
                  <td className="px-3 py-2 text-slate-600">{t?.planned_rft_date ? fmtDate(t.planned_rft_date) : <span className="text-slate-300">—</span>}</td>
                  <td className="px-3 py-2 text-slate-600">{t?.actual_rft_date ? fmtDate(t.actual_rft_date) : <span className="text-slate-300">—</span>}</td>
                  <td className="px-3 py-2">{delta ? <span className={`font-medium ${delta.cls}`}>{delta.label}</span> : <span className="text-slate-300">—</span>}</td>
                  <td className="px-3 py-2 text-slate-600">{t?.delay_reason ? DELAY_REASON_LABELS[t.delay_reason] || t.delay_reason : <span className="text-slate-300">—</span>}</td>
                  <td className="px-3 py-2 text-right"><button onClick={() => { setEditKey(story.key); setEditForm({}) }} className="p-1 text-slate-400 hover:bg-slate-100 rounded"><Edit2 className="h-3.5 w-3.5" /></button></td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {visible.length === 0 && (
          <div className="p-6 text-center text-slate-400 text-xs">
            {search ? `No stories match "${search}"` : 'No stories to track.'}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Timeline panel (one sprint) ────────────────────────────────────────────

function TimelinePanel({ sprintId, activities = [] }) {
  const qc = useQueryClient()
  const reorderMutation = useMutation({
    mutationFn: (ids) => axios.post(`${API}/sprint/${sprintId}/reorder`, { ordered_ids: ids }).then(r => r.data),
    onSuccess: () => qc.invalidateQueries(['sprint-plan:activities', sprintId]),
  })
  function move(idx, dir) {
    const ids = activities.map(a => a.id)
    const ni = idx + dir
    if (ni < 0 || ni >= ids.length) return
    ;[ids[idx], ids[ni]] = [ids[ni], ids[idx]]
    reorderMutation.mutate(ids)
  }
  const maxHours = Math.max(...activities.map(a => a.estimation_hours || 0), 8)
  const totalHours = activities.reduce((s, a) => s + (a.estimation_hours || 0), 0)

  if (activities.length === 0)
    return <div className="bg-white rounded-xl border border-slate-200 p-6 text-center text-slate-400 text-xs">No activities yet.</div>

  const barColor = { qa_testing: 'bg-blue-400', regression: 'bg-purple-400', smoke_test: 'bg-teal-400', review: 'bg-orange-400', exploratory: 'bg-pink-400', other: 'bg-slate-300' }

  return (
    <div className="space-y-2">
      <div className="flex justify-between text-xs text-slate-500">
        <span><span className="font-semibold text-slate-700">{activities.length}</span> activities</span>
        <span>Total <span className="font-semibold text-teal-700">{totalHours.toFixed(1)}h</span></span>
      </div>
      <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
        {activities.map((a, idx) => {
          const pct = Math.max(2, (a.estimation_hours || 0) / maxHours * 100)
          const dot = { planned: 'bg-slate-400', in_progress: 'bg-blue-500', done: 'bg-green-500', blocked: 'bg-red-500' }[a.status] || 'bg-slate-400'
          return (
            <div key={a.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-slate-50">
              <span className="text-slate-300 text-xs w-4 text-right shrink-0">{idx + 1}</span>
              <span className={`w-2 h-2 rounded-full shrink-0 ${barColor[a.activity_type] || 'bg-slate-300'}`} />
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-slate-800 truncate">{a.activity_name}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  {a.story_key && <span className="text-xs text-blue-600 font-medium">{a.story_key}</span>}
                  <span className={`inline-flex items-center gap-1 px-1.5 py-0 rounded-full text-xs ${STATUS_COLORS[a.status]}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
                    {ACTIVITY_STATUS_LABELS[a.status]}
                  </span>
                </div>
              </div>
              <div className="w-36 shrink-0 flex items-center gap-2">
                <div className="flex-1 bg-slate-100 rounded-full h-2 overflow-hidden">
                  <div className={`h-full rounded-full ${barColor[a.activity_type] || 'bg-slate-300'}`} style={{ width: `${pct}%` }} />
                </div>
                <span className="text-xs text-slate-600 w-8 text-right shrink-0">{a.estimation_hours != null ? `${a.estimation_hours}h` : '—'}</span>
              </div>
              <div className="flex flex-col gap-0.5 shrink-0">
                <button onClick={() => move(idx, -1)} disabled={idx === 0} className="p-0.5 text-slate-300 hover:text-slate-600 disabled:opacity-20"><ArrowUp className="h-3 w-3" /></button>
                <button onClick={() => move(idx, 1)} disabled={idx === activities.length - 1} className="p-0.5 text-slate-300 hover:text-slate-600 disabled:opacity-20"><ArrowDown className="h-3 w-3" /></button>
              </div>
            </div>
          )
        })}
      </div>
      {/* Type legend */}
      <div className="flex flex-wrap gap-3 text-xs text-slate-500 bg-white rounded-xl border border-slate-200 px-3 py-2">
        {Object.entries(ACTIVITY_TYPE_LABELS).map(([type, label]) => {
          const items = activities.filter(a => a.activity_type === type)
          if (!items.length) return null
          const hrs = items.reduce((s, a) => s + (a.estimation_hours || 0), 0)
          return (
            <span key={type} className="flex items-center gap-1">
              <span className={`w-2 h-2 rounded-full ${barColor[type]}`} />
              {label} <span className="font-semibold text-slate-700">{hrs}h</span>
            </span>
          )
        })}
      </div>
    </div>
  )
}

// ── Sprint data hook ───────────────────────────────────────────────────────

function useSprintData(sprintId) {
  const storiesQ = useQuery({
    queryKey: ['sprint-plan:stories', sprintId],
    queryFn: () => axios.get(`${API}/sprint/${sprintId}/stories`).then(r => r.data),
    enabled: !!sprintId, staleTime: 180_000,
  })
  const activitiesQ = useQuery({
    queryKey: ['sprint-plan:activities', sprintId],
    queryFn: () => axios.get(`${API}/sprint/${sprintId}/activities`).then(r => r.data.activities),
    enabled: !!sprintId, staleTime: 30_000,
  })
  const trackingQ = useQuery({
    queryKey: ['sprint-plan:tracking', sprintId],
    queryFn: () => axios.get(`${API}/sprint/${sprintId}/tracking`).then(r => r.data.tracking),
    enabled: !!sprintId, staleTime: 60_000,
  })
  return { storiesQ, activitiesQ, trackingQ }
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function SprintPlanningPage() {
  const [sprint1Id, setSprint1Id] = useState(null)
  const [sprint2Id, setSprint2Id] = useState(null)
  const [showSprint2, setShowSprint2] = useState(false)
  const [activeTab, setActiveTab] = useState('stories')

  const sprintsQ = useQuery({
    queryKey: ['sprint-plan:sprints'],
    queryFn: () => axios.get(`${API}/sprints`).then(r => r.data.sprints),
    staleTime: 300_000,
  })
  const sprints = sprintsQ.data || []

  // Auto-select active sprint on first load
  useMemo(() => {
    if (!sprint1Id && sprints.length > 0) {
      const active = sprints.find(s => s.state === 'active')
      setSprint1Id(active ? active.id : sprints[0].id)
    }
  }, [sprints])

  const sprint1 = sprints.find(s => s.id === sprint1Id) || null
  const sprint2 = sprints.find(s => s.id === sprint2Id) || null

  const d1 = useSprintData(sprint1Id)
  const d2 = useSprintData(sprint2Id)

  const isFetching = sprintsQ.isFetching || d1.storiesQ.isFetching || d1.activitiesQ.isFetching ||
    (sprint2Id && (d2.storiesQ.isFetching || d2.activitiesQ.isFetching))

  const stateChip = { active: 'bg-green-100 text-green-700', future: 'bg-blue-100 text-blue-700', closed: 'bg-slate-100 text-slate-500' }

  function SprintRow({ sprint, sprintId, setSprintId, colorIdx, onRemove }) {
    const rem = sprint ? daysRemaining(sprint) : null
    return (
      <div className="flex items-center gap-3 flex-wrap">
        <span className={`text-xs font-bold px-2 py-0.5 rounded-full shrink-0 ${SPRINT_BADGE_COLORS[colorIdx]}`}>
          Sprint {colorIdx + 1}
        </span>
        <div className="relative">
          <select value={sprintId || ''} onChange={e => setSprintId(e.target.value ? Number(e.target.value) : null)}
            className="appearance-none bg-white border border-slate-200 rounded-lg pl-3 pr-7 py-1.5 text-sm text-slate-800 font-medium focus:outline-none focus:ring-2 focus:ring-brand-400 min-w-[220px]">
            <option value="">— select sprint —</option>
            {sprints.map(s => (
              <option key={s.id} value={s.id} disabled={s.id === (colorIdx === 0 ? sprint2Id : sprint1Id)}>
                {s.name} {s.state === 'active' ? '(Active)' : s.state === 'future' ? '(Future)' : ''}
              </option>
            ))}
          </select>
          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
        </div>
        {sprint && (
          <>
            <Badge className={stateChip[sprint.state] || 'bg-slate-100 text-slate-500'}>{sprint.state}</Badge>
            {sprintDateRange(sprint) && <span className="text-xs text-slate-500">{sprintDateRange(sprint)}</span>}
            {rem && <span className={`text-xs font-medium ${rem.cls}`}>{rem.label}</span>}
          </>
        )}
        {onRemove && (
          <button onClick={onRemove} className="ml-auto text-slate-400 hover:text-red-400 transition-colors" title="Remove sprint 2">
            <XCircle className="h-4 w-4" />
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex-1 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <CalendarDays className="h-6 w-6 text-brand-600" />
            <h1 className="text-xl font-bold text-slate-800">Sprint Planning</h1>
          </div>
          <button onClick={() => { sprintsQ.refetch(); d1.storiesQ.refetch(); d1.activitiesQ.refetch(); d1.trackingQ.refetch(); if (sprint2Id) { d2.storiesQ.refetch(); d2.activitiesQ.refetch(); d2.trackingQ.refetch() } }}
            className="flex items-center gap-2 text-slate-500 hover:text-slate-700 text-sm px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50">
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>

        {/* Sprint selectors */}
        <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
          <SprintRow sprint={sprint1} sprintId={sprint1Id} setSprintId={setSprint1Id} colorIdx={0} />

          {showSprint2 ? (
            <SprintRow sprint={sprint2} sprintId={sprint2Id} setSprintId={setSprint2Id} colorIdx={1}
              onRemove={() => { setShowSprint2(false); setSprint2Id(null) }} />
          ) : (
            <button onClick={() => setShowSprint2(true)}
              className="flex items-center gap-1.5 text-slate-400 hover:text-brand-600 text-xs font-medium transition-colors">
              <PlusCircle className="h-3.5 w-3.5" /> Add second sprint to board
            </button>
          )}
        </div>

        {sprint1Id ? (
          <>
            {/* Tabs */}
            <div className="flex gap-1 bg-white rounded-xl border border-slate-200 p-1">
              {TABS.map(tab => {
                const Icon = TAB_ICONS[tab]
                return (
                  <button key={tab} onClick={() => setActiveTab(tab)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors flex-1 justify-center ${activeTab === tab ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
                    <Icon className="h-4 w-4" />{TAB_LABELS[tab]}
                  </button>
                )
              })}
            </div>

            {/* Tab content — renders one or two sprint sections */}
            <div className="space-y-6">
              {/* Sprint 1 section */}
              {sprint1 && (
                <div>
                  {showSprint2 && sprint2 && <SprintSectionHeader sprint={sprint1} colorIdx={0} />}
                  {activeTab === 'stories' && <StoriesPanel storiesData={d1.storiesQ.isLoading ? null : d1.storiesQ.data} />}
                  {activeTab === 'activities' && <ActivitiesPanel sprintId={sprint1Id} sprintName={sprint1.name} activities={d1.activitiesQ.data || []} storiesData={d1.storiesQ.data} />}
                  {activeTab === 'tracking' && <TrackingPanel sprintId={sprint1Id} sprintName={sprint1?.name || ''} stories={d1.storiesQ.data?.stories || []} tracking={d1.trackingQ.data || []} />}
                  {activeTab === 'timeline' && <TimelinePanel sprintId={sprint1Id} activities={d1.activitiesQ.data || []} />}
                </div>
              )}

              {/* Sprint 2 section */}
              {showSprint2 && sprint2Id && (
                <div>
                  <SprintSectionHeader sprint={sprint2 || { name: 'Sprint 2', state: '' }} colorIdx={1} />
                  {activeTab === 'stories' && <StoriesPanel storiesData={d2.storiesQ.isLoading ? null : d2.storiesQ.data} />}
                  {activeTab === 'activities' && <ActivitiesPanel sprintId={sprint2Id} sprintName={sprint2?.name || ''} activities={d2.activitiesQ.data || []} storiesData={d2.storiesQ.data} />}
                  {activeTab === 'tracking' && <TrackingPanel sprintId={sprint2Id} sprintName={sprint2?.name || ''} stories={d2.storiesQ.data?.stories || []} tracking={d2.trackingQ.data || []} />}
                  {activeTab === 'timeline' && <TimelinePanel sprintId={sprint2Id} activities={d2.activitiesQ.data || []} />}
                </div>
              )}

              {/* Prompt when sprint 2 is open but not yet selected */}
              {showSprint2 && !sprint2Id && (
                <div className="bg-purple-50 border border-purple-200 rounded-xl p-6 text-center">
                  <p className="text-purple-500 text-sm">Select a second sprint above to view it here.</p>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="bg-white rounded-xl border border-slate-200 p-16 text-center">
            <CalendarDays className="h-10 w-10 text-slate-300 mx-auto mb-3" />
            <p className="text-slate-500 font-medium">Select a sprint to start planning</p>
            <p className="text-slate-400 text-sm mt-1">Track QA activities, story readiness, and timelines.</p>
          </div>
        )}
      </div>
    </div>
  )
}

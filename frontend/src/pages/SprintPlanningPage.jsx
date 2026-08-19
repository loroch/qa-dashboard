import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import {
  CalendarDays, ChevronDown, RefreshCw, Plus, Trash2, Edit2, Save, X,
  ArrowUp, ArrowDown, ExternalLink, CheckCircle2, Clock, AlertTriangle,
  Layers, BarChart2, Target, Zap, ChevronRight
} from 'lucide-react'

const API = '/api/sprint-planning'

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
  Highest: 'bg-red-600',
  High: 'bg-orange-500',
  Medium: 'bg-yellow-400',
  Low: 'bg-blue-400',
  Lowest: 'bg-slate-400',
}

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
  } catch { return iso.slice(0, 10) }
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

function StatCard({ icon: Icon, label, value, sub, color = 'text-slate-700' }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-start gap-3">
      <div className="p-2 rounded-lg bg-slate-50">
        <Icon className={`h-5 w-5 ${color}`} />
      </div>
      <div>
        <p className="text-2xl font-bold text-slate-800">{value}</p>
        <p className="text-xs text-slate-500 mt-0.5">{label}</p>
        {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
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
      {summary && <span className="text-slate-500 font-normal truncate max-w-[180px]"> – {summary}</span>}
      <ExternalLink className="h-3 w-3 shrink-0" />
    </a>
  )
}

// ── Tabs ───────────────────────────────────────────────────────────────────

const TABS = ['stories', 'activities', 'tracking', 'timeline']
const TAB_LABELS = { stories: 'Stories', activities: 'QA Activities', tracking: 'RTF Tracking', timeline: 'Timeline' }
const TAB_ICONS = { stories: Layers, activities: Target, tracking: CalendarDays, timeline: BarChart2 }

// ── Stories tab ────────────────────────────────────────────────────────────

function StoriesTab({ storiesData }) {
  if (!storiesData) return <div className="p-8 text-slate-400 text-sm">Select a sprint to load stories.</div>

  const { stories = [], total_story_points, total_estimated_hours, total_stories } = storiesData

  const grouped = useMemo(() => {
    const map = {}
    for (const s of stories) {
      const epic = s.epic_key || s.parent_key || 'No Epic'
      if (!map[epic]) map[epic] = { epic_key: s.epic_key || s.parent_key, parent_summary: s.parent_summary, stories: [] }
      map[epic].stories.push(s)
    }
    return Object.values(map)
  }, [stories])

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard icon={Layers} label="Stories in sprint" value={total_stories} color="text-blue-600" />
        <StatCard icon={Zap} label="Story points" value={total_story_points ? total_story_points.toFixed(0) : '—'} color="text-purple-600" />
        <StatCard icon={Clock} label="Estimated hours" value={total_estimated_hours ? `${total_estimated_hours.toFixed(0)}h` : '—'} color="text-teal-600" />
      </div>

      {/* Grouped table */}
      {grouped.map(group => (
        <div key={group.epic_key || 'no-epic'} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="bg-slate-50 px-4 py-2.5 border-b border-slate-200 flex items-center gap-2">
            <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
            <span className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
              {group.epic_key ? `${group.epic_key}${group.parent_summary ? ' – ' + group.parent_summary : ''}` : 'No Epic / Direct Issues'}
            </span>
            <Badge className="bg-slate-200 text-slate-600">{group.stories.length}</Badge>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-50/60">
              <tr className="text-xs text-slate-500 uppercase tracking-wide">
                <th className="px-4 py-2 text-left font-medium">Key</th>
                <th className="px-4 py-2 text-left font-medium">Summary</th>
                <th className="px-4 py-2 text-left font-medium">SP</th>
                <th className="px-4 py-2 text-left font-medium">Est.h</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-left font-medium">Assignee</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {group.stories.map(s => (
                <tr key={s.key} className="hover:bg-slate-50/60">
                  <td className="px-4 py-2.5 whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      {PRIORITY_DOT[s.priority] && <span className={`w-2 h-2 rounded-full ${PRIORITY_DOT[s.priority]}`} title={s.priority} />}
                      <a href={s.url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline font-medium text-xs">
                        {s.key}
                      </a>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 max-w-xs">
                    <span className="text-slate-700 line-clamp-2">{s.summary}</span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-600 text-center">
                    {s.story_points != null ? s.story_points : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-slate-600 text-center">
                    {s.original_estimate_hours ? `${s.original_estimate_hours}h` : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{s.status || '—'}</span>
                  </td>
                  <td className="px-4 py-2.5 text-slate-500 text-xs">{s.assignee || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      {stories.length === 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center text-slate-400 text-sm">
          No stories found in this sprint.
        </div>
      )}
    </div>
  )
}

// ── QA Activities tab ──────────────────────────────────────────────────────

const BLANK_ACTIVITY = { activity_name: '', activity_type: 'qa_testing', story_key: '', story_summary: '', estimation_hours: '', status: 'planned', description: '' }

function ActivitiesTab({ sprintId, sprintName, activities = [], storiesData, onMutated }) {
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

  function handleStoryPick(e) {
    const key = e.target.value
    const s = stories.find(x => x.key === key)
    setForm(f => ({ ...f, story_key: key, story_summary: s?.summary || '' }))
  }

  const totalHours = activities.reduce((s, a) => s + (a.estimation_hours || 0), 0)

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <span className="text-sm text-slate-600">
            <span className="font-semibold text-slate-800">{activities.length}</span> activities
          </span>
          {totalHours > 0 && (
            <span className="text-sm text-slate-600">
              Total: <span className="font-semibold text-teal-700">{totalHours.toFixed(1)}h</span>
            </span>
          )}
        </div>
        <button
          onClick={() => setShowAdd(v => !v)}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
        >
          <Plus className="h-4 w-4" /> Add Activity
        </button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
          <p className="text-sm font-semibold text-blue-800">New QA Activity</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-xs text-slate-500 mb-1">Activity Name *</label>
              <input value={form.activity_name} onChange={e => setForm(f => ({ ...f, activity_name: e.target.value }))}
                placeholder="e.g. QA Testing for Auth Flow"
                className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300" />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Type</label>
              <select value={form.activity_type} onChange={e => setForm(f => ({ ...f, activity_type: e.target.value }))}
                className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-300">
                {Object.entries(ACTIVITY_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Estimated Hours</label>
              <input type="number" min="0" step="0.5" value={form.estimation_hours}
                onChange={e => setForm(f => ({ ...f, estimation_hours: e.target.value }))}
                placeholder="e.g. 4"
                className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300" />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Linked Story (optional)</label>
              <select value={form.story_key} onChange={handleStoryPick}
                className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-300">
                <option value="">— no story —</option>
                {stories.map(s => <option key={s.key} value={s.key}>{s.key}: {s.summary}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">Status</label>
              <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-300">
                {Object.entries(ACTIVITY_STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-xs text-slate-500 mb-1">Description (optional)</label>
              <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Additional notes..."
                className="w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300" />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              disabled={!form.activity_name || addMutation.isPending}
              onClick={() => addMutation.mutate({ ...form, sprint_name: sprintName, estimation_hours: form.estimation_hours ? parseFloat(form.estimation_hours) : null })}
              className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-1.5 rounded-lg text-sm font-medium transition-colors"
            >
              {addMutation.isPending ? 'Adding…' : 'Add Activity'}
            </button>
            <button onClick={() => setShowAdd(false)} className="bg-white border border-slate-200 text-slate-600 hover:bg-slate-50 px-4 py-1.5 rounded-lg text-sm">
              Cancel
            </button>
          </div>
          {addMutation.isError && <p className="text-red-600 text-xs">{addMutation.error?.response?.data?.detail || 'Error adding activity'}</p>}
        </div>
      )}

      {/* Activities table */}
      {activities.length > 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr className="text-xs text-slate-500 uppercase tracking-wide">
                <th className="px-4 py-2.5 text-left font-medium w-8">#</th>
                <th className="px-4 py-2.5 text-left font-medium">Activity</th>
                <th className="px-4 py-2.5 text-left font-medium">Type</th>
                <th className="px-4 py-2.5 text-left font-medium">Story</th>
                <th className="px-4 py-2.5 text-left font-medium">Hours</th>
                <th className="px-4 py-2.5 text-left font-medium">Status</th>
                <th className="px-4 py-2.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {activities.map((a, idx) => editId === a.id ? (
                <tr key={a.id} className="bg-blue-50">
                  <td className="px-4 py-2 text-slate-400 text-xs">{idx + 1}</td>
                  <td className="px-4 py-2">
                    <input value={editForm.activity_name ?? a.activity_name}
                      onChange={e => setEditForm(f => ({ ...f, activity_name: e.target.value }))}
                      className="border border-blue-300 rounded px-2 py-1 text-xs w-full focus:outline-none" />
                  </td>
                  <td className="px-4 py-2">
                    <select value={editForm.activity_type ?? a.activity_type}
                      onChange={e => setEditForm(f => ({ ...f, activity_type: e.target.value }))}
                      className="border border-blue-300 rounded px-2 py-1 text-xs bg-white focus:outline-none">
                      {Object.entries(ACTIVITY_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    <select value={editForm.story_key ?? a.story_key}
                      onChange={e => {
                        const key = e.target.value
                        const s = stories.find(x => x.key === key)
                        setEditForm(f => ({ ...f, story_key: key, story_summary: s?.summary || '' }))
                      }}
                      className="border border-blue-300 rounded px-2 py-1 text-xs bg-white focus:outline-none max-w-[180px]">
                      <option value="">— none —</option>
                      {stories.map(s => <option key={s.key} value={s.key}>{s.key}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    <input type="number" min="0" step="0.5" value={editForm.estimation_hours ?? (a.estimation_hours ?? '')}
                      onChange={e => setEditForm(f => ({ ...f, estimation_hours: e.target.value ? parseFloat(e.target.value) : null }))}
                      className="border border-blue-300 rounded px-2 py-1 text-xs w-16 focus:outline-none" />
                  </td>
                  <td className="px-4 py-2">
                    <select value={editForm.status ?? a.status}
                      onChange={e => setEditForm(f => ({ ...f, status: e.target.value }))}
                      className="border border-blue-300 rounded px-2 py-1 text-xs bg-white focus:outline-none">
                      {Object.entries(ACTIVITY_STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => updateMutation.mutate({ id: a.id, data: editForm })}
                        className="p-1.5 text-green-600 hover:bg-green-100 rounded" title="Save">
                        <Save className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => setEditId(null)} className="p-1.5 text-slate-400 hover:bg-slate-100 rounded" title="Cancel">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={a.id} className="hover:bg-slate-50/60">
                  <td className="px-4 py-2.5 text-slate-400 text-xs">{idx + 1}</td>
                  <td className="px-4 py-2.5">
                    <p className="text-slate-800 font-medium text-sm">{a.activity_name}</p>
                    {a.description && <p className="text-slate-400 text-xs mt-0.5">{a.description}</p>}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge className={TYPE_COLORS[a.activity_type] || 'bg-slate-100 text-slate-600'}>
                      {ACTIVITY_TYPE_LABELS[a.activity_type] || a.activity_type}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    <IssueLink issueKey={a.story_key} summary={a.story_summary} />
                  </td>
                  <td className="px-4 py-2.5 text-slate-700 font-medium">
                    {a.estimation_hours != null ? `${a.estimation_hours}h` : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge className={STATUS_COLORS[a.status] || 'bg-slate-100 text-slate-500'}>
                      {ACTIVITY_STATUS_LABELS[a.status] || a.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      {a.story_key && (
                        <button onClick={() => pushJiraMutation.mutate(a.id)}
                          disabled={pushJiraMutation.isPending}
                          className="p-1.5 text-blue-500 hover:bg-blue-50 rounded text-xs font-medium" title="Create Jira sub-task">
                          Jira
                        </button>
                      )}
                      <button onClick={() => { setEditId(a.id); setEditForm({}) }}
                        className="p-1.5 text-slate-400 hover:bg-slate-100 rounded" title="Edit">
                        <Edit2 className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => { if (confirm('Delete this activity?')) deleteMutation.mutate(a.id) }}
                        className="p-1.5 text-red-400 hover:bg-red-50 rounded" title="Delete">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !showAdd && (
          <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
            <Target className="h-8 w-8 text-slate-300 mx-auto mb-2" />
            <p className="text-slate-400 text-sm">No QA activities yet for this sprint.</p>
            <button onClick={() => setShowAdd(true)} className="mt-3 text-blue-600 hover:text-blue-800 text-sm font-medium">
              + Add your first activity
            </button>
          </div>
        )
      )}
    </div>
  )
}

// ── RTF Tracking tab ───────────────────────────────────────────────────────

function TrackingTab({ sprintId, stories = [], tracking = [] }) {
  const qc = useQueryClient()
  const [editKey, setEditKey] = useState(null)
  const [editForm, setEditForm] = useState({})

  const trackingByKey = useMemo(() => {
    const m = {}
    for (const t of tracking) m[t.story_key] = t
    return m
  }, [tracking])

  const merged = useMemo(() => {
    const rows = stories.map(s => ({ story: s, tracking: trackingByKey[s.key] || null }))
    // also show tracking rows that belong to stories not in current sprint fetch (edge case)
    for (const t of tracking) {
      if (!stories.find(s => s.key === t.story_key)) {
        rows.push({ story: { key: t.story_key, summary: t.story_summary, url: `https://avite.atlassian.net/browse/${t.story_key}` }, tracking: t })
      }
    }
    return rows
  }, [stories, trackingByKey])

  const upsertMutation = useMutation({
    mutationFn: ({ key, data }) => axios.put(`${API}/sprint/${sprintId}/tracking/${key}`, data).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries(['sprint-plan:tracking', sprintId]); setEditKey(null) },
  })

  const onTimeCount = merged.filter(r => r.tracking?.planned_rft_date && r.tracking?.actual_rft_date &&
    new Date(r.tracking.actual_rft_date) <= new Date(r.tracking.planned_rft_date)).length
  const delayedCount = merged.filter(r => r.tracking?.planned_rft_date && r.tracking?.actual_rft_date &&
    new Date(r.tracking.actual_rft_date) > new Date(r.tracking.planned_rft_date)).length
  const untrackedCount = merged.filter(r => !r.tracking?.planned_rft_date).length

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard icon={CheckCircle2} label="On time" value={onTimeCount} color="text-green-600" />
        <StatCard icon={AlertTriangle} label="Delayed" value={delayedCount} color="text-red-500" />
        <StatCard icon={Clock} label="Not tracked" value={untrackedCount} color="text-slate-400" />
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50">
            <tr className="text-xs text-slate-500 uppercase tracking-wide">
              <th className="px-4 py-2.5 text-left font-medium">Story</th>
              <th className="px-4 py-2.5 text-left font-medium">Planned RFT</th>
              <th className="px-4 py-2.5 text-left font-medium">Actual RFT</th>
              <th className="px-4 py-2.5 text-left font-medium">Delta</th>
              <th className="px-4 py-2.5 text-left font-medium">Delay Reason</th>
              <th className="px-4 py-2.5 text-left font-medium">Notes</th>
              <th className="px-4 py-2.5 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {merged.map(({ story, tracking: t }) => {
              const isEditing = editKey === story.key
              const delta = t ? dateDelta(t.planned_rft_date, t.actual_rft_date) : null
              return isEditing ? (
                <tr key={story.key} className="bg-blue-50">
                  <td className="px-4 py-2.5">
                    <IssueLink issueKey={story.key} url={story.url} summary={story.summary} />
                  </td>
                  <td className="px-4 py-2">
                    <input type="date" value={editForm.planned_rft_date ?? (t?.planned_rft_date || '')}
                      onChange={e => setEditForm(f => ({ ...f, planned_rft_date: e.target.value }))}
                      className="border border-blue-300 rounded px-2 py-1 text-xs focus:outline-none" />
                  </td>
                  <td className="px-4 py-2">
                    <input type="date" value={editForm.actual_rft_date ?? (t?.actual_rft_date || '')}
                      onChange={e => setEditForm(f => ({ ...f, actual_rft_date: e.target.value }))}
                      className="border border-blue-300 rounded px-2 py-1 text-xs focus:outline-none" />
                  </td>
                  <td className="px-4 py-2 text-slate-400 text-xs">—</td>
                  <td className="px-4 py-2">
                    <select value={editForm.delay_reason ?? (t?.delay_reason || '')}
                      onChange={e => setEditForm(f => ({ ...f, delay_reason: e.target.value }))}
                      className="border border-blue-300 rounded px-2 py-1 text-xs bg-white focus:outline-none max-w-[180px]">
                      <option value="">— none —</option>
                      {Object.entries(DELAY_REASON_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    <input value={editForm.delay_notes ?? (t?.delay_notes || '')}
                      onChange={e => setEditForm(f => ({ ...f, delay_notes: e.target.value }))}
                      placeholder="Notes..."
                      className="border border-blue-300 rounded px-2 py-1 text-xs w-full focus:outline-none" />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => upsertMutation.mutate({ key: story.key, data: { ...editForm, story_summary: story.summary } })}
                        className="p-1.5 text-green-600 hover:bg-green-100 rounded" title="Save">
                        <Save className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => setEditKey(null)} className="p-1.5 text-slate-400 hover:bg-slate-100 rounded">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={story.key} className={`hover:bg-slate-50/60 ${delta?.label.includes('late') ? 'bg-red-50/30' : ''}`}>
                  <td className="px-4 py-2.5">
                    <IssueLink issueKey={story.key} url={story.url} summary={story.summary} />
                  </td>
                  <td className="px-4 py-2.5 text-slate-600 text-xs">{t?.planned_rft_date ? fmtDate(t.planned_rft_date) : <span className="text-slate-300">—</span>}</td>
                  <td className="px-4 py-2.5 text-slate-600 text-xs">{t?.actual_rft_date ? fmtDate(t.actual_rft_date) : <span className="text-slate-300">—</span>}</td>
                  <td className="px-4 py-2.5 text-xs">
                    {delta ? <span className={delta.cls}>{delta.label}</span> : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-600">
                    {t?.delay_reason ? DELAY_REASON_LABELS[t.delay_reason] || t.delay_reason : <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-slate-500 max-w-[180px] truncate" title={t?.delay_notes}>
                    {t?.delay_notes || <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button onClick={() => { setEditKey(story.key); setEditForm({}) }}
                      className="p-1.5 text-slate-400 hover:bg-slate-100 rounded" title="Edit tracking">
                      <Edit2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {merged.length === 0 && (
          <div className="p-8 text-center text-slate-400 text-sm">
            No stories to track yet — load a sprint to populate this table.
          </div>
        )}
      </div>
    </div>
  )
}

// ── Timeline tab ───────────────────────────────────────────────────────────

function TimelineTab({ sprintId, activities = [] }) {
  const qc = useQueryClient()

  const reorderMutation = useMutation({
    mutationFn: (ids) => axios.post(`${API}/sprint/${sprintId}/reorder`, { ordered_ids: ids }).then(r => r.data),
    onSuccess: () => qc.invalidateQueries(['sprint-plan:activities', sprintId]),
  })

  function move(idx, dir) {
    const ids = activities.map(a => a.id)
    const newIdx = idx + dir
    if (newIdx < 0 || newIdx >= ids.length) return
    ;[ids[idx], ids[newIdx]] = [ids[newIdx], ids[idx]]
    reorderMutation.mutate(ids)
  }

  const maxHours = Math.max(...activities.map(a => a.estimation_hours || 0), 8)
  const totalHours = activities.reduce((s, a) => s + (a.estimation_hours || 0), 0)

  if (activities.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-10 text-center">
        <BarChart2 className="h-8 w-8 text-slate-300 mx-auto mb-2" />
        <p className="text-slate-400 text-sm">No QA activities yet. Add some in the QA Activities tab.</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm text-slate-600">
        <span className="font-semibold text-slate-800">{activities.length} activities</span>
        <span>Total: <span className="font-semibold text-teal-700">{totalHours.toFixed(1)}h</span></span>
      </div>

      {/* Sprint duration bars */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden divide-y divide-slate-100">
        {activities.map((a, idx) => {
          const pct = maxHours > 0 ? Math.max(2, (a.estimation_hours || 0) / maxHours * 100) : 2
          const typeColor = {
            qa_testing: 'bg-blue-400', regression: 'bg-purple-400', smoke_test: 'bg-teal-400',
            review: 'bg-orange-400', exploratory: 'bg-pink-400', other: 'bg-slate-300',
          }[a.activity_type] || 'bg-slate-300'
          const statusDot = { planned: 'bg-slate-400', in_progress: 'bg-blue-500', done: 'bg-green-500', blocked: 'bg-red-500' }[a.status] || 'bg-slate-400'

          return (
            <div key={a.id} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50">
              <span className="text-slate-300 text-xs w-5 text-right shrink-0">{idx + 1}</span>

              {/* Type dot */}
              <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${typeColor}`} title={ACTIVITY_TYPE_LABELS[a.activity_type]} />

              {/* Name + story */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-800 truncate">{a.activity_name}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  {a.story_key && (
                    <span className="text-xs text-blue-600 font-medium">{a.story_key}</span>
                  )}
                  <Badge className={`${STATUS_COLORS[a.status]} text-xs`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${statusDot}`} />
                    {ACTIVITY_STATUS_LABELS[a.status] || a.status}
                  </Badge>
                </div>
              </div>

              {/* Bar */}
              <div className="w-48 shrink-0">
                <div className="flex items-center gap-2">
                  <div className="flex-1 bg-slate-100 rounded-full h-2.5 overflow-hidden">
                    <div className={`h-full rounded-full ${typeColor}`} style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-xs font-medium text-slate-600 w-10 text-right shrink-0">
                    {a.estimation_hours != null ? `${a.estimation_hours}h` : '—'}
                  </span>
                </div>
              </div>

              {/* Reorder */}
              <div className="flex flex-col gap-0.5 shrink-0">
                <button onClick={() => move(idx, -1)} disabled={idx === 0}
                  className="p-0.5 text-slate-300 hover:text-slate-600 disabled:opacity-20 transition-colors" title="Move up">
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => move(idx, 1)} disabled={idx === activities.length - 1}
                  className="p-0.5 text-slate-300 hover:text-slate-600 disabled:opacity-20 transition-colors" title="Move down">
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {/* Summary bar */}
      <div className="bg-white rounded-xl border border-slate-200 p-3 flex flex-wrap gap-3">
        {Object.entries(ACTIVITY_TYPE_LABELS).map(([type, label]) => {
          const items = activities.filter(a => a.activity_type === type)
          if (!items.length) return null
          const hrs = items.reduce((s, a) => s + (a.estimation_hours || 0), 0)
          const dot = { qa_testing: 'bg-blue-400', regression: 'bg-purple-400', smoke_test: 'bg-teal-400', review: 'bg-orange-400', exploratory: 'bg-pink-400', other: 'bg-slate-300' }[type]
          return (
            <div key={type} className="flex items-center gap-1.5 text-xs text-slate-600">
              <span className={`w-2 h-2 rounded-full ${dot}`} />
              <span>{label}</span>
              <span className="font-semibold text-slate-800">{hrs}h</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────

export default function SprintPlanningPage() {
  const [selectedSprintId, setSelectedSprintId] = useState(null)
  const [activeTab, setActiveTab] = useState('stories')

  const sprintsQ = useQuery({
    queryKey: ['sprint-plan:sprints'],
    queryFn: () => axios.get(`${API}/sprints`).then(r => r.data.sprints),
    staleTime: 300_000,
  })

  const sprints = sprintsQ.data || []
  const selectedSprint = sprints.find(s => s.id === selectedSprintId) || null

  // Auto-select the active sprint on first load
  useMemo(() => {
    if (!selectedSprintId && sprints.length > 0) {
      const active = sprints.find(s => s.state === 'active')
      if (active) setSelectedSprintId(active.id)
      else setSelectedSprintId(sprints[0].id)
    }
  }, [sprints])

  const storiesQ = useQuery({
    queryKey: ['sprint-plan:stories', selectedSprintId],
    queryFn: () => axios.get(`${API}/sprint/${selectedSprintId}/stories`).then(r => r.data),
    enabled: !!selectedSprintId,
    staleTime: 180_000,
  })

  const activitiesQ = useQuery({
    queryKey: ['sprint-plan:activities', selectedSprintId],
    queryFn: () => axios.get(`${API}/sprint/${selectedSprintId}/activities`).then(r => r.data.activities),
    enabled: !!selectedSprintId,
    staleTime: 30_000,
  })

  const trackingQ = useQuery({
    queryKey: ['sprint-plan:tracking', selectedSprintId],
    queryFn: () => axios.get(`${API}/sprint/${selectedSprintId}/tracking`).then(r => r.data.tracking),
    enabled: !!selectedSprintId,
    staleTime: 60_000,
  })

  const rem = selectedSprint ? daysRemaining(selectedSprint) : null
  const dateRange = selectedSprint ? sprintDateRange(selectedSprint) : ''

  const stateChip = {
    active: 'bg-green-100 text-green-700',
    future: 'bg-blue-100 text-blue-700',
    closed: 'bg-slate-100 text-slate-500',
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
          <button
            onClick={() => {
              if (selectedSprintId) {
                storiesQ.refetch()
                activitiesQ.refetch()
                trackingQ.refetch()
              }
              sprintsQ.refetch()
            }}
            className="flex items-center gap-2 text-slate-500 hover:text-slate-700 text-sm px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 transition-colors"
          >
            <RefreshCw className={`h-4 w-4 ${sprintsQ.isFetching || storiesQ.isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {/* Sprint selector + info */}
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-slate-600 shrink-0">Sprint</label>
              <div className="relative">
                <select
                  value={selectedSprintId || ''}
                  onChange={e => setSelectedSprintId(e.target.value ? Number(e.target.value) : null)}
                  className="appearance-none bg-white border border-slate-200 rounded-lg pl-3 pr-8 py-2 text-sm text-slate-800 font-medium focus:outline-none focus:ring-2 focus:ring-brand-400 min-w-[240px]"
                >
                  <option value="">— select sprint —</option>
                  {sprints.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.name} {s.state === 'active' ? '(Active)' : s.state === 'future' ? '(Future)' : ''}
                    </option>
                  ))}
                </select>
                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
              </div>
            </div>

            {selectedSprint && (
              <>
                <Badge className={stateChip[selectedSprint.state] || 'bg-slate-100 text-slate-500'}>
                  {selectedSprint.state}
                </Badge>
                {dateRange && <span className="text-sm text-slate-500">{dateRange}</span>}
                {rem && <span className={`text-sm font-medium ${rem.cls}`}>{rem.label}</span>}
                {activitiesQ.data && (
                  <span className="text-sm text-slate-500">
                    <span className="font-semibold text-slate-700">{activitiesQ.data.length}</span> QA activities
                    {activitiesQ.data.length > 0 && (
                      <> · <span className="font-semibold text-teal-700">
                        {activitiesQ.data.reduce((s, a) => s + (a.estimation_hours || 0), 0).toFixed(1)}h
                      </span></>
                    )}
                  </span>
                )}
              </>
            )}

            {sprintsQ.isLoading && <span className="text-sm text-slate-400">Loading sprints…</span>}
          </div>
        </div>

        {selectedSprintId ? (
          <>
            {/* Tabs */}
            <div className="flex gap-1 bg-white rounded-xl border border-slate-200 p-1">
              {TABS.map(tab => {
                const Icon = TAB_ICONS[tab]
                return (
                  <button key={tab} onClick={() => setActiveTab(tab)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors flex-1 justify-center ${
                      activeTab === tab ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {TAB_LABELS[tab]}
                  </button>
                )
              })}
            </div>

            {/* Tab content */}
            <div>
              {activeTab === 'stories' && (
                storiesQ.isLoading
                  ? <div className="p-8 text-slate-400 text-sm text-center">Loading stories…</div>
                  : <StoriesTab storiesData={storiesQ.data} />
              )}
              {activeTab === 'activities' && (
                activitiesQ.isLoading
                  ? <div className="p-8 text-slate-400 text-sm text-center">Loading activities…</div>
                  : <ActivitiesTab
                      sprintId={selectedSprintId}
                      sprintName={selectedSprint?.name || ''}
                      activities={activitiesQ.data || []}
                      storiesData={storiesQ.data}
                    />
              )}
              {activeTab === 'tracking' && (
                <TrackingTab
                  sprintId={selectedSprintId}
                  stories={storiesQ.data?.stories || []}
                  tracking={trackingQ.data || []}
                />
              )}
              {activeTab === 'timeline' && (
                activitiesQ.isLoading
                  ? <div className="p-8 text-slate-400 text-sm text-center">Loading…</div>
                  : <TimelineTab sprintId={selectedSprintId} activities={activitiesQ.data || []} />
              )}
            </div>
          </>
        ) : (
          <div className="bg-white rounded-xl border border-slate-200 p-16 text-center">
            <CalendarDays className="h-10 w-10 text-slate-300 mx-auto mb-3" />
            <p className="text-slate-500 font-medium">Select a sprint to start planning</p>
            <p className="text-slate-400 text-sm mt-1">Track QA activities, story readiness, and timelines per sprint.</p>
          </div>
        )}
      </div>
    </div>
  )
}

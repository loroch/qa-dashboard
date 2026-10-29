import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { Header } from '../components/layout/Header'
import { BASE_URL } from '../services/api'
import {
  Server, Database, Search, Figma as FigmaIcon, Mail, Sparkles, Globe, Eye, EyeOff,
  CheckCircle2, XCircle, Loader2, Play, RotateCcw, Save, Bug, ExternalLink, ChevronDown,
  ChevronRight, Plus, Trash2, FileText, History, PlugZap, ClipboardCheck, AlertTriangle, X,
} from 'lucide-react'

// Runs and connection tests can take a while (Playwright probe, AI review)
const api = axios.create({ baseURL: BASE_URL, timeout: 180000 })
const apiErr = (e) => e?.response?.data?.detail || e.message

const SEV_STYLE = {
  critical: 'bg-red-600 text-white',
  high: 'bg-orange-500 text-white',
  medium: 'bg-yellow-400 text-gray-900',
  low: 'bg-green-500 text-white',
  info: 'bg-slate-400 text-white',
}
const VERDICT_STYLE = {
  pass: 'text-green-600 dark:text-green-400',
  fail: 'text-red-600 dark:text-red-400',
  partial: 'text-orange-500',
  not_verified: 'text-gray-500',
}

const CHECKS = [
  { id: 'jira', label: 'Jira hygiene', icon: ClipboardCheck, desc: 'Status vs children, ToDo test cases, missing AC / fix version, open bugs' },
  { id: 'ui', label: 'UI probe (Playwright)', icon: Globe, desc: 'Log in, click menu items, record every API call: time, status, counts, console errors, screenshots' },
  { id: 'spec', label: 'Spec values', icon: CheckCircle2, desc: 'Hex colors written in the requirements vs colors the API returns (needs UI probe)' },
  { id: 'figma', label: 'Figma design', icon: FigmaIcon, desc: 'Read the Figma frames linked from the issue tree as evidence' },
  { id: 'db', label: 'Database queries', icon: Database, desc: 'Read-only SQL against the environment DB — compare with what the UI got' },
  { id: 'elastic', label: 'Elastic logs', icon: Search, desc: 'Slow / failing BFF API calls and error lines in the log index' },
  { id: 'tests', label: 'Run linked Jira tests', icon: Play, desc: 'Start the Automation tab runner for every linked Test issue (slow — runs in background)' },
  { id: 'ai', label: 'AI requirement review', icon: Sparkles, desc: 'Claude maps every requirement to the evidence → pass / fail / not verified + bug-ready findings' },
]

const DEFAULT_OPTIONS = {
  checks: { jira: true, ui: true, spec: true, figma: true, db: true, elastic: true, tests: false, ai: true },
  ui: { nav_labels: 'MAP', slow_ms: 3000, max_wait_s: 90 },
  db: { queries: [] },
  elastic: { minutes: 60, slow_ms: 3000, keywords: '' },
  figma: { urls: '' },
}

const ENV_SECTIONS = [
  { id: 'web', title: 'Web client', icon: Globe, test: 'web', fields: [['url', 'URL'], ['user', 'User'], ['password', 'Password', 'secret'], ['nav_labels', 'Default menu items to probe (comma separated)']] },
  { id: 'db', title: 'Database (SQL Server)', icon: Database, test: 'db', fields: [['server', 'Server'], ['port', 'Port'], ['database', 'Database'], ['user', 'User'], ['password', 'Password', 'secret']] },
  { id: 'elastic', title: 'Elasticsearch', icon: Search, test: 'elastic', extraTest: ['ssh', 'Test SSH port'], fields: [['url', 'URL'], ['index', 'Index pattern'], ['user', 'User (optional)'], ['password', 'Password (optional)', 'secret'], ['ssh_host', 'SSH host'], ['ssh_user', 'SSH user'], ['ssh_password', 'SSH password', 'secret']] },
  { id: 'figma', title: 'Figma', icon: FigmaIcon, test: 'figma', fields: [['email', 'Account email']], note: (p) => `API token (.env FIGMA_API_TOKEN): ${p.figma?.token_configured ? 'configured' : 'missing'}` },
  { id: 'smtp', title: 'Email (SMTP)', icon: Mail, test: 'smtp', fields: [['host', 'Host'], ['port', 'Port'], ['user', 'User'], ['password', 'Password', 'secret'], ['from', 'From']] },
  { id: 'jira', title: 'Jira', icon: ClipboardCheck, test: 'jira', readOnly: true, fields: [['base_url', 'Base URL'], ['email', 'API user']], note: () => 'Uses the dashboard Jira API token from .env' },
  { id: 'ai', title: 'AI (Claude)', icon: Sparkles, test: 'ai', readOnly: true, fields: [['model', 'Model']], note: (p) => `ANTHROPIC_API_KEY: ${p.ai?.configured ? 'configured' : 'missing'}` },
]

const SQL_TEMPLATES = [
  { name: 'Open events by severity', sql: 'select Severity, count(*) as open_events from C4IData.EventsData where IsDeleted=0 and State in (0,2) group by Severity order by Severity' },
  { name: 'Events created last hour', sql: "select count(*) as created_last_hour from C4IData.EventsData where EventCreationTime > dateadd(hour,-1,getutcdate())" },
  { name: 'Event by id', sql: 'select top 1 EventID, State, Severity, EventType, EventCreationTime, LastModificationTime from C4IData.EventsData where EventID = 0' },
]

function Pill({ ok, children }) {
  if (ok === undefined) return null
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${ok ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
      {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}{children}
    </span>
  )
}

function Section({ title, icon: Icon, right, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="card">
      <div className="px-5 py-3 flex items-center gap-2 cursor-pointer select-none" onClick={() => setOpen(o => !o)}>
        {open ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
        {Icon && <Icon className="h-4 w-4 text-brand-600 dark:text-brand-300" />}
        <h2 className="font-semibold text-sm flex-1">{title}</h2>
        <div onClick={e => e.stopPropagation()}>{right}</div>
      </div>
      {open && <div className="px-5 pb-5">{children}</div>}
    </div>
  )
}

const inputCls = 'w-full rounded-md border border-gray-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-2.5 py-1.5 text-sm'

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function EnvironmentPanel({ profile, setProfile, onSaved }) {
  const [tests, setTests] = useState({})
  const [revealed, setRevealed] = useState(false)
  const qc = useQueryClient()

  const runTest = async (target) => {
    setTests(t => ({ ...t, [target]: { loading: true } }))
    try {
      const r = await api.post(`/validation/test/${target}`, { profile }).then(r => r.data)
      setTests(t => ({ ...t, [target]: r }))
    } catch (e) {
      setTests(t => ({ ...t, [target]: { ok: false, detail: apiErr(e) } }))
    }
  }
  const testAll = () => ENV_SECTIONS.forEach(s => { runTest(s.test); if (s.extraTest) runTest(s.extraTest[0]) })

  const save = useMutation({
    mutationFn: () => api.put('/validation/profile', profile).then(r => r.data),
    onSuccess: (p) => { setProfile(p); setRevealed(false); onSaved?.(); qc.invalidateQueries({ queryKey: ['validation-profile'] }) },
  })
  const reset = useMutation({
    mutationFn: () => api.post('/validation/profile/reset').then(r => r.data),
    onSuccess: (p) => { setProfile(p); setRevealed(false) },
  })
  const toggleReveal = async () => {
    if (revealed) { setRevealed(false); return }
    const full = await api.get('/validation/profile?reveal=true').then(r => r.data)
    // keep unsaved edits, only fill in the real secrets
    setProfile(p => {
      const next = JSON.parse(JSON.stringify(p))
      for (const s of ENV_SECTIONS) for (const [k, , kind] of s.fields)
        if (kind === 'secret' && next[s.id]?.[k] === '••••••••') next[s.id][k] = full[s.id][k]
      return next
    })
    setRevealed(true)
  }
  const setField = (section, key, value) => setProfile(p => ({ ...p, [section]: { ...p[section], [key]: value } }))

  return (
    <Section
      title={`Environment — ${profile.name || 'default'}`}
      icon={Server}
      defaultOpen={false}
      right={
        <div className="flex items-center gap-2">
          <button className="btn-secondary text-xs flex items-center gap-1" onClick={testAll}><PlugZap className="h-3.5 w-3.5" />Test all</button>
          <button className="btn-secondary text-xs flex items-center gap-1" onClick={toggleReveal}>
            {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}{revealed ? 'Hide' : 'Show'} passwords
          </button>
          <button className="btn-secondary text-xs flex items-center gap-1" onClick={() => reset.mutate()} title="Back to the .env defaults"><RotateCcw className="h-3.5 w-3.5" />Defaults</button>
          <button className="btn-primary text-xs flex items-center gap-1" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}Save
          </button>
        </div>
      }
    >
      <div className="mb-3 flex items-center gap-2">
        <label className="text-xs text-gray-500 w-28">Profile name</label>
        <input className={inputCls + ' max-w-xs'} value={profile.name || ''} onChange={e => setProfile(p => ({ ...p, name: e.target.value }))} />
        {save.isSuccess && <span className="text-xs text-green-600">Saved</span>}
        {save.isError && <span className="text-xs text-red-600">{apiErr(save.error)}</span>}
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {ENV_SECTIONS.map(s => {
          const t = tests[s.test]
          const t2 = s.extraTest ? tests[s.extraTest[0]] : null
          return (
            <div key={s.id} className="rounded-lg border border-gray-200 dark:border-slate-700 p-3">
              <div className="flex items-center gap-2 mb-2">
                <s.icon className="h-4 w-4 text-gray-500" />
                <span className="font-medium text-sm flex-1">{s.title}</span>
                {s.extraTest && (
                  <button className="text-xs text-brand-600 dark:text-brand-300 hover:underline" onClick={() => runTest(s.extraTest[0])}>{s.extraTest[1]}</button>
                )}
                <button className="text-xs text-brand-600 dark:text-brand-300 hover:underline flex items-center gap-1" onClick={() => runTest(s.test)}>
                  {t?.loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <PlugZap className="h-3 w-3" />}Test
                </button>
              </div>
              <div className="grid grid-cols-[9rem_1fr] gap-x-2 gap-y-1.5 items-center">
                {s.fields.map(([k, label, kind]) => (
                  <FieldRow key={k} label={label} kind={kind} readOnly={s.readOnly}
                    value={profile[s.id]?.[k] ?? ''} onChange={v => setField(s.id, k, v)} />
                ))}
              </div>
              {s.note && <p className="text-xs text-gray-500 mt-2">{s.note(profile)}</p>}
              {t && !t.loading && <div className="mt-2"><Pill ok={t.ok}><span className="break-all">{t.detail}{t.ms != null ? ` (${t.ms} ms)` : ''}</span></Pill></div>}
              {t2 && !t2.loading && <div className="mt-1"><Pill ok={t2.ok}><span className="break-all">{t2.detail}</span></Pill></div>}
            </div>
          )
        })}
      </div>
      <p className="text-xs text-gray-500 mt-3">Defaults come from the dashboard's <code>.env</code>. Saving stores your edits for everyone using this dashboard; "Defaults" removes them. Unsaved edits are still used by tests and runs.</p>
    </Section>
  )
}

function FieldRow({ label, kind, value, onChange, readOnly }) {
  const [show, setShow] = useState(false)
  return (
    <>
      <label className="text-xs text-gray-500">{label}</label>
      <div className="relative">
        <input
          className={inputCls + (readOnly ? ' opacity-70' : '') + (kind === 'secret' ? ' pr-8' : '')}
          type={kind === 'secret' && !show ? 'password' : 'text'}
          value={value} readOnly={readOnly}
          onChange={e => onChange(e.target.value)}
        />
        {kind === 'secret' && (
          <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" onClick={() => setShow(s => !s)} tabIndex={-1}>
            {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Issue + checks
// ---------------------------------------------------------------------------

function IssueCard({ issue }) {
  const [open, setOpen] = useState(false)
  const r = issue.root
  const items = [...issue.children, ...issue.subtasks]
  return (
    <div className="rounded-lg border border-gray-200 dark:border-slate-700 p-3 text-sm">
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <a href={issue.jira_url} target="_blank" rel="noreferrer" className="font-semibold text-brand-600 dark:text-brand-300 hover:underline inline-flex items-center gap-1">
            {r.key}<ExternalLink className="h-3 w-3" />
          </a>
          <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-700">{r.issuetype}</span>
          <span className="ml-1 text-xs px-1.5 py-0.5 rounded bg-gray-100 dark:bg-slate-700">{r.status}</span>
          {r.fix_versions.map(v => <span key={v} className="ml-1 text-xs px-1.5 py-0.5 rounded bg-brand-50 dark:bg-slate-700 text-brand-700 dark:text-brand-200">{v}</span>)}
          <p className="mt-1 font-medium">{r.summary}</p>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
        <span>{issue.stats.children} children</span><span>{issue.stats.subtasks} subtasks</span>
        <span>{issue.stats.with_ac} with acceptance criteria</span><span>{issue.stats.tests} linked tests</span>
        <span>{issue.stats.bugs} linked bugs</span><span>{issue.figma_urls.length} Figma links</span>
      </div>
      {Object.keys(issue.spec_colors).length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-gray-500">Colors in requirements:</span>
          {Object.entries(issue.spec_colors).map(([c, keys]) => (
            <span key={c} className="inline-flex items-center gap-1" title={keys.join(', ')}>
              <span className="h-3 w-3 rounded-sm border border-gray-300" style={{ background: c }} />{c}
            </span>
          ))}
        </div>
      )}
      {items.length > 0 && (
        <button className="mt-2 text-xs text-brand-600 dark:text-brand-300 hover:underline" onClick={() => setOpen(o => !o)}>
          {open ? 'Hide' : 'Show'} {items.length} child items
        </button>
      )}
      {open && (
        <ul className="mt-2 space-y-1 text-xs max-h-64 overflow-auto">
          {items.map(c => (
            <li key={c.key} className="flex gap-2">
              <span className="font-mono w-24 shrink-0">{c.key}</span>
              <span className="w-20 shrink-0 text-gray-500">{c.issuetype}</span>
              <span className="w-20 shrink-0 text-gray-500">{c.status}</span>
              <span className="flex-1">{c.summary}{c.acceptance_criteria ? '' : <span className="text-gray-400"> (no AC)</span>}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const CHECK_LABEL = Object.fromEntries(CHECKS.map(c => [c.id, c.label]))
const PRIORITY_STYLE = { P1: 'bg-red-600 text-white', P2: 'bg-orange-400 text-white', P3: 'bg-slate-400 text-white' }

function ExplainPanel({ data, onApply, onRegenerate, regenerating, applied }) {
  const [openTest, setOpenTest] = useState(null)
  const s = data.suggested_settings || {}
  const asText = () => [
    `${data.issue_key} — ${data.issue_summary}`, '', data.explanation, '',
    'How it works:', ...(data.how_it_works || []).map(x => `• ${x}`), '',
    'Key points:', ...(data.key_points || []).map(x => `• ${x}`), '',
    'Risks:', ...(data.risks || []).map(x => `• ${x}`), '',
    'Recommended tests:',
    ...(data.tests || []).flatMap((t, i) => [
      `${i + 1}. [${t.priority}] ${t.title} (${t.type}, ${t.check})`,
      ...(t.steps || []).map(st => `   - ${st}`), `   Expected: ${t.expected}`,
    ]),
  ].join('\n')
  return (
    <div className="mt-3 rounded-lg border border-brand-200 dark:border-slate-600 bg-brand-50/40 dark:bg-slate-800/50 p-4 text-sm space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-brand-600 dark:text-brand-300" />
        <span className="font-semibold flex-1">In simple words</span>
        <span className="text-xs text-gray-500">{data.cached ? 'saved' : 'generated'} {data.generated_at ? new Date(data.generated_at + (data.generated_at.endsWith('Z') ? '' : 'Z')).toLocaleString() : ''}</span>
        <button className="btn-secondary text-xs" onClick={() => navigator.clipboard?.writeText(asText())}>Copy</button>
        <button className="btn-secondary text-xs flex items-center gap-1" onClick={onRegenerate} disabled={regenerating}>
          {regenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}Regenerate
        </button>
      </div>
      <p className="leading-relaxed">{data.explanation}</p>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {[['How it should work', data.how_it_works], ['What to verify', data.key_points], ['Risk areas', data.risks]].map(([title, items]) => (
          <div key={title}>
            <p className="text-xs font-semibold text-gray-500 uppercase mb-1">{title}</p>
            <ul className="list-disc pl-4 space-y-0.5 text-xs">{(items || []).map((x, i) => <li key={i}>{x}</li>)}</ul>
          </div>
        ))}
      </div>

      <div>
        <div className="flex items-center gap-2 mb-1">
          <p className="text-xs font-semibold text-gray-500 uppercase flex-1">Recommended tests ({(data.tests || []).length})</p>
          <button className="btn-primary text-xs flex items-center gap-1" onClick={onApply}>
            <CheckCircle2 className="h-3.5 w-3.5" />{applied ? 'Applied — apply again' : 'Apply suggested settings to the checks'}
          </button>
        </div>
        <div className="border border-gray-200 dark:border-slate-700 rounded divide-y divide-gray-100 dark:divide-slate-700 bg-white dark:bg-slate-800">
          {(data.tests || []).map((t, i) => (
            <div key={i}>
              <div className="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-700/50" onClick={() => setOpenTest(openTest === i ? null : i)}>
                {openTest === i ? <ChevronDown className="h-3.5 w-3.5 text-gray-400" /> : <ChevronRight className="h-3.5 w-3.5 text-gray-400" />}
                <span className={`text-[10px] font-bold px-1.5 rounded ${PRIORITY_STYLE[t.priority] || PRIORITY_STYLE.P3}`}>{t.priority}</span>
                <span className="flex-1 text-xs font-medium">{t.title}</span>
                <span className="text-[10px] uppercase text-gray-500 w-14">{t.type}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded whitespace-nowrap ${t.check === 'manual' ? 'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-gray-300' : 'bg-brand-100 dark:bg-slate-600 text-brand-700 dark:text-brand-100'}`}>
                  {t.check === 'manual' ? 'Manual' : `Auto: ${CHECK_LABEL[t.check] || t.check}`}
                </span>
              </div>
              {openTest === i && (
                <div className="px-8 pb-2 text-xs space-y-1">
                  <ol className="list-decimal pl-4">{(t.steps || []).map((st, j) => <li key={j}>{st}</li>)}</ol>
                  <p><span className="text-gray-500">Expected:</span> {t.expected}</p>
                  {t.why && <p className="text-gray-500">{t.why}</p>}
                </div>
              )}
            </div>
          ))}
        </div>
        <p className="text-xs text-gray-500 mt-1">
          Suggested: menu <b>{s.nav_labels || '—'}</b> · {(s.db_queries || []).length} DB queries (checked against the real schema) · Elastic keywords <b>{(s.elastic_keywords || []).join(', ') || '—'}</b>
        </p>
        {(data.dropped_queries || []).length > 0 && (
          <p className="text-xs text-orange-600">Dropped {data.dropped_queries.length} suggested queries: {data.dropped_queries.map(q => `${q.name} (${q.reason})`).join('; ')}</p>
        )}
      </div>
    </div>
  )
}

function DbQueriesEditor({ queries, onChange, profile }) {
  const [preview, setPreview] = useState({})
  const update = (i, patch) => onChange(queries.map((q, j) => (j === i ? { ...q, ...patch } : q)))
  const runPreview = async (i) => {
    setPreview(p => ({ ...p, [i]: { loading: true } }))
    try {
      const r = await api.post('/validation/sql', { sql: queries[i].sql, profile }).then(r => r.data)
      setPreview(p => ({ ...p, [i]: r }))
    } catch (e) {
      setPreview(p => ({ ...p, [i]: { error: apiErr(e) } }))
    }
  }
  return (
    <div className="space-y-2">
      {queries.map((q, i) => (
        <div key={i} className="rounded border border-gray-200 dark:border-slate-700 p-2 space-y-1">
          <div className="flex gap-2">
            <input className={inputCls} placeholder="Name" value={q.name} onChange={e => update(i, { name: e.target.value })} />
            <button className="btn-secondary text-xs" onClick={() => runPreview(i)}>
              {preview[i]?.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Preview'}
            </button>
            <button className="text-gray-400 hover:text-red-500" onClick={() => onChange(queries.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></button>
          </div>
          <textarea className={inputCls + ' font-mono text-xs'} rows={2} value={q.sql} onChange={e => update(i, { sql: e.target.value })} />
          {preview[i]?.error && <p className="text-xs text-red-600">{preview[i].error}</p>}
          {preview[i]?.columns && <ResultTable columns={preview[i].columns} rows={preview[i].rows.slice(0, 10)} />}
        </div>
      ))}
      <div className="flex flex-wrap gap-2 items-center">
        <button className="btn-secondary text-xs flex items-center gap-1" onClick={() => onChange([...queries, { name: '', sql: 'select top 10 * from ' }])}><Plus className="h-3.5 w-3.5" />Query</button>
        <span className="text-xs text-gray-500">Templates:</span>
        {SQL_TEMPLATES.map(t => (
          <button key={t.name} className="text-xs text-brand-600 dark:text-brand-300 hover:underline" onClick={() => onChange([...queries, { ...t }])}>{t.name}</button>
        ))}
      </div>
      <p className="text-xs text-gray-500">Read-only: only a single SELECT / WITH statement is accepted.</p>
    </div>
  )
}

function ChecksPanel({ options, setOptions, profile }) {
  const setCheck = (id, v) => setOptions(o => ({ ...o, checks: { ...o.checks, [id]: v } }))
  const setOpt = (group, key, v) => setOptions(o => ({ ...o, [group]: { ...o[group], [key]: v } }))
  const c = options.checks
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {CHECKS.map(ch => (
          <label key={ch.id} className={`flex gap-2 rounded-lg border p-2.5 cursor-pointer ${c[ch.id] ? 'border-brand-400 bg-brand-50/50 dark:bg-slate-700/40' : 'border-gray-200 dark:border-slate-700'}`}>
            <input type="checkbox" className="mt-0.5" checked={!!c[ch.id]} onChange={e => setCheck(ch.id, e.target.checked)} />
            <ch.icon className="h-4 w-4 mt-0.5 text-gray-500 shrink-0" />
            <span><span className="text-sm font-medium">{ch.label}</span><br /><span className="text-xs text-gray-500">{ch.desc}</span></span>
          </label>
        ))}
      </div>

      {c.ui && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 rounded-lg bg-gray-50 dark:bg-slate-800/60 p-3">
          <div className="md:col-span-1"><label className="text-xs text-gray-500">UI — menu items to click (comma separated, exact text)</label>
            <input className={inputCls} value={options.ui.nav_labels} onChange={e => setOpt('ui', 'nav_labels', e.target.value)} placeholder="MAP, EVENTS" /></div>
          <div><label className="text-xs text-gray-500">Slow API threshold (ms)</label>
            <input type="number" className={inputCls} value={options.ui.slow_ms} onChange={e => setOpt('ui', 'slow_ms', +e.target.value)} /></div>
          <div><label className="text-xs text-gray-500">Max wait per page (s)</label>
            <input type="number" className={inputCls} value={options.ui.max_wait_s} onChange={e => setOpt('ui', 'max_wait_s', +e.target.value)} /></div>
        </div>
      )}
      {c.elastic && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 rounded-lg bg-gray-50 dark:bg-slate-800/60 p-3">
          <div><label className="text-xs text-gray-500">Elastic — look back (minutes)</label>
            <input type="number" className={inputCls} value={options.elastic.minutes} onChange={e => setOpt('elastic', 'minutes', +e.target.value)} /></div>
          <div><label className="text-xs text-gray-500">Slow p95 threshold (ms)</label>
            <input type="number" className={inputCls} value={options.elastic.slow_ms} onChange={e => setOpt('elastic', 'slow_ms', +e.target.value)} /></div>
          <div><label className="text-xs text-gray-500">Keywords to count (comma separated)</label>
            <input className={inputCls} value={options.elastic.keywords} onChange={e => setOpt('elastic', 'keywords', e.target.value)} placeholder="events/map, Severity" /></div>
        </div>
      )}
      {c.figma && (
        <div className="rounded-lg bg-gray-50 dark:bg-slate-800/60 p-3">
          <label className="text-xs text-gray-500">Figma frame URLs (optional — leave empty to use the links found in Jira)</label>
          <input className={inputCls} value={options.figma.urls} onChange={e => setOpt('figma', 'urls', e.target.value)} placeholder="https://www.figma.com/design/…?node-id=…" />
        </div>
      )}
      {c.db && (
        <div className="rounded-lg bg-gray-50 dark:bg-slate-800/60 p-3">
          <p className="text-xs text-gray-500 mb-2">Database queries</p>
          <DbQueriesEditor queries={options.db.queries} onChange={q => setOpt('db', 'queries', q)} profile={profile} />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function ResultTable({ columns, rows }) {
  return (
    <div className="overflow-auto max-h-80 border border-gray-200 dark:border-slate-700 rounded">
      <table className="text-xs w-full">
        <thead className="bg-gray-50 dark:bg-slate-800 sticky top-0">
          <tr>{columns.map(c => <th key={c} className="text-left px-2 py-1 font-medium">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-gray-100 dark:border-slate-700">
              {r.map((v, j) => <td key={j} className="px-2 py-1 align-top">{v === null ? <span className="text-gray-400">null</span> : String(v)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const shotUrl = (name) => `${BASE_URL}/validation/screenshots/${name}`

function BugModal({ run, finding, onClose, onFiled }) {
  const root = run.results?.issue?.root || {}
  const [summary, setSummary] = useState(`${root.fix_versions?.[0] ? `[${root.fix_versions[0]}] ` : ''}${finding.title}`)
  const [description, setDescription] = useState(
    [
      finding.detail,
      finding.evidence ? `\nEvidence:\n${finding.evidence}` : '',
      `\nEnvironment: ${run.env?.web?.url || ''}`,
      `Found by QA Dashboard Validation Portal (run #${run.id}, check: ${finding.check}) while validating ${run.issue_key}.`,
    ].filter(Boolean).join('\n')
  )
  const [priority, setPriority] = useState(
    { critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low', info: 'Lowest' }[finding.severity] || 'Medium'
  )
  const [attach, setAttach] = useState(!!finding.screenshot)
  const file = useMutation({
    mutationFn: () => api.post(`/validation/runs/${run.id}/bugs`, {
      finding_id: finding.id, summary, description, priority, attach_screenshot: attach,
    }).then(r => r.data),
    onSuccess: (r) => onFiled(r),
  })
  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="card w-full max-w-2xl p-5 space-y-3" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <Bug className="h-5 w-5 text-red-500" /><h3 className="font-semibold flex-1">Create bug in Jira</h3>
          <button onClick={onClose}><X className="h-4 w-4" /></button>
        </div>
        <p className="text-xs text-gray-500">
          Project {run.issue_key.split('-')[0]} · fix version {root.fix_versions?.join(', ') || '—'} · linked "Relates" to {[...new Set([finding.related_key, run.issue_key])].filter(Boolean).join(' and ')}
        </p>
        <div><label className="text-xs text-gray-500">Summary</label><input className={inputCls} value={summary} onChange={e => setSummary(e.target.value)} /></div>
        <div><label className="text-xs text-gray-500">Description</label><textarea className={inputCls + ' text-xs'} rows={10} value={description} onChange={e => setDescription(e.target.value)} /></div>
        <div className="flex items-center gap-4">
          <div><label className="text-xs text-gray-500 mr-2">Priority</label>
            <select className={inputCls + ' w-auto inline-block'} value={priority} onChange={e => setPriority(e.target.value)}>
              {['Highest', 'High', 'Medium', 'Low', 'Lowest'].map(p => <option key={p}>{p}</option>)}
            </select></div>
          {finding.screenshot && (
            <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={attach} onChange={e => setAttach(e.target.checked)} />Attach screenshot</label>
          )}
        </div>
        {file.isError && <p className="text-xs text-red-600">{apiErr(file.error)}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex items-center gap-1" onClick={() => file.mutate()} disabled={file.isPending || !summary.trim()}>
            {file.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bug className="h-4 w-4" />}Create in Jira
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function EmailModal({ run, selected, onClose }) {
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [note, setNote] = useState('')
  const findings = run.findings.filter(f => !selected.length || selected.includes(f.id))
  const [subject, setSubject] = useState(`[QA Validation] ${run.issue_key} ${run.issue_summary || ''} — ${findings.length} findings`)
  const split = (s) => s.split(/[;,\s]+/).map(x => x.trim()).filter(Boolean)
  const send = useMutation({
    mutationFn: () => api.post(`/validation/runs/${run.id}/email`, {
      to: split(to), cc: split(cc), subject, note, finding_ids: selected.length ? selected : null,
    }).then(r => r.data),
  })
  const reportUrl = `${BASE_URL}/validation/runs/${run.id}/report${selected.length ? `?findings=${selected.join(',')}` : ''}`
  const mailto = () => {
    const body = [
      note, '', `Validation of ${run.issue_key} — ${run.issue_summary || ''}`, `Environment: ${run.env?.web?.url || ''}`, '',
      ...findings.map(f => `[${f.severity.toUpperCase()}] ${f.title}${f.bug_key ? ` (${f.bug_key})` : ''}\n   ${(f.detail || '').slice(0, 300)}`),
      '', `Full report: ${reportUrl}`,
    ].join('\n')
    window.location.href = `mailto:${encodeURIComponent(split(to).join(';'))}?cc=${encodeURIComponent(split(cc).join(';'))}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body.slice(0, 1800))}`
  }
  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="card w-full max-w-xl p-5 space-y-3" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <Mail className="h-5 w-5 text-brand-600" /><h3 className="font-semibold flex-1">Send results by email</h3>
          <button onClick={onClose}><X className="h-4 w-4" /></button>
        </div>
        <p className="text-xs text-gray-500">{findings.length} findings {selected.length ? '(selected)' : '(all)'} + AI summary and requirement verdicts.</p>
        <div><label className="text-xs text-gray-500">To</label><input className={inputCls} value={to} onChange={e => setTo(e.target.value)} placeholder="dev-lead@kabatone.com, …" /></div>
        <div><label className="text-xs text-gray-500">Cc</label><input className={inputCls} value={cc} onChange={e => setCc(e.target.value)} /></div>
        <div><label className="text-xs text-gray-500">Subject</label><input className={inputCls} value={subject} onChange={e => setSubject(e.target.value)} /></div>
        <div><label className="text-xs text-gray-500">Note (top of the mail)</label><textarea className={inputCls} rows={3} value={note} onChange={e => setNote(e.target.value)} /></div>
        {send.isError && <p className="text-xs text-red-600">{apiErr(send.error)}</p>}
        {send.isSuccess && <p className="text-xs text-green-600">Sent to {send.data.to.join(', ')}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <a className="btn-secondary flex items-center gap-1" href={reportUrl} target="_blank" rel="noreferrer"><FileText className="h-4 w-4" />Open report</a>
          <button className="btn-secondary flex items-center gap-1" onClick={mailto} disabled={!to.trim()}><ExternalLink className="h-4 w-4" />Open in mail app</button>
          <button className="btn-primary flex items-center gap-1" onClick={() => send.mutate()} disabled={send.isPending || !to.trim()}>
            {send.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}Send (SMTP)
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function FindingsList({ run, onChanged }) {
  const [selected, setSelected] = useState([])
  const [bugFor, setBugFor] = useState(null)
  const [emailOpen, setEmailOpen] = useState(false)
  const [sevFilter, setSevFilter] = useState('all')
  const jiraBase = run.env?.jira?.base_url || ''
  const list = run.findings.filter(f => sevFilter === 'all' || f.severity === sevFilter)
  const toggle = (id) => setSelected(s => (s.includes(id) ? s.filter(x => x !== id) : [...s, id]))
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {['all', 'critical', 'high', 'medium', 'low', 'info'].map(s => (
          <button key={s} onClick={() => setSevFilter(s)}
            className={`text-xs px-2 py-1 rounded-full border ${sevFilter === s ? 'border-brand-500 bg-brand-50 dark:bg-slate-700' : 'border-gray-200 dark:border-slate-600'}`}>
            {s} {s === 'all' ? run.findings.length : run.finding_counts?.[s] || 0}
          </button>
        ))}
        <div className="flex-1" />
        <button className="text-xs text-brand-600 dark:text-brand-300 hover:underline" onClick={() => setSelected(selected.length ? [] : list.map(f => f.id))}>
          {selected.length ? 'Clear selection' : 'Select all'}
        </button>
        <button className="btn-primary text-xs flex items-center gap-1" onClick={() => setEmailOpen(true)} disabled={!run.findings.length}>
          <Mail className="h-3.5 w-3.5" />Email {selected.length ? `${selected.length} selected` : 'all'}
        </button>
      </div>
      {!list.length && <p className="text-sm text-gray-500">No findings.</p>}
      <ul className="space-y-2">
        {list.map(f => (
          <li key={f.id} className="rounded-lg border border-gray-200 dark:border-slate-700 p-3 flex gap-3">
            <input type="checkbox" className="mt-1" checked={selected.includes(f.id)} onChange={() => toggle(f.id)} />
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${SEV_STYLE[f.severity] || SEV_STYLE.info}`}>{f.severity}</span>
                <span className="text-[10px] uppercase text-gray-500">{f.check}</span>
                <span className="font-medium text-sm">{f.title}</span>
              </div>
              {f.detail && <p className="text-xs text-gray-600 dark:text-gray-300 mt-1 whitespace-pre-wrap">{f.detail}</p>}
              {f.evidence && <pre className="text-[11px] text-gray-500 mt-1 whitespace-pre-wrap break-all max-h-32 overflow-auto">{f.evidence}</pre>}
              {f.screenshot && (
                <a href={shotUrl(f.screenshot)} target="_blank" rel="noreferrer">
                  <img src={shotUrl(f.screenshot)} alt="screenshot" className="mt-2 h-24 rounded border border-gray-200 dark:border-slate-700" />
                </a>
              )}
            </div>
            <div className="shrink-0">
              {f.bug_key ? (
                <a href={`${jiraBase}/browse/${f.bug_key}`} target="_blank" rel="noreferrer" className="text-xs text-green-600 flex items-center gap-1 hover:underline">
                  <CheckCircle2 className="h-3.5 w-3.5" />{f.bug_key}
                </a>
              ) : (
                <button className="btn-secondary text-xs flex items-center gap-1" onClick={() => setBugFor(f)}><Bug className="h-3.5 w-3.5" />Create bug</button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {bugFor && <BugModal run={run} finding={bugFor} onClose={() => setBugFor(null)} onFiled={() => { setBugFor(null); onChanged() }} />}
      {emailOpen && <EmailModal run={run} selected={selected} onClose={() => setEmailOpen(false)} />}
    </div>
  )
}

function EvidenceTabs({ run }) {
  const r = run.results || {}
  const tabs = [
    r.ai && !r.ai.error && ['ai', 'Requirements'],
    r.ui && ['ui', 'UI / API calls'],
    r.spec && ['spec', 'Spec values'],
    r.db && ['db', 'Database'],
    r.elastic && ['elastic', 'Elastic'],
    r.jira && ['jira', 'Jira'],
    r.figma && ['figma', 'Figma'],
    r.tests && ['tests', 'Linked tests'],
  ].filter(Boolean)
  const [tab, setTab] = useState(tabs[0]?.[0])
  useEffect(() => { if (!tabs.find(t => t[0] === tab) && tabs[0]) setTab(tabs[0][0]) }, [tabs.length])
  if (!tabs.length) return null
  const cur = r[tab] || {}
  return (
    <div>
      <div className="flex flex-wrap gap-1 border-b border-gray-200 dark:border-slate-700 mb-3">
        {tabs.map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`text-sm px-3 py-1.5 -mb-px border-b-2 ${tab === id ? 'border-brand-500 font-medium' : 'border-transparent text-gray-500'}`}>{label}</button>
        ))}
      </div>
      {cur.error && <p className="text-sm text-red-600 mb-2">This check failed: {cur.error}</p>}

      {tab === 'ai' && (
        <div className="space-y-3">
          {cur.summary && <p className="text-sm"><span className={`font-semibold mr-2 ${VERDICT_STYLE[cur.overall === 'pass' ? 'pass' : cur.overall === 'fail' ? 'fail' : 'partial']}`}>{(cur.overall || '').toUpperCase()}</span>{cur.summary}</p>}
          <div className="flex gap-4 text-xs">{Object.entries(cur.tally || {}).map(([k, v]) => <span key={k} className={VERDICT_STYLE[k]}>{k.replace('_', ' ')}: {v}</span>)}</div>
          <div className="overflow-auto border border-gray-200 dark:border-slate-700 rounded">
            <table className="text-xs w-full">
              <thead className="bg-gray-50 dark:bg-slate-800"><tr><th className="text-left px-2 py-1">Req</th><th className="text-left px-2 py-1">Issue</th><th className="text-left px-2 py-1">Requirement</th><th className="text-left px-2 py-1">Verdict</th><th className="text-left px-2 py-1">Evidence</th></tr></thead>
              <tbody>
                {(cur.requirements || []).map((q, i) => (
                  <tr key={i} className="border-t border-gray-100 dark:border-slate-700 align-top">
                    <td className="px-2 py-1 whitespace-nowrap">{q.id}</td>
                    <td className="px-2 py-1 whitespace-nowrap font-mono">{q.source_key}</td>
                    <td className="px-2 py-1">{q.requirement}</td>
                    <td className={`px-2 py-1 font-semibold whitespace-nowrap ${VERDICT_STYLE[q.verdict] || ''}`}>{(q.verdict || '').replace('_', ' ')}</td>
                    <td className="px-2 py-1 text-gray-600 dark:text-gray-300">{q.evidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'ui' && cur.steps && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-3">
            {cur.steps.map((s, i) => (
              <div key={i} className="text-xs w-64">
                <div className="flex items-center gap-1 mb-1">
                  {s.ok && s.settled !== false ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> : <AlertTriangle className="h-3.5 w-3.5 text-orange-500" />}
                  <span className="font-medium">{s.name}</span>
                  <span className="text-gray-500">· {Math.round((s.waitedMs || 0) / 1000)}s{s.settled === false ? ' (still loading)' : ''}</span>
                </div>
                {s.screenshot_name && <a href={shotUrl(s.screenshot_name)} target="_blank" rel="noreferrer"><img src={shotUrl(s.screenshot_name)} alt={s.name} className="rounded border border-gray-200 dark:border-slate-700" /></a>}
              </div>
            ))}
          </div>
          <ResultTable
            columns={['Step', 'Method', 'Path', 'Status', 'Time (ms)', 'Counts', 'Request body']}
            rows={(cur.requests || []).map(q => [q.step, q.method, q.path, q.status ?? q.failure, q.durationMs,
              Object.entries(q.counts || {}).map(([k, v]) => `${k}=${v}`).join(' '), q.postData || ''])}
          />
          {cur.console_errors?.length > 0 && (
            <details className="text-xs"><summary className="cursor-pointer text-gray-500">{cur.console_errors.length} console errors</summary>
              <pre className="whitespace-pre-wrap mt-1">{cur.console_errors.map(e => `[${e.step}] ${e.text}`).join('\n')}</pre></details>
          )}
        </div>
      )}

      {tab === 'spec' && (
        <div className="space-y-2 text-sm">
          {cur.note && <p className="text-gray-500">{cur.note}</p>}
          {Object.entries(cur.spec_colors || {}).map(([c, keys]) => {
            const ok = !(cur.missing || []).includes(c)
            return (
              <div key={c} className="flex items-center gap-2">
                <span className="h-4 w-4 rounded border border-gray-300" style={{ background: c }} />
                <span className="font-mono w-20">{c}</span>
                <span className="text-xs text-gray-500 w-28">{keys.join(', ')}</span>
                <Pill ok={ok}>{ok ? `returned by ${cur.reference_endpoint || (cur.api_colors?.[c] || []).join(', ')}` : `not returned ${cur.reference_endpoint ? `in ${cur.reference_endpoint}` : 'by any API'}`}</Pill>
              </div>
            )
          })}
          {cur.unexpected?.length > 0 && (
            <p className="text-xs text-orange-600 pt-1">{cur.reference_endpoint} also returns colors not in the requirements: {cur.unexpected.join(', ')}</p>
          )}
          {Object.keys(cur.api_colors || {}).length > 0 && (
            <div className="pt-2"><p className="text-xs text-gray-500 mb-1">Colors the API returned:</p>
              <div className="flex flex-wrap gap-2">{Object.entries(cur.api_colors).map(([c, paths]) => (
                <span key={c} className="text-xs inline-flex items-center gap-1" title={paths.join('\n')}><span className="h-3 w-3 rounded-sm border" style={{ background: c }} />{c}</span>
              ))}</div></div>
          )}
        </div>
      )}

      {tab === 'db' && (
        <div className="space-y-3">
          {cur.note && <p className="text-sm text-gray-500">{cur.note}</p>}
          {(cur.queries || []).map((q, i) => (
            <div key={i}>
              <p className="text-sm font-medium">{q.name} {q.ms != null && <span className="text-xs text-gray-500">({q.ms} ms)</span>}</p>
              <pre className="text-[11px] text-gray-500 whitespace-pre-wrap">{q.sql}</pre>
              {q.error ? <p className="text-xs text-red-600">{q.error}</p> : <ResultTable columns={q.columns} rows={q.rows} />}
            </div>
          ))}
        </div>
      )}

      {tab === 'elastic' && (
        <div className="space-y-3">
          <p className="text-xs text-gray-500">Last {cur.minutes} min · slow threshold p95 ≥ {cur.slow_ms} ms · {cur.error_total} error lines</p>
          <ResultTable columns={['Endpoint', 'Calls', '5xx', 'Avg ms', 'p95 ms', 'Max ms']}
            rows={(cur.endpoints || []).map(e => [e.endpoint, e.count, e.errors, e.avg_ms, e.p95_ms, e.max_ms])} />
          {(cur.keywords || []).map(k => (
            <details key={k.keyword} className="text-xs"><summary className="cursor-pointer">"{k.keyword}" — {k.total} hits</summary>
              <pre className="whitespace-pre-wrap mt-1 text-gray-500">{k.latest.join('\n')}</pre></details>
          ))}
          {(cur.error_groups || []).length > 0 && (
            <ResultTable columns={['Count', 'Latest', 'Sample']} rows={cur.error_groups.map(g => [g.count, g.latest, g.sample])} />
          )}
        </div>
      )}

      {tab === 'jira' && (
        <div className="text-sm space-y-1">
          {[['ToDo test cases', cur.todo_tests], ['Open children', cur.open_children], ['Stories without AC', cur.stories_without_ac], ['No fix version', cur.no_fix_version], ['Open linked bugs', cur.open_bugs]].map(([label, keys]) => (
            <p key={label}><span className="text-gray-500 w-44 inline-block">{label} ({(keys || []).length})</span>
              {(keys || []).map(k => <a key={k} href={`${run.env?.jira?.base_url}/browse/${k}`} target="_blank" rel="noreferrer" className="font-mono text-xs mr-2 text-brand-600 dark:text-brand-300 hover:underline">{k}</a>)}</p>
          ))}
        </div>
      )}

      {tab === 'figma' && (
        <div className="space-y-2 text-sm">
          {cur.note && <p className="text-gray-500">{cur.note}</p>}
          {(cur.frames || []).map((f, i) => (
            <div key={i} className="rounded border border-gray-200 dark:border-slate-700 p-2">
              <a href={f.url} target="_blank" rel="noreferrer" className="text-brand-600 dark:text-brand-300 hover:underline">{f.title || f.url}</a>
              {f.error ? <p className="text-xs text-red-600">{f.error}</p> : (
                <>
                  <div className="flex flex-wrap gap-2 mt-1">{(f.colors || []).map(c => <span key={c} className="text-xs inline-flex items-center gap-1"><span className="h-3 w-3 rounded-sm border" style={{ background: c }} />{c}</span>)}</div>
                  <p className="text-xs text-gray-500 mt-1">{(f.text_summary || '').slice(0, 600)}</p>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'tests' && (
        <div className="text-sm">
          <p className="text-gray-500 mb-1">{cur.note}</p>
          {(cur.started || []).map(s => <p key={s.story}>{s.story}: {s.tests} tests started</p>)}
          <a href="/automation" className="text-brand-600 dark:text-brand-300 hover:underline text-xs">Open the Automation tab</a>
        </div>
      )}
    </div>
  )
}

function RunView({ runId }) {
  const qc = useQueryClient()
  const { data: run } = useQuery({
    queryKey: ['validation-run', runId],
    queryFn: () => api.get(`/validation/runs/${runId}`).then(r => r.data),
    refetchInterval: (q) => (['pending', 'running'].includes(q.state.data?.status) ? 1500 : false),
  })
  if (!run) return <div className="card p-5"><Loader2 className="h-4 w-4 animate-spin" /></div>
  const active = ['pending', 'running'].includes(run.status)
  return (
    <>
      <Section
        title={`Run #${run.id} — ${run.issue_key} ${run.issue_summary || ''}`}
        icon={active ? Loader2 : run.status === 'done' ? CheckCircle2 : XCircle}
        defaultOpen={true}
        right={
          <div className="flex items-center gap-2 text-xs">
            {Object.entries(run.finding_counts || {}).filter(([, n]) => n).map(([s, n]) => (
              <span key={s} className={`px-1.5 py-0.5 rounded font-semibold ${SEV_STYLE[s]}`}>{n} {s}</span>
            ))}
            <span className="text-gray-500">{run.status}</span>
            {!active && <a className="btn-secondary text-xs flex items-center gap-1" href={`${BASE_URL}/validation/runs/${run.id}/report`} target="_blank" rel="noreferrer"><FileText className="h-3.5 w-3.5" />Report</a>}
          </div>
        }
      >
        <pre className={`text-[11px] bg-gray-900 text-green-300 rounded p-3 overflow-auto ${active ? 'max-h-72' : 'max-h-40'}`}>{run.log_output || 'Starting…'}</pre>
        {run.error && <p className="text-sm text-red-600 mt-2">{run.error}</p>}
      </Section>
      {(run.findings?.length > 0 || !active) && (
        <Section title={`Findings (${run.findings?.length || 0})`} icon={Bug}>
          <FindingsList run={run} onChanged={() => qc.invalidateQueries({ queryKey: ['validation-run', runId] })} />
        </Section>
      )}
      {Object.keys(run.results || {}).length > 1 && (
        <Section title="Evidence" icon={ClipboardCheck}>
          <EvidenceTabs run={run} />
        </Section>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ValidationPortalPage() {
  const qc = useQueryClient()
  const [profile, setProfile] = useState(null)
  const [issueKey, setIssueKey] = useState('')
  const [options, setOptions] = useState(DEFAULT_OPTIONS)
  const [runId, setRunId] = useState(null)

  const profileQ = useQuery({ queryKey: ['validation-profile'], queryFn: () => api.get('/validation/profile').then(r => r.data) })
  useEffect(() => {
    if (profileQ.data && !profile) {
      setProfile(profileQ.data)
      setOptions(o => ({ ...o, ui: { ...o.ui, nav_labels: profileQ.data.web?.nav_labels ?? o.ui.nav_labels } }))
    }
  }, [profileQ.data])

  const runsQ = useQuery({ queryKey: ['validation-runs'], queryFn: () => api.get('/validation/runs').then(r => r.data.runs), refetchInterval: 10000 })

  const issue = useMutation({ mutationFn: (key) => api.get(`/validation/issue/${encodeURIComponent(key)}`).then(r => r.data) })
  const explain = useMutation({
    mutationFn: ({ key, refresh }) => api.post(`/validation/issue/${encodeURIComponent(key)}/explain${refresh ? '?refresh=true' : ''}`).then(r => r.data),
  })
  const [applied, setApplied] = useState(false)
  const loadIssue = () => {
    if (!issueKey.trim()) return
    explain.reset(); setApplied(false)
    issue.mutate(issueKey.trim().toUpperCase())
  }
  const currentKey = issue.data?.root.key || issueKey.trim().toUpperCase()
  const applySuggestions = () => {
    const s = explain.data?.suggested_settings || {}
    const wanted = new Set((explain.data?.tests || []).map(t => t.check).filter(c => c in DEFAULT_OPTIONS.checks))
    setOptions(o => ({
      ...o,
      checks: { ...o.checks, ...Object.fromEntries([...wanted].map(c => [c, true])), ai: true },
      ui: { ...o.ui, nav_labels: s.nav_labels || o.ui.nav_labels },
      db: { queries: (s.db_queries || []).length ? s.db_queries.map(q => ({ name: q.name || '', sql: q.sql || '' })) : o.db.queries },
      elastic: { ...o.elastic, keywords: (s.elastic_keywords || []).length ? s.elastic_keywords.join(', ') : o.elastic.keywords },
    }))
    setApplied(true)
  }

  // Sensible defaults once an issue is loaded: count its endpoints in Elastic, use its Figma links
  useEffect(() => {
    if (!issue.data) return
    if (!options.db.queries.length && /event|map|severity/i.test(issue.data.root.summary + JSON.stringify(issue.data.children.map(c => c.summary)))) {
      setOptions(o => ({ ...o, db: { queries: [SQL_TEMPLATES[0]] } }))
    }
  }, [issue.data])

  const start = useMutation({
    mutationFn: () => api.post('/validation/runs', {
      issue_key: issue.data?.root.key || issueKey.trim().toUpperCase(),
      profile,
      options: {
        ...options,
        elastic: { ...options.elastic, keywords: String(options.elastic.keywords || '').split(',').map(s => s.trim()).filter(Boolean) },
        figma: { urls: String(options.figma.urls || '').split(/[\s,]+/).filter(Boolean) },
      },
    }).then(r => r.data),
    onSuccess: (r) => { setRunId(r.id); qc.invalidateQueries({ queryKey: ['validation-runs'] }) },
  })

  const selectedChecks = useMemo(() => Object.values(options.checks).filter(Boolean).length, [options.checks])

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <Header title="Validation Portal" />
      <div className="flex-1 p-6 space-y-5 overflow-auto">
        {profileQ.isError && <div className="card p-4 text-sm text-red-600">Could not load the environment profile: {apiErr(profileQ.error)}</div>}
        {profile && <EnvironmentPanel profile={profile} setProfile={setProfile} />}

        <Section title="What to validate" icon={ClipboardCheck}>
          <div className="flex gap-2 mb-3">
            <input className={inputCls + ' max-w-xs font-mono'} placeholder="Epic / Story / Bug / Task key — e.g. TMT0-38353"
              value={issueKey} onChange={e => setIssueKey(e.target.value)} onKeyDown={e => e.key === 'Enter' && loadIssue()} />
            <button className="btn-secondary flex items-center gap-1" onClick={loadIssue} disabled={issue.isPending || !issueKey.trim()}>
              {issue.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}Load
            </button>
            <button className="btn-secondary flex items-center gap-1" title="Explain in simple words + recommended tests"
              onClick={() => explain.mutate({ key: currentKey })} disabled={explain.isPending || !currentKey}>
              {explain.isPending && !explain.variables?.refresh ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}Explain &amp; test plan
            </button>
          </div>
          {issue.isError && <p className="text-sm text-red-600 mb-2">{apiErr(issue.error)}</p>}
          {issue.data && <IssueCard issue={issue.data} />}
          {explain.isPending && !explain.data && <p className="text-sm text-gray-500 mt-3 flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Reading the item and writing the explanation + test plan… (about 30–60 s)</p>}
          {explain.isError && <p className="text-sm text-red-600 mt-2">{apiErr(explain.error)}</p>}
          {explain.data && (
            <ExplainPanel data={explain.data} applied={applied} onApply={applySuggestions}
              regenerating={explain.isPending && explain.variables?.refresh}
              onRegenerate={() => explain.mutate({ key: explain.data.issue_key, refresh: true })} />
          )}
        </Section>

        <Section title={`Automatic validation — ${selectedChecks} checks selected`} icon={Play}
          right={
            <button className="btn-primary flex items-center gap-1 text-sm" onClick={() => start.mutate()}
              disabled={start.isPending || !(issue.data || issueKey.trim()) || !profile || !selectedChecks}>
              {start.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}Run validation
            </button>
          }>
          <ChecksPanel options={options} setOptions={setOptions} profile={profile} />
          {start.isError && <p className="text-sm text-red-600 mt-2">{apiErr(start.error)}</p>}
        </Section>

        {runId && <RunView key={runId} runId={runId} />}

        <Section title="Recent runs" icon={History} defaultOpen={!runId}>
          {!runsQ.data?.length && <p className="text-sm text-gray-500">No runs yet.</p>}
          <ul className="divide-y divide-gray-100 dark:divide-slate-700">
            {(runsQ.data || []).map(r => (
              <li key={r.id} className={`py-2 flex items-center gap-3 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800 px-2 rounded ${r.id === runId ? 'bg-brand-50 dark:bg-slate-700/50' : ''}`}
                onClick={() => setRunId(r.id)}>
                <span className="text-gray-500 w-10">#{r.id}</span>
                <span className="font-mono w-28">{r.issue_key}</span>
                <span className="flex-1 truncate">{r.issue_summary}</span>
                <span className="flex gap-1">{Object.entries(r.finding_counts || {}).filter(([, n]) => n).map(([s, n]) => (
                  <span key={s} className={`text-[10px] px-1.5 rounded font-semibold ${SEV_STYLE[s]}`}>{n}</span>
                ))}</span>
                <span className="text-xs text-gray-500 w-16">{r.status}</span>
                <span className="text-xs text-gray-500 w-36">{r.created_at ? new Date(r.created_at + 'Z').toLocaleString() : ''}</span>
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  )
}

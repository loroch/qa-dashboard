import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import { Header } from '../components/layout/Header'
import { BASE_URL } from '../services/api'
import {
  LayoutDashboard, ListChecks, ShieldAlert, FlaskConical, Server, PlayCircle, Sparkles, MessageSquare, Bell,
  Settings, Loader2, CheckCircle2, XCircle, AlertTriangle, Info, GitMerge, ExternalLink, X, Search, Play,
  Wand2, Copy, RefreshCw, Rocket, CircleDot, Palette,
} from 'lucide-react'

// Snapshot builds, AI calls and lab runs are slow
const api = axios.create({ baseURL: `${BASE_URL}/nextgen`, timeout: 300000 })
const get = (u, p) => api.get(u, { params: p }).then(r => r.data)
const post = (u, b) => api.post(u, b).then(r => r.data)
const errText = (e) => e?.response?.data?.detail || e?.message || String(e)

const STATUS = { good: '#0ca30c', warning: '#fab219', critical: '#d03b3b' }
const CAT = { done: '#1baf7a', indeterminate: '#2a78d6', new: '#9ca3af' }
const fmtN = (n) => (n == null ? '—' : Number(n).toLocaleString())
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—')
const short = (s) => (s ? String(s).slice(0, 8) : '—')
function ago(iso) {
  if (!iso) return '—'
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 90) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '—')

const TABS = [
  ['overview', 'Overview', LayoutDashboard], ['trace', 'Requirements & Releases', ListChecks], ['ux', 'UX Reference', Palette],
  ['domains', 'Domains & Risk', ShieldAlert], ['tests', 'Tests & Coverage', FlaskConical],
  ['env', 'Environment', Server], ['lab', 'Playwright Lab', PlayCircle], ['advisor', 'AI Test Advisor', Sparkles],
  ['slack', 'Slack', MessageSquare], ['alerts', 'Notifications', Bell], ['settings', 'Settings', Settings],
]

// ---------------------------------------------------------------- shared bits

function Card({ title, icon: Icon, right, children, className = '' }) {
  return (
    <div className={`card p-4 ${className}`}>
      {title && (
        <div className="flex items-center gap-2 mb-3">
          {Icon && <Icon className="h-4 w-4 text-brand-600 dark:text-brand-300" />}
          <h3 className="font-semibold text-sm flex-1">{title}</h3>
          {right}
        </div>
      )}
      {children}
    </div>
  )
}

function Stat({ label, value, sub, tone }) {
  const color = tone === 'bad' ? 'text-red-600 dark:text-red-400' : tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : ''
  return (
    <div className="card px-4 py-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-2xl font-semibold mt-0.5 ${color}`}>{value}</p>
      {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
    </div>
  )
}

function Pill({ children, tone = 'gray', title }) {
  const tones = {
    gray: 'bg-gray-100 text-gray-700 dark:bg-slate-700 dark:text-slate-200',
    green: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    blue: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
    amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    red: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
    purple: 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300',
  }
  return <span title={title} className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-medium whitespace-nowrap ${tones[tone]}`}>{children}</span>
}

const levelTone = (l) => ({ high: 'red', critical: 'red', medium: 'amber', warning: 'amber', low: 'blue', info: 'blue' }[l] || 'gray')
const catTone = (c) => ({ done: 'green', indeterminate: 'blue', new: 'gray' }[c] || 'gray')
const codeTone = (s) => ({ deployed: 'green', 'partly deployed': 'amber', 'merged, not deployed': 'amber', merged: 'blue', none: 'gray' }[s] || 'gray')
const runTone = (s) => ({ passed: 'green', failed: 'red', error: 'red', running: 'blue', pending: 'gray' }[s] || 'gray')

function Table({ columns, rows, max = 520, onRow }) {
  return (
    <div className="overflow-auto border border-gray-200 dark:border-slate-700 rounded" style={{ maxHeight: max }}>
      <table className="text-xs w-full">
        <thead className="bg-gray-50 dark:bg-slate-800 sticky top-0 z-10">
          <tr>{columns.map(c => <th key={c} className="text-left px-2 py-1.5 font-medium whitespace-nowrap">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} onClick={onRow ? () => onRow(i) : undefined}
                className={`border-t border-gray-100 dark:border-slate-700 align-top ${onRow ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-slate-800' : ''}`}>
              {r.map((v, j) => <td key={j} className="px-2 py-1">{v}</td>)}
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={columns.length} className="px-2 py-4 text-center text-gray-500">Nothing to show</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

// Done / in progress / to do as one stacked bar, counts in the tooltip
function ProgressBar({ done, progress, todo }) {
  const total = done + progress + todo
  if (!total) return <span className="text-gray-400">—</span>
  const w = (n) => `${(n / total) * 100}%`
  return (
    <div className="flex items-center gap-2 min-w-[9rem]" title={`${done} done · ${progress} in progress · ${todo} to do`}>
      <div className="flex h-2 w-28 rounded-sm overflow-hidden bg-gray-100 dark:bg-slate-700">
        <div style={{ width: w(done), background: CAT.done }} />
        <div style={{ width: w(progress), background: CAT.indeterminate }} />
        <div style={{ width: w(todo), background: CAT.new }} />
      </div>
      <span>{pct(done, total)}</span>
    </div>
  )
}

function RiskBar({ value, level }) {
  const color = level === 'high' ? STATUS.critical : level === 'medium' ? STATUS.warning : STATUS.good
  return (
    <div className="flex items-center gap-2 min-w-[7rem]">
      <div className="h-2 w-16 rounded-sm bg-gray-100 dark:bg-slate-700 overflow-hidden">
        <div className="h-2" style={{ width: `${Math.max(3, value)}%`, background: color }} />
      </div>
      <span className="font-medium">{value}</span>
      <Pill tone={levelTone(level)}>{level}</Pill>
    </div>
  )
}

function ErrorBox({ error }) {
  if (!error) return null
  return <div className="text-xs text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded p-2 my-2">{errText(error)}</div>
}

function JiraLink({ k, base }) {
  if (!k) return null
  return <a href={`${base}/browse/${k}`} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
            className="text-brand-600 dark:text-brand-300 hover:underline font-mono whitespace-nowrap">{k}</a>
}

// ---------------------------------------------------------------- page

export default function NextGenHubPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState(() => localStorage.getItem('ng-tab') || 'overview')
  const [openIssue, setOpenIssue] = useState(null)
  const [labDraft, setLabDraft] = useState(null)        // {name, script, issue_key} pushed from other tabs
  const [advisorTarget, setAdvisorTarget] = useState(null)
  useEffect(() => { try { localStorage.setItem('ng-tab', tab) } catch { /* private mode */ } }, [tab])

  const snapQ = useQuery({
    queryKey: ['ng-snapshot'], queryFn: () => get('/snapshot'),
    refetchInterval: (q) => (q.state.data?.status?.running ? 3000 : 60000),
  })
  const cfgQ = useQuery({ queryKey: ['ng-settings'], queryFn: () => get('/settings') })
  const notifQ = useQuery({ queryKey: ['ng-notif'], queryFn: () => get('/notifications', { limit: 150 }), refetchInterval: 30000 })
  const refresh = useMutation({ mutationFn: () => post('/refresh'), onSuccess: () => qc.invalidateQueries({ queryKey: ['ng-snapshot'] }) })

  const snap = snapQ.data?.snapshot
  const status = snapQ.data?.status || {}
  const jiraBase = cfgQ.data?.derived?.jira_base_url || 'https://avite.atlassian.net'
  const unread = notifQ.data?.unread || 0
  const prevRunning = useRef(false)
  useEffect(() => {  // a finished refresh can raise new notifications
    if (prevRunning.current && !status.running) qc.invalidateQueries({ queryKey: ['ng-notif'] })
    prevRunning.current = !!status.running
  }, [status.running, qc])

  const ctx = {
    snap, jiraBase, openIssue: setOpenIssue, goTab: setTab,
    toLab: (d) => { setLabDraft(d); setTab('lab') },
    toAdvisor: (t) => { setAdvisorTarget(t); setTab('advisor') },
  }

  return (
    <div className="flex flex-col h-full">
      <Header title="NextGen QA Hub" lastRefresh={snap ? new Date(snap.generated_at) : null}
              isRefreshing={status.running || refresh.isPending} onRefresh={() => refresh.mutate()}
              extraActions={
                <button onClick={() => setTab('alerts')} className="relative btn-secondary flex items-center gap-1.5 text-sm" title="Notifications">
                  <Bell className="h-4 w-4" />
                  {unread > 0 && <span className="absolute -top-1.5 -right-1.5 bg-red-600 text-white text-[10px] rounded-full px-1.5">{unread}</span>}
                </button>
              } />
      <div className="px-6 pt-3 border-b border-gray-200 dark:border-slate-700 bg-white dark:bg-slate-900">
        <div className="flex gap-1 overflow-x-auto">
          {TABS.map(([id, label, Icon]) => (
            <button key={id} onClick={() => setTab(id)}
                    className={`flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 whitespace-nowrap ${tab === id
                      ? 'border-brand-600 text-brand-700 dark:text-brand-300 font-medium'
                      : 'border-transparent text-gray-500 hover:text-gray-800 dark:hover:text-slate-200'}`}>
              <Icon className="h-4 w-4" />{label}
              {id === 'alerts' && unread > 0 && <span className="ml-1 bg-red-600 text-white text-[10px] rounded-full px-1.5">{unread}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6 space-y-4">
        {status.running && (
          <div className="card px-4 py-2 text-sm flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-brand-600" />
            Refreshing the hub — {status.step || 'starting'}… (environment, GitLab, Jira {snap?.project || 'K1NG'})
          </div>
        )}
        {snapQ.error && <ErrorBox error={`The hub API is not reachable (${errText(snapQ.error)}) — is the backend running the latest version?`} />}
        {refresh.error && <ErrorBox error={`Refresh could not start: ${errText(refresh.error)}`} />}
        {status.error && !status.running && <ErrorBox error={`Last refresh failed: ${status.error}`} />}
        {snap?.errors && Object.entries(snap.errors).map(([k, v]) => <ErrorBox key={k} error={`${k}: ${v}`} />)}

        {!snap && !['settings', 'lab', 'alerts', 'env'].includes(tab) ? (
          <Card>
            <div className="text-center py-10 space-y-3">
              <Rocket className="h-8 w-8 mx-auto text-brand-600" />
              <p className="font-medium">No snapshot yet</p>
              <p className="text-sm text-gray-500">The hub reads the K1-NG repository, Jira and the dev environment and correlates them. The first build takes about a minute.</p>
              <button className="btn-primary" disabled={status.running} onClick={() => refresh.mutate()}>
                {status.running ? 'Building…' : 'Build the first snapshot'}
              </button>
            </div>
          </Card>
        ) : (
          <>
            {tab === 'overview' && <Overview {...ctx} />}
            {tab === 'trace' && <Trace {...ctx} />}
            {tab === 'ux' && <UxTab {...ctx} />}
            {tab === 'domains' && <Domains {...ctx} />}
            {tab === 'tests' && <Tests {...ctx} />}
            {tab === 'env' && <Environment {...ctx} />}
            {tab === 'lab' && <Lab {...ctx} draft={labDraft} clearDraft={() => setLabDraft(null)} />}
            {tab === 'advisor' && <Advisor {...ctx} target={advisorTarget} />}
            {tab === 'slack' && <Slack {...ctx} />}
            {tab === 'alerts' && <Alerts {...ctx} />}
            {tab === 'settings' && <SettingsTab />}
          </>
        )}
      </div>
      {openIssue && <IssueDrawer issueKey={openIssue} onClose={() => setOpenIssue(null)} {...ctx} />}
    </div>
  )
}

// ---------------------------------------------------------------- overview

function EnvStrip({ env, repo }) {
  if (!env) return null
  const up = env.healthy && env.ready !== false
  const v = env.version || {}
  return (
    <div className="card px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
      <span className="flex items-center gap-2 font-medium">
        <CircleDot className="h-4 w-4" style={{ color: up ? STATUS.good : STATUS.critical }} />
        {up ? 'Environment up' : 'Environment DOWN'}
      </span>
      <a href={env.url} target="_blank" rel="noreferrer" className="text-brand-600 dark:text-brand-300 hover:underline">{env.url?.replace('https://', '')}</a>
      <span>Release <b>{v.release || '—'}</b> · version <b>{v.version || '—'}</b></span>
      <span className="font-mono">sha {short(v.gitSha)}</span>
      <span>built {when(v.builtAt)}</span>
      {repo?.main_ahead_of_deployed != null && (
        <span className={repo.main_ahead_of_deployed ? 'text-amber-600 dark:text-amber-400' : ''}>
          main is <b>{repo.main_ahead_of_deployed}</b> commits ahead of the deployment
        </span>
      )}
      {env.login && <span>QA sign-in {env.login.ok ? <Pill tone="green">ok</Pill> : <Pill tone="red">failed</Pill>}</span>}
      {env.ready_note && <span title={env.ready_note}><Pill tone="amber">readiness unknown</Pill></span>}
    </div>
  )
}

function Overview({ snap, openIssue, goTab }) {
  const qc = useQueryClient()
  const s = snap.summary
  const brief = useMutation({ mutationFn: () => post('/ai/briefing'), onSuccess: () => qc.invalidateQueries({ queryKey: ['ng-snapshot'] }) })
  const b = brief.data || snap.briefing
  return (
    <div className="space-y-4">
      <EnvStrip env={snap.env} repo={snap.repo} />
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
        <Stat label={`Open tickets (${snap.project})`} value={fmtN(s.open)} sub={`${fmtN(s.in_progress)} in progress · ${fmtN(s.done)} done`} />
        <Stat label="Open bugs" value={fmtN(s.open_bugs)} sub={`${fmtN(s.bugs_created_7d)} opened in 7 days`} tone={s.open_bugs > 20 ? 'warn' : undefined} />
        <Stat label="Tickets with merged code" value={fmtN(s.tickets_with_code)} sub={`${fmtN(s.changes_30d)} merges in 30 days`} />
        <Stat label="Merged, not deployed" value={fmtN(s.merged_not_deployed)} tone={s.merged_not_deployed ? 'warn' : undefined} sub="waiting for the next deployment" />
        <Stat label="Deployed, not validated" value={fmtN(s.deployed_not_validated)} sub="last 30 days, no passing lab run" tone={s.deployed_not_validated ? 'warn' : undefined} />
        <Stat label="UI e2e cases automated" value={`${fmtN(s.plan_automated)} / ${fmtN(s.plan_total)}`} sub={`${fmtN(s.ui_tests)} UI · ${fmtN(s.api_cases)} API · ${fmtN(s.unit_cases)} unit`} />
      </div>

      <div className="grid xl:grid-cols-2 gap-4">
        <Card title="Recommendations" icon={AlertTriangle}>
          <ul className="space-y-2">
            {snap.recommendations.map((r, i) => (
              <li key={i} className="flex gap-2 text-sm"><Pill tone={levelTone(r.level)}>{r.area}</Pill><span>{r.text}</span></li>
            ))}
            {!snap.recommendations.length && <li className="text-sm text-gray-500">Nothing flagged.</li>}
          </ul>
        </Card>
        <Card title="AI QA briefing" icon={Sparkles} right={
          <button className="btn-secondary text-xs flex items-center gap-1" disabled={brief.isPending} onClick={() => brief.mutate()}>
            {brief.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}{b ? 'Regenerate' : 'Generate'}
          </button>}>
          <ErrorBox error={brief.error} />
          {!b && !brief.isPending && <p className="text-sm text-gray-500">Claude reads the whole snapshot and writes the QA status, the top risks with evidence and next steps for manual and automation testers.</p>}
          {brief.isPending && <p className="text-sm text-gray-500 flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Analysing the snapshot…</p>}
          {b && (
            <div className="space-y-3 text-sm">
              <p className="font-semibold">{b.headline}</p>
              <p className="text-gray-700 dark:text-slate-300">{b.status}</p>
              <div>
                <p className="text-xs font-medium text-gray-500 mb-1">Top risks</p>
                <ul className="space-y-1">{b.risks.map((r, i) => (
                  <li key={i}><Pill tone={levelTone(r.severity)}>{r.severity}</Pill> <b>{r.title}</b> — <span className="text-gray-600 dark:text-slate-400">{r.evidence}</span></li>
                ))}</ul>
              </div>
              <div className="grid md:grid-cols-2 gap-3">
                <div><p className="text-xs font-medium text-gray-500 mb-1">Manual testers</p><ul className="list-disc ml-4 space-y-0.5">{b.manual_next_steps.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
                <div><p className="text-xs font-medium text-gray-500 mb-1">Automation</p><ul className="list-disc ml-4 space-y-0.5">{b.automation_next_steps.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
              </div>
              {b.generated_at && <p className="text-xs text-gray-400">Generated {ago(b.generated_at)}</p>}
            </div>
          )}
        </Card>
      </div>

      <div className="grid xl:grid-cols-2 gap-4">
        <Card title="QA risk by domain" icon={ShieldAlert} right={<button className="text-xs text-brand-600 hover:underline" onClick={() => goTab('domains')}>All domains</button>}>
          <Table columns={['Domain', 'Risk', 'Open bugs', 'Merges 14d', 'Why']}
                 rows={snap.domains.slice(0, 7).map(d => [d.domain, <RiskBar value={d.risk} level={d.risk_level} />, d.open_bugs, d.changes_14d,
                   <span className="text-gray-600 dark:text-slate-400">{d.reasons.slice(0, 2).join('; ') || '—'}</span>])} />
        </Card>
        <Card title="Latest merges to main" icon={GitMerge}>
          <Table max={330} columns={['When', 'Change', 'Tickets', 'On env']}
                 rows={snap.recent_changes.slice(0, 25).map(c => [
                   <span className="whitespace-nowrap">{ago(c.date)}</span>, c.subject.replace(/^Merge branch '([^']+)' into '?main'?/, '$1'),
                   <span className="flex flex-wrap gap-1">{c.keys.map(k => <button key={k} className="font-mono text-brand-600 dark:text-brand-300 hover:underline" onClick={() => openIssue(k)}>{k}</button>)}</span>,
                   c.deployed === true ? <Pill tone="green">deployed</Pill> : c.deployed === false ? <Pill tone="amber">not yet</Pill> : <Pill>?</Pill>])} />
        </Card>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- traceability

const GAP_FILTERS = ['Merged, not deployed', 'Deployed, not validated in env', 'Code merged, Jira not Done', 'No test changes', 'Done in Jira, no code found']

function Trace({ snap, jiraBase, openIssue }) {
  const [q, setQ] = useState('')
  const [type, setType] = useState('')
  const [cat, setCat] = useState('open')
  const [code, setCode] = useState('')
  const [dom, setDom] = useState('')
  const [gap, setGap] = useState('')
  const [version, setVersion] = useState('')
  const [page, setPage] = useState(0)
  const [hideBacklog, setHideBacklog] = useState(true)
  const types = useMemo(() => [...new Set(snap.issues.map(i => i.type))].sort(), [snap])
  const domains = useMemo(() => [...new Set(snap.issues.map(i => i.domain))].sort(), [snap])
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase()
    return snap.issues.filter(i =>
      (!t || i.key.toLowerCase().includes(t) || i.summary.toLowerCase().includes(t)) &&
      (!type || i.type === type) &&
      (!cat || (cat === 'open' ? i.category !== 'done' : i.category === cat)) &&
      (!code || i.code_state === code) && (!dom || i.domain === dom) &&
      (!gap || i.gaps.includes(gap)) && (!version || (i.versions || []).includes(version)))
  }, [snap, q, type, cat, code, dom, gap, version])
  useEffect(() => setPage(0), [q, type, cat, code, dom, gap, version])
  const PAGE = 100
  const releases = snap.releases.filter(r => !hideBacklog || (!/backlog/i.test(r.version) && r.version !== '(no fix version)'))
  const sel = 'border border-gray-300 dark:border-slate-600 dark:bg-slate-800 rounded px-2 py-1 text-xs'

  return (
    <div className="space-y-4">
      <Card title="Releases (Jira fix versions) — requirement → code → environment → validation" icon={Rocket}
            right={<label className="text-xs flex items-center gap-1"><input type="checkbox" checked={hideBacklog} onChange={e => setHideBacklog(e.target.checked)} />hide backlog</label>}>
        <Table max={360} columns={['Version', 'Tickets', 'Jira progress', 'With code', 'On env', 'Validated', 'Open bugs', '']}
               rows={releases.map(r => [<b>{r.version}</b>, r.total, <ProgressBar done={r.done} progress={r.in_progress} todo={r.todo} />,
                 `${r.with_code} (${pct(r.with_code, r.total)})`, `${r.deployed} (${pct(r.deployed, r.total)})`, r.validated,
                 r.open_bugs ? <Pill tone="red">{r.open_bugs}</Pill> : 0,
                 <button className="text-brand-600 hover:underline" onClick={() => { setVersion(r.version === '(no fix version)' ? '' : r.version); setCat('') }}>tickets</button>])} />
        <p className="text-xs text-gray-500 mt-2">With code = a merged MR names the ticket. On env = that code is in the SHA the environment runs. Validated = a passing Playwright Lab run for the ticket.</p>
      </Card>

      <Card title={`Tickets (${fmtN(rows.length)})`} icon={ListChecks}>
        <div className="flex flex-wrap gap-2 mb-3 items-center">
          <div className="relative"><Search className="h-3.5 w-3.5 absolute left-2 top-1.5 text-gray-400" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="key or words" className={`${sel} pl-7 w-48`} /></div>
          <select className={sel} value={type} onChange={e => setType(e.target.value)}><option value="">All types</option>{types.map(t => <option key={t}>{t}</option>)}</select>
          <select className={sel} value={cat} onChange={e => setCat(e.target.value)}>
            <option value="open">Not done</option><option value="">Any status</option><option value="new">To do</option><option value="indeterminate">In progress</option><option value="done">Done</option></select>
          <select className={sel} value={code} onChange={e => setCode(e.target.value)}><option value="">Any code state</option>
            {['none', 'merged, not deployed', 'partly deployed', 'deployed', 'merged'].map(x => <option key={x}>{x}</option>)}</select>
          <select className={sel} value={dom} onChange={e => setDom(e.target.value)}><option value="">All domains</option>{domains.map(d => <option key={d}>{d}</option>)}</select>
          <select className={sel} value={gap} onChange={e => setGap(e.target.value)}><option value="">Any gap</option>{GAP_FILTERS.map(g => <option key={g}>{g}</option>)}</select>
          <select className={sel} value={version} onChange={e => setVersion(e.target.value)}><option value="">All versions</option>{snap.releases.map(r => <option key={r.version}>{r.version}</option>)}</select>
        </div>
        <Table max={620} onRow={(i) => openIssue(rows[page * PAGE + i].key)}
               columns={['Key', 'Type', 'Summary', 'Status', 'Domain', 'Code', 'Merges', 'Tests', 'Validated', 'Gaps']}
               rows={rows.slice(page * PAGE, page * PAGE + PAGE).map(i => [
                 <JiraLink k={i.key} base={jiraBase} />, i.type, <span className="line-clamp-2">{i.summary}</span>,
                 <Pill tone={catTone(i.category)}>{i.status}</Pill>, i.domain, <Pill tone={codeTone(i.code_state)}>{i.code_state}</Pill>,
                 i.changes || '—', i.test_files || '—',
                 i.validation ? <Pill tone={runTone(i.validation.status)}>{i.validation.status}</Pill> : '—',
                 <span className="flex flex-wrap gap-1">{i.gaps.map(g => <Pill key={g} tone="amber">{g}</Pill>)}</span>])} />
        {rows.length > PAGE && (
          <div className="flex items-center gap-2 mt-2 text-xs">
            <button className="btn-secondary text-xs" disabled={!page} onClick={() => setPage(p => p - 1)}>Previous</button>
            <span>{page * PAGE + 1}–{Math.min(rows.length, (page + 1) * PAGE)} of {rows.length}</span>
            <button className="btn-secondary text-xs" disabled={(page + 1) * PAGE >= rows.length} onClick={() => setPage(p => p + 1)}>Next</button>
          </div>
        )}
      </Card>

      <Card title={`Epics (${snap.epics.length})`} icon={ListChecks}>
        <Table max={420} onRow={(i) => openIssue(snap.epics[i].key)}
               columns={['Epic', 'Summary', 'Domain', 'Children', 'Jira progress', 'With code', 'On env', 'Open bugs']}
               rows={snap.epics.map(e => [<JiraLink k={e.key} base={jiraBase} />, e.summary, e.domain, e.children,
                 <ProgressBar done={e.done} progress={0} todo={e.children - e.done} />, e.with_code, e.deployed,
                 e.open_bugs ? <Pill tone="red">{e.open_bugs}</Pill> : 0])} />
      </Card>
    </div>
  )
}

function IssueDrawer({ issueKey, onClose, jiraBase, toLab, toAdvisor, snap }) {
  const q = useQuery({ queryKey: ['ng-issue', issueKey], queryFn: () => get(`/issue/${issueKey}`) })
  const gen = useMutation({ mutationFn: () => post('/ai/lab-script', { issue_key: issueKey }),
                            onSuccess: (d) => { toLab({ name: d.name, script: d.script, issue_key: d.issue_key, notes: d }); onClose() } })
  const d = q.data
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <div className="w-full max-w-3xl h-full overflow-auto bg-white dark:bg-slate-900 shadow-xl p-5 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-2">
          <div className="flex-1">
            <p className="text-xs text-gray-500">{d?.type} · {d?.status}{d?.versions?.length ? ` · ${d.versions.join(', ')}` : ''}</p>
            <h2 className="font-semibold"><JiraLink k={d?.key || issueKey} base={jiraBase} /> {d?.summary}</h2>
          </div>
          <button onClick={onClose}><X className="h-5 w-5" /></button>
        </div>
        {q.isLoading && <Loader2 className="h-5 w-5 animate-spin" />}
        <ErrorBox error={q.error || gen.error} />
        {d && (
          <>
            <div className="flex flex-wrap gap-2">
              <button className="btn-primary text-xs flex items-center gap-1" disabled={gen.isPending} onClick={() => gen.mutate()}>
                {gen.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}Generate a validation script (Playwright Lab)</button>
              <button className="btn-secondary text-xs flex items-center gap-1" onClick={() => { toAdvisor({ issue_key: d.key }); onClose() }}>
                <Sparkles className="h-3 w-3" />Alternative tests (Grok)</button>
              <a className="btn-secondary text-xs flex items-center gap-1" href={d.url} target="_blank" rel="noreferrer"><ExternalLink className="h-3 w-3" />Open in Jira</a>
            </div>
            {d.row && (
              <div className="flex flex-wrap gap-2 text-xs items-center">
                <span>Domain <b>{d.row.domain}</b></span><Pill tone={codeTone(d.row.code_state)}>{d.row.code_state}</Pill>
                <span>{d.row.changes} merges · {d.row.test_files} test files changed</span>
                {d.row.gaps.map(g => <Pill key={g} tone="amber">{g}</Pill>)}
              </div>
            )}
            <UxForIssue snap={snap} issueKey={d.key} parentKey={d.parent} />
            <Card title="Description"><pre className="whitespace-pre-wrap text-xs font-sans max-h-72 overflow-auto">{d.description || '(empty)'}</pre></Card>
            <Card title={`Merges to main (${d.changes.length})`} icon={GitMerge}>
              <Table max={260} columns={['When', 'SHA', 'Change', 'On env']}
                     rows={d.changes.map(c => [when(c.date), <span className="font-mono">{c.sha}</span>, c.subject,
                       c.deployed === true ? <Pill tone="green">deployed</Pill> : c.deployed === false ? <Pill tone="amber">not yet</Pill> : '?'])} />
              {!d.changes.length && <p className="text-xs text-gray-500 mt-1">Only the latest 150 merges are kept in the snapshot; older work shows in the counters but not here.</p>}
            </Card>
            {!!d.links.length && (
              <Card title="Links"><ul className="text-xs space-y-1">{d.links.map((l, i) => <li key={i}>{l.type}: <JiraLink k={l.key} base={jiraBase} /> {l.summary}</li>)}</ul></Card>
            )}
            <Card title={`Playwright Lab runs (${d.lab_runs.length})`} icon={PlayCircle}>
              <ul className="text-xs space-y-1">{d.lab_runs.map(r => <li key={r.id}>#{r.id} <Pill tone={runTone(r.status)}>{r.status}</Pill> {r.name} · {when(r.created_at)}</li>)}</ul>
              {!d.lab_runs.length && <p className="text-xs text-gray-500">Not validated on the environment yet.</p>}
            </Card>
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- UX reference

const AC_KIND_TONE = { ui: 'blue', behaviour: 'purple', system: 'gray' }
const STATE_TONE = { Empty: 'gray', Loading: 'blue', Populated: 'green', Error: 'red', 'Permission-denied': 'amber', Degraded: 'amber' }

function acChecklist(e) {
  const lines = [`# ${e.epic} — ${e.title} (${e.epic_key})`, '']
  e.stories.forEach(s => {
    lines.push(`## ${s.id} ${s.title} (${s.key})`)
    s.acs.forEach(a => lines.push(`- [ ] ${a.id} [${a.kind}] ${a.text}`))
    lines.push('')
  })
  ;(e.extra?.surfaces || []).forEach(sf => {
    lines.push(`## Surface: ${sf.name}`)
    ;(sf.states || []).forEach(st => lines.push(`- [ ] ${st}: ${sf.details?.[st] || ''}`))
    lines.push('')
  })
  return lines.join('\n')
}

function UxEpic({ e, jiraBase, openIssue, toAdvisor }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const surfaces = e.extra?.surfaces || []
  const notes = e.extra?.fpdStates || []
  return (
    <div className="border border-gray-200 dark:border-slate-700 rounded">
      <button onClick={() => setOpen(o => !o)} className="w-full flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-slate-800">
        <span className="font-mono text-xs text-gray-500 w-16">{e.epic}</span>
        <span className="font-medium text-sm flex-1 min-w-[16rem]">{e.title}</span>
        <JiraLink k={e.epic_key} base={jiraBase} />
        {e.jira && <Pill tone={catTone(e.jira.category)}>{e.jira.status}</Pill>}
        <span className="text-xs text-gray-500">{e.stories.length} stories · {e.acs} ACs</span>
        <span className="text-xs" title="Acceptance criteria named in a repository test">
          <Pill tone={e.acs_tested ? 'green' : 'gray'}>{e.acs_tested}/{e.acs} in tests</Pill></span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-3 border-t border-gray-100 dark:border-slate-700">
          <div className="flex flex-wrap gap-2 pt-3 items-center text-xs">
            {e.figma_url && <a className="btn-secondary text-xs flex items-center gap-1" href={e.figma_url} target="_blank" rel="noreferrer"><ExternalLink className="h-3 w-3" />Figma page</a>}
            {e.design_task_key && <span>Design task <JiraLink k={e.design_task_key} base={jiraBase} /> {e.design_task && <Pill tone={catTone(e.design_task.category)}>{e.design_task.status}</Pill>}</span>}
            <button className="btn-secondary text-xs flex items-center gap-1" onClick={() => toAdvisor({ issue_key: e.epic_key })}><Sparkles className="h-3 w-3" />Test ideas for the epic</button>
            <button className="btn-secondary text-xs flex items-center gap-1" onClick={() => { navigator.clipboard.writeText(acChecklist(e)); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
              <Copy className="h-3 w-3" />{copied ? 'Copied' : 'Copy AC checklist'}</button>
          </div>

          {e.stories.map(s => (
            <div key={s.key || s.id} className="border border-gray-100 dark:border-slate-700 rounded p-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono text-xs text-gray-500">{s.id}</span>
                <span className="font-medium flex-1">{s.title}</span>
                {s.key && <button className="font-mono text-xs text-brand-600 dark:text-brand-300 hover:underline" onClick={() => openIssue(s.key)}>{s.key}</button>}
                {s.jira ? <><Pill tone={catTone(s.jira.category)}>{s.jira.status}</Pill><Pill tone={codeTone(s.jira.code_state)}>{s.jira.code_state}</Pill></> : <Pill>not in Jira</Pill>}
                {s.key && <button className="text-xs text-brand-600 hover:underline" onClick={() => toAdvisor({ issue_key: s.key })}>test ideas</button>}
              </div>
              {s.note && <p className="text-xs text-gray-500 mt-1">{s.note}</p>}
              <ul className="mt-1.5 space-y-0.5">
                {s.acs.map(a => (
                  <li key={a.id} className="text-xs flex gap-2 items-start">
                    {a.tested ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" style={{ color: STATUS.good }} /> : <CircleDot className="h-3.5 w-3.5 shrink-0 mt-0.5 text-gray-300" />}
                    <span className="font-mono text-gray-500 w-20 shrink-0">{a.id}</span>
                    <Pill tone={AC_KIND_TONE[a.kind] || 'gray'}>{a.kind}</Pill>
                    <span>{a.text}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}

          {!!surfaces.length && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Surfaces — the states every screen must handle</p>
              <Table max={420} columns={['Surface', ...[...new Set(surfaces.flatMap(sf => sf.states || []))]]}
                     rows={surfaces.map(sf => [<b>{sf.name}</b>, ...[...new Set(surfaces.flatMap(x => x.states || []))].map(st =>
                       sf.details?.[st] ? <span><Pill tone={STATE_TONE[st] || 'gray'}>{st}</Pill><br />{sf.details[st]}</span> : '—')])} />
            </div>
          )}
          {!!notes.length && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Design notes</p>
              <ul className="text-xs space-y-0.5">{notes.map((n, i) => <li key={i}><span className="font-mono text-gray-500">{n.story}</span> <b>{n.name}</b>: {n.text}</li>)}</ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function UxTab({ snap, jiraBase, openIssue, toAdvisor }) {
  const qc = useQueryClient()
  const refreshUx = useMutation({ mutationFn: () => post('/ux/refresh'), onSuccess: () => qc.invalidateQueries({ queryKey: ['ng-snapshot'] }) })
  const [q, setQ] = useState('')
  const ux = snap.ux
  if (!ux) {
    return (
      <Card title="UX reference" icon={Palette}>
        <p className="text-sm text-gray-500">Not loaded yet. The hub reads the epic-by-epic UX spec from the K1 prototype on every refresh.</p>
        <button className="btn-primary text-sm mt-2" disabled={refreshUx.isPending} onClick={() => refreshUx.mutate()}>{refreshUx.isPending ? 'Reading…' : 'Read it now'}</button>
        <ErrorBox error={refreshUx.error} />
      </Card>
    )
  }
  const t = q.trim().toLowerCase()
  const epics = ux.epics.filter(e => !t || JSON.stringify(e).toLowerCase().includes(t))
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-5 gap-3">
        <Stat label="UX spec release" value={ux.release} sub={`spec of ${when(ux.spec_generated_at)}`} />
        <Stat label="Epics · stories" value={`${ux.epics.length} · ${ux.story_count}`} sub="with design tasks and Figma pages" />
        <Stat label="Acceptance criteria" value={fmtN(ux.ac_count)} sub={`${ux.acs_tested} named in repository tests`} />
        <Stat label="Stories with code" value={fmtN(ux.stories_with_code)} sub="a merged MR names the story" />
        <div className="card px-4 py-3 text-xs space-y-1.5">
          <a className="flex items-center gap-1 text-brand-600 dark:text-brand-300 hover:underline" href={ux.source_url} target="_blank" rel="noreferrer"><ExternalLink className="h-3 w-3" />Open the prototype</a>
          {ux.figma_file_url && <a className="flex items-center gap-1 text-brand-600 dark:text-brand-300 hover:underline" href={ux.figma_file_url} target="_blank" rel="noreferrer"><ExternalLink className="h-3 w-3" />Figma file "NextGen"</a>}
          <button className="flex items-center gap-1 text-brand-600 hover:underline" disabled={refreshUx.isPending} onClick={() => refreshUx.mutate()}>
            <RefreshCw className={`h-3 w-3 ${refreshUx.isPending ? 'animate-spin' : ''}`} />Re-read the spec</button>
          <p className="text-gray-400">read {ago(ux.fetched_at)}</p>
        </div>
      </div>
      <ErrorBox error={refreshUx.error} />
      <Card title="Epics in the UX spec" icon={Palette} right={
        <div className="relative"><Search className="h-3.5 w-3.5 absolute left-2 top-1.5 text-gray-400" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="search ACs, states…" className="border border-gray-300 dark:border-slate-600 dark:bg-slate-800 rounded px-2 py-1 text-xs pl-7 w-56" /></div>}>
        <p className="text-xs text-gray-500 mb-3">
          The agreed UI/UX for each epic: stories with numbered acceptance criteria, the states every surface must handle (empty, loading, populated, error,
          permission-denied, degraded) and responsive/RTL notes — read from the K1 prototype, linked to Jira and to the Figma page. The AI advisor and the Lab
          script generator use these as the expected behaviour for any ticket in these epics.
        </p>
        <div className="space-y-2">{epics.map(e => <UxEpic key={e.epic_key || e.epic} e={e} jiraBase={jiraBase} openIssue={openIssue} toAdvisor={toAdvisor} />)}</div>
      </Card>
    </div>
  )
}

function UxForIssue({ snap, issueKey, parentKey }) {
  const ux = snap?.ux
  if (!ux) return null
  const hits = []
  ux.epics.forEach(e => {
    const stories = e.stories.filter(s => s.key === issueKey)
    if (stories.length) hits.push({ e, stories })
    else if ([e.epic_key, e.design_task_key].includes(issueKey) || e.epic_key === parentKey) hits.push({ e, stories: e.stories })
  })
  if (!hits.length) return null
  return (
    <Card title="UX reference (prototype spec)" icon={Palette}>
      {hits.map(({ e, stories }) => (
        <div key={e.epic_key} className="text-xs space-y-1.5">
          <p className="font-medium">{e.epic} — {e.title} {e.figma_url && <a className="text-brand-600 hover:underline ml-1" href={e.figma_url} target="_blank" rel="noreferrer">Figma</a>}</p>
          {stories.map(s => (
            <div key={s.id}>
              <p className="font-medium">{s.id} {s.title}</p>
              <ul className="ml-2 space-y-0.5">{s.acs.map(a => (
                <li key={a.id} className="flex gap-2"><span className="font-mono text-gray-500 w-20 shrink-0">{a.id}</span><span>{a.text}</span>{a.tested && <Pill tone="green">in tests</Pill>}</li>))}</ul>
            </div>
          ))}
        </div>
      ))}
    </Card>
  )
}

// ---------------------------------------------------------------- domains

function Domains({ snap, toAdvisor }) {
  return (
    <div className="space-y-4">
      <Card title="QA risk by domain" icon={ShieldAlert}>
        <Table max={700} columns={['Domain', 'Risk', 'Merges 30d / 14d', 'Merges touching tests', 'UI e2e', 'API e2e', 'Unit', 'Open bugs', 'Open tickets', 'Not on env', 'Not validated', 'Why', '']}
               rows={snap.domains.map(d => [<b>{d.domain}</b>, <RiskBar value={d.risk} level={d.risk_level} />,
                 `${d.changes_30d} / ${d.changes_14d}`, d.test_share == null ? '—' : `${Math.round(d.test_share * 100)}%`,
                 fmtN(d.ui_tests), fmtN(d.api_cases), fmtN(d.unit_cases),
                 d.open_bugs ? <Pill tone="red">{d.open_bugs}</Pill> : 0, d.open_issues, d.undeployed || 0, d.not_validated || 0,
                 <span className="text-gray-600 dark:text-slate-400">{d.reasons.join('; ') || '—'}</span>,
                 <button className="text-brand-600 hover:underline whitespace-nowrap" onClick={() => toAdvisor({ domain: d.domain })}>Ask AI</button>])} />
        <p className="text-xs text-gray-500 mt-2">
          Domains come from the paths each MR changed (libs/&lt;scope&gt;, web pages, connectors…) and, for tickets without code, from their wording.
          The risk score adds open bugs, churn in the last 14 days, merges that changed no test, thin e2e coverage, undeployed and unvalidated work.
        </p>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------- tests

function Tests({ snap }) {
  const t = snap.tests || {}
  const plan = t.plan || {}
  const ci = t.ci || []
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <Stat label="UI e2e (Playwright)" value={fmtN(t.ui?.tests)} sub={`${fmtN(t.ui?.files)} spec files · ${fmtN(t.ui?.skipped)} skipped`} />
        <Stat label="API e2e cases" value={fmtN(t.api?.cases)} sub={`${t.api?.suites?.length || 0} suites`} />
        <Stat label="Unit / use-case cases" value={fmtN(t.unit?.cases)} sub={`${fmtN(t.unit?.files)} spec files`} />
        <Stat label="Contract suites" value={fmtN(t.unit?.contract_files)} sub="fake vs real repository" />
        <Stat label="Connector tests (pytest)" value={fmtN((t.python || []).reduce((a, p) => a + p.cases, 0))} sub={(t.python || []).map(p => `${p.connector} ${p.cases}`).join(' · ')} />
        <Stat label="UI plan automated" value={plan.total ? pct(snap.summary.plan_automated, plan.total) : '—'}
              sub={plan.total ? `${fmtN(snap.summary.plan_automated)} of ${fmtN(plan.total)} · ${plan.need_player} need the player, ${plan.manual} manual` : ''} />
      </div>

      <div className="grid xl:grid-cols-2 gap-4">
        <Card title="CI gates (.gitlab-ci.yml)" icon={CheckCircle2}>
          <div className="flex flex-wrap gap-1.5">
            {ci.map(j => <Pill key={j.job + j.file} tone={j.placeholder ? 'red' : 'green'} title={j.file}>{j.job}{j.placeholder ? ' (placeholder)' : ''}</Pill>)}
          </div>
          <p className="text-xs text-gray-500 mt-2">Red = a job that only prints a placeholder. None of the e2e suites, the real-Postgres checks or load tests are wired into CI — they run on a laptop.</p>
        </Card>
        <Card title="UI coverage plan vs automated specs (docs/e2e-ui-coverage-plan.md)" icon={FlaskConical}>
          <Table max={300} columns={['Area', 'Planned cases', 'Automated', 'Coverage']}
                 rows={(plan.areas || []).sort((a, b) => (a.automated / a.planned) - (b.automated / b.planned)).map(a => [a.area, a.planned, a.automated,
                   <div className="flex items-center gap-2"><div className="h-2 w-20 bg-gray-100 dark:bg-slate-700 rounded-sm overflow-hidden"><div className="h-2" style={{ width: pct(a.automated, a.planned), background: a.automated / a.planned < 0.5 ? STATUS.warning : STATUS.good }} /></div>{pct(a.automated, a.planned)}</div>])} />
        </Card>
      </div>

      <div className="grid xl:grid-cols-3 gap-4">
        <Card title="UI e2e by area" icon={PlayCircle}>
          <Table max={380} columns={['Area', 'Domain', 'Files', 'Tests', 'Skipped']}
                 rows={(t.ui?.areas || []).map(a => [a.area, a.domain, a.files, a.tests, a.skipped || 0])} />
        </Card>
        <Card title="API e2e suites" icon={Server}>
          <Table max={380} columns={['Suite', 'Domain', 'Cases']} rows={(t.api?.suites || []).map(s => [s.suite, s.domain, s.cases])} />
        </Card>
        <Card title="Unit tests by project" icon={FlaskConical}>
          <Table max={380} columns={['Project', 'Domain', 'Files', 'Cases']}
                 rows={(t.unit?.projects || []).slice(0, 60).map(u => [u.project, u.domain, u.files, fmtN(u.cases)])} />
        </Card>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- environment

function Environment({ snap }) {
  const qc = useQueryClient()
  const hist = useQuery({ queryKey: ['ng-env'], queryFn: () => get('/env', { limit: 300 }), refetchInterval: 60000 })
  const check = useMutation({ mutationFn: () => post('/env/check'), onSuccess: () => qc.invalidateQueries({ queryKey: ['ng-env'] }) })
  const [deploysOnly, setDeploysOnly] = useState(true)
  const cur = check.data || snap?.env
  const rows = useMemo(() => {
    const h = hist.data?.history || []
    if (!deploysOnly) return h
    return h.filter((r, i) => { const older = h[i + 1]; return !older || older.git_sha !== r.git_sha || older.healthy !== r.healthy || older.ready !== r.ready || older.login_ok !== r.login_ok })
  }, [hist.data, deploysOnly])
  const v = cur?.version || {}
  return (
    <div className="space-y-4">
      <Card title="Current state" icon={Server} right={
        <button className="btn-secondary text-xs flex items-center gap-1" disabled={check.isPending} onClick={() => check.mutate()}>
          {check.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}Check now</button>}>
        <ErrorBox error={check.error} />
        {cur ? (
          <div className="grid lg:grid-cols-3 gap-4 text-xs">
            <div className="space-y-1">
              <p><b>{cur.url}</b></p>
              <p>Product {v.product} · release <b>{v.release}</b> · version <b>{v.version}</b></p>
              <p>git <span className="font-mono">{v.gitSha}</span></p>
              <p>built {when(v.builtAt)} · checked {ago(cur.checked_at)}{cur.uptime_s ? ` · up ${Math.round(cur.uptime_s / 3600)} h` : ''}</p>
              {snap?.repo?.heads?.main && <p>main head <span className="font-mono">{short(snap.repo.heads.main[0])}</span> — {snap.repo.main_ahead_of_deployed ?? '?'} commits not deployed</p>}
            </div>
            <div>
              <Table max={200} columns={['Endpoint', 'Status', 'ms']} rows={Object.entries(cur.endpoints || {}).map(([p, e]) => [p, e.status ?? <Pill tone="red">{e.error || 'error'}</Pill>, e.ms])} />
              <div className="flex flex-wrap gap-1 mt-2">{(cur.ready_checks || []).map(c => <Pill key={c.name} tone={c.ok ? 'green' : 'red'}>{c.name} {c.durationMs}ms</Pill>)}</div>
              {cur.ready_note && <p className="mt-2 text-amber-700 dark:text-amber-400">{cur.ready_note}</p>}
            </div>
            <div className="space-y-1">
              <p className="font-medium">QA account sign-in</p>
              {!cur.login && <p className="text-gray-500">No QA account configured (Settings → Environment).</p>}
              {cur.login && <p>{cur.login.ok ? <Pill tone="green">signed in</Pill> : <Pill tone="red">failed {cur.login.status || ''}</Pill>} {cur.login.ms} ms {cur.login.detail || cur.login.error || ''}</p>}
              {cur.login?.roles && <p>Roles: {cur.login.roles.join(', ') || '—'}</p>}
              {v.subsystems && <pre className="bg-gray-50 dark:bg-slate-800 rounded p-2 overflow-auto max-h-40">{JSON.stringify(v.subsystems, null, 1)}</pre>}
            </div>
          </div>
        ) : <p className="text-sm text-gray-500">Not checked yet.</p>}
      </Card>
      <Card title="Deployments and outages" icon={Rocket}
            right={<label className="text-xs flex items-center gap-1"><input type="checkbox" checked={deploysOnly} onChange={e => setDeploysOnly(e.target.checked)} />changes only</label>}>
        <Table max={520} columns={['Checked', 'SHA', 'Version', 'Release', 'Built', 'Healthy', 'Ready', 'QA sign-in']}
               rows={rows.map(r => [when(r.checked_at), <span className="font-mono">{short(r.git_sha)}</span>, r.version, r.release, when(r.built_at),
                 r.healthy ? <Pill tone="green">yes</Pill> : <Pill tone="red">no</Pill>,
                 r.ready == null ? <Pill tone="amber">unknown</Pill> : r.ready ? <Pill tone="green">yes</Pill> : <Pill tone="red">no</Pill>,
                 r.login_ok == null ? '—' : r.login_ok ? <Pill tone="green">ok</Pill> : <Pill tone="red">failed</Pill>])} />
        <p className="text-xs text-gray-500 mt-2">Checked every 5 minutes in the background. A new SHA or an outage raises a notification.</p>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------- playwright lab

const VERDICT = {
  product_bug: ['Product bug', 'red'], not_deployed: ['Not deployed yet', 'purple'], script_issue: ['Script issue', 'amber'],
  environment: ['Environment', 'blue'], test_data: ['Test data / permissions', 'blue'], unclear: ['Unclear', 'gray'],
}

function bugText(b, run) {
  return [`${b.title}`, '', `Found by NextGen QA Hub lab run #${run.id} on ${run.env_url}${run.issue_key ? ` (${run.issue_key})` : ''}`,
    `Severity: ${b.severity}`, '', 'Steps to reproduce:', ...b.steps.map((s, i) => `${i + 1}. ${s}`), '',
    `Expected: ${b.expected}`, `Actual: ${b.actual}`].join('\n')
}

function FailureExplanation({ run, onApplyScript, autoRef }) {
  const qc = useQueryClient()
  const [copied, setCopied] = useState('')
  const stored = run.result?.explanation
  const explain = useMutation({
    mutationFn: (refresh) => post(`/lab/runs/${run.id}/explain`, { refresh: !!refresh }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ng-lab-run', run.id] }),
  })
  if (autoRef) autoRef.current = () => { if (!explain.isPending) explain.mutate(false) }
  const x = explain.data || stored
  const copy = (what, text) => { navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(''), 1500) }
  const [label, tone] = VERDICT[x?.verdict] || VERDICT.unclear
  return (
    <div className="border-2 border-amber-300 dark:border-amber-600/60 bg-amber-50/60 dark:bg-amber-900/10 rounded p-3 text-xs space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="h-4 w-4 text-amber-600" />
        <span className="font-semibold text-sm flex-1">Why did it fail?</span>
        {!x && <button className="btn-primary text-xs flex items-center gap-1" disabled={explain.isPending} onClick={() => explain.mutate(false)}>
          {explain.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {explain.isPending ? 'Analysing the screenshot, page and log…' : 'Explain failure'}</button>}
        {x && <button className="text-brand-600 hover:underline flex items-center gap-1" disabled={explain.isPending} onClick={() => explain.mutate(true)}>
          <RefreshCw className={`h-3 w-3 ${explain.isPending ? 'animate-spin' : ''}`} />Ask again</button>}
      </div>
      {!x && !explain.isPending && <p className="text-gray-600 dark:text-slate-400">Claude reads the failure screenshot, what was on the page, the failed API calls, console errors, the script and the ticket, and says whether it is a product bug, a script problem, the environment or test data — with a fixed script or a bug draft.</p>}
      <ErrorBox error={explain.error} />
      {x && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={tone}>{label}</Pill><Pill>{x.confidence} confidence</Pill>
            {x.failed_step && <span className="text-gray-500">step “{x.failed_step}”</span>}
          </div>
          <p className="text-sm font-medium">{x.summary}</p>
          <p>{x.what_happened}</p>
          {x.root_cause && <p><b>Root cause:</b> {x.root_cause}</p>}
          {!!x.evidence?.length && <><p className="font-medium">Evidence</p><ul className="list-disc ml-4 space-y-0.5">{x.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul></>}
          {!!x.next_steps?.length && <><p className="font-medium">Next steps</p><ol className="list-decimal ml-4 space-y-0.5">{x.next_steps.map((e, i) => <li key={i}>{e}</li>)}</ol></>}
          {x.fixed_script && (
            <div className="space-y-1">
              <p className="font-medium">Suggested script fix</p>
              {x.fix_explanation && <p>{x.fix_explanation}</p>}
              <div className="flex gap-2">
                <button className="btn-secondary text-xs flex items-center gap-1" onClick={() => onApplyScript(x.fixed_script)}><Wand2 className="h-3 w-3" />Load the fixed script</button>
                <button className="btn-secondary text-xs flex items-center gap-1" onClick={() => copy('script', x.fixed_script)}><Copy className="h-3 w-3" />{copied === 'script' ? 'Copied' : 'Copy'}</button>
              </div>
            </div>
          )}
          {x.bug?.title && (
            <div className="space-y-1 border-t border-amber-200 dark:border-amber-700/40 pt-2">
              <p className="font-medium">Bug draft <span className="font-normal text-gray-500">(not filed — review it, then file it in Jira yourself)</span></p>
              <pre className="whitespace-pre-wrap bg-white dark:bg-slate-900 rounded p-2 border border-gray-200 dark:border-slate-700">{bugText(x.bug, run)}</pre>
              <button className="btn-secondary text-xs flex items-center gap-1" onClick={() => copy('bug', bugText(x.bug, run))}><Copy className="h-3 w-3" />{copied === 'bug' ? 'Copied' : 'Copy bug text'}</button>
            </div>
          )}
          <p className="text-gray-400">{x.model} · {ago(x.generated_at)}</p>
        </>
      )}
    </div>
  )
}

function Lab({ draft, clearDraft, jiraBase }) {
  const qc = useQueryClient()
  const tpl = useQuery({ queryKey: ['ng-lab-tpl'], queryFn: () => get('/lab/templates') })
  const runs = useQuery({ queryKey: ['ng-lab-runs'], queryFn: () => get('/lab/runs'), refetchInterval: 5000 })
  const [name, setName] = useState('Smoke — sign in and open every main page')
  const [issueKey, setIssueKey] = useState('')
  const [script, setScript] = useState('')
  const [routes, setRoutes] = useState('')
  const [notes, setNotes] = useState(null)
  const [runId, setRunId] = useState(null)
  const [genKey, setGenKey] = useState('')

  useEffect(() => {
    if (tpl.data && !script && !draft) { setScript(tpl.data.templates[0].script); setRoutes(tpl.data.routes.join(', ')) }
  }, [tpl.data]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (draft) { setName(draft.name); setScript(draft.script); setIssueKey(draft.issue_key || ''); setNotes(draft.notes || null); clearDraft() }
  }, [draft, clearDraft])

  const run = useMutation({
    mutationFn: () => post('/lab/runs', { name, script, issue_key: issueKey || null, kind: notes ? 'ai' : 'script',
      routes: routes.split(',').map(r => r.trim()).filter(Boolean) }),
    onSuccess: (r) => { setRunId(r.id); qc.invalidateQueries({ queryKey: ['ng-lab-runs'] }) },
  })
  const gen = useMutation({
    mutationFn: () => post('/ai/lab-script', { issue_key: genKey.trim() }),
    onSuccess: (d) => { setName(d.name); setScript(d.script); setIssueKey(d.issue_key); setNotes(d) },
  })
  const detail = useQuery({
    queryKey: ['ng-lab-run', runId], enabled: !!runId, queryFn: () => get(`/lab/runs/${runId}`),
    refetchInterval: (q) => (['pending', 'running'].includes(q.state.data?.status) ? 1500 : false),
  })
  const explainRef = useRef(null)
  const logRef = useRef(null)
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [detail.data?.log])
  const sel = 'border border-gray-300 dark:border-slate-600 dark:bg-slate-800 rounded px-2 py-1 text-xs'
  const d = detail.data
  const res = d?.result

  return (
    <div className="space-y-4">
      <div className="grid xl:grid-cols-2 gap-4">
        <Card title="Script" icon={PlayCircle}>
          <div className="flex flex-wrap gap-2 mb-2 items-center">
            <select className={sel} onChange={e => { const t = tpl.data.templates.find(x => x.id === e.target.value); if (t) { setScript(t.script); setName(t.name); setNotes(null) } }} defaultValue="">
              <option value="" disabled>Template…</option>{tpl.data?.templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <input className={`${sel} flex-1 min-w-[12rem]`} value={name} onChange={e => setName(e.target.value)} placeholder="Run name" />
            <input className={`${sel} w-32 font-mono`} value={issueKey} onChange={e => setIssueKey(e.target.value)} placeholder="K1NG-…" title="Link the run to a ticket: a pass marks it validated" />
          </div>
          <textarea value={script} onChange={e => setScript(e.target.value)} spellCheck={false}
                    className="w-full h-80 font-mono text-xs border border-gray-300 dark:border-slate-600 dark:bg-slate-950 rounded p-2" />
          <div className="flex flex-wrap gap-2 mt-2 items-center">
            <input className={`${sel} flex-1`} value={routes} onChange={e => setRoutes(e.target.value)} title="CFG.routes for the smoke template" placeholder="routes for CFG.routes" />
            <button className="btn-primary flex items-center gap-1 text-sm" disabled={run.isPending || !script.trim()} onClick={() => run.mutate()}>
              {run.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}Run on environment</button>
          </div>
          <ErrorBox error={run.error} />
          <details className="mt-2 text-xs text-gray-600 dark:text-slate-400">
            <summary className="cursor-pointer">What the script can use</summary>
            <p className="mt-1"><code>login()</code> signs in with the hub's QA account · <code>open('/route')</code> navigates and waits for the page to render (don't use 'networkidle': the app keeps live streams open) · <code>step(name, async () =&gt; …)</code> timed + screenshotted step (throws on failure) ·
              <code> expect.visible(sel)</code>, <code>expect.text(words)</code>, <code>expect.ok(cond, msg)</code> · <code>page</code>, <code>context</code>, <code>log()</code>, <code>CFG.url</code>, <code>CFG.routes</code>.
              Console errors and failed API calls are recorded automatically.</p>
          </details>
          <div className="border-t border-gray-200 dark:border-slate-700 mt-3 pt-3 flex flex-wrap gap-2 items-center">
            <Wand2 className="h-4 w-4 text-brand-600" /><span className="text-xs">Generate from a ticket with Claude:</span>
            <input className={`${sel} w-32 font-mono`} value={genKey} onChange={e => setGenKey(e.target.value)} placeholder="K1NG-1234" />
            <button className="btn-secondary text-xs" disabled={gen.isPending || !genKey.trim()} onClick={() => gen.mutate()}>
              {gen.isPending ? 'Writing…' : 'Generate'}</button>
          </div>
          <ErrorBox error={gen.error} />
          {notes && (
            <div className="text-xs mt-2 space-y-1">
              <p>{notes.explanation}</p>
              {!!notes.manual_checks?.length && <><p className="font-medium">Still check by hand:</p><ul className="list-disc ml-4">{notes.manual_checks.map((m, i) => <li key={i}>{m}</li>)}</ul></>}
            </div>
          )}
        </Card>

        <Card title={d ? `Run #${d.id} — ${d.name}` : 'Run'} icon={CircleDot} right={d && <Pill tone={runTone(d.status)}>{d.status}</Pill>}>
          {!d && <p className="text-sm text-gray-500">Run a script, or open a run from the history below.</p>}
          {d && (
            <div className="space-y-3">
              <pre ref={logRef} className="bg-slate-950 text-slate-200 text-[11px] rounded p-2 h-48 overflow-auto whitespace-pre-wrap">{d.log || 'Starting…'}</pre>
              {res?.error && <ErrorBox error={res.error} />}
              {['failed', 'error'].includes(d.status) && (
                <FailureExplanation key={d.id} run={d} autoRef={explainRef}
                                    onApplyScript={(s) => { setScript(s); setName(d.name); setIssueKey(d.issue_key || '') }} />
              )}
              {res?.steps && (
                <div className="space-y-2">
                  {res.steps.map((s, i) => (
                    <div key={i} className="flex gap-3 items-start border border-gray-200 dark:border-slate-700 rounded p-2">
                      {s.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" style={{ color: STATUS.good }} /> : <XCircle className="h-4 w-4 shrink-0" style={{ color: STATUS.critical }} />}
                      <div className="flex-1 text-xs">
                        <p className="font-medium">{s.name} <span className="text-gray-500 font-normal">{s.ms} ms</span></p>
                        {s.error && <p className="text-red-600 dark:text-red-400">{s.error}</p>}
                        {!s.ok && !res.explanation && <button className="text-brand-600 hover:underline flex items-center gap-1 mt-0.5" onClick={() => explainRef.current?.()}>
                          <Sparkles className="h-3 w-3" />Why did this step fail?</button>}
                        <p className="text-gray-400 truncate">{s.url}</p>
                      </div>
                      {s.shot && <a href={`${BASE_URL}/nextgen/lab/runs/${d.id}/shot/${s.shot}`} target="_blank" rel="noreferrer">
                        <img src={`${BASE_URL}/nextgen/lab/runs/${d.id}/shot/${s.shot}`} alt={s.name} className="w-40 rounded border border-gray-200 dark:border-slate-700" /></a>}
                    </div>
                  ))}
                </div>
              )}
              {!!res?.failedRequests?.length && (
                <div><p className="text-xs font-medium mb-1">Failed API calls ({res.failedRequests.length})</p>
                  <pre className="text-[11px] bg-gray-50 dark:bg-slate-800 rounded p-2 max-h-40 overflow-auto">{[...new Set(res.failedRequests)].join('\n')}</pre></div>
              )}
              {!!res?.console?.length && (
                <div><p className="text-xs font-medium mb-1">Console errors ({res.console.length})</p>
                  <pre className="text-[11px] bg-gray-50 dark:bg-slate-800 rounded p-2 max-h-40 overflow-auto">{[...new Set(res.console)].join('\n')}</pre></div>
              )}
            </div>
          )}
        </Card>
      </div>

      <Card title="Run history" icon={ListChecks}>
        <Table max={360} onRow={(i) => setRunId(runs.data.runs[i].id)}
               columns={['#', 'Name', 'Ticket', 'Kind', 'Status', 'Steps', 'Started', 'Finished']}
               rows={(runs.data?.runs || []).map(r => [r.id, r.name, <JiraLink k={r.issue_key} base={jiraBase} />, r.kind,
                 <Pill tone={runTone(r.status)}>{r.status}</Pill>, r.steps ? `${r.steps - r.failed_steps}/${r.steps} ok` : '—', when(r.created_at), when(r.finished_at)])} />
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------- AI advisor

function toMarkdown(r) {
  const lines = [`# Alternative tests — ${r.subject} (${r.provider})`, '', r.analysis, '', '## Gaps', ...r.gaps.map(g => `- ${g}`), '', '## Manual tests']
  r.manual_tests.forEach((t, i) => lines.push('', `### ${i + 1}. [${t.priority}] ${t.title} (${t.type})`, `Preconditions: ${t.preconditions}`, ...t.steps.map((s, j) => `${j + 1}. ${s}`), `Expected: ${t.expected}`))
  lines.push('', '## Automation tests')
  r.automation_tests.forEach(t => lines.push(`- [${t.priority}] **${t.title}** — ${t.level} in \`${t.where}\`: ${t.sketch}`))
  return lines.join('\n')
}

function Advisor({ snap, target, jiraBase }) {
  const cfgQ = useQuery({ queryKey: ['ng-settings'], queryFn: () => get('/settings') })
  const hasGrok = cfgQ.data?.grok?.api_key
  const [mode, setMode] = useState(target?.domain ? 'domain' : 'ticket')
  const [key, setKey] = useState(target?.issue_key || '')
  const [domain, setDomain] = useState(target?.domain || snap?.domains?.[0]?.domain || '')
  const [provider, setProvider] = useState('grok')
  const [extra, setExtra] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (target?.issue_key) { setMode('ticket'); setKey(target.issue_key) }
    if (target?.domain) { setMode('domain'); setDomain(target.domain) }
  }, [target])
  const ask = useMutation({ mutationFn: () => post('/ai/alt-tests', mode === 'ticket' ? { issue_key: key.trim(), provider, extra } : { domain, provider, extra }) })
  const r = ask.data
  const sel = 'border border-gray-300 dark:border-slate-600 dark:bg-slate-800 rounded px-2 py-1 text-xs'
  return (
    <div className="space-y-4">
      <Card title="Independent test advisor" icon={Sparkles}>
        <p className="text-xs text-gray-500 mb-3">
          The code and its tests were written by the same AI agents, so they share the same blind spots. A second model reads the ticket or domain plus
          the automated tests that already exist, and proposes the manual and automation tests that are missing.
        </p>
        <div className="flex flex-wrap gap-2 items-center">
          <select className={sel} value={mode} onChange={e => setMode(e.target.value)}><option value="ticket">A ticket</option><option value="domain">A domain</option></select>
          {mode === 'ticket'
            ? <input className={`${sel} w-36 font-mono`} value={key} onChange={e => setKey(e.target.value)} placeholder="K1NG-1234" />
            : <select className={sel} value={domain} onChange={e => setDomain(e.target.value)}>{(snap?.domains || []).map(d => <option key={d.domain}>{d.domain}</option>)}</select>}
          <select className={sel} value={provider} onChange={e => setProvider(e.target.value)}>
            <option value="grok">Grok (xAI){hasGrok ? '' : ' — no key, falls back to Claude'}</option><option value="claude">Claude</option></select>
          <input className={`${sel} flex-1 min-w-[16rem]`} value={extra} onChange={e => setExtra(e.target.value)} placeholder="Extra context (optional): customer scenario, known issue, focus…" />
          <button className="btn-primary text-sm flex items-center gap-1" disabled={ask.isPending || (mode === 'ticket' && !key.trim())} onClick={() => ask.mutate()}>
            {ask.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}Suggest tests</button>
        </div>
        <ErrorBox error={ask.error} />
      </Card>
      {ask.isPending && <Card><p className="text-sm flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Reading the {mode} and the existing tests…</p></Card>}
      {r && (
        <>
          <Card title={`Analysis — ${r.subject}`} icon={Info} right={
            <span className="flex items-center gap-2"><Pill tone="purple">{r.provider}</Pill>
              <button className="btn-secondary text-xs flex items-center gap-1" onClick={() => { navigator.clipboard.writeText(toMarkdown(r)); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>
                <Copy className="h-3 w-3" />{copied ? 'Copied' : 'Copy as Markdown'}</button></span>}>
            <p className="text-sm whitespace-pre-wrap">{r.analysis}</p>
            <p className="text-xs text-gray-500 mt-2">{r.existing_tests_considered} existing automated tests were given to the model.</p>
            <ul className="mt-2 space-y-1">{r.gaps.map((g, i) => <li key={i} className="text-sm flex gap-2"><AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />{g}</li>)}</ul>
          </Card>
          <div className="grid xl:grid-cols-2 gap-4">
            <Card title={`Manual tests (${r.manual_tests.length})`} icon={ListChecks}>
              <div className="space-y-3">
                {r.manual_tests.map((t, i) => (
                  <div key={i} className="border border-gray-200 dark:border-slate-700 rounded p-2 text-xs">
                    <p className="font-medium"><Pill tone={t.priority === 'P0' ? 'red' : t.priority === 'P1' ? 'amber' : 'gray'}>{t.priority}</Pill> {t.title} <span className="text-gray-500">({t.type})</span></p>
                    <p className="text-gray-500 mt-1">Preconditions: {t.preconditions}</p>
                    <ol className="list-decimal ml-4 mt-1 space-y-0.5">{t.steps.map((s, j) => <li key={j}>{s}</li>)}</ol>
                    <p className="mt-1"><b>Expected:</b> {t.expected}</p>
                  </div>
                ))}
              </div>
            </Card>
            <Card title={`Automation tests (${r.automation_tests.length})`} icon={FlaskConical}>
              <Table max={900} columns={['P', 'Test', 'Level', 'Where', 'Sketch']}
                     rows={r.automation_tests.map(t => [<Pill tone={t.priority === 'P0' ? 'red' : t.priority === 'P1' ? 'amber' : 'gray'}>{t.priority}</Pill>,
                       <b>{t.title}</b>, <Pill tone="blue">{t.level}</Pill>, <span className="font-mono">{t.where}</span>, t.sketch])} />
            </Card>
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- slack

function SourceLinks({ sources }) {
  if (!sources?.length) return null
  return (
    <span className="inline-flex flex-wrap gap-1 ml-1">
      {sources.slice(0, 4).map(s => s.link
        ? <a key={s.ref} href={s.link} target="_blank" rel="noreferrer" title={`${s.user} · ${when(s.at)}`}
             className="text-[10px] text-brand-600 dark:text-brand-300 hover:underline">#{s.channel}</a>
        : <span key={s.ref} className="text-[10px] text-gray-400">#{s.channel}</span>)}
    </span>
  )
}

const KIND_TONE = { bug: 'red', risk: 'amber', environment: 'blue', release: 'green', test: 'purple', other: 'gray' }

function SlackDigest({ days, openIssue }) {
  const qc = useQueryClient()
  const last = useQuery({ queryKey: ['ng-slack-summary'], queryFn: () => get('/slack/summary') })
  const run = useMutation({ mutationFn: () => post('/slack/summary', { days }),
                            onSuccess: (d) => { qc.setQueryData(['ng-slack-summary'], { summary: d }); qc.invalidateQueries({ queryKey: ['ng-notif'] }) } })
  const tick = useMutation({ mutationFn: (b) => post('/slack/summary/action', b),
                             onSuccess: (d) => qc.setQueryData(['ng-slack-summary'], { summary: d }) })
  const [qaOnly, setQaOnly] = useState(true)
  const s = last.data?.summary
  const done = new Set(s?.done || [])
  const actions = (s?.action_items || []).filter(a => !qaOnly || a.qa_related)
  const order = { high: 0, medium: 1, low: 2 }
  return (
    <Card title="NextGen Slack digest" icon={Sparkles} right={
      <span className="flex items-center gap-2">
        {s && <span className="text-xs text-gray-500">{s.messages} messages · {s.days} days · {ago(s.generated_at)}</span>}
        <button className="btn-primary text-xs flex items-center gap-1" disabled={run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
          {run.isPending ? 'Reading the channels…' : `Summarize last ${days} day${days > 1 ? 's' : ''}`}
        </button>
      </span>}>
      <ErrorBox error={run.error} />
      {!s && !run.isPending && <p className="text-sm text-gray-500">Compiles every next-gen channel, threads included, into one digest: decisions, action items (QA ones flagged and sent to Notifications), QA insights and open questions — each linked back to the Slack message. Also refreshed automatically every 6 hours.</p>}
      {s && (
        <div className="space-y-4 text-sm">
          <div>
            <p className="font-semibold">{s.headline}</p>
            <p className="text-gray-700 dark:text-slate-300 mt-1 whitespace-pre-wrap">{s.overview}</p>
            <p className="text-xs text-gray-400 mt-1">Read: {(s.channels_read || []).map(c => '#' + c).join(', ')}</p>
          </div>

          <div>
            <div className="flex items-center gap-3 mb-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Action items ({actions.length})</p>
              <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={qaOnly} onChange={e => setQaOnly(e.target.checked)} />QA-related only</label>
            </div>
            <Table max={360} columns={['', 'Priority', 'Task', 'Owner', 'Due', 'Source']}
                   rows={[...actions].sort((a, b) => order[a.priority] - order[b.priority]).map(a => [
                     <input type="checkbox" checked={done.has(a.task)} onChange={e => tick.mutate({ task: a.task, done: e.target.checked })} />,
                     <Pill tone={levelTone(a.priority)}>{a.priority}</Pill>,
                     <span className={done.has(a.task) ? 'line-through text-gray-400' : ''}>{a.task}{a.qa_related && !qaOnly && <> <Pill tone="purple">QA</Pill></>}</span>,
                     a.owner || '—', a.due || '—', <SourceLinks sources={a.sources} />])} />
          </div>

          <div className="grid xl:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">QA insights ({s.qa_insights.length})</p>
              <ul className="space-y-1.5">{s.qa_insights.map((q, i) => (
                <li key={i}><Pill tone={KIND_TONE[q.kind]}>{q.kind}</Pill> <b>{q.title}</b> — <span className="text-gray-600 dark:text-slate-400">{q.detail}</span>
                  {q.tickets.map(k => <button key={k} className="ml-1" onClick={() => openIssue(k)}><Pill tone="blue">{k}</Pill></button>)}
                  <SourceLinks sources={q.sources} /></li>))}</ul>
            </div>
            <div className="space-y-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Decisions ({s.decisions.length})</p>
                <ul className="list-disc ml-4 space-y-1">{s.decisions.map((d, i) => <li key={i}>{d.text}<SourceLinks sources={d.sources} /></li>)}</ul>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Open questions ({s.open_questions.length})</p>
                <ul className="list-disc ml-4 space-y-1">{s.open_questions.map((q, i) => <li key={i}>{q.question}<SourceLinks sources={q.sources} /></li>)}</ul>
              </div>
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">By channel</p>
            <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-2">{s.channels.map(c => (
              <div key={c.channel} className="border border-gray-200 dark:border-slate-700 rounded p-2 text-xs"><p className="font-medium">#{c.channel.replace(/^#/, '')}</p><p className="text-gray-600 dark:text-slate-400 mt-1">{c.summary}</p></div>))}</div>
          </div>
        </div>
      )}
    </Card>
  )
}

function SlackMessage({ m, openIssue }) {
  return (
    <div className={`text-xs border rounded p-2 ${m.alerts.length ? 'border-amber-300 dark:border-amber-700 bg-amber-50/50 dark:bg-amber-900/10' : 'border-gray-200 dark:border-slate-700'}`}>
      <p className="text-gray-500"><b className="text-gray-800 dark:text-slate-200">{m.user}</b> · {when(m.at)}{m.replies ? ` · ${m.replies} replies` : ''}
        {m.link && <a href={m.link} target="_blank" rel="noreferrer" className="ml-2 text-brand-600 hover:underline">open</a>}</p>
      <p className="whitespace-pre-wrap mt-1">{m.text}</p>
      {(m.alerts.length > 0 || m.keys.length > 0) && (
        <div className="flex flex-wrap gap-1 mt-1">
          {m.alerts.map(a => <Pill key={a} tone="amber">{a}</Pill>)}
          {m.keys.map(k => <button key={k} onClick={() => openIssue(k)}><Pill tone="blue">{k}</Pill></button>)}
        </div>
      )}
    </div>
  )
}

function Slack({ openIssue }) {
  const [days, setDays] = useState(7)
  const [alertsOnly, setAlertsOnly] = useState(false)
  const q = useQuery({ queryKey: ['ng-slack', days], queryFn: () => get('/slack', { days }), refetchInterval: 120000 })
  const d = q.data
  if (q.isLoading) return <Card><Loader2 className="h-5 w-5 animate-spin" /></Card>
  if (q.error) return <Card><ErrorBox error={q.error} /></Card>
  if (!d?.configured) {
    return (
      <Card title="Slack is not connected" icon={MessageSquare}>
        <ol className="list-decimal ml-5 text-sm space-y-1">
          <li>Create a Slack app (api.slack.com/apps) in the KabatOne workspace and add the bot scopes <code>channels:read</code>, <code>groups:read</code>, <code>channels:history</code>, <code>groups:history</code>, <code>users:read</code>.</li>
          <li>Install it and copy the <b>Bot User OAuth Token</b> (xoxb-…) into Settings → Slack.</li>
          <li>In each NextGen channel run <code>/invite @your-bot</code> — private channels are invisible to the bot until then.</li>
        </ol>
      </Card>
    )
  }
  const sel = 'border border-gray-300 dark:border-slate-600 dark:bg-slate-800 rounded px-2 py-1 text-xs'
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-center text-sm">
        <span>Last</span>
        <select className={sel} value={days} onChange={e => setDays(Number(e.target.value))}>
          {[1, 3, 7, 14, 30].map(n => <option key={n} value={n}>{n} day{n > 1 ? 's' : ''}</option>)}</select>
        <span className="text-xs text-gray-500">Channels matching <code>{(d.patterns || []).join(', ')}</code> · {d.as_user ? <>reading as <b>{d.bot}</b> (your user token)</> : <>bot @{d.bot}</>} · {d.channels.length} channel{d.channels.length === 1 ? '' : 's'}</span>
        {q.isFetching && <Loader2 className="h-4 w-4 animate-spin" />}
      </div>
      {!!d.hints?.length && (
        <div className="card px-4 py-2 text-xs space-y-1 border-amber-300 dark:border-amber-700">
          {d.hints.map((h, i) => <p key={i} className="flex gap-2"><Info className="h-4 w-4 shrink-0 text-amber-500" />{h}</p>)}
        </div>
      )}
      <SlackDigest days={days} openIssue={openIssue} />
      <div className="flex items-center gap-2">
        <h3 className="font-semibold text-sm">Messages</h3>
        <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={alertsOnly} onChange={e => setAlertsOnly(e.target.checked)} />only messages with alerts or tickets</label>
      </div>
      {!d.channels.length && <Card><p className="text-sm text-gray-500">No next-gen channel is visible yet — add your Slack user token in Settings, or /invite the bot to the next-gen channels.</p></Card>}
      <div className="grid xl:grid-cols-2 gap-4">
        {d.channels.map(ch => (
          <Card key={ch.id || ch.name} title={`#${ch.name}${ch.private ? " (private)" : ""}`} icon={MessageSquare} right={<span className="text-xs text-gray-500">{ch.messages.length} messages</span>}>
            {ch.error && <ErrorBox error={ch.error} />}
            <div className="space-y-2 max-h-[38rem] overflow-auto">
              {ch.messages.filter(m => !alertsOnly || m.alerts.length || m.keys.length).map(m => <SlackMessage key={m.ts} m={m} openIssue={openIssue} />)}
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- notifications

function Alerts() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['ng-notif'], queryFn: () => get('/notifications', { limit: 150 }), refetchInterval: 30000 })
  const readAll = useMutation({ mutationFn: () => post('/notifications/read'), onSuccess: () => qc.invalidateQueries({ queryKey: ['ng-notif'] }) })
  const readOne = useMutation({ mutationFn: (id) => post(`/notifications/read/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['ng-notif'] }) })
  const icon = (l) => l === 'critical' ? <XCircle className="h-4 w-4" style={{ color: STATUS.critical }} /> : l === 'warning'
    ? <AlertTriangle className="h-4 w-4" style={{ color: STATUS.warning }} /> : <Info className="h-4 w-4 text-brand-600" />
  return (
    <Card title={`Notifications (${q.data?.unread || 0} unread)`} icon={Bell}
          right={<button className="btn-secondary text-xs" onClick={() => readAll.mutate()}>Mark all read</button>}>
      <p className="text-xs text-gray-500 mb-3">Raised in the background: new deployments and outages (every 5 min), new bugs, domains turning high-risk and new merges (every refresh), failed lab runs, and Slack messages with alerts or ticket keys.</p>
      <div className="space-y-1.5">
        {(q.data?.items || []).map(n => (
          <div key={n.id} className={`flex gap-2 items-start text-sm border rounded p-2 ${n.read ? 'border-gray-100 dark:border-slate-800 opacity-70' : 'border-gray-200 dark:border-slate-700'}`}>
            {icon(n.level)}
            <div className="flex-1 min-w-0">
              <p className={n.read ? '' : 'font-medium'}>{n.title}</p>
              {n.detail && <p className="text-xs text-gray-500 break-words">{n.detail}</p>}
              <p className="text-[11px] text-gray-400">{n.category} · {when(n.created_at)}{n.link && <> · <a href={n.link} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">open</a></>}</p>
            </div>
            {!n.read && <button className="text-xs text-brand-600 hover:underline" onClick={() => readOne.mutate(n.id)}>read</button>}
          </div>
        ))}
        {!q.data?.items?.length && <p className="text-sm text-gray-500">No notifications yet.</p>}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------- settings

const FIELDS = [
  ['env', 'NextGen environment', [['url', 'URL'], ['user', 'QA account email'], ['password', 'Password', 'password']]],
  ['repo', 'GitLab repository', [['path', 'Local clone path'], ['url', 'Clone URL'], ['token', 'GitLab token (read_repository) — only to clone', 'password'],
    ['main_branch', 'Main branch'], ['deploy_branch', 'Branch deployed to dev']]],
  ['jira', 'Jira', [['project', 'Project key']]],
  ['slack', 'Slack', [['token', 'Bot token (xoxb-…)', 'password'],
    ['user_token', 'User token (xoxp-…) — optional: reads every private next-gen channel you are in, no invite needed', 'password'],
    ['channels', 'Channels (comma separated, * wildcards, case-insensitive)'], ['days', 'Days to show']]],
  ['grok', 'Grok (xAI) test advisor', [['api_key', 'API key', 'password'], ['model', 'Model'], ['base_url', 'API base URL']]],
  ['ux', 'UX reference', [['url', 'Prototype URL (epic-by-epic UX spec)'], ['figma_file_key', 'Figma file key of the epic pages']]],
]

function SettingsTab() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['ng-settings'], queryFn: () => get('/settings') })
  const [form, setForm] = useState(null)
  useEffect(() => { if (q.data) setForm(JSON.parse(JSON.stringify(q.data))) }, [q.data])
  const save = useMutation({ mutationFn: () => api.put('/settings', form).then(r => r.data),
                             onSuccess: (d) => { qc.setQueryData(['ng-settings'], d); setForm(JSON.parse(JSON.stringify(d))) } })
  const test = useMutation({ mutationFn: () => post('/settings/test') })
  if (!form) return <Card><Loader2 className="h-5 w-5 animate-spin" /></Card>
  const set = (section, key, value) => setForm(f => ({ ...f, [section]: { ...f[section], [key]: value } }))
  const inp = 'w-full border border-gray-300 dark:border-slate-600 dark:bg-slate-800 rounded px-2 py-1 text-sm'
  return (
    <div className="space-y-4">
      <div className="grid xl:grid-cols-2 gap-4">
        {FIELDS.map(([section, title, fields]) => (
          <Card key={section} title={title} icon={Settings}>
            <div className="space-y-2">
              {fields.map(([k, label, type]) => (
                <label key={k} className="block text-xs">
                  <span className="text-gray-600 dark:text-slate-400">{label}</span>
                  <input type={type || 'text'} className={inp} value={form[section]?.[k] ?? ''} onChange={e => set(section, k, e.target.value)} autoComplete="off" />
                </label>
              ))}
            </div>
          </Card>
        ))}
        <Card title="Other connectors" icon={Info}>
          <ul className="text-xs space-y-1">
            <li>Jira: {form.derived?.jira_base_url} (the dashboard's Jira account)</li>
            <li>Claude: {form.derived?.claude_configured ? 'configured' : 'ANTHROPIC_API_KEY missing'} — briefing, lab scripts, advisor fallback</li>
            <li>Figma: {form.derived?.figma_configured ? 'token set' : 'FIGMA_API_TOKEN missing'} (Automation tab reads Figma frames linked from tickets)</li>
          </ul>
          <label className="block text-xs mt-3">
            <span className="text-gray-600 dark:text-slate-400">Background refresh (minutes; takes effect after a restart)</span>
            <input className={inp} value={form.poll_minutes ?? 15} onChange={e => setForm(f => ({ ...f, poll_minutes: Number(e.target.value) || 15 }))} />
          </label>
        </Card>
      </div>
      <div className="flex gap-2">
        <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</button>
        <button className="btn-secondary flex items-center gap-1" disabled={test.isPending} onClick={() => test.mutate()}>
          {test.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Test connectors (saved values)</button>
        {save.isSuccess && <span className="text-sm text-green-600 self-center">Saved</span>}
      </div>
      <ErrorBox error={save.error || test.error} />
      {test.data && (
        <Card title={`Connector test (${test.data.took_ms} ms)`} icon={CheckCircle2}>
          <Table columns={['Connector', 'Result', 'Detail']}
                 rows={Object.entries(test.data).filter(([k]) => k !== 'took_ms').map(([k, v]) => [k,
                   v.ok === true ? <Pill tone="green">ok</Pill> : v.ok === false ? <Pill tone="red">failed</Pill> : <Pill>not set</Pill>, v.detail])} />
        </Card>
      )}
    </div>
  )
}

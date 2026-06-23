"""
Zabbix Hub Proxy  --  serves both K1 dashboards + daily analysis from one port
Run:  python zbx_hub_proxy.py
Open: http://localhost:8080/

Routes:
  GET  /                              -> launcher page
  POST /zbx-api/<site>               -> Zabbix proxy (tamaulipas | michoacan)
  POST /daily-api/<site>             -> fetch 24h alert data + Claude AI analysis

Set ANTHROPIC_API_KEY env var to enable the AI report section.
"""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import urllib.request, json, sys, os, time
from datetime import datetime, timezone
from collections import defaultdict

PORT = 8080

SITES = {
    'tamaulipas': (
        'http://172.15.6.33/zabbix/api_jsonrpc.php',
        'e9b1250fdd746b70b173b4d26cdf6e4c2c88c855dbbb7c83e4a7748a0b5b2b35',
    ),
    'michoacan': (
        'http://10.21.144.248/zabbix/api_jsonrpc.php',
        '25dfa0cedfc9b4da3cd160b4e025493512d62a4cf35d0235ee49964529e662d5',
    ),
}

SITE_LABELS = {
    'tamaulipas': 'K1 Tamaulipas',
    'michoacan':  'K1 Michoacan',
}

SITE_PREFIXES = {
    'tamaulipas': {
        'REY':'Reynosa', 'VIC':'Cd. Victoria', 'TAM':'Tampico',
        'MAN':'Mante', 'LAR':'Laredo', 'MAT':'Matamoros',
    },
    'michoacan': {
        'MOR':'Morelia', 'PAT':'Patzcuaro', 'URU':'Uruapan',
        'LAP':'La Piedad', 'JIQ':'Jiquilpan', 'APA':'Apatzingan',
        'ZIT':'Zitacuaro', 'HUE':'Huetamo', 'COA':'Coalcoman',
        'ZAM':'Zamora', 'LAZ':'Lazaro Cardenas',
    },
}

SEV_LABELS = {
    '0': 'Not classified', '1': 'Info', '2': 'Warning',
    '3': 'Average',        '4': 'High', '5': 'Disaster',
}

ANTHROPIC_KEY = os.environ.get('ANTHROPIC_API_KEY', '')


# ── Helpers ────────────────────────────────────────────────────────────────────

def zbx_call(api_url, token, method, params):
    body = json.dumps({'jsonrpc': '2.0', 'method': method, 'params': params, 'id': 1}).encode()
    req  = urllib.request.Request(
        api_url, data=body,
        headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read())
    if 'error' in data:
        raise RuntimeError(data['error'])
    return data.get('result', [])


def site_of(hosts, prefix_map):
    for h in (hosts or []):
        name = h.get('host') or h.get('name') or ''
        code = name.split('-')[0].upper()
        if code in prefix_map:
            return prefix_map[code]
        if code:
            return code
    return 'Unknown'


def build_host_map(api_url, token, all_probs):
    """Fetch trigger→host mapping for all problems (problem.get lacks selectHosts in Zabbix 7)."""
    tids = list({p['objectid'] for p in all_probs if p.get('objectid')})
    host_map = {}
    for i in range(0, len(tids), 200):
        batch = tids[i:i + 200]
        try:
            triggers = zbx_call(api_url, token, 'trigger.get', {
                'output': ['triggerid'],
                'selectHosts': ['host', 'name'],
                'triggerids': batch,
            })
            for t in triggers:
                host_map[t['triggerid']] = t.get('hosts', [])
        except Exception:
            pass
    return host_map


def process_daily(site, today_probs, yest_probs, host_map):
    prefix_map = SITE_PREFIXES.get(site, {})

    by_sev_today  = defaultdict(int)
    by_site_today = defaultdict(int)
    name_count    = defaultdict(int)
    unacked       = 0

    for p in today_probs:
        sev       = SEV_LABELS.get(str(p.get('severity', 0)), 'Unknown')
        hosts     = host_map.get(p.get('objectid', ''), [])
        site_name = site_of(hosts, prefix_map)
        by_sev_today[sev]        += 1
        by_site_today[site_name] += 1
        name_count[p.get('name', 'Unknown')] += 1
        ack_val = p.get('acknowledges', 0)
        if isinstance(ack_val, list):
            ack_val = len(ack_val)
        if int(ack_val or 0) == 0:
            unacked += 1

    by_sev_yest  = defaultdict(int)
    by_site_yest = defaultdict(int)
    for p in yest_probs:
        sev       = SEV_LABELS.get(str(p.get('severity', 0)), 'Unknown')
        hosts     = host_map.get(p.get('objectid', ''), [])
        site_name = site_of(hosts, prefix_map)
        by_sev_yest[sev]        += 1
        by_site_yest[site_name] += 1

    top10 = sorted(name_count.items(), key=lambda x: -x[1])[:10]

    return {
        'today_total': len(today_probs),
        'yest_total':  len(yest_probs),
        'unacked':     unacked,
        'by_severity_today': dict(by_sev_today),
        'by_severity_yest':  dict(by_sev_yest),
        'by_site_today':     dict(by_site_today),
        'by_site_yest':      dict(by_site_yest),
        'top10': [{'name': n, 'count': c} for n, c in top10],
    }


def call_claude(site, summary):
    if not ANTHROPIC_KEY:
        return None
    label    = SITE_LABELS.get(site, site)
    date_str = datetime.now(timezone.utc).strftime('%Y-%m-%d')

    prompt = f"""You are a Zabbix infrastructure analyst for {label} operations.

24-hour alert report ({date_str}):
- New problems today: {summary['today_total']}  (yesterday: {summary['yest_total']})
- Unacknowledged: {summary['unacked']}
- By severity today: {json.dumps(summary['by_severity_today'])}
- By site today: {json.dumps(summary['by_site_today'])}
- Top recurring issues: {json.dumps([t['name'] + ' x' + str(t['count']) for t in summary['top10'][:6]])}

Write a concise operational report in 3 short paragraphs:
1. Overall 24h health assessment and trend vs yesterday
2. Sites and severity areas of concern
3. Top recurring patterns and recommended actions

Be specific, direct, professional. Under 220 words total."""

    body = json.dumps({
        'model': 'claude-haiku-4-5-20251001',
        'max_tokens': 600,
        'messages': [{'role': 'user', 'content': prompt}],
    }).encode()
    req = urllib.request.Request(
        'https://api.anthropic.com/v1/messages', data=body,
        headers={
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_KEY,
            'anthropic-version': '2023-06-01',
        }
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        result = json.loads(resp.read())
    return result['content'][0]['text']


# ── HTTP Handler ───────────────────────────────────────────────────────────────

class Handler(SimpleHTTPRequestHandler):

    def do_OPTIONS(self):
        self._cors(200)

    def do_GET(self):
        path = self.path.split('?')[0]
        if path in ('/', '/index.html'):
            self._serve_html(LAUNCHER_HTML)
        else:
            super().do_GET()

    def do_POST(self):
        parts = self.path.split('?')[0].strip('/').split('/')

        # /zbx-api/<site>  -- transparent Zabbix proxy
        if len(parts) == 2 and parts[0] == 'zbx-api' and parts[1] in SITES:
            site = parts[1]
            api_url, token = SITES[site]
            length = int(self.headers.get('Content-Length', 0))
            body   = self.rfile.read(length)
            try:
                method = json.loads(body).get('method', '?')
            except Exception:
                method = '?'
            print(f'[{site}] >> {method}', flush=True)
            req = urllib.request.Request(
                api_url, data=body,
                headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {token}'}
            )
            try:
                with urllib.request.urlopen(req, timeout=20) as resp:
                    result = resp.read()
                print(f'[{site}] << OK  {method}  ({len(result):,} bytes)', flush=True)
                self._cors(200, 'application/json')
                self.wfile.write(result)
            except Exception as e:
                print(f'[{site}] << ERR {method}  {e}', flush=True)
                self._cors(502, 'application/json')
                self.wfile.write(json.dumps({'error': {'message': str(e)}}).encode())

        # /daily-api/<site>  -- 24h analysis + Claude AI
        elif len(parts) == 2 and parts[0] == 'daily-api' and parts[1] in SITES:
            site = parts[1]
            print(f'[daily-api] {site} -- fetching ...', flush=True)
            try:
                api_url, token = SITES[site]
                now      = int(time.time())
                day_ago  = now - 86400
                two_days = now - 172800

                today_probs = zbx_call(api_url, token, 'problem.get', {
                    'output': ['eventid', 'objectid', 'name', 'severity', 'clock', 'r_clock'],
                    'selectAcknowledges': 'count',
                    'time_from': day_ago,
                    'recent': False,
                    'sortfield': 'eventid',
                    'sortorder': 'DESC',
                    'limit': 2000,
                })
                yest_probs = zbx_call(api_url, token, 'problem.get', {
                    'output': ['eventid', 'objectid', 'name', 'severity', 'clock'],
                    'time_from': two_days,
                    'time_till': day_ago,
                    'recent': False,
                    'sortfield': 'eventid',
                    'sortorder': 'DESC',
                    'limit': 2000,
                })

                host_map = build_host_map(api_url, token, today_probs + yest_probs)
                summary  = process_daily(site, today_probs, yest_probs, host_map)
                print(f'[daily-api] {site} -- {summary["today_total"]} today / {summary["yest_total"]} yesterday', flush=True)

                ai_text = None
                try:
                    ai_text = call_claude(site, summary)
                    print(f'[daily-api] {site} -- Claude OK', flush=True)
                except Exception as ce:
                    print(f'[daily-api] {site} -- Claude SKIP: {ce}', flush=True)

                payload = json.dumps({
                    'site':         site,
                    'label':        SITE_LABELS.get(site, site),
                    'generated_at': datetime.now(timezone.utc).isoformat(),
                    'summary':      summary,
                    'ai_report':    ai_text,
                }).encode()
                self._cors(200, 'application/json')
                self.wfile.write(payload)

            except Exception as e:
                print(f'[daily-api] {site} -- ERR {e}', flush=True)
                self._cors(502, 'application/json')
                self.wfile.write(json.dumps({'error': str(e)}).encode())

        else:
            super().do_POST()

    def _cors(self, code, ctype=None):
        self.send_response(code)
        self.send_header('Access-Control-Allow-Origin',  '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        if ctype:
            self.send_header('Content-Type', ctype)
        self.end_headers()

    def _serve_html(self, html_str):
        html = html_str.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type',   'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(html)))
        self.end_headers()
        self.wfile.write(html)

    def log_message(self, fmt, *args):
        line = fmt % args
        if any(x in line for x in ('GET /', 'POST')):
            print(f'[browser] {line}', flush=True)


# ── Launcher HTML ──────────────────────────────────────────────────────────────

LAUNCHER_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>K1 Infrastructure Hub</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  min-height: 100vh;
  background: #080c18;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  font-family: 'Segoe UI', system-ui, sans-serif;
  color: #e2e8f0;
  padding: 40px 20px;
}
h1 { font-size: 22px; font-weight: 600; margin-bottom: 6px; }
.sub { color: #64748b; font-size: 13px; margin-bottom: 52px; }
.section-label {
  font-size: 10px; font-weight: 600; letter-spacing: 1.5px;
  color: #475569; text-transform: uppercase;
  width: 100%; max-width: 900px;
  margin-bottom: 14px; margin-top: 32px;
}
.cards {
  display: flex;
  gap: 22px;
  flex-wrap: wrap;
  justify-content: center;
  max-width: 960px;
  width: 100%;
}
a.card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  flex: 1; min-width: 240px; max-width: 300px;
  padding: 24px 24px 20px;
  border-radius: 14px;
  background: rgba(255,255,255,0.045);
  border: 1px solid rgba(255,255,255,0.08);
  text-decoration: none;
  color: inherit;
  transition: transform .15s, border-color .15s, background .15s;
}
a.card:hover {
  transform: translateY(-4px);
  background: rgba(255,255,255,0.075);
  border-color: rgba(234,88,12,0.5);
}
a.card.analysis { border-color: rgba(99,102,241,0.3); }
a.card.analysis:hover { border-color: rgba(99,102,241,0.7); }
.badge {
  width: 40px; height: 40px; border-radius: 10px;
  background: linear-gradient(135deg,#ea580c,#7c2d12);
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 800; color: #fff;
  margin-bottom: 16px;
}
.badge.ai { background: linear-gradient(135deg,#6366f1,#312e81); font-size: 18px; }
.card-title { font-size: 15px; font-weight: 700; margin-bottom: 5px; }
.card-sub   { font-size: 11px; color: #64748b; margin-bottom: 12px; }
.card-sites { font-size: 11px; color: #94a3b8; line-height: 1.7; }
.arrow { align-self: flex-end; margin-top: 16px; font-size: 16px; color: #ea580c; opacity:.7; }
.arrow.ai { color: #6366f1; }
</style>
</head>
<body>
<h1>K1 Infrastructure Hub</h1>
<p class="sub">Select a dashboard or analysis report</p>

<div class="section-label">Real-time Dashboards</div>
<div class="cards">
  <a class="card" href="/zabbix_dashboard.html?site=tamaulipas">
    <div class="badge">K1</div>
    <div class="card-title">K1 Tamaulipas</div>
    <div class="card-sub">Zabbix &mdash; 172.15.6.33</div>
    <div class="card-sites">
      Laredo &bull; Mante &bull; Matamoros<br>
      Reynosa &bull; Tampico &bull; Cd. Victoria
    </div>
    <div class="arrow">&#8594;</div>
  </a>
  <a class="card" href="/zabbix_dashboard.html?site=michoacan">
    <div class="badge">K1</div>
    <div class="card-title">K1 Michoacan</div>
    <div class="card-sub">Zabbix &mdash; 10.21.144.248</div>
    <div class="card-sites">
      Morelia &bull; P&aacute;tzcuaro &bull; Uruapan &bull; La Piedad<br>
      Jiquilpan &bull; Apatzing&aacute;n &bull; Zit&aacute;cuaro<br>
      Huetamo &bull; Coalcom&aacute;n &bull; Zamora &bull; L&aacute;zaro C&aacute;rdenas
    </div>
    <div class="arrow">&#8594;</div>
  </a>
</div>

<div class="section-label">Daily Analysis</div>
<div class="cards">
  <a class="card analysis" href="/daily_analysis.html?site=tamaulipas">
    <div class="badge ai">&#128200;</div>
    <div class="card-title">Tamaulipas &mdash; Daily Analysis</div>
    <div class="card-sub">Last 24h &bull; Alert trends &bull; AI report</div>
    <div class="card-sites">
      Summary by site and severity<br>
      Top recurring issues<br>
      Claude AI operational report
    </div>
    <div class="arrow ai">&#8594;</div>
  </a>
  <a class="card analysis" href="/daily_analysis.html?site=michoacan">
    <div class="badge ai">&#128200;</div>
    <div class="card-title">Michoacan &mdash; Daily Analysis</div>
    <div class="card-sub">Last 24h &bull; Alert trends &bull; AI report</div>
    <div class="card-sites">
      Summary by site and severity<br>
      Top recurring issues<br>
      Claude AI operational report
    </div>
    <div class="arrow ai">&#8594;</div>
  </a>
</div>
</body>
</html>"""


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print('K1 Infrastructure Hub Proxy', flush=True)
    print(f'Launcher  --  http://localhost:{PORT}/', flush=True)
    if ANTHROPIC_KEY:
        print('Claude AI -- enabled (ANTHROPIC_API_KEY set)', flush=True)
    else:
        print('Claude AI -- DISABLED (set ANTHROPIC_API_KEY to enable AI reports)', flush=True)
    print('', flush=True)

    for name, (url, tok) in SITES.items():
        print(f'Testing [{name}] at {url} ...', flush=True)
        for label, body, auth in [
            ('version', b'{"jsonrpc":"2.0","method":"apiinfo.version","params":{},"id":1}', False),
            ('auth',    b'{"jsonrpc":"2.0","method":"host.get","params":{"output":["hostid","name"],"limit":1},"id":2}', True),
        ]:
            hdrs = {'Content-Type': 'application/json'}
            if auth:
                hdrs['Authorization'] = f'Bearer {tok}'
            try:
                req = urllib.request.Request(url, data=body, headers=hdrs)
                with urllib.request.urlopen(req, timeout=10) as r:
                    data = json.loads(r.read())
                if 'error' in data:
                    print(f'  [{label}]  ERROR -- {data["error"]}', flush=True)
                else:
                    print(f'  [{label}]  OK    -- {str(data.get("result",""))[:60]}', flush=True)
            except Exception as e:
                print(f'  [{label}]  FAIL  -- {e}', flush=True)
        print('', flush=True)

    server = ThreadingHTTPServer(('', PORT), Handler)
    print(f'Serving on http://localhost:{PORT}/', flush=True)
    print('Waiting for browser requests...\n', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
        sys.exit(0)

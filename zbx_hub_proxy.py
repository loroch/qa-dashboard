"""
Zabbix Hub Proxy  --  serves both K1 dashboards from one port
Run:  python zbx_hub_proxy.py
Open: http://localhost:8080/

Routes:
  GET  /                                  -> launcher page
  GET  /zabbix_dashboard.html?site=X      -> dashboard (served as static file)
  POST /zbx-api/tamaulipas               -> Zabbix 172.15.6.33
  POST /zbx-api/michoacan                -> Zabbix 10.21.144.248
"""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import urllib.request, json, sys, os

PORT = 8080

SITES = {
    'tamaulipas': (
        'http://172.15.6.33/zabbix/api_jsonrpc.php',
        '3ffaa441479bee310081b847fd6a8d100fb01d34ed189301f5d78c7f5639e9d7',
    ),
    'michoacan': (
        'http://10.21.144.248/zabbix/api_jsonrpc.php',
        '25dfa0cedfc9b4da3cd160b4e025493512d62a4cf35d0235ee49964529e662d5',
    ),
}


class Handler(SimpleHTTPRequestHandler):

    def do_OPTIONS(self):
        self._cors(200)

    def do_GET(self):
        if self.path == '/' or self.path == '/index.html':
            self._serve_launcher()
        else:
            super().do_GET()

    def do_POST(self):
        # /zbx-api/<site>
        parts = self.path.split('?')[0].strip('/').split('/')
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
                self.wfile.write(json.dumps({'error': {'message': str(e), 'data': str(e)}}).encode())
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

    def _serve_launcher(self):
        html = LAUNCHER_HTML.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type',   'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(html)))
        self.end_headers()
        self.wfile.write(html)

    def log_message(self, fmt, *args):
        line = fmt % args
        if any(x in line for x in ('GET /', 'POST')):
            print(f'[browser] {line}', flush=True)


LAUNCHER_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>K1 Infrastructure Dashboards</title>
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
}
h1 {
  font-size: 22px;
  font-weight: 600;
  margin-bottom: 8px;
  letter-spacing: 0.5px;
}
p { color: #64748b; font-size: 13px; margin-bottom: 48px; }
.cards {
  display: flex;
  gap: 28px;
  flex-wrap: wrap;
  justify-content: center;
}
a.card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 280px;
  padding: 28px 28px 24px;
  border-radius: 16px;
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
.badge {
  width: 44px; height: 44px;
  border-radius: 12px;
  background: linear-gradient(135deg,#ea580c,#7c2d12);
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 800; letter-spacing: -0.5px;
  color: #fff;
  margin-bottom: 20px;
}
.card-title { font-size: 17px; font-weight: 700; margin-bottom: 6px; }
.card-sub   { font-size: 12px; color: #64748b; margin-bottom: 16px; }
.card-sites { font-size: 11px; color: #94a3b8; line-height: 1.7; }
.arrow {
  align-self: flex-end;
  margin-top: 20px;
  font-size: 18px;
  color: #ea580c;
  opacity: 0.7;
}
</style>
</head>
<body>
<h1>K1 Infrastructure Dashboards</h1>
<p>Select a region to open its real-time Zabbix dashboard</p>
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
</body>
</html>"""


if __name__ == '__main__':
    print('K1 Infrastructure Hub Proxy', flush=True)
    print(f'Launcher  --  http://localhost:{PORT}/', flush=True)
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

"""
Zabbix Dashboard Proxy Server
Run:  python zbx_proxy.py
Open: http://localhost:8080/zabbix_dashboard.html
"""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import urllib.request, json, sys

ZABBIX_API = 'http://172.15.6.33/zabbix/api_jsonrpc.php'
ZBX_TOKEN  = '3ffaa441479bee310081b847fd6a8d100fb01d34ed189301f5d78c7f5639e9d7'
PORT       = 8080


class Handler(SimpleHTTPRequestHandler):

    def do_OPTIONS(self):
        self._cors(200)

    def do_POST(self):
        if self.path == '/zbx-api':
            length = int(self.headers.get('Content-Length', 0))
            body   = self.rfile.read(length)
            try:
                method = json.loads(body).get('method', '?')
            except Exception:
                method = '?'
            print(f'[>> Zabbix] {method}', flush=True)
            req = urllib.request.Request(
                ZABBIX_API,
                data=body,
                headers={
                    'Content-Type':  'application/json',
                    'Authorization': f'Bearer {ZBX_TOKEN}',
                }
            )
            try:
                with urllib.request.urlopen(req, timeout=20) as resp:
                    result = resp.read()
                print(f'[<< OK]     {method}  ({len(result):,} bytes)', flush=True)
                self._cors(200, 'application/json')
                self.wfile.write(result)
            except Exception as e:
                print(f'[<< ERROR]  {method}  {e}', flush=True)
                self._cors(502, 'application/json')
                self.wfile.write(json.dumps(
                    {'error': {'message': str(e), 'data': str(e)}}
                ).encode())
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

    def log_message(self, fmt, *args):
        # Print GET/POST lines so we can confirm browser hits the proxy
        line = fmt % args
        if any(x in line for x in ('GET', 'POST', 'OPTIONS')):
            print(f'[browser]  {line}', flush=True)


if __name__ == '__main__':
    # ── Test Zabbix reachability ──────────────────────────────────
    print(f'Testing Zabbix at {ZABBIX_API} ...', flush=True)
    for label, body, auth in [
        ('version (no auth)', b'{"jsonrpc":"2.0","method":"apiinfo.version","params":{},"id":1}', False),
        ('host.get  (token)', b'{"jsonrpc":"2.0","method":"host.get","params":{"output":["hostid","name"],"limit":1},"id":2}', True),
    ]:
        hdrs = {'Content-Type': 'application/json'}
        if auth:
            hdrs['Authorization'] = f'Bearer {ZBX_TOKEN}'
        try:
            req = urllib.request.Request(ZABBIX_API, data=body, headers=hdrs)
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.loads(r.read())
            if 'error' in data:
                print(f'  [{label}]  ERROR  -- {data["error"]}', flush=True)
            else:
                print(f'  [{label}]  OK     -- {str(data.get("result",""))[:80]}', flush=True)
        except Exception as e:
            print(f'  [{label}]  FAIL   -- {e}', flush=True)

    server = ThreadingHTTPServer(('', PORT), Handler)
    print(f'\nDashboard  --  http://localhost:{PORT}/zabbix_dashboard.html')
    print('Waiting for browser requests...\n')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.')
        sys.exit(0)

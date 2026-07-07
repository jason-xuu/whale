#!/bin/bash
# Whale Tracker launcher — serves the dashboard locally and proxies CBOE data
# (CBOE blocks direct browser requests; this tiny local server fetches on your behalf).
# Keep this window open while using the dashboard. Press Ctrl+C to stop.
cd "$(dirname "$0")"
exec python3 - <<'PYEOF'
import http.server, urllib.request, urllib.parse, os, sys, webbrowser

ALLOWED_HOSTS = {'cdn.cboe.com', 'efts.sec.gov', 'data.sec.gov', 'www.sec.gov'}

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=os.getcwd(), **kw)

    def do_GET(self):
        # Browsers abort in-flight requests all the time (tab close, refresh,
        # navigation) — a half-written response is normal, not an error.
        try:
            self._get()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _get(self):
        if not self.path.startswith('/proxy?'):
            return super().do_GET()
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        url = (q.get('url') or [''])[0]
        host = urllib.parse.urlparse(url).hostname or ''
        if not url.startswith('https://') or host not in ALLOWED_HOSTS:
            self.send_error(400, 'URL not allowed')
            return
        try:
            req = urllib.request.Request(url, headers={
                'User-Agent': 'WhaleTracker/1.0 (personal research dashboard)',
                'Accept': 'application/json, text/xml, */*'})
            with urllib.request.urlopen(req, timeout=30) as r:
                body = r.read()
                ctype = r.headers.get('Content-Type', 'application/json')
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self.send_error(502, str(e)[:120])

    def log_message(self, *a):
        pass

srv = None
for port in range(8742, 8753):
    try:
        srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
        break
    except OSError:
        continue
if srv is None:
    sys.exit('No free port between 8742-8752')

url = f'http://127.0.0.1:{port}/whale-dashboard.html'
print(f'''
  Whale Tracker is running:  {url}
  Keep this window open while using the dashboard.
  Press Ctrl+C (or close this window) to stop.
''')
webbrowser.open(url)
try:
    srv.serve_forever()
except KeyboardInterrupt:
    pass
PYEOF

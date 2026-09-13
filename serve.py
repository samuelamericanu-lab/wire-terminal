#!/usr/bin/env python3
"""
Wire Terminal — static file server + tiny CORS proxy for Yahoo / RSS.

Usage:
  python3 serve.py          # http://127.0.0.1:8765/
  python3 serve.py 9000     # custom port

Proxy:
  GET /proxy?url=<encoded absolute http(s) URL>
  Only allows known market/news hosts (see ALLOWED_HOSTS).
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765

ALLOWED_HOSTS = {
    "query1.finance.yahoo.com",
    "query2.finance.yahoo.com",
    "feeds.reuters.com",
    "www.reutersagency.com",
    "search.cnbc.com",
    "www.cnbc.com",
    "feeds.marketwatch.com",
    "feeds.content.dowjones.io",
    "feeds.bbci.co.uk",
    "www.investing.com",
    "rss.cnn.com",
    "feeds.finance.yahoo.com",
}

UA = (
    "Mozilla/5.0 (compatible; WireTerminal/1.0; +local-desk) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/proxy":
            return self._proxy(parsed)
        if parsed.path == "/api/health":
            body = json.dumps({"ok": True, "app": "Wire Terminal"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()

    def _proxy(self, parsed):
        qs = urllib.parse.parse_qs(parsed.query)
        raw = (qs.get("url") or [None])[0]
        if not raw:
            return self._err(400, "missing url")
        try:
            target = urllib.parse.urlparse(raw)
        except Exception:
            return self._err(400, "bad url")
        if target.scheme not in ("http", "https") or not target.hostname:
            return self._err(400, "invalid scheme/host")
        host = target.hostname.lower()
        if host not in ALLOWED_HOSTS:
            return self._err(403, f"host not allowed: {host}")

        req = urllib.request.Request(
            raw,
            headers={
                "User-Agent": UA,
                "Accept": "application/json, application/rss+xml, application/xml, text/xml, */*",
            },
            method="GET",
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = resp.read()
                ctype = resp.headers.get("Content-Type", "application/octet-stream")
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            body = e.read() if e.fp else b""
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type", "text/plain"))
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            return self._err(502, str(e))

    def _err(self, code, msg):
        body = json.dumps({"error": msg}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"Wire Terminal → http://127.0.0.1:{PORT}/")
    print("  Static files + /proxy?url=… (Yahoo / RSS allowlist)")
    print("  Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()

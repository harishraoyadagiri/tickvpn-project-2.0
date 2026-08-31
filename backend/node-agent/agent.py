#!/usr/bin/env python3
"""
TickVPN node agent — runs on the WireGuard droplet itself.
Lets the backend add/remove peers over HTTP instead of a human doing it
via Console. Auth is one shared secret header; fine for a small number of
trusted nodes.
"""
import subprocess
import shlex
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer

SECRET = os.environ.get("NODE_SHARED_SECRET", "")
PORT = 8787


def run(cmd: str):
    subprocess.run(cmd, shell=True, check=True)


class Handler(BaseHTTPRequestHandler):
    def _authorized(self):
        return SECRET != "" and self.headers.get("X-Node-Secret") == SECRET

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw or b"{}")

    def _respond(self, code, payload):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())

    def do_GET(self):
        if self.path == "/health":
            self._respond(200, {"ok": True})
        else:
            self._respond(404, {"error": "not found"})

    def do_POST(self):
        if not self._authorized():
            return self._respond(403, {"error": "unauthorized"})
        try:
            if self.path == "/peers":
                body = self._read_json()
                pubkey = shlex.quote(body["publicKey"])
                allowed_ip = shlex.quote(body["allowedIp"])
                run(f"wg set wg0 peer {pubkey} allowed-ips {allowed_ip}")
                run("wg-quick save wg0")
                self._respond(200, {"ok": True})
            elif self.path == "/peers/remove":
                body = self._read_json()
                pubkey = shlex.quote(body["publicKey"])
                run(f"wg set wg0 peer {pubkey} remove")
                run("wg-quick save wg0")
                self._respond(200, {"ok": True})
            else:
                self._respond(404, {"error": "not found"})
        except Exception as e:
            self._respond(500, {"error": str(e)})

    def log_message(self, format, *args):
        pass  # keep the console quiet


if __name__ == "__main__":
    if not SECRET:
        print("WARNING: NODE_SHARED_SECRET is not set — all requests will be rejected.")
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"TickVPN node agent listening on :{PORT}")
    server.serve_forever()

#!/bin/bash
# TickVPN — Node Agent installer. Paste this whole thing into the Droplet
# Console and press Enter. Installs the agent that lets your backend add
# and remove WireGuard peers automatically.
set -e

# EDIT THIS before pasting: must match NODE_SHARED_SECRET in your backend's
# real .env file (not .env.example). Left as a placeholder here on purpose —
# this file is checked into git, so a real secret must never be committed.
NODE_SHARED_SECRET="__REPLACE_WITH_YOUR_NODE_SHARED_SECRET__"

cat > /root/agent.py << 'PYEOF'
#!/usr/bin/env python3
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
        pass


if __name__ == "__main__":
    if not SECRET:
        print("WARNING: NODE_SHARED_SECRET is not set — all requests will be rejected.")
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"TickVPN node agent listening on :{PORT}")
    server.serve_forever()
PYEOF

cat > /etc/systemd/system/tickvpn-agent.service << EOF
[Unit]
Description=TickVPN Node Agent
After=network.target wg-quick@wg0.service

[Service]
Environment=NODE_SHARED_SECRET=${NODE_SHARED_SECRET}
ExecStart=/usr/bin/python3 /root/agent.py
Restart=always

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable tickvpn-agent
systemctl restart tickvpn-agent

echo "=================================================="
echo "Agent installed. Test it with:"
echo "curl localhost:8787/health"
echo "=================================================="

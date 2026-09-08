#!/usr/bin/env bash
#
# Installs the TickVPN node agent on a WireGuard droplet.
#
# Copy this directory to the node and run it as root:
#
#   scp -r backend/node-agent root@<droplet>:/opt/tickvpn-agent
#   ssh root@<droplet>
#   TICKVPN_API_URL=https://api.example.com \
#   TICKVPN_NODE_ID=<node uuid> \
#   TICKVPN_NODE_TOKEN=<token minted by the API> \
#     bash /opt/tickvpn-agent/install-agent.sh
#
# The agent installed here is agent.py from this same directory — it is NOT
# duplicated inline. An earlier version of this script carried its own copy of
# the agent source, which silently went stale when the agent was rewritten and
# would have deployed a version with an inbound HTTP port and a shared secret
# long after that design was removed. One copy, one source of truth.
#
# The agent makes only outbound connections. It listens on nothing, so there is
# no port to firewall and no credential on the wire except to your own API
# over TLS.
set -euo pipefail

INSTALL_DIR=/opt/tickvpn-agent
SERVICE=tickvpn-agent
WG_INTERFACE="${TICKVPN_WG_INTERFACE:-wg0}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "error: $*" >&2; exit 1; }

[[ "$(id -u)" == "0" ]] || die "run as root"

for var in TICKVPN_API_URL TICKVPN_NODE_ID TICKVPN_NODE_TOKEN; do
  [[ -n "${!var:-}" ]] || die "$var is required"
done

case "$TICKVPN_API_URL" in
  https://*) ;;
  http://localhost*|http://127.0.0.1*) echo "warning: plaintext API URL — local testing only" >&2 ;;
  *) die "TICKVPN_API_URL must be https (the node token travels on it)" ;;
esac

[[ -f "$SOURCE_DIR/agent.py" ]] || die "agent.py not found next to this script"
command -v wg >/dev/null || die "wireguard-tools is not installed"
command -v python3 >/dev/null || die "python3 is not installed"

echo "==> installing agent to $INSTALL_DIR"
install -d -m 755 "$INSTALL_DIR"
install -m 755 "$SOURCE_DIR/agent.py" "$INSTALL_DIR/agent.py"

# The token lives in a root-only file rather than in the unit, because
# `systemctl show` exposes Environment= values to any local user.
echo "==> writing credentials to $INSTALL_DIR/agent.env (0600)"
umask 077
cat > "$INSTALL_DIR/agent.env" <<EOF
TICKVPN_API_URL=$TICKVPN_API_URL
TICKVPN_NODE_ID=$TICKVPN_NODE_ID
TICKVPN_NODE_TOKEN=$TICKVPN_NODE_TOKEN
TICKVPN_WG_INTERFACE=$WG_INTERFACE
EOF
chmod 600 "$INSTALL_DIR/agent.env"

echo "==> installing systemd unit"
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=TickVPN node agent
After=network-online.target wg-quick@$WG_INTERFACE.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$INSTALL_DIR/agent.env
ExecStart=/usr/bin/python3 $INSTALL_DIR/agent.py
Restart=always
RestartSec=5

# The agent only needs to run wg and talk to the API.
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=strict
ReadWritePaths=$INSTALL_DIR
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
EOF

# Technical Decisions D8: block outbound mail from day one. A VPN node that can
# send mail becomes a spam relay, and DigitalOcean de-platforms for that faster
# than for anything else on the abuse list.
if command -v nft >/dev/null; then
  echo "==> blocking outbound SMTP (25, 465, 587)"
  nft list table inet tickvpn >/dev/null 2>&1 || nft add table inet tickvpn
  nft list chain inet tickvpn egress >/dev/null 2>&1 || \
    nft add chain inet tickvpn egress '{ type filter hook forward priority 0; }'
  nft add rule inet tickvpn egress tcp dport '{ 25, 465, 587 }' drop 2>/dev/null || true
  nft add rule inet tickvpn egress udp dport '{ 25, 465, 587 }' drop 2>/dev/null || true
  echo "    (make these persistent with nftables.conf — this run is not saved)"
else
  echo "warning: nft not found — outbound SMTP is NOT blocked. Install nftables." >&2
fi

echo "==> starting $SERVICE"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"
sleep 2

if systemctl is-active --quiet "$SERVICE"; then
  echo
  echo "Agent is running. It reports every 10s and reconciles peers every 15s."
  echo "  journalctl -u $SERVICE -f     # follow"
  echo "  wg show $WG_INTERFACE         # peers the control plane has authorised"
else
  echo
  echo "Agent failed to start:" >&2
  journalctl -u "$SERVICE" -n 30 --no-pager >&2
  exit 1
fi

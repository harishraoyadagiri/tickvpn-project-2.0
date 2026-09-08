#!/usr/bin/env bash
#
# Builds a real WireGuard tunnel on this machine so tests/live-tunnel.ts has
# something genuine to measure: a server interface (wg0) in the root namespace
# and a client (wg1) in a network namespace, talking over a veth pair.
#
# This exists because "the customer connected and we billed them" is the one
# claim in this product that cannot be verified with a mock. The metering path
# reads real handshake timestamps and real byte counters out of `wg show dump`,
# so the test needs a real interface producing them.
#
#   sudo backend/tests/setup-local-wireguard.sh          # create
#   sudo backend/tests/setup-local-wireguard.sh teardown # remove
#
# Requires root (network namespaces and interfaces) plus wireguard-tools. Uses
# the kernel module when present and falls back to userspace wireguard-go,
# which is what makes this work inside containers and CI runners.
set -euo pipefail

KEY_DIR="${TICKVPN_WG_KEY_DIR:-/tmp/tickvpn-wg}"
NS="${TICKVPN_WG_NS:-tickvpn-cli}"
SERVER_IF="${TICKVPN_WG_IF:-wg0}"
CLIENT_IF="wg1"
SERVER_TUNNEL_IP="10.8.0.1/24"
UNDERLAY_SERVER="172.31.0.1/24"
UNDERLAY_CLIENT="172.31.0.2/24"
LISTEN_PORT=51820

export PATH="$PATH:/usr/sbin:/sbin"

log() { printf '  %s\n' "$*"; }

teardown() {
  log "removing namespace, interfaces and keys"
  ip netns pids "$NS" 2>/dev/null | xargs -r kill 2>/dev/null || true
  ip netns del "$NS" 2>/dev/null || true
  ip link del veth0 2>/dev/null || true
  ip link del "$SERVER_IF" 2>/dev/null || true
  pkill -f "wireguard-go $SERVER_IF" 2>/dev/null || true
  rm -rf "$KEY_DIR"
  log "done"
}

if [[ "${1:-}" == "teardown" ]]; then
  teardown
  exit 0
fi

if [[ "$(id -u)" != "0" ]]; then
  echo "This script needs root — it creates network interfaces and a namespace." >&2
  exit 1
fi
for tool in wg ip; do
  command -v "$tool" >/dev/null || { echo "Missing '$tool'. Install wireguard-tools and iproute2." >&2; exit 1; }
done

teardown >/dev/null 2>&1 || true
mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"
umask 077

log "generating keypairs in $KEY_DIR"
wg genkey > "$KEY_DIR/server.key"
wg pubkey < "$KEY_DIR/server.key" > "$KEY_DIR/server.pub"
wg genkey > "$KEY_DIR/client.key"
wg pubkey < "$KEY_DIR/client.key" > "$KEY_DIR/client.pub"

# Kernel WireGuard where available, userspace otherwise. Containers and some CI
# runners have no wireguard module, and wireguard-go is behaviourally identical
# for what these tests measure.
create_wg_interface() {
  local ifname="$1"; shift
  local netns="${1:-}"
  if [[ -n "$netns" ]]; then
    if ip netns exec "$netns" ip link add dev "$ifname" type wireguard 2>/dev/null; then
      log "$ifname: kernel wireguard (in $netns)"
    else
      command -v wireguard-go >/dev/null || { echo "No wireguard module and no wireguard-go." >&2; exit 1; }
      ip netns exec "$netns" wireguard-go "$ifname" >/dev/null 2>&1
      log "$ifname: userspace wireguard-go (in $netns)"
    fi
  else
    if ip link add dev "$ifname" type wireguard 2>/dev/null; then
      log "$ifname: kernel wireguard"
    else
      command -v wireguard-go >/dev/null || { echo "No wireguard module and no wireguard-go." >&2; exit 1; }
      wireguard-go "$ifname" >/dev/null 2>&1
      log "$ifname: userspace wireguard-go"
    fi
  fi
}

log "creating namespace $NS and the veth underlay"
ip netns add "$NS"
ip link add veth0 type veth peer name veth1
ip link set veth1 netns "$NS"
ip addr add "$UNDERLAY_SERVER" dev veth0
ip link set veth0 up
ip netns exec "$NS" ip addr add "$UNDERLAY_CLIENT" dev veth1
ip netns exec "$NS" ip link set veth1 up
ip netns exec "$NS" ip link set lo up

create_wg_interface "$SERVER_IF"
wg set "$SERVER_IF" private-key "$KEY_DIR/server.key" listen-port "$LISTEN_PORT"
ip addr add "$SERVER_TUNNEL_IP" dev "$SERVER_IF"
ip link set "$SERVER_IF" up

create_wg_interface "$CLIENT_IF" "$NS"
ip netns exec "$NS" wg set "$CLIENT_IF" private-key "$KEY_DIR/client.key"
ip netns exec "$NS" wg set "$CLIENT_IF" peer "$(cat "$KEY_DIR/server.pub")" \
  endpoint "${UNDERLAY_SERVER%/*}:$LISTEN_PORT" allowed-ips 10.8.0.0/24
ip netns exec "$NS" ip link set "$CLIENT_IF" up

# Deliberately no PersistentKeepalive, matching the configs the API issues:
# keepalive manufactures handshakes with no user traffic, which would make
# handshake freshness useless as a "is this peer actually in use" signal (D2).

cat <<EOF

  Ready.
    server interface : $SERVER_IF  ($SERVER_TUNNEL_IP, port $LISTEN_PORT)
    client namespace : $NS  (interface $CLIENT_IF)
    keys             : $KEY_DIR

  The client peer is NOT yet on the server — that is the point. The node agent
  installs it once the control plane authorises the device.

  Run the end-to-end test with:
    cd backend && npm run test:tunnel
EOF

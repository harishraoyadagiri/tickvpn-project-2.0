#!/usr/bin/env python3
"""
TickVPN node agent.

Runs on each WireGuard droplet under systemd. Two loops, straight from
Technical Decisions D2:

  report loop     every 10s  — `wg show <iface> dump` -> POST to the control plane
  reconcile loop  every 15s  — GET the authoritative peer set -> make wg0 match

Two things worth noticing about the shape of this.

First, the agent is **outbound only**. It listens on nothing. The previous
version ran an HTTP server on 0.0.0.0:8787 that accepted a static shared secret
in cleartext over the public internet — a long-lived credential able to add and
remove peers, broadcast on every call. There is now no inbound port to attack,
no secret in flight, and nothing to firewall.

Second, the agent is the **only writer to wg0**. Peer membership is decided by
one query in the control plane (authorizationService) and applied here. That is
what makes a zero balance actually disconnect somebody: when a customer runs
out they leave the allowed set, and within one reconcile pass the peer is gone
from the interface.
"""

import json
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

API_URL = os.environ.get("TICKVPN_API_URL", "").rstrip("/")
NODE_ID = os.environ.get("TICKVPN_NODE_ID", "")
NODE_TOKEN = os.environ.get("TICKVPN_NODE_TOKEN", "")
INTERFACE = os.environ.get("TICKVPN_WG_INTERFACE", "wg0")

REPORT_INTERVAL = int(os.environ.get("TICKVPN_REPORT_INTERVAL", "10"))
RECONCILE_INTERVAL = int(os.environ.get("TICKVPN_RECONCILE_INTERVAL", "15"))
HTTP_TIMEOUT = int(os.environ.get("TICKVPN_HTTP_TIMEOUT", "10"))

_stop = threading.Event()


def log(msg):
    print("[agent] " + msg, flush=True)


def wg(*args):
    """Run a wg command with an argument list — never a shell string."""
    result = subprocess.run(
        ["wg"] + list(args), capture_output=True, text=True, check=True, timeout=15
    )
    return result.stdout


def read_peers():
    """
    Parse `wg show <iface> dump`.

    Line 1 is the interface (private key, public key, listen port, fwmark) and
    is skipped — a private key never leaves the node. Every later line is a
    peer: public key, preshared key, endpoint, allowed ips, latest handshake
    (unix seconds, 0 = never), rx bytes, tx bytes, keepalive.

    Byte counters are absolute and reset to zero whenever a peer is re-added or
    the node reboots, which the reconcile loop does routinely. We report the
    absolute value and let the control plane detect the reset (D5), so the agent
    holds no state of its own and a restart loses nothing.
    """
    peers = []
    for line in wg("show", INTERFACE, "dump").splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) < 8:
            continue
        peers.append(
            {
                "publicKey": parts[0],
                "latestHandshake": int(parts[4] or 0),
                "rxBytes": int(parts[5] or 0),
                "txBytes": int(parts[6] or 0),
            }
        )
    return peers


def api(path, payload=None):
    url = API_URL + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data else "GET")
    req.add_header("Authorization", "Bearer " + NODE_TOKEN)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return json.loads(resp.read() or b"{}")


def reconcile_once():
    """Make the interface match the control plane's peer set exactly."""
    allowed = api("/api/internal/nodes/" + NODE_ID + "/peers").get("peers", [])
    wanted = {p["publicKey"]: p["allowedIp"] for p in allowed}
    present = set(p["publicKey"] for p in read_peers())

    added = removed = 0
    for key, allowed_ip in wanted.items():
        if key not in present:
            wg("set", INTERFACE, "peer", key, "allowed-ips", allowed_ip)
            added += 1

    for key in present - set(wanted):
        wg("set", INTERFACE, "peer", key, "remove")
        removed += 1

    if added or removed:
        log("reconciled: +%d peer(s), -%d peer(s)" % (added, removed))
    return added, removed


def report_loop():
    while not _stop.is_set():
        try:
            result = api(
                "/api/internal/nodes/" + NODE_ID + "/report", {"peers": read_peers()}
            )
            dropped = result.get("dropped") or []
            if dropped:
                log("%d peer(s) ran out of balance; reconciling early" % len(dropped))
                reconcile_once()
        except urllib.error.HTTPError as e:
            log("report rejected: HTTP %s" % e.code)
        except Exception as e:
            log("report failed: %s" % e)
        _stop.wait(REPORT_INTERVAL)


def reconcile_loop():
    while not _stop.is_set():
        try:
            reconcile_once()
        except urllib.error.HTTPError as e:
            log("reconcile rejected: HTTP %s" % e.code)
        except Exception as e:
            log("reconcile failed: %s" % e)
        _stop.wait(RECONCILE_INTERVAL)


def main():
    missing = [
        name
        for name, value in (
            ("TICKVPN_API_URL", API_URL),
            ("TICKVPN_NODE_ID", NODE_ID),
            ("TICKVPN_NODE_TOKEN", NODE_TOKEN),
        )
        if not value
    ]
    if missing:
        log("refusing to start, missing: " + ", ".join(missing))
        return 1

    local = "localhost" in API_URL or "127.0.0.1" in API_URL
    if not API_URL.startswith("https://") and not local:
        log("refusing to start: TICKVPN_API_URL must be https outside local testing")
        return 1

    try:
        wg("show", INTERFACE)
    except Exception as e:
        log("cannot read interface %s: %s" % (INTERFACE, e))
        return 1

    log("starting for node %s on %s -> %s" % (NODE_ID, INTERFACE, API_URL))

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: _stop.set())

    for target in (report_loop, reconcile_loop):
        threading.Thread(target=target, daemon=True).start()

    while not _stop.is_set():
        time.sleep(1)
    log("stopping")
    return 0


if __name__ == "__main__":
    sys.exit(main())

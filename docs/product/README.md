# Product documents

- **`TickVPN_Vision_and_PRD.docx`** — the product vision and MVP requirements.
  Scanned before publishing: no infrastructure details, keys or addresses.

## Deliberately not in this repository

`TickVPN_Session_Summary.docx` — an internal build log from 30 Aug 2026. It is
kept privately because it contains live infrastructure detail: a droplet name
and public IP, a WireGuard server public key, the ngrok tunnel setup, and an
architecture diagram naming personal devices. The document says so itself —
section 8 is headed "Reference — Keys, IPs, and Links" and opens with "Treat
this page as sensitive."

None of that belongs in a public repository. If any of those resources are
still live, treat the IP and node key as known and rotate the node when
convenient — a public IP running WireGuard is not itself a vulnerability, but
there is no reason to publish a target.

The architecture it described is also superseded: it shows the node agent
listening on port 8787 with shared-secret auth, which was replaced by an
outbound-only agent with per-node bearer tokens. See
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the current design.

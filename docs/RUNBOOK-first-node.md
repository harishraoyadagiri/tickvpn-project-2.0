# Runbook — bringing up a VPN node

From a bare droplet to a device being billed for real traffic. Written to be
run more than once: the second and third nodes follow the same steps with a
different region code.

Roughly 30 minutes the first time.

**Before you start** you need a deployed API reachable over HTTPS, and shell
access to something holding `DATABASE_URL` (your laptop is fine — DigitalOcean's
managed Postgres accepts external connections).

Throughout, `<CODE>` is the region code in upper case: `US`, `EU` or `ASIA`.

---

## 1. Create the droplet

Smallest shared-CPU droplet, Ubuntu 24.04, SSH key only. Note its public IP.

```bash
ssh root@<droplet-ip>
apt-get update && apt-get install -y wireguard-tools nftables python3
```

## 2. Bring up `wg0`

```bash
umask 077
wg genkey | tee /etc/wireguard/private.key | wg pubkey > /etc/wireguard/public.key

cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
Address = 10.8.1.1/24
ListenPort = 51820
PostUp   = nft add table ip tickvpn; nft add chain ip tickvpn post { type nat hook postrouting priority 100 \\; }; nft add rule ip tickvpn post oifname "$(ip route show default | awk '{print $5; exit}')" masquerade
PostDown = nft delete table ip tickvpn
EOF

# The private key goes in by reference, never pasted into a file you might share.
sed -i "s|^\\[Interface\\]|[Interface]\\nPrivateKey = $(cat /etc/wireguard/private.key)|" /etc/wireguard/wg0.conf

sysctl -w net.ipv4.ip_forward=1
echo "net.ipv4.ip_forward=1" > /etc/sysctl.d/99-tickvpn.conf

systemctl enable --now wg-quick@wg0
wg show wg0
```

> **The `Address` must match the region's `subnetBase`.** The seed assigns
> `10.8.1.0/24` to `us`, `10.8.2.0/24` to `eu`, `10.8.3.0/24` to `asia`, and the
> control plane allocates peer addresses inside that range. A mismatch produces
> peers the node will install and never route.

Then, on the DigitalOcean firewall for this droplet: inbound **51820/udp** from
anywhere, **22/tcp** from your IP only. Nothing else.

Take the node's public key — you need it in the next step:

```bash
cat /etc/wireguard/public.key
```

## 3. Register it in the control plane

Run this wherever `DATABASE_URL` points at your database:

```bash
NODE_IP_<CODE>=<droplet-ip> \
NODE_PUBKEY_<CODE>=<contents of public.key> \
  npm --prefix backend run seed
```

The seed prints what it did. You are looking for exactly this:

```
Nodes:
  us-node-1      United States   HEALTHY  selectable     registered from NODE_IP_US / NODE_PUBKEY_US
  eu-node-1      Europe          OFFLINE  NOT selectable existing registration, left as it was
  asia-node-1    Asia            OFFLINE  NOT selectable existing registration, left as it was
```

A region stays `OFFLINE` until you register a real droplet for it, and that is
deliberate. A node with no machine behind it would otherwise hand out a
WireGuard config naming a public key nobody holds: it downloads cleanly, the QR
scans cleanly, and the tunnel silently never comes up. `OFFLINE` makes that
region refuse with `no_capacity`, which is at least true.

The seed only ever promotes. Re-running it without these variables will not take
a live node out of service.

## 4. Mint the agent token

```bash
npm --prefix backend run node:token -- --list       # confirm what is registered
npm --prefix backend run node:token -- us-node-1    # mint
```

Shown once, stored only as a SHA-256. There is deliberately no production HTTP
route that does this — a credential controlling a node's peer set has no
business being reachable from the internet.

Lost it? Re-mint. That rotates: the previous token stops working immediately,
which is also how you retire a node you no longer trust.

## 5. Install the agent

```bash
scp -r backend/node-agent root@<droplet-ip>:/opt/tickvpn-agent
ssh root@<droplet-ip>

TICKVPN_API_URL=https://<your-api-host> \
TICKVPN_NODE_ID=<from step 4> \
TICKVPN_NODE_TOKEN=<from step 4> \
  bash /opt/tickvpn-agent/install-agent.sh

systemctl status tickvpn-agent
journalctl -u tickvpn-agent -f
```

Within ten seconds you should see the first report go out. The installer also
blocks outbound 25, 465 and 587, so a customer cannot use your node to send
spam and get the droplet blacklisted.

The agent makes only outbound calls. It listens on nothing, so there is no
inbound port to protect beyond WireGuard's own.

## 6. Verify — the part that actually matters

Everything above can look right while the tunnel does nothing. These four checks
are the ones worth doing.

**a. The node is talking to the control plane**

```bash
npm --prefix backend run node:token -- --list
```

`last seen` should be within the last ten seconds. `never reported` means the
agent cannot reach the API — check `journalctl -u tickvpn-agent` for a 403
(wrong token) or a connection error (wrong URL, or TLS).

**b. A device can connect**

Sign in on your phone, credit yourself a Day Pass, add a device in this region,
and scan the QR code with the WireGuard app.

**c. Traffic is actually going through the droplet**

```
On the phone, with the tunnel on, open:  https://ifconfig.me
```

It must return the **droplet's** IP. If it returns your home or carrier IP, the
tunnel is not carrying traffic — check `AllowedIPs = 0.0.0.0/0, ::/0` in the
config and that the handshake shows up in `wg show wg0`.

**d. Minutes come off, and zero really disconnects**

```bash
ssh root@<droplet-ip> watch -n2 wg show wg0
```

Browse for a couple of minutes on the phone, then watch the wallet fall on the
dashboard. Then let it reach zero. Within one reconcile pass — about 15 seconds
— the peer should vanish from `wg show wg0` and the phone should lose its
connection. Top up and it comes back with no re-provisioning.

That last check is the product. Everything else is plumbing.

---

## When something is wrong

| Symptom | Almost always |
|---|---|
| Region missing from the menu, or `no_capacity` | The node is `OFFLINE` — step 3 was skipped or the `NODE_*` variables were misspelled |
| Agent logs 403 on every call | Token mismatch. Re-mint (step 4) and restart the service with the new value |
| Agent logs connection errors | `TICKVPN_API_URL` wrong, or missing `https://`. The installer refuses plaintext |
| Config downloads, no handshake ever | Node's `publicKey` in the database is not the key in `/etc/wireguard/public.key`. Re-run step 3 |
| Handshake works, no internet | IP forwarding or the masquerade rule. Check `sysctl net.ipv4.ip_forward` and `nft list table ip tickvpn` |
| Peer address outside the tunnel range | `Address` on `wg0` doesn't match the region's `subnetBase` |
| Minutes never move | The report loop is running but not qualifying: usage needs a handshake under 180s **and** 5 MB moved. A phone on the lock screen deliberately costs nothing |
| Minutes move while nothing is connected | Should be impossible. Check for a second agent still running against the same node |

## Retiring a node

```bash
# 1. stop new peers landing on it
psql "$DATABASE_URL" -c "UPDATE \"VPNNode\" SET status='DRAINING' WHERE hostname='us-node-1'"

# 2. existing customers move when they next re-provision; when the peer count
#    reaches zero, cut the credential so the agent cannot act again
npm --prefix backend run node:token -- us-node-1   # rotating orphans the old token

# 3. destroy the droplet
```

Rotating the token is what actually revokes a node. Deleting the droplet without
it leaves a working credential in whatever shell history it was pasted into.

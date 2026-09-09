"use client";

import { useEffect, useState } from "react";
import { api, ApiError, type Device, type ProvisionResult, type Region } from "@/lib/api";
import { buildConfigFile, derivePublicKey, generateKeyPair, getPrivateKey, storePrivateKey } from "@/lib/wireguard";
import { formatDateTime } from "@/lib/format";
import { ConfigQR } from "@/components/ConfigQR";

const MAX_DEVICES = 3;

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [regions, setRegions] = useState<Region[]>([]);
  const [adding, setAdding] = useState(false);
  const [newDeviceName, setNewDeviceName] = useState("");
  const [newRegion, setNewRegion] = useState("us");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastConfig, setLastConfig] = useState<{ deviceId: string; text: string } | null>(null);

  function reload() {
    api
      .get<Device[]>("/devices")
      .then(setDevices)
      .catch(() => setDevices([]));
  }

  useEffect(() => {
    reload();
    api
      .get<Region[]>("/regions")
      .then((r) => {
        setRegions(r);
        if (r[0]) setNewRegion(r[0].code);
      })
      .catch(() => {});
  }, []);

  const activeCount = devices?.filter((d) => d.status === "ACTIVE").length ?? 0;

  async function addDevice(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const keys = generateKeyPair();
      const result = await api.post<ProvisionResult>("/devices", {
        publicKey: keys.publicKey,
        name: newDeviceName || "New device",
        regionCode: newRegion,
      });
      storePrivateKey(result.device.id, keys.privateKey);
      setLastConfig({
        deviceId: result.device.id,
        text: buildConfigFile({
          privateKey: keys.privateKey,
          internalIp: result.config.internalIp,
          dns: result.config.dns,
          serverPublicKey: result.config.serverPublicKey,
          serverEndpoint: result.config.serverEndpoint,
          allowedIps: result.config.allowedIps,
        }),
      });
      setNewDeviceName("");
      setAdding(false);
      reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    try {
      await api.delete(`/devices/${id}`);
      reload();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function viewConfig(device: Device) {
    const privateKey = getPrivateKey(device.id);
    if (!privateKey) {
      setError(
        "This device's private key isn't in this browser — it was generated on whichever browser added it and never leaves that device. Revoke and re-add it here to get a new config."
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // provisionDevice treats a call with the same public key (owned by this
      // user) as an update, not a new device, so this just re-fetches the
      // peer config rather than creating anything.
      const publicKey = derivePublicKey(privateKey);
      const result = await api.post<ProvisionResult>("/vpn/provision", {
        devicePublicKey: publicKey,
        regionCode: device.node?.region.code ?? "us",
        deviceName: device.name,
      });
      setLastConfig({
        deviceId: device.id,
        text: buildConfigFile({
          privateKey,
          internalIp: result.config.internalIp,
          dns: result.config.dns,
          serverPublicKey: result.config.serverPublicKey,
          serverEndpoint: result.config.serverEndpoint,
          allowedIps: result.config.allowedIps,
        }),
      });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="dash-head">
        <div>
          <h1>Devices</h1>
          <div className="sub">Up to {MAX_DEVICES} active devices per account.</div>
        </div>
      </div>

      {error && <div className="warn-box">{error}</div>}

      {lastConfig && (
        <div className="card">
          <div className="card-head">
            <h3>Your new device&apos;s WireGuard config</h3>
            <button className="link-btn" onClick={() => setLastConfig(null)}>
              Dismiss
            </button>
          </div>
          <div className="warn-box">
            This is shown once. The private key never touches our servers — it was generated in
            your browser and is saved only in this browser&apos;s local storage. Import this into
            a WireGuard client to actually connect.
          </div>
          <ConfigQR text={lastConfig.text} />
          <div className="config-box">{lastConfig.text}</div>
          <div style={{ display: "flex", gap: 10 }}>
            <button className="btn btn-outline btn-sm" onClick={() => navigator.clipboard.writeText(lastConfig.text)}>
              Copy config
            </button>
            <button className="btn btn-outline btn-sm" onClick={() => downloadConfig(lastConfig.text)}>
              Download .conf
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>Your devices</h3>
          <span className="link-btn">
            {activeCount} of {MAX_DEVICES}
          </span>
        </div>

        {devices === null && <div style={{ color: "var(--muted)", fontSize: 13 }}>Loading…</div>}

        {devices?.map((d) => (
          <div className="device-row" key={d.id}>
            <div className="dev-left">
              <div className="dev-icon">💻</div>
              <div>
                <div className="dev-name">{d.name}</div>
                <div className="dev-meta">
                  {d.status === "REVOKED"
                    ? "Revoked"
                    : d.node
                      ? `${d.node.region.name} · ${d.lastHandshakeAt ? "handshake " + formatDateTime(d.lastHandshakeAt) : "never connected"}`
                      : "Provisioning…"}
                </div>
              </div>
            </div>
            <div className="dev-actions">
              {d.status === "ACTIVE" && (
                <>
                  <span className="status-pill">Active</span>
                  <button className="link-btn" disabled={busy} onClick={() => viewConfig(d)}>
                    View config
                  </button>
                  <button className="revoke-btn" disabled={busy} onClick={() => revoke(d.id)}>
                    Revoke
                  </button>
                </>
              )}
            </div>
          </div>
        ))}

        {!adding ? (
          <button className="add-device-row" onClick={() => setAdding(true)} disabled={activeCount >= MAX_DEVICES}>
            + Add a device ({activeCount} of {MAX_DEVICES} used)
          </button>
        ) : (
          <form onSubmit={addDevice} style={{ paddingTop: 14, borderTop: "1px dashed var(--line)", marginTop: 4 }}>
            <div className="field">
              <label htmlFor="dname">Device name</label>
              <input
                id="dname"
                value={newDeviceName}
                onChange={(e) => setNewDeviceName(e.target.value)}
                placeholder="e.g. MacBook Pro"
                autoFocus
              />
            </div>
            <div className="field">
              <label>Region</label>
              <div className="region-pills">
                {regions.map((r) => (
                  <button
                    type="button"
                    key={r.code}
                    className={`region-pill${newRegion === r.code ? " active" : ""}`}
                    onClick={() => setNewRegion(r.code)}
                  >
                    {r.name}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn btn-primary btn-sm" disabled={busy}>
                {busy ? <span className="spinner" /> : "Generate & add"}
              </button>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function downloadConfig(text: string) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "tickvpn.conf";
  a.click();
  URL.revokeObjectURL(url);
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === "device_limit_reached") return `You've hit the ${MAX_DEVICES}-device limit — revoke one first.`;
    if (err.code === "public_key_in_use") return "That key is already registered to another account.";
    return err.code.replace(/_/g, " ");
  }
  return "Something went wrong.";
}

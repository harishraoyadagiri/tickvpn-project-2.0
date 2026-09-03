import nacl from "tweetnacl";

/**
 * Client-side WireGuard keypair generation.
 *
 * The private key is generated in the browser and never sent to the server —
 * CLAUDE.md is explicit that client private keys must never reach the API.
 * Only the public key goes in the POST /devices call; the private key lives
 * in localStorage on this device only, exactly like a real WireGuard client.
 *
 * tweetnacl's box keypair is Curve25519 (X25519), the same curve WireGuard
 * uses, so the raw 32-byte keys are directly usable as WireGuard keys once
 * base64-encoded.
 */
export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

export function generateKeyPair(): KeyPair {
  const pair = nacl.box.keyPair();
  return {
    publicKey: toBase64(pair.publicKey),
    privateKey: toBase64(pair.secretKey),
  };
}

/** Re-derive the public key from a stored private key — lets us re-fetch a device's config later without storing the public key separately. */
export function derivePublicKey(privateKeyBase64: string): string {
  const secretKey = fromBase64(privateKeyBase64);
  const pair = nacl.box.keyPair.fromSecretKey(secretKey);
  return toBase64(pair.publicKey);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const STORAGE_PREFIX = "tickvpn:device-key:";

/** Private keys are per-device and per-browser — never synced, never sent anywhere. */
export function storePrivateKey(deviceId: string, privateKey: string) {
  try {
    localStorage.setItem(STORAGE_PREFIX + deviceId, privateKey);
  } catch {
    // Storage unavailable (private browsing, quota) — the config is still
    // shown once at creation time, just not recoverable later.
  }
}

export function getPrivateKey(deviceId: string): string | null {
  try {
    return localStorage.getItem(STORAGE_PREFIX + deviceId);
  } catch {
    return null;
  }
}

export function buildConfigFile(params: {
  privateKey: string;
  internalIp: string;
  dns: string;
  serverPublicKey: string;
  serverEndpoint: string;
  allowedIps: string;
}): string {
  return `[Interface]
PrivateKey = ${params.privateKey}
Address = ${params.internalIp}
DNS = ${params.dns}

[Peer]
PublicKey = ${params.serverPublicKey}
Endpoint = ${params.serverEndpoint}
AllowedIPs = ${params.allowedIps}
`;
}

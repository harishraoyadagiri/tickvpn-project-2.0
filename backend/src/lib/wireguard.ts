/**
 * A WireGuard public key is 32 raw bytes, base64-encoded: 42 base64 characters,
 * then one character from the restricted final-quantum set, then '='. Anything
 * else is not a key, and letting one through means writing junk into
 * `wg set wg0 peer ...` on a real node.
 */
const WG_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw]=$/;

export function isValidWireGuardKey(key: unknown): key is string {
  return typeof key === "string" && WG_KEY.test(key);
}

/**
 * Device names are shown in the dashboard and written to logs. Strip control
 * characters, collapse whitespace, and bound the length.
 */
export function normaliseDeviceName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0 || cleaned.length > 64) return null;
  return cleaned;
}

/**
 * Allocate the next free host address inside a node's subnet.
 *
 * Addresses are scoped per node (the old code counted every ACTIVE device
 * globally, so the second node's first peer collided with the first node's),
 * and freed addresses are reused rather than leaking the range.
 *
 * `.1` is the node itself and `.2`–`.9` are reserved for peers created by hand
 * during node bring-up, so allocation starts at `.10`.
 */
export function nextFreeAddress(subnetBase: string, taken: string[]): string {
  const used = new Set(taken.map((cidr) => cidr.split("/")[0]));
  for (let host = 10; host <= 254; host++) {
    const candidate = `${subnetBase}.${host}`;
    if (!used.has(candidate)) return `${candidate}/32`;
  }
  throw new Error(`No free addresses left in ${subnetBase}.0/24`);
}

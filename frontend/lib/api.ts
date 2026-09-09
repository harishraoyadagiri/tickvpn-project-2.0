const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  if (res.status === 204) return undefined as T;

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const code = body?.error ?? `http_${res.status}`;
    throw new ApiError(res.status, code, body?.message);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: "POST", body: data !== undefined ? JSON.stringify(data) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

// ---- Response shapes, matching backend/src/routes/*.ts and services/*.ts ----

export interface Wallet {
  minuteBalance: number;
  daysRemaining: number;
}

export interface LedgerEntry {
  id: string;
  type: string;
  amount: number;
  unit: string;
  balanceBefore: number;
  balanceAfter: number;
  referenceType: string | null;
  createdAt: string;
}

export interface ConnectionStatus {
  minuteBalance: number;
  daysRemaining: number;
  connected: boolean;
  session: {
    id: string;
    startedAt: string;
    minutesBilled: number;
    lastSeenAt: string;
    bytesUsed: string | number;
  } | null;
  devices: {
    id: string;
    name: string;
    lastHandshakeAt: string | null;
    nodeId: string | null;
    internalIp: string | null;
  }[];
}

export interface Device {
  id: string;
  name: string;
  status: "ACTIVE" | "REVOKED";
  internalIp: string | null;
  lastHandshakeAt: string | null;
  lastConnectedAt: string | null;
  createdAt: string;
  node: { hostname: string; region: { code: string; name: string } } | null;
}

export interface ProvisionResult {
  device: { id: string; name: string; status: string; internalIp: string; createdAt: string };
  region: string;
  readyInSeconds: number;
  config: {
    serverPublicKey: string;
    serverEndpoint: string;
    internalIp: string;
    dns: string;
    allowedIps: string;
  };
}

export interface Region {
  id: string;
  code: string;
  name: string;
  country: string;
  city: string;
  active: boolean;
  sortOrder: number;
}

export interface Product {
  id: string;
  name: string;
  kind: string;
  durationMinutes: number;
  priceCents: number;
  currency: string;
  active: boolean;
  sortOrder: number;
}

export interface Purchase {
  id: string;
  status: "PENDING" | "PAID" | "FAILED" | "REFUNDED";
  amountCents: number;
  productName: string;
  minutes: number;
  createdAt: string;
}

export interface PricingModel {
  baseRate: number;
  decayExp: number;
  minutesPerDayPass: number;
  tiers: { name: string; minutes: number; priceCents: number }[];
  quoteCents?: number;
}

export interface TrendingPayload {
  region: string;
  regionLabel: string;
  asOf: string;
  apps: { rank: number; name: string; artist: string; artworkUrl: string; url: string }[];
  appsSource: "live" | "sample";
  netflixMovies: { rank: number; title: string }[];
  netflixTV: { rank: number; title: string }[];
  netflixSource: "live" | "sample";
  netflixWeek: string | null;
}

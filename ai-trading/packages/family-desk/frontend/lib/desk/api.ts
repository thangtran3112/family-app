import { deskFetch } from "../api/client.ts";

// Shared plumbing for the per-area loaders in lib/desk/*.ts (02m §c4): one function per endpoint,
// each taking an optional `{ signal, client }` so tests can inject a client built on a fake fetch.
export type DeskClient = typeof deskFetch;
export type RequestOptions = { signal?: AbortSignal; client?: DeskClient };

const BASE = "/api/desk";

type QueryValue = string | number | boolean | null | undefined;

/** `?a=1&b=x`, skipping unset values; empty when nothing is set. */
export function query(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export const deskPath = (path: string, params: Record<string, QueryValue> = {}) => `${BASE}${path}${query(params)}`;

export const symbolPath = (symbol: string) => encodeURIComponent(symbol);

export function jsonInit(method: "POST" | "PUT" | "PATCH", body: unknown, options: RequestOptions = {}): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: options.signal };
}

export const readInit = (options: RequestOptions = {}): RequestInit => ({ signal: options.signal });
export const clientOf = (options: RequestOptions = {}): DeskClient => options.client ?? deskFetch;

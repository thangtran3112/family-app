import type { ZodType } from "zod";
import { hubLoginUrl } from "../auth.ts";

export type DeskApiErrorKind = "http" | "unauthenticated" | "malformed";

export class DeskApiError extends Error {
  readonly kind: DeskApiErrorKind;
  readonly status?: number;

  constructor(
    kind: DeskApiErrorKind,
    status?: number,
  ) {
    super(kind === "http" ? `Desk API request failed (${status})` : `Desk API ${kind} error`);
    this.name = "DeskApiError";
    this.kind = kind;
    this.status = status;
  }
}

type DeskLocation = Pick<Location, "href">;

export function createDeskApiClient(
  fetchImplementation: typeof fetch = fetch,
  getLocation: () => DeskLocation = () => window.location,
) {
  let redirected = false;

  return async function deskFetch<T>(path: string, schema: ZodType<T>, init?: RequestInit): Promise<T> {
    if (!path.startsWith("/api/desk/")) {
      throw new DeskApiError("malformed");
    }

    const headers = new Headers(init?.headers);
    headers.delete("Cf-Access-Authenticated-User-Email");

    const response = await fetchImplementation(path, {
      ...init,
      headers,
      credentials: "include",
      cache: "no-store",
    });

    if (response.status === 401) {
      if (!redirected) {
        redirected = true;
        const location = getLocation();
        location.href = hubLoginUrl(location.href);
      }
      throw new DeskApiError("unauthenticated", response.status);
    }
    if (!response.ok) throw new DeskApiError("http", response.status);

    try {
      return schema.parse(await response.json());
    } catch {
      throw new DeskApiError("malformed", response.status);
    }
  };
}

const browserDeskFetch = createDeskApiClient();

export function deskFetch<T>(path: string, schema: ZodType<T>, init?: RequestInit): Promise<T> {
  return browserDeskFetch(path, schema, init);
}

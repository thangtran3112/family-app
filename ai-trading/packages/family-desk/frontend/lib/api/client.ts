import type { ZodType } from "zod";
import { hubLoginUrl } from "../auth.ts";

export type DeskApiErrorKind = "http" | "unauthenticated" | "malformed";

export type DeskApiProblem = { path: string; message: string };
export type DeskApiErrorBody = { detail?: string; problems?: DeskApiProblem[] };

export class DeskApiError extends Error {
  readonly kind: DeskApiErrorKind;
  readonly status?: number;
  /** Plain message from a `{"detail": "…"}` body (409 and similar); safe to show. */
  readonly detail?: string;
  /** Spec problems from a 422 `{"detail": {"problems": […]}}` body. */
  readonly problems: DeskApiProblem[];

  constructor(
    kind: DeskApiErrorKind,
    status?: number,
    body: DeskApiErrorBody = {},
  ) {
    super(kind === "http" ? `Desk API request failed (${status})` : `Desk API ${kind} error`);
    this.name = "DeskApiError";
    this.kind = kind;
    this.status = status;
    this.detail = body.detail;
    this.problems = body.problems ?? [];
  }
}

/** Reads the FastAPI error body (02m §a1): a string `detail`, or `detail.problems` with dotted paths. */
export function parseErrorBody(value: unknown): DeskApiErrorBody {
  if (typeof value !== "object" || value === null) return {};
  const detail = (value as { detail?: unknown }).detail;
  if (typeof detail === "string") return { detail };
  if (typeof detail !== "object" || detail === null) return {};
  const problems = (detail as { problems?: unknown }).problems;
  if (!Array.isArray(problems)) return {};
  return {
    problems: problems.flatMap((item): DeskApiProblem[] => {
      if (typeof item !== "object" || item === null) return [];
      const { path, message } = item as { path?: unknown; message?: unknown };
      return typeof path === "string" && typeof message === "string" ? [{ path, message }] : [];
    }),
  };
}

type DeskLocation = Pick<Location, "href">;

export function createDeskApiClient(
  fetchImplementation: typeof fetch = fetch,
  getLocation: () => DeskLocation = () => window.location,
) {
  let redirected = false;

  return async function deskFetch<T>(path: string, schema: ZodType<T>, init?: RequestInit): Promise<T> {
    if (!path.startsWith("/api/desk/") || path.includes("\\")) {
      throw new DeskApiError("malformed");
    }

    let origin: string;
    let target: URL;
    try {
      origin = new URL(getLocation().href).origin;
      target = new URL(path, origin);
    } catch {
      throw new DeskApiError("malformed");
    }
    if (target.origin !== origin || !target.pathname.startsWith("/api/desk/")) {
      throw new DeskApiError("malformed");
    }

    const headers = new Headers(init?.headers);
    headers.delete("Cf-Access-Authenticated-User-Email");

    const response = await fetchImplementation(target, {
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
    if (!response.ok) {
      let body: DeskApiErrorBody = {};
      try {
        body = parseErrorBody(await response.json());
      } catch {
        // Not JSON (or an empty body): the status alone is the error.
      }
      throw new DeskApiError("http", response.status, body);
    }

    try {
      return schema.parse(response.status === 204 ? undefined : await response.json());
    } catch {
      throw new DeskApiError("malformed", response.status);
    }
  };
}

const browserDeskFetch = createDeskApiClient();

export function deskFetch<T>(path: string, schema: ZodType<T>, init?: RequestInit): Promise<T> {
  return browserDeskFetch(path, schema, init);
}

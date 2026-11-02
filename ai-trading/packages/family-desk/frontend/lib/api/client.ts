import type { ZodType } from "zod";
import { hubLoginUrl } from "../auth.ts";

export type DeskApiErrorKind = "http" | "unauthenticated" | "malformed" | "timeout";

/**
 * A read (GET) that has no answer after this long is a failure, not a wait: a screen on a skeleton shows an error with Retry instead.
 * Writes are not bounded here: Skip day and a day open legitimately run for a minute or more, and the gateway cuts them (see `patience.ts`).
 */
export const READ_TIMEOUT_MS = 30_000;

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

/** The caller's signal joined with a timer: aborts when either fires. `timedOut()` tells which, and `done()` clears the timer. */
function boundedSignal(caller: AbortSignal | null | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const forward = () => controller.abort(caller?.reason);
  if (caller?.aborted) forward();
  else caller?.addEventListener("abort", forward, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    done: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", forward);
    },
  };
}

export function createDeskApiClient(
  fetchImplementation: typeof fetch = fetch,
  getLocation: () => DeskLocation = () => window.location,
  readTimeoutMs: number = READ_TIMEOUT_MS,
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

    const bound = (init?.method ?? "GET").toUpperCase() === "GET" ? boundedSignal(init?.signal, readTimeoutMs) : null;
    try {
      const response = await fetchImplementation(target, {
        ...init,
        signal: bound?.signal ?? init?.signal,
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
    } catch (error) {
      // The timer fired, not the caller: a read with no answer is a failed read.
      if (bound?.timedOut()) throw new DeskApiError("timeout");
      throw error;
    } finally {
      bound?.done();
    }
  };
}

const browserDeskFetch = createDeskApiClient();

export function deskFetch<T>(path: string, schema: ZodType<T>, init?: RequestInit): Promise<T> {
  return browserDeskFetch(path, schema, init);
}

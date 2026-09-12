export type GatewayRouteClass = "webhook" | "api" | "internal" | "health";

export interface GatewayLimit {
  max: number;
  windowSeconds: number;
}

export interface GatewayRateDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

export const GATEWAY_LIMITS: Record<GatewayRouteClass, GatewayLimit> = {
  webhook: { max: 20, windowSeconds: 60 },
  api: { max: 120, windowSeconds: 60 },
  internal: { max: 300, windowSeconds: 60 },
  health: { max: 30, windowSeconds: 60 },
};

const WINDOW_MILLISECONDS = 60_000;
const MAX_ENTRIES = 1_024;

interface RateEntry {
  windowStartedAt: number;
  count: number;
}

export interface GatewayRateLimiterOptions {
  clock?: () => number;
}

export interface GatewayRateLimiter {
  check(
    routeClass: GatewayRouteClass,
    key: string,
  ): GatewayRateDecision;
  size(): number;
  clear(): void;
}

export interface AuthorizationRateKeyInput {
  remoteAddress?: string;
}

export function createGatewayRateLimiter({
  clock = Date.now,
}: GatewayRateLimiterOptions = {}): GatewayRateLimiter {
  const entries = new Map<string, RateEntry>();

  function prune(now: number): void {
    for (const [key, entry] of entries) {
      if (now - entry.windowStartedAt >= WINDOW_MILLISECONDS) {
        entries.delete(key);
      }
    }

    while (entries.size > MAX_ENTRIES) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      entries.delete(oldestKey);
    }
  }

  return {
    check(routeClass, key) {
      const now = clock();
      if (entries.size > MAX_ENTRIES) {
        prune(now);
      }

      const entryKey = `${routeClass}:${key}`;
      const limit = GATEWAY_LIMITS[routeClass];
      const existing = entries.get(entryKey);
      const entry =
        existing && now - existing.windowStartedAt < WINDOW_MILLISECONDS
          ? existing
          : { windowStartedAt: now, count: 0 };

      entry.count += 1;
      entries.set(entryKey, entry);
      prune(now);

      const allowed = entry.count <= limit.max;
      const remaining = Math.max(0, limit.max - entry.count);
      const retryAfterSeconds = allowed
        ? 0
        : Math.max(
            1,
            Math.ceil(
              (entry.windowStartedAt + WINDOW_MILLISECONDS - now) / 1_000,
            ),
          );

      return {
        allowed,
        limit: limit.max,
        remaining,
        retryAfterSeconds,
      };
    },
    size: () => entries.size,
    clear: () => entries.clear(),
  };
}

export function authorizationRateKey({
  remoteAddress,
}: AuthorizationRateKeyInput): string {
  return `address:${remoteAddress ?? "unknown"}`;
}

export function classifyGatewayRoute(path: string): GatewayRouteClass {
  if (path === "/health/live" || path === "/health/ready") {
    return "health";
  }
  if (path === "/api/v1/integrations/clerk/webhook") {
    return "webhook";
  }
  if (path.startsWith("/internal/v1/")) {
    return "internal";
  }
  return "api";
}

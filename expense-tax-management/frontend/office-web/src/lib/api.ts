import { createAppApiClient, type DuplicateResolutionAction, type SuggestionResolveRequest } from "@expense-tax/contracts";
import type { OfficeSession } from "./session";
import { getAppAuthorization, type ClerkGetToken } from "./clerk";

type AppApiClient = ReturnType<typeof createAppApiClient>;
export const DUPLICATE_REVIEW_UPDATED_EVENT = "expense-tax:duplicate-review-updated";

// ------------------------------------------------------------------ //
// Scope path helpers
// ------------------------------------------------------------------ //

function scopeExpensesPath(session: OfficeSession): {
  path:
    | "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses"
    | "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses";
  params: Record<string, string>;
} {
  if (session.scope.kind === "business") {
    return {
      path: "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses",
      params: { tenantId: session.tenantId, businessId: session.scope.businessId },
    };
  }
  return {
    path: "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses",
    params: { tenantId: session.tenantId, profileId: session.scope.profileId },
  };
}

function scopeDuplicatePath(session: OfficeSession): {
  path:
    | "/api/v1/tenants/{tenantId}/businesses/{businessId}/duplicate-matches"
    | "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/duplicate-matches";
  params: Record<string, string>;
} {
  if (session.scope.kind === "business") {
    return {
      path: "/api/v1/tenants/{tenantId}/businesses/{businessId}/duplicate-matches",
      params: { tenantId: session.tenantId, businessId: session.scope.businessId },
    };
  }
  return {
    path: "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/duplicate-matches",
    params: { tenantId: session.tenantId, profileId: session.scope.profileId },
  };
}

function scopeDuplicateResolvePath(session: OfficeSession, matchId: string): {
  path:
    | "/api/v1/tenants/{tenantId}/businesses/{businessId}/duplicate-matches/{matchId}/resolve"
    | "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/duplicate-matches/{matchId}/resolve";
  params: Record<string, string>;
} {
  if (session.scope.kind === "business") {
    return {
      path: "/api/v1/tenants/{tenantId}/businesses/{businessId}/duplicate-matches/{matchId}/resolve",
      params: { tenantId: session.tenantId, businessId: session.scope.businessId, matchId },
    };
  }
  return {
    path: "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/duplicate-matches/{matchId}/resolve",
    params: { tenantId: session.tenantId, profileId: session.scope.profileId, matchId },
  };
}

function scopeSuggestionResolvePath(session: OfficeSession, expenseId: string, suggestionId: string): {
  path:
    | "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses/{expenseId}/suggestions/{suggestionId}/resolve"
    | "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses/{expenseId}/suggestions/{suggestionId}/resolve";
  params: Record<string, string>;
} {
  if (session.scope.kind === "business") {
    return {
      path: "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses/{expenseId}/suggestions/{suggestionId}/resolve",
      params: { tenantId: session.tenantId, businessId: session.scope.businessId, expenseId, suggestionId },
    };
  }
  return {
    path: "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses/{expenseId}/suggestions/{suggestionId}/resolve",
    params: { tenantId: session.tenantId, profileId: session.scope.profileId, expenseId, suggestionId },
  };
}

function scopeSuggestionsPath(session: OfficeSession, expenseId: string): {
  path:
    | "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses/{expenseId}/suggestions"
    | "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses/{expenseId}/suggestions";
  params: Record<string, string>;
} {
  if (session.scope.kind === "business") {
    return {
      path: "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses/{expenseId}/suggestions",
      params: { tenantId: session.tenantId, businessId: session.scope.businessId, expenseId },
    };
  }
  return {
    path: "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses/{expenseId}/suggestions",
    params: { tenantId: session.tenantId, profileId: session.scope.profileId, expenseId },
  };
}

function scopeExpenseDetailPath(session: OfficeSession, expenseId: string): {
  path:
    | "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses/{expenseId}"
    | "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses/{expenseId}";
  params: Record<string, string>;
} {
  if (session.scope.kind === "business") {
    return {
      path: "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses/{expenseId}",
      params: { tenantId: session.tenantId, businessId: session.scope.businessId, expenseId },
    };
  }
  return {
    path: "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses/{expenseId}",
    params: { tenantId: session.tenantId, profileId: session.scope.profileId, expenseId },
  };
}

// ------------------------------------------------------------------ //
// Error types
// ------------------------------------------------------------------ //

export class DuplicateReviewError extends Error {
  constructor(message: string, readonly status?: number) {
    super(status === 401 || status === 403 ? "Office authorization required" : message);
    this.name = "DuplicateReviewError";
  }
}

export class EnrichmentReviewError extends Error {
  constructor(message: string, readonly status?: number) {
    super(status === 401 || status === 403 ? "Office authorization required" : message);
    this.name = "EnrichmentReviewError";
  }
}

// ------------------------------------------------------------------ //
// State helpers
// ------------------------------------------------------------------ //

export type DuplicateReviewState = "loading" | "unauthorized" | "error" | "empty" | "pending" | "conflict";

export function getDuplicateReviewState(input: {
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
  organizationLoaded: boolean;
  hasSession: boolean;
  hasOrganization: boolean;
  items?: readonly unknown[];
  error?: string;
  conflict?: boolean;
}): DuplicateReviewState {
  if (!input.isLoaded || !input.organizationLoaded) return "loading";
  if (!input.isSignedIn || !input.hasSession || !input.hasOrganization) return "unauthorized";
  if (input.conflict) return "conflict";
  if (input.error) return "error";
  if (input.items === undefined) return "loading";
  return input.items.length === 0 ? "empty" : "pending";
}

export type EnrichmentReviewState = "loading" | "unauthorized" | "error" | "empty" | "pending" | "conflict" | "stale" | "success";

export function getEnrichmentReviewState(input: {
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
  hasSession: boolean;
  hasOrganization: boolean;
  suggestions?: readonly unknown[];
  error?: string;
  conflict?: boolean;
  stale?: boolean;
}): EnrichmentReviewState {
  if (!input.isLoaded) return "loading";
  if (!input.isSignedIn || !input.hasSession || !input.hasOrganization) return "unauthorized";
  if (input.conflict) return "conflict";
  if (input.stale) return "stale";
  if (input.error) return "error";
  if (input.suggestions === undefined) return "loading";
  return input.suggestions.length === 0 ? "empty" : "pending";
}

// ------------------------------------------------------------------ //
// Source label helpers
// ------------------------------------------------------------------ //

type SuggestionSource = "historical" | "ai" | "manual" | "manual_baseline";

export function getSuggestionSourceLabel(source: SuggestionSource): string {
  switch (source) {
    case "historical": return "Historical pattern";
    case "ai": return "AI suggestion";
    case "manual": return "Manual decision";
    case "manual_baseline": return "Baseline import";
  }
}

export function getSourceBadge(matchType: "file_sha256" | "fingerprint" | "fuzzy_fields") {
  if (matchType === "file_sha256") return { label: "Source file", tone: "ok" as const };
  if (matchType === "fingerprint") return { label: "Expense fingerprint", tone: "ok" as const };
  return { label: "Matching fields", tone: "warn" as const };
}

// ------------------------------------------------------------------ //
// Stable idempotency keys
// ------------------------------------------------------------------ //

/**
 * Generates a stable idempotency key for a user action on a specific entity.
 * Key is deterministic so retrying the same action reuses the same key.
 */
export function makeStableIdempotencyKey(action: string, ...ids: string[]): string {
  return `${action}:${ids.join(":")}`;
}

// ------------------------------------------------------------------ //
// Misc helpers
// ------------------------------------------------------------------ //

export function formatPendingDuplicateCount(input: { items: readonly unknown[]; nextCursor: string | null }) {
  return input.nextCursor ? "50+" : String(input.items.length);
}

export function shouldApplyPendingDuplicateCount(active: boolean, requestSequence: number, currentSequence: number) {
  return active && requestSequence === currentSequence;
}

// ------------------------------------------------------------------ //
// Auth helpers
// ------------------------------------------------------------------ //

async function getDuplicateAuthorization(getToken: ClerkGetToken, organizationId: string | null | undefined) {
  try {
    return await getAppAuthorization(getToken, organizationId);
  } catch {
    throw new DuplicateReviewError("Office authorization required", 401);
  }
}

// ------------------------------------------------------------------ //
// Ledger API (Personal and Business scope)
// ------------------------------------------------------------------ //

export type LedgerQueryOptions = {
  tagId?: string[];
  cursor?: string;
  sort?: string;
  direction?: string;
  limit?: number;
};

export async function fetchLedger(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
  options?: LedgerQueryOptions,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const headers = await getAppAuthorization(getToken, organizationId);
  const baseQuery = {
    sort: (options?.sort ?? "incurredOn") as "incurredOn" | "amount" | "merchant" | "createdAt",
    direction: (options?.direction ?? "desc") as "asc" | "desc",
    limit: options?.limit ?? 50,
    ...(options?.cursor ? { cursor: options.cursor } : {}),
    ...(options?.tagId?.length ? { tagId: options.tagId as string | string[] } : {}),
  };
  let result;
  if (session.scope.kind === "business") {
    result = await api.GET("/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses", {
      params: { path: { tenantId: session.tenantId, businessId: session.scope.businessId }, query: baseQuery },
      headers,
    });
  } else {
    result = await api.GET("/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses", {
      params: { path: { tenantId: session.tenantId, profileId: session.scope.profileId }, query: baseQuery },
      headers,
    });
  }
  if (!result.data) throw new Error("Ledger unavailable");
  return result.data;
}

// ------------------------------------------------------------------ //
// Expense detail API (Personal and Business scope)
// ------------------------------------------------------------------ //

export async function fetchExpenseDetail(
  session: OfficeSession,
  expenseId: string,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const headers = await getAppAuthorization(getToken, organizationId);
  let result;
  if (session.scope.kind === "business") {
    result = await api.GET("/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses/{expenseId}", {
      params: { path: { tenantId: session.tenantId, businessId: session.scope.businessId, expenseId } },
      headers,
    });
  } else {
    result = await api.GET("/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses/{expenseId}", {
      params: { path: { tenantId: session.tenantId, profileId: session.scope.profileId, expenseId } },
      headers,
    });
  }
  if (!result.data) {
    const status = result.response?.status;
    if (status === 401 || status === 403) throw new EnrichmentReviewError("Office authorization required", status);
    throw new EnrichmentReviewError("Expense detail unavailable");
  }
  return result.data;
}

// ------------------------------------------------------------------ //
// Suggestions API (Personal and Business scope)
// ------------------------------------------------------------------ //

export async function fetchSuggestions(
  session: OfficeSession,
  expenseId: string,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const headers = await getAppAuthorization(getToken, organizationId);
  let result;
  if (session.scope.kind === "business") {
    result = await api.GET("/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses/{expenseId}/suggestions", {
      params: { path: { tenantId: session.tenantId, businessId: session.scope.businessId, expenseId } },
      headers,
    });
  } else {
    result = await api.GET("/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses/{expenseId}/suggestions", {
      params: { path: { tenantId: session.tenantId, profileId: session.scope.profileId, expenseId } },
      headers,
    });
  }
  if (!result.data) {
    const status = result.response?.status;
    if (status === 401 || status === 403) throw new EnrichmentReviewError("Office authorization required", status);
    throw new EnrichmentReviewError("Suggestions unavailable");
  }
  return result.data;
}

export async function resolveSuggestion(
  session: OfficeSession,
  expenseId: string,
  suggestionId: string,
  body: SuggestionResolveRequest,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const headers = await getAppAuthorization(getToken, organizationId);
  let result;
  if (session.scope.kind === "business") {
    result = await api.POST("/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses/{expenseId}/suggestions/{suggestionId}/resolve", {
      params: { path: { tenantId: session.tenantId, businessId: session.scope.businessId, expenseId, suggestionId } },
      headers,
      body,
    });
  } else {
    result = await api.POST("/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses/{expenseId}/suggestions/{suggestionId}/resolve", {
      params: { path: { tenantId: session.tenantId, profileId: session.scope.profileId, expenseId, suggestionId } },
      headers,
      body,
    });
  }
  if (!result.data) {
    const status = result.response?.status;
    if (status === 409) throw new EnrichmentReviewError("This expense changed. Refresh to review latest state.", 409);
    if (status === 401 || status === 403) throw new EnrichmentReviewError("Office authorization required", status);
    throw new EnrichmentReviewError("Suggestion resolution unavailable");
  }
  return result.data;
}

// ------------------------------------------------------------------ //
// Duplicate matches API (Personal and Business scope)
// ------------------------------------------------------------------ //

export async function fetchDuplicateMatches(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
  cursor?: string,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const headers = await getDuplicateAuthorization(getToken, organizationId);
  const query = { status: "pending" as const, limit: 50, ...(cursor ? { cursor } : {}) };
  let result;
  if (session.scope.kind === "business") {
    result = await api.GET("/api/v1/tenants/{tenantId}/businesses/{businessId}/duplicate-matches", {
      params: { path: { tenantId: session.tenantId, businessId: session.scope.businessId }, query },
      headers,
    });
  } else {
    result = await api.GET("/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/duplicate-matches", {
      params: { path: { tenantId: session.tenantId, profileId: session.scope.profileId }, query },
      headers,
    });
  }
  if (!result.data) throw new DuplicateReviewError("Duplicate matches unavailable", result.response?.status);
  return result.data;
}

export function announceDuplicateReviewUpdated() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(DUPLICATE_REVIEW_UPDATED_EVENT));
}

export async function resolveDuplicateMatch(
  session: OfficeSession,
  matchId: string,
  action: DuplicateResolutionAction,
  expectedMatchVersion: number,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const headers = await getDuplicateAuthorization(getToken, organizationId);
  const body = { action, expectedMatchVersion, idempotencyKey: crypto.randomUUID() };
  let result;
  if (session.scope.kind === "business") {
    result = await api.POST("/api/v1/tenants/{tenantId}/businesses/{businessId}/duplicate-matches/{matchId}/resolve", {
      params: { path: { tenantId: session.tenantId, businessId: session.scope.businessId, matchId } },
      headers,
      body,
    });
  } else {
    result = await api.POST("/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/duplicate-matches/{matchId}/resolve", {
      params: { path: { tenantId: session.tenantId, profileId: session.scope.profileId, matchId } },
      headers,
      body,
    });
  }
  if (!result.data) {
    const status = result.response?.status;
    throw new DuplicateReviewError(status === 409 ? "This match changed. Refreshing review list." : "Resolution unavailable", status);
  }
  return result.data;
}

// ------------------------------------------------------------------ //
// Tax report API (Business scope only - callers must gate)
// ------------------------------------------------------------------ //

export async function fetchTaxReport(session: OfficeSession, taxYear: number, getToken: ClerkGetToken, organizationId: string | null | undefined, client?: AppApiClient) {
  if (session.scope.kind !== "business") throw new Error("Tax report requires business scope");
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.GET(
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/tax-reports/{taxYear}",
    { params: { path: { tenantId: session.tenantId, businessId: session.scope.businessId, taxYear } }, headers: await getAppAuthorization(getToken, organizationId) },
  );
  if (!result.data) throw new Error("Tax report unavailable");
  return result.data;
}

// ------------------------------------------------------------------ //
// Export API (Business scope only - callers must gate)
// ------------------------------------------------------------------ //

export async function createExport(session: OfficeSession, taxYear: number, getToken: ClerkGetToken, organizationId: string | null | undefined, includeUnresolved = false, client?: AppApiClient) {
  if (session.scope.kind !== "business") throw new Error("Exports require business scope");
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.POST(
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/exports",
    {
      params: {
        path: { tenantId: session.tenantId, businessId: session.scope.businessId },
        header: { "idempotency-key": crypto.randomUUID() },
      },
      headers: await getAppAuthorization(getToken, organizationId),
      body: { taxYear, includeUnresolved },
    },
  );
  if (!result.data) throw new Error("Export unavailable");
  return result.data;
}

// ------------------------------------------------------------------ //
// Tags API (tenant-scoped, Personal and Business)
// ------------------------------------------------------------------ //

export type TagQueryOptions = {
  status?: "active" | "archived";
  cursor?: string;
  limit?: number;
};

export async function fetchTags(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
  _options?: TagQueryOptions,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.GET("/api/v1/tenants/{tenantId}/tags", {
    params: { path: { tenantId: session.tenantId } },
    headers: await getAppAuthorization(getToken, organizationId),
  });
  if (!result.data) throw new Error("Tags unavailable");
  return result.data;
}

export async function createTag(
  session: OfficeSession,
  name: string,
  color: string | null | undefined,
  _idempotencyKey: string,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.POST("/api/v1/tenants/{tenantId}/tags", {
    params: { path: { tenantId: session.tenantId } },
    headers: await getAppAuthorization(getToken, organizationId),
    body: { name, ...(color !== undefined ? { color } : {}) },
  });
  if (!result.data) throw new Error("Tag creation unavailable");
  return result.data;
}

export async function updateTag(
  session: OfficeSession,
  tagId: string,
  body: { expectedVersion: number; name?: string; color?: string | null },
  _idempotencyKey: string,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.PATCH("/api/v1/tenants/{tenantId}/tags/{tagId}", {
    params: { path: { tenantId: session.tenantId, tagId } },
    headers: await getAppAuthorization(getToken, organizationId),
    body,
  });
  if (!result.data) {
    const status = result.response?.status;
    if (status === 409) throw new Error("Tag version conflict. Refresh to see latest.");
    throw new Error("Tag update unavailable");
  }
  return result.data;
}

export async function archiveTag(
  session: OfficeSession,
  tagId: string,
  expectedVersion: number,
  _idempotencyKey: string,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.DELETE("/api/v1/tenants/{tenantId}/tags/{tagId}", {
    params: { path: { tenantId: session.tenantId, tagId } },
    headers: await getAppAuthorization(getToken, organizationId),
    body: { expectedVersion },
  });
  if (!result.data) {
    const status = result.response?.status;
    if (status === 409) throw new Error("Tag version conflict. Refresh to see latest.");
    throw new Error("Tag archive unavailable");
  }
  return result.data;
}

export async function unarchiveTag(
  session: OfficeSession,
  tagId: string,
  expectedVersion: number,
  _idempotencyKey: string,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.POST("/api/v1/tenants/{tenantId}/tags/{tagId}/unarchive", {
    params: { path: { tenantId: session.tenantId, tagId } },
    headers: await getAppAuthorization(getToken, organizationId),
    body: { expectedVersion },
  });
  if (!result.data) {
    const status = result.response?.status;
    if (status === 409) throw new Error("Tag version conflict. Refresh to see latest.");
    throw new Error("Tag unarchive unavailable");
  }
  return result.data;
}

export async function mergeTags(
  session: OfficeSession,
  sourceTagId: string,
  targetTagId: string,
  expectedSourceVersion: number,
  expectedTargetVersion: number,
  _idempotencyKey: string,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.POST("/api/v1/tenants/{tenantId}/tags/{tagId}/merge", {
    params: { path: { tenantId: session.tenantId, tagId: sourceTagId } },
    headers: await getAppAuthorization(getToken, organizationId),
    body: { sourceTagId, targetTagId, expectedSourceVersion, expectedTargetVersion },
  });
  if (!result.data) {
    const status = (result as { response?: { status: number } }).response?.status;
    if (status === 409) throw new Error("Tag version conflict during merge. Refresh to see latest.");
    throw new Error("Tag merge unavailable");
  }
  return result.data;
}

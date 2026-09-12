import { createAppApiClient, type DuplicateResolutionAction } from "@expense-tax/contracts";
import type { OfficeSession } from "./session";
import { getAppAuthorization, type ClerkGetToken } from "./clerk";

type AppApiClient = ReturnType<typeof createAppApiClient>;
export const DUPLICATE_REVIEW_UPDATED_EVENT = "expense-tax:duplicate-review-updated";

export class DuplicateReviewError extends Error {
  constructor(message: string, readonly status?: number) {
    super(status === 401 || status === 403 ? "Office authorization required" : message);
    this.name = "DuplicateReviewError";
  }
}

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

export function getSourceBadge(matchType: "file_sha256" | "fingerprint" | "fuzzy_fields") {
  if (matchType === "file_sha256") return { label: "Source file", tone: "ok" as const };
  if (matchType === "fingerprint") return { label: "Expense fingerprint", tone: "ok" as const };
  return { label: "Matching fields", tone: "warn" as const };
}

export async function fetchDuplicateMatches(
  session: OfficeSession,
  getToken: ClerkGetToken,
  organizationId: string | null | undefined,
  client?: AppApiClient,
  cursor?: string,
) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.GET(
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/duplicate-matches",
    {
      params: {
        path: { tenantId: session.tenantId, businessId: session.businessId },
        query: { status: "pending", limit: 50, ...(cursor ? { cursor } : {}) },
      },
      headers: await getAppAuthorization(getToken, organizationId),
    },
  );
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
  const result = await api.POST(
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/duplicate-matches/{matchId}/resolve",
    {
      params: { path: { tenantId: session.tenantId, businessId: session.businessId, matchId } },
      headers: await getAppAuthorization(getToken, organizationId),
      body: { action, expectedMatchVersion, idempotencyKey: crypto.randomUUID() },
    },
  );
  if (!result.data) {
    const status = result.response?.status;
    throw new DuplicateReviewError(status === 409 ? "This match changed. Refreshing review list." : "Resolution unavailable", status);
  }
  return result.data;
}

export async function fetchTaxReport(session: OfficeSession, taxYear: number, getToken: ClerkGetToken, organizationId: string | null | undefined, client?: AppApiClient) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.GET(
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/tax-reports/{taxYear}",
    { params: { path: { tenantId: session.tenantId, businessId: session.businessId, taxYear } }, headers: await getAppAuthorization(getToken, organizationId) },
  );
  if (!result.data) throw new Error("Tax report unavailable");
  return result.data;
}

export async function createExport(session: OfficeSession, taxYear: number, getToken: ClerkGetToken, organizationId: string | null | undefined, includeUnresolved = false, client?: AppApiClient) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.POST(
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/exports",
    {
      params: {
        path: { tenantId: session.tenantId, businessId: session.businessId },
        header: { "idempotency-key": crypto.randomUUID() },
      },
      headers: await getAppAuthorization(getToken, organizationId),
      body: { taxYear, includeUnresolved },
    },
  );
  if (!result.data) throw new Error("Export unavailable");
  return result.data;
}

export async function fetchLedger(session: OfficeSession, getToken: ClerkGetToken, organizationId: string | null | undefined, client?: AppApiClient) {
  const api = client ?? createAppApiClient(session.apiBaseUrl);
  const result = await api.GET(
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses",
    {
      params: {
        path: { tenantId: session.tenantId, businessId: session.businessId },
        query: { sort: "incurredOn", direction: "desc", limit: 50 },
      },
      headers: await getAppAuthorization(getToken, organizationId),
    },
  );
  if (!result.data) throw new Error("Ledger unavailable");
  return result.data;
}

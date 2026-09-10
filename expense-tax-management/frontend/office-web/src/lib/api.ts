import { createAppApiClient } from "@expense-tax/contracts";
import type { OfficeSession } from "./session";
import { getAppAuthorization, type ClerkGetToken } from "./clerk";

type AppApiClient = ReturnType<typeof createAppApiClient>;

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

import { createAppApiClient } from "@expense-tax/contracts";
import type { OfficeSession } from "./session";

const headers = (session: OfficeSession) => ({ authorization: `Bearer ${session.tenantToken}` });

export async function fetchTaxReport(session: OfficeSession, taxYear: number) {
  const client = createAppApiClient(session.apiBaseUrl);
  const result = await client.GET(
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/tax-reports/{taxYear}",
    { params: { path: { tenantId: session.tenantId, businessId: session.businessId, taxYear } }, headers: headers(session) },
  );
  if (!result.data) throw new Error("Tax report unavailable");
  return result.data;
}

export async function createExport(session: OfficeSession, taxYear: number, includeUnresolved = false) {
  const client = createAppApiClient(session.apiBaseUrl);
  const result = await client.POST(
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/exports",
    {
      params: {
        path: { tenantId: session.tenantId, businessId: session.businessId },
        header: { "idempotency-key": crypto.randomUUID() },
      },
      headers: headers(session),
      body: { taxYear, includeUnresolved },
    },
  );
  if (!result.data) throw new Error("Export unavailable");
  return result.data;
}

export async function fetchLedger(session: OfficeSession) {
  const client = createAppApiClient(session.apiBaseUrl);
  const result = await client.GET(
    "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses",
    {
      params: {
        path: { tenantId: session.tenantId, businessId: session.businessId },
        query: { sort: "incurredOn", direction: "desc", limit: 50 },
      },
      headers: headers(session),
    },
  );
  if (!result.data) throw new Error("Ledger unavailable");
  return result.data;
}

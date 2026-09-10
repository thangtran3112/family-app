import { describe, expect, it, vi } from "vitest";

import { fetchLedger } from "./api";

describe("Office API authorization boundary", () => {
  it("propagates Clerk bearer header to ledger request", async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: { items: [] } }) };
    const getToken = vi.fn().mockResolvedValue("office-token");
    const session = { apiBaseUrl: "http://app.test", tenantId: "tenant-1", businessId: "business-1", label: "Family" };

    await fetchLedger(session, getToken, "org_123", client as never);

    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses",
      expect.objectContaining({ headers: { authorization: "Bearer office-token" } }),
    );
  });
});

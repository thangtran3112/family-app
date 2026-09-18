import { describe, expect, it, vi } from "vitest";

import { fetchDuplicateMatches, fetchLedger, fetchTags, resolveSuggestion } from "./api";
import type { OfficeSession } from "./session";

const businessSession: OfficeSession = {
  apiBaseUrl: "http://app.test",
  tenantId: "tenant-1",
  scope: { kind: "business", businessId: "business-1" },
  label: "Family Business",
};

const personalSession: OfficeSession = {
  apiBaseUrl: "http://app.test",
  tenantId: "tenant-1",
  scope: { kind: "personal", profileId: "profile-1" },
  label: "Personal",
};

describe("Office API authorization boundary", () => {
  it("propagates Clerk bearer header to ledger request - business scope", async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: { items: [] } }) };
    const getToken = vi.fn().mockResolvedValue("office-token");

    await fetchLedger(businessSession, getToken, "org_123", client as never);

    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses",
      expect.objectContaining({ headers: { authorization: "Bearer office-token" } }),
    );
  });

  it("uses personal-profile route for personal scope in ledger", async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: { items: [] } }) };
    const getToken = vi.fn().mockResolvedValue("office-token");

    await fetchLedger(personalSession, getToken, "org_123", client as never);

    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses",
      expect.objectContaining({
        params: expect.objectContaining({
          path: { tenantId: "tenant-1", profileId: "profile-1" },
        }),
        headers: { authorization: "Bearer office-token" },
      }),
    );
  });

  it("sends repeated tagId query params (server pagination, no client filtering)", async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: { items: [], nextCursor: null } }) };
    const getToken = vi.fn().mockResolvedValue("office-token");

    await fetchLedger(businessSession, getToken, "org_123", client as never, {
      tagId: ["tag-a", "tag-b"],
      cursor: "cursor-1",
      sort: "incurredOn",
      direction: "asc",
    });

    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses",
      expect.objectContaining({
        params: expect.objectContaining({
          query: expect.objectContaining({
            tagId: ["tag-a", "tag-b"],
            cursor: "cursor-1",
            sort: "incurredOn",
            direction: "asc",
          }),
        }),
      }),
    );
  });

  it("uses personal duplicate-match route for personal scope", async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: { items: [], nextCursor: null } }) };
    const getToken = vi.fn().mockResolvedValue("office-token");

    await fetchDuplicateMatches(personalSession, getToken, "org_123", client as never);

    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/duplicate-matches",
      expect.objectContaining({
        params: expect.objectContaining({
          path: { tenantId: "tenant-1", profileId: "profile-1" },
        }),
      }),
    );
  });

  it("uses business duplicate-match route for business scope", async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: { items: [], nextCursor: null } }) };
    const getToken = vi.fn().mockResolvedValue("office-token");

    await fetchDuplicateMatches(businessSession, getToken, "org_123", client as never);

    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/businesses/{businessId}/duplicate-matches",
      expect.objectContaining({
        params: expect.objectContaining({
          path: { tenantId: "tenant-1", businessId: "business-1" },
        }),
      }),
    );
  });

  it("fetches tags at tenant scope", async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: { items: [], nextCursor: null } }) };
    const getToken = vi.fn().mockResolvedValue("office-token");

    await fetchTags(businessSession, getToken, "org_123", client as never);

    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/tags",
      expect.objectContaining({
        params: expect.objectContaining({
          path: { tenantId: "tenant-1" },
        }),
        headers: { authorization: "Bearer office-token" },
      }),
    );
  });
});

describe("suggestion resolve API", () => {
  it("sends stable idempotency key and action for business scope", async () => {
    const client = {
      POST: vi.fn().mockResolvedValue({
        data: { suggestionId: "sugg-1", status: "accepted", version: 2 },
      }),
    };
    const getToken = vi.fn().mockResolvedValue("office-token");
    const stableKey = "stable-idem-key-1";

    await resolveSuggestion(businessSession, "exp-1", "sugg-1", {
      action: "accepted",
      expectedSuggestionVersion: 1,
      expectedExpenseVersion: 3,
      idempotencyKey: stableKey,
    }, getToken, "org_123", client as never);

    expect(client.POST).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/businesses/{businessId}/expenses/{expenseId}/suggestions/{suggestionId}/resolve",
      expect.objectContaining({
        params: expect.objectContaining({
          path: { tenantId: "tenant-1", businessId: "business-1", expenseId: "exp-1", suggestionId: "sugg-1" },
        }),
        body: expect.objectContaining({
          action: "accepted",
          idempotencyKey: stableKey,
        }),
      }),
    );
  });

  it("sends stable idempotency key for personal scope", async () => {
    const client = {
      POST: vi.fn().mockResolvedValue({
        data: { suggestionId: "sugg-2", status: "rejected", version: 1 },
      }),
    };
    const getToken = vi.fn().mockResolvedValue("office-token");
    const stableKey = "stable-idem-key-2";

    await resolveSuggestion(personalSession, "exp-2", "sugg-2", {
      action: "rejected",
      expectedSuggestionVersion: 1,
      expectedExpenseVersion: 2,
      idempotencyKey: stableKey,
    }, getToken, "org_123", client as never);

    expect(client.POST).toHaveBeenCalledWith(
      "/api/v1/tenants/{tenantId}/personal-profiles/{profileId}/expenses/{expenseId}/suggestions/{suggestionId}/resolve",
      expect.objectContaining({
        params: expect.objectContaining({
          path: { tenantId: "tenant-1", profileId: "profile-1", expenseId: "exp-2", suggestionId: "sugg-2" },
        }),
        body: expect.objectContaining({
          action: "rejected",
          idempotencyKey: stableKey,
        }),
      }),
    );
  });

  it("requires deductible percentage for tax_category acceptance", async () => {
    const client = {
      POST: vi.fn().mockResolvedValue({
        data: { suggestionId: "sugg-3", status: "accepted", version: 2 },
      }),
    };
    const getToken = vi.fn().mockResolvedValue("office-token");

    await resolveSuggestion(businessSession, "exp-3", "sugg-3", {
      action: "accepted",
      expectedSuggestionVersion: 1,
      expectedExpenseVersion: 1,
      idempotencyKey: "key-3",
      taxAcceptance: { businessTaxProfileId: "prof-1", deductiblePercent: "50" },
    }, getToken, "org_123", client as never);

    expect(client.POST).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: expect.objectContaining({
          taxAcceptance: { businessTaxProfileId: "prof-1", deductiblePercent: "50" },
        }),
      }),
    );
  });
});

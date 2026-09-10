import { describe, expect, it, vi } from "vitest";

import { getAppAuthorization, getTenantGateState } from "./clerk";

describe("capture Clerk authorization", () => {
  it("rejects signed-out requests without creating a bearer token", async () => {
    await expect(getAppAuthorization(vi.fn().mockResolvedValue(null), "org_123"))
      .rejects.toThrow("Authentication required");
  });

  it("requests tenant token for active organization", async () => {
    const getToken = vi.fn().mockResolvedValue("tenant-token");

    await expect(getAppAuthorization(getToken, "org_123")).resolves.toEqual({
      authorization: "Bearer tenant-token",
    });
    expect(getToken).toHaveBeenCalledWith({
      template: "expense-app",
      organizationId: "org_123",
    });
  });

  it("can force Clerk token refresh", async () => {
    const getToken = vi.fn().mockResolvedValue("refreshed-token");

    await getAppAuthorization(getToken, "org_123", { skipCache: true });

    expect(getToken).toHaveBeenCalledWith({
      template: "expense-app",
      organizationId: "org_123",
      skipCache: true,
    });
  });

  it("keeps signed-in users in recovery state until organization selected", () => {
    expect(getTenantGateState({ isLoaded: true, isSignedIn: true, organizationId: null })).toBe("missing-organization");
  });
});

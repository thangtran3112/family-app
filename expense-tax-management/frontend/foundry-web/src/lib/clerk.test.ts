import { describe, expect, it, vi } from "vitest";

import { getPlatformAuthorization } from "./clerk";

describe("Foundry Clerk authorization", () => {
  it("requests platform template without a tenant organization", async () => {
    const getToken = vi.fn().mockResolvedValue("platform-token");

    await expect(getPlatformAuthorization(getToken)).resolves.toEqual({
      authorization: "Bearer platform-token",
    });
    expect(getToken).toHaveBeenCalledWith({
      template: "expense-foundry-platform",
    });
  });

  it("rejects signed-out platform requests", async () => {
    await expect(getPlatformAuthorization(vi.fn().mockResolvedValue(null)))
      .rejects.toThrow("Authentication required");
  });

  it("supports explicit token refresh", async () => {
    const getToken = vi.fn().mockResolvedValue("new-platform-token");

    await getPlatformAuthorization(getToken, { skipCache: true });

    expect(getToken).toHaveBeenCalledWith({
      template: "expense-foundry-platform",
      skipCache: true,
    });
  });
});

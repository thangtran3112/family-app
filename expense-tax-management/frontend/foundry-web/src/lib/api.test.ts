import { describe, expect, it, vi } from "vitest";

import { fetchProviders } from "./api";

describe("Foundry API authorization boundary", () => {
  it("propagates Clerk platform bearer header to provider request", async () => {
    const client = { GET: vi.fn().mockResolvedValue({ data: { items: [] } }) };
    const getToken = vi.fn().mockResolvedValue("platform-token");
    const session = { baseUrl: "http://foundry.test", role: "catalog_manager" as const };

    await fetchProviders(session, getToken, client as never);

    expect(client.GET).toHaveBeenCalledWith(
      "/internal/v1/provider-connections",
      { headers: { authorization: "Bearer platform-token" } },
    );
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { getPlatformAuthorization, requireClerkPublishableKey } from "./clerk";

const source = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

describe("Foundry Clerk authorization", () => {
  it("requires a configured publishable key", () => {
    expect(() => requireClerkPublishableKey(" ")).toThrow(
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is required",
    );
  });
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

  it("uses hash routing for every mounted Clerk sign-in", () => {
    for (const file of ["../components/foundry-auth-gate.tsx", "../app/platform-login/page.tsx"]) {
      const contents = source(file);

      expect(contents).toContain('routing="hash"');
      expect(contents).not.toContain('routing="path"');
    }
  });
});

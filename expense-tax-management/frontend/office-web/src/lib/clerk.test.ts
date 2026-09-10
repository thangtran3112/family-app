import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { getAppAuthorization, getTenantGateState } from "./clerk";

const source = (relativePath: string) =>
  readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");

describe("office Clerk authorization", () => {
  it("requires active organization before calling App API", async () => {
    const getToken = vi.fn();

    await expect(getAppAuthorization(getToken, null)).rejects.toThrow(
      "Active organization required",
    );
    expect(getToken).not.toHaveBeenCalled();
  });

  it("returns refreshed bearer authorization without persisting it", async () => {
    const getToken = vi.fn().mockResolvedValue("office-token");

    await expect(getAppAuthorization(getToken, "org_456", { skipCache: true }))
      .resolves.toEqual({ authorization: "Bearer office-token" });
  });

  it("rejects null token instead of falling back to a demo token", async () => {
    await expect(getAppAuthorization(vi.fn().mockResolvedValue(null), "org_456"))
      .rejects.toThrow("Authentication required");
  });

  it("keeps signed-in users in recovery state until organization selected", () => {
    expect(getTenantGateState({ isLoaded: true, isSignedIn: true, organizationId: undefined })).toBe("missing-organization");
  });

  it("uses hash routing for every mounted Clerk sign-in", () => {
    for (const file of ["../components/office-auth-gate.tsx", "../app/login/page.tsx"]) {
      const contents = source(file);

      expect(contents).toContain('routing="hash"');
      expect(contents).not.toContain('routing="path"');
    }
  });
});

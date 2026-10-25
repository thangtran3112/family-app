import { defineConfig, devices } from "@playwright/test";

// Production-only run for the Clerk test user (`e2e/auth.spec.ts`, "production test user"): no local backend or proxy.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "auth.spec.ts",
  grep: /production test user/,
  workers: 1,
  reporter: "list",
  metadata: { production: true },
  // Traces record typed values, so they stay off for the credentials.
  use: { ...devices["Desktop Chrome"], trace: "off" },
});

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:18045",
    trace: "retain-on-failure",
  },
  // The legacy specs drive the existing shell, which the desktop shell replaces from 1100 px (02m §c1), so
  // they run just below it. Desktop projects at 1440x900 and 1180x820 arrive with the integration step (02m §d5).
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1080, height: 800 } } }],
  webServer: [
    {
      command: "cd ../backend && uv run python tests/e2e/browser_server.py",
      url: "http://127.0.0.1:18044/healthz",
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      command: "node e2e/proxy.mjs",
      url: "http://127.0.0.1:18045/",
      timeout: 30_000,
      reuseExistingServer: false,
    },
  ],
});

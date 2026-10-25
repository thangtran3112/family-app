import { defineConfig, devices } from "@playwright/test";

// Ports are overridable so several runs can share a machine (`DESK_E2E_API_PORT`, `DESK_E2E_PROXY_PORT`); the
// specs read the same values through `e2e/helpers.ts`.
const apiPort = process.env.DESK_E2E_API_PORT ?? "18044";
const proxyPort = process.env.DESK_E2E_PROXY_PORT ?? "18045";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://127.0.0.1:${proxyPort}`,
    trace: "retain-on-failure",
  },
  projects: [
    // The first specs drive the mobile shell, which the desktop shell replaces from 1100 px (02m §c1), so they run
    // just below it.
    {
      name: "chromium",
      testIgnore: "desk/**",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1080, height: 800 } },
    },
    // One spec per board family (02m §d5, `e2e/desk/`), each at both desktop bands.
    {
      name: "desktop-1440",
      testMatch: "desk/**/*.spec.ts",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "desktop-1180",
      testMatch: "desk/**/*.spec.ts",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1180, height: 820 } },
    },
  ],
  webServer: [
    {
      command: "cd ../backend && uv run python tests/e2e/browser_server.py",
      url: `http://127.0.0.1:${apiPort}/healthz`,
      timeout: 60_000,
      reuseExistingServer: false,
    },
    {
      command: "node e2e/proxy.mjs",
      url: `http://127.0.0.1:${proxyPort}/`,
      timeout: 30_000,
      reuseExistingServer: false,
      env: {
        DESK_E2E_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
        DESK_E2E_PROXY_PORT: proxyPort,
      },
    },
  ],
});

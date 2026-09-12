import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkPhase1cGateway,
  parseCloudflareIngress,
} from "./check-phase-1c-gateway.mjs";

const projectRoot = join(process.cwd());
const repoRoot = join(projectRoot, "..");
const read = (path) => readFileSync(join(repoRoot, path), "utf8");

const terraform = read("infrastructure/cloudflare/expense-tax/main.tf");
const compose = read("expense-tax-management/docker-compose.yml");
const design = read("docs/superpowers/specs/2026-09-11-phase-1c-gateway-hardening-design.md");
const readme = read("infrastructure/cloudflare/expense-tax/README.md");
const frontendConfigs = [
  "expense-tax-management/frontend/capture-web/next.config.ts",
  "expense-tax-management/frontend/office-web/next.config.ts",
  "expense-tax-management/frontend/foundry-web/next.config.ts",
].map(read);

describe("Phase 1C gateway static policy", () => {
  it("passes repository gateway policy checks", () => {
    expect(checkPhase1cGateway()).toEqual([]);
  });

  it("requires shared frontend security headers without CSP", () => {
    for (const source of frontendConfigs) {
      expect(source).toContain("headers");
      expect(source).toContain("X-Content-Type-Options");
      expect(source).toContain("Referrer-Policy");
      expect(source).toContain("X-Frame-Options");
      expect(source).toContain("Permissions-Policy");
      expect(source).not.toContain("Content-Security-Policy");
    }
  });

  it("keeps all public hosts on loopback origins with a fail-closed route", () => {
    for (const hostname of [
      "primary_hostname",
      "api_hostname",
      "capture_hostname",
      "office_hostname",
      "foundry_hostname",
    ]) {
      expect(terraform).toContain(`var.${hostname}`);
    }
    for (const origin of ["7301", "8100", "7302", "8200", "7303"]) {
      expect(terraform).toContain(`http://127.0.0.1:${origin}`);
    }
    expect(terraform).toContain('path     = "/internal/v1/*"');
    expect(terraform).toContain('service  = "http://127.0.0.1:8200"');
    expect(terraform).toContain('service = "http_status:404"');
    expect(terraform).not.toMatch(/cloudflare_(access|worker|waf|rate_limit)/u);
    expect(terraform.indexOf('path     = "/internal/v1/*"')).toBeLessThan(
      terraform.indexOf('service  = "http://127.0.0.1:7303"'),
    );
  });

  it("requires the final parsed ingress entry to be the exact 404 catch-all", () => {
    expect(parseCloudflareIngress(terraform).at(-1)).toEqual({
      service: "http_status:404",
    });
  });

  it("parses a final ingress object without a trailing comma", () => {
    const source = `ingress = [
      {
        service = "http_status:404"
      },
      {
        service = "http://127.0.0.1:7301"
      }
    ]`;

    expect(parseCloudflareIngress(source)).toEqual([
      { service: "http_status:404" },
      { service: "http://127.0.0.1:7301" },
    ]);
  });

  it("keeps application ports private and documents free-tier boundary", () => {
    for (const port of ["7301", "7302", "7303", "8100", "8200"]) {
      expect(compose).toContain(`127.0.0.1:${port}:${port}`);
      expect(compose).not.toContain(`0.0.0.0:${port}`);
    }
    expect(design).toContain("free tier");
    expect(design).toContain("No Workers/edge functions");
    expect(readme).toContain("free-tier");
    expect(readme).toContain("paid WAF");
    expect(readme).toContain("separate approval");
  });
});

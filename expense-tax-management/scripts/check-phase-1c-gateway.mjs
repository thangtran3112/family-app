import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = join(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = join(appRoot, "..");
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

const securityHeaders = [
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
  ["X-Frame-Options", "DENY"],
  ["Permissions-Policy", "camera=(self), microphone=(), geolocation=()"],
  ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
  ["Cache-Control", "no-store"],
];

export function parseCloudflareIngress(source) {
  const ingressBody = source.match(/ingress\s*=\s*\[([\s\S]*?)\n\s*\]\s*\n/u)?.[1];
  if (!ingressBody) return [];

  return [...ingressBody.matchAll(/\{\s*([\s\S]*?)\n\s*\},/gu)].map(([, body]) => {
    const entry = {};
    for (const line of body.split("\n")) {
      const match = line.match(/^\s*(hostname|path|service)\s*=\s*(?:"([^"]+)"|(\S+))\s*$/u);
      if (match) entry[match[1]] = match[2] ?? match[3];
    }
    return entry;
  });
}

export function checkPhase1cGateway() {
  const failures = [];
  const includes = (source, value, label = value) => {
    if (!source.includes(value)) failures.push(`missing: ${label}`);
  };
  const excludes = (source, value, label = value) => {
    if (source.includes(value)) failures.push(`forbidden: ${label}`);
  };
  const before = (source, first, second, label) => {
    const firstIndex = source.indexOf(first);
    const secondIndex = source.indexOf(second);
    if (firstIndex === -1 || secondIndex === -1 || firstIndex >= secondIndex) {
      failures.push(`ordering: ${label}`);
    }
  };

  for (const [name, value] of securityHeaders) {
    for (const source of frontendConfigs) includes(source, name);
    for (const source of frontendConfigs) includes(source, value);
  }
  for (const source of frontendConfigs) {
    includes(source, 'source: "/:path*"', "frontend catch-all header route");
    excludes(source, "Content-Security-Policy", "frontend CSP");
  }

  for (const hostname of [
    "primary_hostname",
    "api_hostname",
    "capture_hostname",
    "office_hostname",
    "foundry_hostname",
  ]) includes(terraform, `var.${hostname}`);
  for (const route of [
    ["primary_hostname", "7301"],
    ["api_hostname", "8100"],
    ["capture_hostname", "7301"],
    ["office_hostname", "7302"],
  ]) {
    includes(
      terraform,
      `        hostname = var.${route[0]}\n        service  = "http://127.0.0.1:${route[1]}"`,
      `${route[0]} route mapping`,
    );
  }
  includes(
    terraform,
    '        hostname = var.foundry_hostname\n        path     = "/internal/v1/*"\n        service  = "http://127.0.0.1:8200"',
    "Foundry service route mapping",
  );
  includes(
    terraform,
    '        hostname = var.foundry_hostname\n        service  = "http://127.0.0.1:7303"',
    "Foundry web route mapping",
  );
  for (const port of ["7301", "8100", "7302", "8200", "7303"]) {
    includes(terraform, `http://127.0.0.1:${port}`, `loopback origin ${port}`);
    excludes(compose, `0.0.0.0:${port}`, `public origin ${port}`);
    includes(compose, `127.0.0.1:${port}:${port}`, `loopback publish ${port}`);
  }

  includes(terraform, 'path     = "/internal/v1/*"');
  includes(terraform, 'service  = "http://127.0.0.1:8200"');
  includes(terraform, 'service = "http_status:404"');
  before(
    terraform,
    'path     = "/internal/v1/*"',
    'service  = "http://127.0.0.1:7303"',
    "Foundry service route before Foundry web route",
  );
  const finalIngress = parseCloudflareIngress(terraform).at(-1);
  if (JSON.stringify(finalIngress) !== JSON.stringify({ service: "http_status:404" })) {
    failures.push("ordering: final ingress route must be exact http_status:404 catch-all");
  }

  if (/cloudflare_(access|worker|waf|rate_limit)/u.test(terraform)) {
    failures.push("forbidden: paid Cloudflare resource or product reference");
  }
  includes(design, "free tier", "free-tier cost boundary");
  includes(design, "No Workers/edge functions", "Workers exclusion");
  includes(readme, "free-tier Cloudflare Tunnel/DNS/proxy", "free-tier Cloudflare controls");
  includes(readme, "paid WAF", "paid WAF approval boundary");
  includes(readme, "separate approval", "paid control approval boundary");

  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = checkPhase1cGateway();
  if (failures.length > 0) {
    console.error(failures.map((failure) => `FAIL ${failure}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Phase 1C gateway static checks passed");
  }
}

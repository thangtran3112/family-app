import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const CONFIRMATION = "I-understand-private-smoke";

const requiredEnvironment = [
  "APP_API_URL",
  "FOUNDRY_URL",
  "CAPTURE_URL",
  "OFFICE_URL",
  "FAMILY_TENANT_ID",
  "MISMATCH_TENANT_ID",
  "CLERK_ISSUER_URL",
  "CLERK_TENANT_AUDIENCE",
  "CLERK_PLATFORM_AUDIENCE",
  "APP_M2M_AUDIENCE",
  "FOUNDRY_M2M_AUDIENCE",
  "THANG_TENANT_TOKEN",
  "THANG_PLATFORM_TOKEN",
  "TRAMILY_TENANT_TOKEN",
  "APP_M2M_TOKEN",
  "FOUNDRY_M2M_TOKEN",
  "WEBHOOK_REPLAY_URL",
  "WEBHOOK_REPLAY_BODY",
  "WEBHOOK_REPLAY_HEADERS_JSON",
];

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`missing required smoke input: ${name}`);
  }
  return value.trim();
}

function url(value, name) {
  const candidate = required(value, name);
  try {
    const parsed = new URL(candidate);
    if (!/^https?:$/u.test(parsed.protocol)) throw new Error("unsupported protocol");
  } catch {
    throw new Error(`invalid smoke URL: ${name}`);
  }
  return candidate.replace(/\/$/u, "");
}

function parseHeaders(value) {
  let headers;
  try {
    headers = JSON.parse(required(value, "WEBHOOK_REPLAY_HEADERS_JSON"));
  } catch {
    throw new Error("invalid smoke input: WEBHOOK_REPLAY_HEADERS_JSON");
  }
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error("invalid smoke input: WEBHOOK_REPLAY_HEADERS_JSON");
  }
  for (const name of ["svix-id", "svix-timestamp", "svix-signature"]) {
    required(headers[name], `WEBHOOK_REPLAY_HEADERS_JSON.${name}`);
  }
  return Object.fromEntries(Object.entries(headers).map(([name, headerValue]) => [name, String(headerValue)]));
}

export function parseSmokeConfig(env = process.env) {
  const values = Object.fromEntries(requiredEnvironment.map((name) => [name, env[name]]));
  const missing = requiredEnvironment.filter((name) => typeof values[name] !== "string" || values[name].trim() === "");
  if (missing.length > 0) throw new Error(`invalid smoke input: ${missing.join(", ")}`);

  return {
    appApiUrl: url(values.APP_API_URL, "APP_API_URL"),
    foundryUrl: url(values.FOUNDRY_URL, "FOUNDRY_URL"),
    captureUrl: url(values.CAPTURE_URL, "CAPTURE_URL"),
    officeUrl: url(values.OFFICE_URL, "OFFICE_URL"),
    tenantId: values.FAMILY_TENANT_ID.trim(),
    mismatchTenantId: values.MISMATCH_TENANT_ID.trim(),
    expectedIssuer: values.CLERK_ISSUER_URL.trim(),
    expectedTenantAudience: values.CLERK_TENANT_AUDIENCE.trim(),
    expectedPlatformAudience: values.CLERK_PLATFORM_AUDIENCE.trim(),
    expectedAppM2mAudience: values.APP_M2M_AUDIENCE.trim(),
    expectedFoundryM2mAudience: values.FOUNDRY_M2M_AUDIENCE.trim(),
    thangTenantToken: values.THANG_TENANT_TOKEN,
    thangPlatformToken: values.THANG_PLATFORM_TOKEN,
    tramilyTenantToken: values.TRAMILY_TENANT_TOKEN,
    appM2mToken: values.APP_M2M_TOKEN,
    foundryM2mToken: values.FOUNDRY_M2M_TOKEN,
    webhookReplayUrl: url(values.WEBHOOK_REPLAY_URL, "WEBHOOK_REPLAY_URL"),
    webhookReplayBody: values.WEBHOOK_REPLAY_BODY,
    webhookReplayHeaders: parseHeaders(values.WEBHOOK_REPLAY_HEADERS_JSON),
  };
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

export function redactHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name.toLowerCase() === "authorization" ? name : name,
    name.toLowerCase() === "authorization" ? "[REDACTED]" : value,
  ]));
}

function endpoint(base, path) {
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

export function buildSmokePlan(config) {
  return [
    { name: "app health", method: "GET", url: endpoint(config.appApiUrl, "/health/ready"), expectedStatus: 200 },
    { name: "foundry health", method: "GET", url: endpoint(config.foundryUrl, "/health/ready"), expectedStatus: 200 },
    { name: "capture health", method: "GET", url: endpoint(config.captureUrl, "/health/ready"), expectedStatus: 200 },
    { name: "office health", method: "GET", url: endpoint(config.officeUrl, "/health/ready"), expectedStatus: 200 },
    { name: "app no-token rejection", method: "GET", url: endpoint(config.appApiUrl, `/api/v1/tenants/${config.tenantId}`), expectedStatus: 401 },
    { name: "thang tenant app access", method: "GET", url: endpoint(config.appApiUrl, `/api/v1/tenants/${config.tenantId}`), expectedStatus: 200, token: config.thangTenantToken, expectedAudience: config.expectedTenantAudience },
    { name: "thang platform Foundry access", method: "GET", url: endpoint(config.foundryUrl, "/internal/v1/ai-models"), expectedStatus: 200, token: config.thangPlatformToken, expectedAudience: config.expectedPlatformAudience, expectedRole: "operator" },
    { name: "tramily Foundry denial", method: "GET", url: endpoint(config.foundryUrl, "/internal/v1/ai-models"), expectedStatus: 403, token: config.tramilyTenantToken, expectedAudience: config.expectedTenantAudience },
    { name: "tenant/org mismatch denial", method: "GET", url: endpoint(config.appApiUrl, `/api/v1/tenants/${config.mismatchTenantId}`), expectedStatus: 403, token: config.thangTenantToken, expectedAudience: config.expectedTenantAudience },
    { name: "app M2M audience", method: "GET", url: endpoint(config.appApiUrl, "/internal/v1/worker/auth-check"), expectedStatus: 200, token: config.appM2mToken, expectedAudience: config.expectedAppM2mAudience },
    { name: "Foundry M2M audience", method: "GET", url: endpoint(config.foundryUrl, "/internal/v1/worker/auth-check"), expectedStatus: 200, token: config.foundryM2mToken, expectedAudience: config.expectedFoundryM2mAudience },
    { name: "webhook delivery", method: "POST", url: config.webhookReplayUrl, expectedStatus: 202, body: config.webhookReplayBody, headers: config.webhookReplayHeaders, expectedReplay: false },
    { name: "webhook replay", method: "POST", url: config.webhookReplayUrl, expectedStatus: 202, body: config.webhookReplayBody, headers: config.webhookReplayHeaders, expectedReplay: true },
  ];
}

async function boundedFetch(fetchImpl, urlValue, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(urlValue, { ...options, signal: controller.signal });
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("response exceeded smoke limit");
    let body = null;
    if (text !== "") {
      try { body = JSON.parse(text); } catch { body = {}; }
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function verifiedClaims(body) {
  return body && typeof body === "object" && body.claimsVerified && typeof body.claimsVerified === "object"
    ? body.claimsVerified
    : undefined;
}

function claimMetadata(claims) {
  if (!claims) return undefined;
  return Object.fromEntries(["issuer", "audience", "subject", "role", "tenantId", "organizationId"]
    .filter((key) => claims[key] !== undefined)
    .map((key) => [key, claims[key]]));
}

function assertClaimMetadata(check, body) {
  if (!check.expectedAudience && !check.expectedRole) return;
  const claims = verifiedClaims(body);
  if (!claims) throw new Error("service did not return verified claim metadata");
  if (claims.issuer !== undefined && claims.issuer !== check.expectedIssuer) throw new Error("issuer metadata mismatch");
  if (claims.audience !== check.expectedAudience) throw new Error("audience metadata mismatch");
  if (check.expectedRole && claims.role !== check.expectedRole) throw new Error("role metadata mismatch");
}

function assertReplay(check, body) {
  if (check.expectedReplay && body?.replayed !== true) throw new Error("webhook replay marker missing");
  if (check.expectedReplay === false && body?.replayed === true) throw new Error("initial webhook delivery marked replayed");
}

export async function runSmokeTests(config, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const logger = options.logger ?? console.log;
  const results = [];
  const plan = buildSmokePlan(config);
  for (const check of plan) {
    try {
      const headers = { ...(check.headers ?? {}), ...(check.token ? bearer(check.token) : {}) };
      const result = await boundedFetch(fetchImpl, check.url, {
        method: check.method,
        headers,
        body: check.body,
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      if (result.status !== check.expectedStatus) throw new Error(`expected ${check.expectedStatus}, got ${result.status}`);
      if (result.status >= 200 && result.status < 300) {
        assertClaimMetadata({ ...check, expectedIssuer: config.expectedIssuer }, result.body);
      }
      assertReplay(check, result.body);
      const metadata = claimMetadata(verifiedClaims(result.body));
      logger(`PASS ${check.name} status=${result.status}${metadata ? ` claims=${JSON.stringify(metadata)}` : ""}`);
      results.push({ name: check.name, status: result.status, passed: true, metadata });
    } catch (error) {
      logger(`FAIL ${check.name} ${error instanceof Error ? error.message : "request failed"}`);
      results.push({ name: check.name, passed: false, error: error instanceof Error ? error.message : "request failed" });
    }
  }
  return {
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    results,
    errors: results.filter((result) => !result.passed).map((result) => result.error),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.argv.includes("--execute") || process.env.PRODUCTION_AUTH_SMOKE_CONFIRM !== CONFIRMATION) {
    console.error(`refusing smoke execution: pass --execute and PRODUCTION_AUTH_SMOKE_CONFIRM=${CONFIRMATION}`);
    process.exitCode = 2;
  } else {
    try {
      const result = await runSmokeTests(parseSmokeConfig());
      process.exitCode = result.failed === 0 ? 0 : 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : "invalid smoke configuration");
      process.exitCode = 2;
    }
  }
}

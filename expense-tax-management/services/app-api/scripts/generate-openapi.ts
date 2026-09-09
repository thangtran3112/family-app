import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AppConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

const unusedVerifier = {
  verify: async () => {
    throw new Error("OpenAPI generation must not verify a token");
  },
};

const config: AppConfig = {
  service: "app-api",
  version: "0.1.0",
  port: 8100,
  databaseUrl: "postgresql://openapi-generator.invalid/app",
  auth: {
    tenant: {
      issuer: "https://identity.generator.invalid",
      audience: "expense-app",
      jwksUrl: "https://identity.generator.invalid/jwks",
    },
    service: {
      issuer: "https://services.generator.invalid",
      audience: "expense-app-internal",
      jwksUrl: "https://services.generator.invalid/jwks",
    },
  },
  temporal: {
    address: "generator.invalid:7233",
    namespace: "generator-invalid",
  },
  storage: {
    backend: "local",
    localDir: "/tmp/expense-tax-generator-storage",
    baseUrl: "https://generator.invalid",
    urlSigningKey: "generator-signing-key",
  },
};

const outputPath = process.env.OPENAPI_OUTPUT_PATH
  ? path.resolve(process.env.OPENAPI_OUTPUT_PATH)
  : fileURLToPath(
      new URL(
        "../../../packages/contracts/generated/openapi/app-api.openapi.json",
        import.meta.url,
      ),
    );

const app = buildApp({
  config,
  logger: false,
  authVerifiers: {
    tenant: unusedVerifier,
    service: unusedVerifier,
  },
});

try {
  await app.ready();
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(sortJson(app.swagger()), null, 2)}\n`,
    "utf8",
  );
} finally {
  await app.close();
}

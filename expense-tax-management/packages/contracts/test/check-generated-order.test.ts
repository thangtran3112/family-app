import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const checkerSource = readFileSync(
  new URL("../scripts/check-generated.mjs", import.meta.url),
  "utf8",
);

describe("generated contract checker build order", () => {
  it("builds gateway policy before generating service OpenAPI", () => {
    const gatewayBuild = checkerSource.indexOf(
      '"@expense-tax/gateway-policy", "run", "build"',
    );
    const appOpenApi = checkerSource.indexOf(
      '"@expense-tax/app-api", "run", "generate:openapi"',
    );
    const foundryOpenApi = checkerSource.indexOf(
      '"@expense-tax/foundry-service", "run", "generate:openapi"',
    );

    expect(gatewayBuild).toBeGreaterThanOrEqual(0);
    expect(appOpenApi).toBeGreaterThan(gatewayBuild);
    expect(foundryOpenApi).toBeGreaterThan(gatewayBuild);
  });
});

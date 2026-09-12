import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const checkerSource = readFileSync(
  new URL("../scripts/check-generated.mjs", import.meta.url),
  "utf8",
);
const rootPackage = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };

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

  it.each(["typecheck", "ci:typecheck"])(
    "builds gateway policy before %s service typechecks",
    (scriptName) => {
      const script = rootPackage.scripts[scriptName] ?? "";
      const gatewayBuild = script.indexOf(
        "pnpm --filter @expense-tax/gateway-policy --fail-if-no-match run build",
      );
      const appTypecheck = script.indexOf(
        "@expense-tax/app-api",
      );
      const foundryTypecheck = script.indexOf(
        "@expense-tax/foundry-service",
      );

      expect(gatewayBuild).toBeGreaterThanOrEqual(0);
      expect(appTypecheck).toBeGreaterThan(gatewayBuild);
      expect(foundryTypecheck).toBeGreaterThan(gatewayBuild);
    },
  );
});

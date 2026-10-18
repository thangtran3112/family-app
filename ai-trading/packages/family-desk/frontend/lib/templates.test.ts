import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { StrategySpecV1Schema } from "@ai-trading/contracts";
import { STRATEGY_TEMPLATES } from "./templates.ts";

test("every shipped strategy template parses with the contract schema", () => {
  for (const template of STRATEGY_TEMPLATES) {
    assert.deepEqual(StrategySpecV1Schema.parse(template.spec), template.spec, template.slug);
  }
});

test("template manifest matches JSON files shipped by contracts", async () => {
  const directory = new URL("../../contracts/templates/", import.meta.url);
  const files = (await readdir(directory)).filter((file) => file.endsWith(".json")).sort();
  assert.deepEqual(STRATEGY_TEMPLATES.map(({ slug }) => `${slug}.json`).sort(), files);
});

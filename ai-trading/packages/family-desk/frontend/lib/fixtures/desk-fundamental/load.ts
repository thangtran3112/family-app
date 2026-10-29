import { readFileSync } from "node:fs";

// Unit-test fixtures only (02n §h step 3b): copied from backend/tests/fixtures/desk-fundamental/api by
// scripts/sync-desk-fixtures.mjs. Screens never import this module.
export function loadFundamentalFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./api/${name}.json`, import.meta.url), "utf8"));
}

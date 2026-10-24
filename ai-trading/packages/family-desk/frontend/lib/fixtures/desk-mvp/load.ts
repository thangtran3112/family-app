import { readFileSync } from "node:fs";

// Unit-test fixtures only (02m §c4): copied from backend/tests/fixtures/desk-mvp/api by
// scripts/sync-desk-fixtures.mjs. Screens never import this module.
export function loadDeskFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./api/${name}.json`, import.meta.url), "utf8"));
}

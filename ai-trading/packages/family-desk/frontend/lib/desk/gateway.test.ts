import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { DeskStatus } from "../api/schemas.ts";
import { containsBannedTerm } from "./freshness.ts";
import { gatewayLine } from "./gateway.ts";

const rows: Array<[DeskStatus["gateway"], string]> = [
  ["not_configured", "Live IBKR quotes: not turned on · using delayed quotes"],
  ["down", "Live IBKR quotes: waiting for IBKR sign-in · using delayed quotes"],
  ["reconnecting", "Live IBKR quotes: reconnecting… · using delayed quotes"],
  ["connected", "Live IBKR quotes: connected"],
];

test("each gateway state yields its exact copy", () => {
  for (const [state, line] of rows) assert.equal(gatewayLine(state), line);
});

test("no gateway line contains a banned term", () => {
  for (const [state] of rows) assert.equal(containsBannedTerm(gatewayLine(state)), false, state);
});

test("BrokerRowsDisabled stays order-free: every input is disabled and no handlers or order calls", () => {
  const source = readFileSync(new URL("../../components/settings/desktop/BrokerRowsDisabled.tsx", import.meta.url), "utf8");
  const inputs = source.match(/<input[\s\S]*?\/>/g) ?? [];
  assert.ok(inputs.length > 0, "expected at least one <input");
  for (const input of inputs) assert.match(input, /\sdisabled\s/);
  for (const forbidden of ["onChange", "onClick", "onSubmit", "fetch(", "placeOrder"]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

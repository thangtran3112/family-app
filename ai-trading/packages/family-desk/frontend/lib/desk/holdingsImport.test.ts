import assert from "node:assert/strict";
import test from "node:test";
import { createDeskApiClient, DeskApiError } from "../api/client.ts";
import { loadFundamentalFixture } from "../fixtures/desk-fundamental/load.ts";
import { containsBannedTerm } from "./freshness.ts";
import { importErrorText, runHoldingsImport } from "./holdingsImport.ts";

const clientAnswering = (status: number, body: unknown) =>
  createDeskApiClient(async () => Response.json(body, { status }), () => ({ href: "https://trading.test/" }));

test("a started import returns the running state", async () => {
  const result = await runHoldingsImport({ client: clientAnswering(202, loadFundamentalFixture("holdings_import")) });
  assert.equal(result.ok && result.state.state, "running");
});

test("each refusal has its own plain words", async () => {
  const texts = new Map<number, string>();
  for (const status of [409, 503, 404, 500]) {
    const result = await runHoldingsImport({ client: clientAnswering(status, { detail: "x" }) });
    assert.equal(result.ok, false);
    if (!result.ok) texts.set(status, result.text);
  }
  assert.equal(texts.get(409), "An import ran in the last minute · try again shortly");
  assert.equal(texts.get(503), "Holdings aren't connected yet · set up the IBKR import in Settings");
  assert.equal(texts.get(404), "No holdings imported for you");
  assert.equal(texts.get(500), "Couldn't import holdings · Try again");
  for (const text of texts.values()) assert.equal(containsBannedTerm(text), false, text);
  assert.equal(importErrorText(new DeskApiError("malformed")), "Couldn't import holdings · Try again");
});

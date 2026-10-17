import assert from "node:assert/strict";
import test from "node:test";
import { hubLoginUrl } from "./auth.ts";

test("hubLoginUrl returns the hub login with the Desk URL as returnTo", () => {
  assert.equal(
    hubLoginUrl("https://trading.tobytran.dev/"),
    "https://trading-hub.tobytran.dev/login?returnTo=https%3A%2F%2Ftrading.tobytran.dev%2F",
  );
});

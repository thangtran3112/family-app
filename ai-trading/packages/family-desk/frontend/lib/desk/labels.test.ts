import assert from "node:assert/strict";
import test from "node:test";
import { indicatorName } from "./labels.ts";

test("indicator acronyms stay capitalised and other names are title-cased", () => {
  assert.deepEqual(
    ["rsi", "cci", "adx", "sma_10", "ema_200", "macd", "awesome_oscillator", "williams_r"].map(indicatorName),
    ["RSI", "CCI", "ADX", "SMA 10", "EMA 200", "MACD", "Awesome Oscillator", "Williams R"],
  );
});

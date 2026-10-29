import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MASK_VALUES, formatQuantity, formatSignedUsd, formatUsd, formatUsdPrice, MASK, maskedQuantity, maskedSignedUsd, maskedText, maskedUsd, readMaskValues, withMaskValues } from "./mask.ts";
import { BANNED_TERMS } from "./freshness.ts";

test("values are hidden by default and only an explicit false shows them", () => {
  assert.equal(DEFAULT_MASK_VALUES, true);
  assert.equal(readMaskValues({}), true);
  assert.equal(readMaskValues({ mask_values: true }), true);
  assert.equal(readMaskValues({ mask_values: "no" }), true);
  assert.equal(readMaskValues({ mask_values: false }), false);
  assert.deepEqual(withMaskValues({ pause_all: true }, false), { pause_all: true, mask_values: false });
});

test("masking hides dollars, shares and contracts and leaves prices alone", () => {
  assert.equal(maskedUsd(true, 208260), MASK);
  assert.equal(maskedUsd(false, 208260), "$208,260");
  assert.equal(maskedSignedUsd(true, -310), MASK);
  assert.equal(maskedSignedUsd(false, -310), "−$310");
  assert.equal(maskedSignedUsd(false, 1204), "+$1,204");
  assert.equal(maskedQuantity(true, 1250), MASK);
  assert.equal(maskedQuantity(false, 1250), "1,250");
  assert.equal(maskedText(true, "120 shares: under one contract at a 50% cap"), MASK);
  assert.equal(maskedText(false, "120 shares"), "120 shares");
  // A missing value is a dash, masked or not: there is nothing to hide.
  assert.equal(maskedUsd(true, null), "—");
  assert.equal(maskedQuantity(true, undefined), "—");
  // A per-share price never goes through the mask.
  assert.equal(formatUsdPrice(231.4), "$231.40");
});

test("dollar formatting never prints null, NaN or negative zero", () => {
  assert.equal(formatUsd(null), "—");
  assert.equal(formatUsd(Number.NaN), "—");
  assert.equal(formatUsd(-0.2), "$0");
  assert.equal(formatUsd(-1234.5, { cents: true }), "−$1,234.50");
  assert.equal(formatSignedUsd(0), "$0");
  assert.equal(formatQuantity(12.5), "12.5");
  for (const text of [MASK, formatUsd(null), formatSignedUsd(null), formatQuantity(null)]) assert.equal(BANNED_TERMS.some((pattern) => pattern.test(text)), false, text);
});

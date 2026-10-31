import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { chartPalette } from "./chartPalette.ts";

// Canvas and SVG cannot read CSS variables, so lib/desk/chartPalette.ts repeats the Desk colours. This test keeps the copy
// honest: every base colour must equal its token in app/globals.css, and every alpha variant must equal its base.

const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

function token(name: string): string {
  const found = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
  assert.ok(found, `${name} is a hex token in globals.css`);
  return found[1].toUpperCase();
}

const BASE_TOKENS = {
  ground: "--color-ground",
  hairline: "--color-hairline",
  text: "--color-text",
  muted: "--color-muted",
  amber: "--color-amber",
  up: "--color-up",
  down: "--color-down",
  ai: "--color-ai",
  price: "--color-chart-price",
  alt: "--color-chart-alt",
} as const;

test("each base chart colour equals its globals.css token", () => {
  for (const [key, name] of Object.entries(BASE_TOKENS)) {
    assert.equal(chartPalette[key as keyof typeof BASE_TOKENS].toUpperCase(), token(name), `${key} vs ${name}`);
  }
});

test("every palette entry is a base colour with a token, or a known alpha variant", () => {
  const variants = ["mutedFaint", "downHalf", "upHalf", "priceFillTop", "priceFillBottom", "clear"];
  assert.deepEqual(Object.keys(chartPalette).sort(), [...Object.keys(BASE_TOKENS), ...variants].sort());
});

test("alpha variants keep their base colour", () => {
  assert.equal(chartPalette.mutedFaint, `${chartPalette.muted}66`);
  assert.equal(chartPalette.downHalf, `${chartPalette.down}80`);
  assert.equal(chartPalette.upHalf, `${chartPalette.up}80`);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(chartPalette.price.slice(i, i + 2), 16));
  assert.equal(chartPalette.priceFillTop, `rgba(${r},${g},${b},0.24)`);
  assert.equal(chartPalette.priceFillBottom, `rgba(${r},${g},${b},0)`);
});

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import test from "node:test";

// Design-system ratchet (design-component-system §7, DS-0): counts the style debt that tokens and components/ui primitives
// replace, across components/**/*.css, and fails when any count RISES above its baseline. Migrating a module lowers a
// count; the same commit lowers the baseline below, which is how progress shows. Never raise a baseline: use a token
// (app/globals.css) or a components/ui primitive instead. Modelled on lib/lanePurity.test.ts.

const root = new URL("../../components/", import.meta.url);

function stylesheets(dir: URL = root): string[] {
  return readdirSync(dir).flatMap((name) => {
    const child = new URL(name + (statSync(new URL(name, dir)).isDirectory() ? "/" : ""), dir);
    if (child.pathname.endsWith("/")) return stylesheets(child);
    return name.endsWith(".css") ? [child.pathname] : [];
  });
}

const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "");
const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

/** Rules whose selector list names the class: one per rule block, so `.button` and `.button:hover` are two rules. */
function selectorRules(text: string, className: string): number {
  const named = new RegExp(`\\.${className}(?![\\w-])`);
  return [...text.matchAll(/([^{}]+)\{/g)].filter(([, prelude]) => !prelude.trim().startsWith("@") && named.test(prelude)).length;
}

const METRICS = {
  "raw hex colours": (text: string) => count(text, /#[0-9a-fA-F]{3,8}\b/g),
  "raw font-size: Npx": (text: string) => count(text, /font-size:\s*\d+(\.\d+)?px/g),
  "raw border-radius: Npx": (text: string) => count(text, /border-radius:\s*\d+(\.\d+)?px/g),
  "outline: 2px solid restatements (use var(--focus-ring))": (text: string) => count(text, /outline:\s*2px solid/g),
  "local .button rules (use components/ui Button)": (text: string) => selectorRules(text, "button"),
  "local .chip rules (use components/ui Badge)": (text: string) => selectorRules(text, "chip"),
  "local .srOnly / .visuallyHidden rules (use .sr-only)": (text: string) => selectorRules(text, "srOnly") + selectorRules(text, "visuallyHidden"),
} as const;

/** Checked in 2026-11-01 at the start of DS-0. Lower a number in the commit that removes the debt; never raise one. */
const BASELINE: Record<keyof typeof METRICS, number> = {
  "raw hex colours": 71,
  "raw font-size: Npx": 131,
  "raw border-radius: Npx": 33,
  "outline: 2px solid restatements (use var(--focus-ring))": 77,
  "local .button rules (use components/ui Button)": 75,
  "local .chip rules (use components/ui Badge)": 32,
  "local .srOnly / .visuallyHidden rules (use .sr-only)": 17,
};

const files = stylesheets();
const texts = files.map((file) => withoutComments(readFileSync(file, "utf8")));

test("the scan found the component stylesheets", () => {
  assert.ok(files.length > 40, `found ${files.length} stylesheets`);
});

for (const [name, measure] of Object.entries(METRICS)) {
  test(`token ratchet: ${name} stays at or below its baseline`, () => {
    const total = texts.reduce((sum, text) => sum + measure(text), 0);
    const baseline = BASELINE[name as keyof typeof METRICS];
    assert.ok(total <= baseline, `${name}: ${total} now, baseline ${baseline}. Use a token or a components/ui primitive instead of adding more.`);
    if (total < baseline) console.log(`# ratchet: ${name} fell to ${total} (baseline ${baseline}): lower the baseline in this commit`);
  });
}

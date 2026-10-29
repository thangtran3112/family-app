import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import test from "node:test";

// Lane purity (02n §a "Lane rules", §j): the Fundamental view never shows technical indicators, setups, the screener or
// an order control, and the Technical view never shows fundamentals or covered calls. A text scan of the component
// folders, so a stray label fails the unit tests, not a reviewer's eye.

const root = new URL("../components/", import.meta.url);

function sources(dir: string): string[] {
  const base = new URL(`${dir}/`, root);
  const found: string[] = [];
  const walk = (path: URL) => {
    for (const name of readdirSync(path)) {
      const child = new URL(name + (statSync(new URL(name, path)).isDirectory() ? "/" : ""), path);
      if (child.pathname.endsWith("/")) walk(child);
      else if (/\.(tsx?|css)$/.test(name) && !/\.test\./.test(name)) found.push(child.pathname);
    }
  };
  walk(base);
  return found;
}

/** The code a person can read on screen is what matters: comments in a source file may name what the lane leaves out. */
const withoutComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const FUNDAMENTAL_BANNED = [/\bRSI\b/, /\bMACD\b/, /\bVWAP\b/, /\bORB\b/, /\bScreener\b/, /\bStoch/, /position sizer/i, /\bplace (an )?order\b/i, /\bPaper (sell|roll)\b/i];
const TECHNICAL_BANNED = [/\bP\/E\b/, /\bFCF\b/, /covered call/i];

test("Fundamental components never name technical indicators, setups, the screener or an order control", () => {
  const files = sources("fundamental");
  assert.ok(files.length > 5, "the scan found the Fundamental components");
  for (const file of files) {
    const text = withoutComments(readFileSync(file, "utf8"));
    for (const pattern of FUNDAMENTAL_BANNED) assert.equal(pattern.test(text), false, `${file} matches ${pattern}`);
  }
});

test("Technical components never name fundamentals or covered calls", () => {
  for (const dir of ["technicals", "screener", "alerts", "dashboard", "watchlists", "strategies", "charts", "workspace"]) {
    for (const file of sources(dir)) {
      const text = withoutComments(readFileSync(file, "utf8"));
      for (const pattern of TECHNICAL_BANNED) assert.equal(pattern.test(text), false, `${file} matches ${pattern}`);
    }
  }
});

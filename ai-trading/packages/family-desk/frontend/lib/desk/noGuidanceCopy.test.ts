import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import test from "node:test";
import { HUB_SWING_COPY } from "../replay/hubSwing.ts";
import { SWING_PLAY_COPY } from "../replay/playView.ts";
import { WEEK_TEXT } from "../replay/weekScreen.ts";
import { PRACTICE_COPY } from "./freshness.ts";

// Owner rulings (2026-11-02, ADR-0022): the date and time of a thread are always shown (no hidden day, no "Show date", no spoiler protection),
// there is no practice window that ends at 11:30 and no rule that asks for a stop on every entry. The words for any of them are gone; this
// keeps them out. A stored plan's `hideDates` and a thread's `stopNoteOnEntry` are accepted by the server and ignored; they are field names, not copy.

const BANNED = /hidden day|hide dates?|show date|replayed market date|spoil|practice window|stop on every entry/i;

test("no Practice copy string talks about a hidden day, hiding dates, a practice window or a stop on every entry", () => {
  const tables: Array<[string, Record<string, string>]> = [
    ["PRACTICE_COPY", PRACTICE_COPY],
    ["HUB_SWING_COPY", HUB_SWING_COPY],
    ["SWING_PLAY_COPY", SWING_PLAY_COPY],
    ["WEEK_TEXT", WEEK_TEXT as Record<string, string>],
  ];
  for (const [name, table] of tables) {
    for (const [key, value] of Object.entries(table)) {
      if (typeof value === "string") assert.equal(BANNED.test(value), false, `${name}.${key}: ${value}`);
    }
  }
});

const root = new URL("../../", import.meta.url);
const sources = (dir: URL): string[] =>
  readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name === ".next" || name === "out" || name === "api") return [];
    const child = new URL(name + (statSync(new URL(name, dir)).isDirectory() ? "/" : ""), dir);
    if (child.pathname.endsWith("/")) return sources(child);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !/Fixtures?\.ts$/.test(name) && !/^fixtures\//.test(name) ? [child.pathname] : [];
  });

test("no screen or view source spells those words either: the strings a screen builds itself are held to the same ruling", () => {
  const files = ["app/", "components/", "lib/"].flatMap((dir) => sources(new URL(dir, root)));
  assert.ok(files.length > 100, `${files.length} source files read`);
  for (const file of files) {
    if (file.endsWith("/lib/desk/noGuidanceCopy.test.ts")) continue;
    const match = BANNED.exec(readFileSync(file, "utf8"));
    assert.equal(match, null, `${file.slice(root.pathname.length)}: "${match?.[0]}"`);
  }
});

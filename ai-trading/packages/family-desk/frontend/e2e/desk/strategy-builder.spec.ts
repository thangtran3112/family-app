import type { Condition } from "@ai-trading/contracts";
import type { Page } from "@playwright/test";
import { api } from "../helpers";
import { test, expect, prepareDesk, openDesk } from "./helpers";

// The Strategy builder's When block is the shared condition tree (conditions PR-B, design-conditions.md §6.2): the only editor
// that can author nested rules, so every node kind, the child limits and the read-only path are exercised here.

type Version = { id: number; version: number; spec: { when: Condition } };

const leaf: Condition = { op: "gte", left: { series: "close" }, right: { value: 0 } };
const all = (...children: Condition[]): Condition => ({ all: children });
const any = (...children: Condition[]): Condition => ({ any: children });
const not = (child: Condition): Condition => ({ not: child });

/** One node of the tree, by its dotted position (`1` is the root, `1.2` the second child of the root). */
const node = (page: Page, position: string) => page.getByRole("group", { name: `Condition ${position}`, exact: true });

/** The tree itself: the `Conditions` fieldset the builder mounts with a hidden legend. */
const tree = (page: Page) => page.getByRole("group", { name: "Conditions", exact: true });

/** The save bar: the builder names it for the version it writes. */
const saveBar = (page: Page) => page.getByRole("region", { name: "Save strategy" });

/** Writes a draft strategy whose v1 is `when`, the way the API and the other specs do, and returns its id. */
async function createDraft(page: Page, name: string, when: Condition): Promise<number> {
  const created = await api(page, "/api/desk/strategies", { method: "POST", data: { name } });
  expect(created.ok()).toBeTruthy();
  const { id } = (await created.json()) as { id: number };
  const saved = await api(page, `/api/desk/strategies/${id}/versions`, {
    method: "POST",
    data: {
      spec: {
        schemaVersion: 1,
        name,
        watch: { universe: { watchlist: "Day movers" }, session: "regular", runOn: "bar_close_1m" },
        when,
        then: { alert: { channels: ["inbox"] } },
      },
      change_note: "initial version",
    },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  return id;
}

/** The spec the builder's JSON panel shows: the stored version, not the live form. */
async function shownSpec(page: Page): Promise<{ when: Condition }> {
  await page.getByText("View JSON", { exact: true }).click();
  const text = await page.locator("details").filter({ hasText: "View JSON" }).locator("pre").innerText();
  return JSON.parse(text) as { when: Condition };
}

async function savedWhen(page: Page, id: number): Promise<Condition> {
  const response = await api(page, `/api/desk/strategies/${id}/versions`);
  expect(response.ok()).toBeTruthy();
  const versions = (await response.json()) as Version[];
  return versions.at(-1)!.spec.when;
}

test.beforeEach(async ({ context }) => prepareDesk(context, "technical"));

test("builds a nested rule and saves it", async ({ page }) => {
  const id = await createDraft(page, "Nested rule", leaf);
  await openDesk(page, `/strategies?id=${id}`);
  await expect(tree(page)).toBeVisible();

  // A leaf root grows into a group; the new row takes the focus.
  await page.getByRole("button", { name: "Add condition to 1" }).click();
  await expect(node(page, "1.2")).toBeVisible();
  await node(page, "1.2").getByRole("combobox", { name: "Condition type" }).selectOption("any");
  await page.getByRole("button", { name: "Add condition to 1.2" }).click();
  const window = node(page, "1.2.2");
  await window.getByRole("combobox", { name: "Condition type" }).selectOption("time_between");
  await window.getByRole("textbox", { name: "Start (ET)" }).fill("09:45");
  await window.getByRole("textbox", { name: "End (ET)" }).fill("15:30");
  await node(page, "1.1").getByRole("combobox", { name: "Condition type" }).selectOption("not");

  const expected = all(
    not(leaf),
    any(leaf, { op: "time_between", start: "09:45", end: "15:30" }),
  );
  await page.getByRole("button", { name: "Save as v2" }).click();
  await expect(page.getByText("Versions · 2")).toBeVisible();
  expect((await shownSpec(page)).when).toEqual(expected);
  expect(await savedWhen(page, id)).toEqual(expected);
});

test("a pattern preset opens and edits", async ({ page }) => {
  const pattern: Condition = { op: "pattern", pattern: "hammer", trend: "after_downtrend", trendBars: 5, withinBars: 1 };
  const id = await createDraft(page, "Hammer", pattern);
  await openDesk(page, `/strategies?id=${id}`);
  // Before this swap a pattern leaf crashed the builder; the fields are the alerts' own.
  await expect(node(page, "1").getByRole("combobox", { name: "Pattern" })).toHaveValue("hammer");
  await expect(node(page, "1").getByRole("combobox", { name: "Trend" })).toHaveValue("after_downtrend");
  await expect(page.getByRole("region", { name: "When" }).getByRole("alert")).toHaveCount(0);

  await node(page, "1").getByRole("combobox", { name: "Trend" }).selectOption("after_uptrend");
  await page.getByRole("button", { name: "Save as v2" }).click();
  await expect(page.getByText("Versions · 2")).toBeVisible();
  const expected = { ...pattern, trend: "after_uptrend" } as Condition;
  expect((await shownSpec(page)).when).toEqual(expected);
  expect(await savedWhen(page, id)).toEqual(expected);
});

test("the limits hold: Remove at one child, Add at twenty, no new nesting at the cap", async ({ page }) => {
  const single = await createDraft(page, "One child", all(leaf));
  await openDesk(page, `/strategies?id=${single}`);
  await expect(page.getByRole("button", { name: "Remove condition 1.1" })).toBeDisabled();
  const add = page.getByRole("button", { name: "Add condition to 1" });
  await expect(add).toBeEnabled();
  for (let count = 1; count < 20; count += 1) await add.click();
  await expect(node(page, "1.20")).toBeVisible();
  await expect(add).toBeDisabled();
  await expect(page.getByRole("button", { name: "Remove condition 1.20" })).toBeEnabled();

  const deep = await createDraft(page, "Four levels", all(all(all(all(leaf)))));
  await openDesk(page, `/strategies?id=${deep}`);
  const atCap = node(page, "1.1.1.1.1").getByRole("combobox", { name: "Condition type" });
  for (const kind of ["all", "any", "not"]) await expect(atCap.locator(`option[value="${kind}"]`)).toBeDisabled();
  const belowCap = node(page, "1.1.1.1").getByRole("combobox", { name: "Condition type" }).first();
  for (const kind of ["all", "any", "not"]) await expect(belowCap.locator(`option[value="${kind}"]`)).toBeEnabled();
});

test("a bad number shows beside its row, in plain words", async ({ page }) => {
  const id = await createDraft(page, "SMA length", all({ op: "gte", left: { series: "sma", length: 20 }, right: { value: 0 } }));
  await openDesk(page, `/strategies?id=${id}`);
  const row = node(page, "1.1");
  await row.getByRole("spinbutton", { name: "Metric length" }).fill("");

  const error = row.getByRole("alert");
  await expect(error).toHaveText("Enter a number.");
  await expect(page.getByText(/when\./)).toHaveCount(0);
  await expect(page.getByText(/Too small/)).toHaveCount(0);
  await expect(saveBar(page)).toContainText("Can't save yet");
  await expect(page.getByRole("button", { name: "Save as v2" })).toBeDisabled();
});

test("keyboard: Tab follows the row, Add focuses the new row, Remove focuses Add, every group is named once", async ({ page }) => {
  const id = await createDraft(page, "Keyboard", all(leaf));
  await openDesk(page, `/strategies?id=${id}`);

  await node(page, "1.1").getByRole("combobox", { name: "Condition type" }).focus();
  await page.keyboard.press("Tab");
  await expect(node(page, "1.1").getByRole("combobox", { name: "Metric" })).toBeFocused();

  await page.getByRole("button", { name: "Add condition to 1" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator('[aria-label="Condition 1.2"] select').first()).toBeFocused();

  await page.getByRole("button", { name: "Remove condition 1.2" }).click();
  await expect(page.getByRole("button", { name: "Add condition to 1" })).toBeFocused();

  const labels = await page.locator('[role="group"][aria-label^="Condition "]').evaluateAll((nodes) => nodes.map((item) => item.getAttribute("aria-label")));
  expect(new Set(labels).size).toBe(labels.length);
});

test("an older version is read-only", async ({ page }) => {
  const id = await createDraft(page, "Two versions", all(leaf));
  await api(page, `/api/desk/strategies/${id}/versions`, {
    method: "POST",
    data: {
      spec: {
        schemaVersion: 1,
        name: "Two versions",
        watch: { universe: { watchlist: "Day movers" }, session: "regular", runOn: "bar_close_1m" },
        when: all(leaf, not(leaf)),
        then: { alert: { channels: ["inbox"] } },
      },
      change_note: "second version",
    },
  });
  await openDesk(page, `/strategies?id=${id}`);
  await expect(node(page, "1.2")).toBeVisible();

  await page.getByRole("button", { name: /^v1 / }).click();
  await expect(saveBar(page)).toContainText("Older version");
  await expect(node(page, "1.1").getByRole("combobox", { name: "Condition type" })).toBeDisabled();
  await expect(node(page, "1.1").getByRole("combobox", { name: "Metric" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Add condition to 1" })).toBeDisabled();
  await expect(node(page, "1.2")).toHaveCount(0);
});

test("opening a strategy does not mark it dirty", async ({ page }) => {
  const id = await createDraft(page, "Clean", all(leaf));
  await openDesk(page, `/strategies?id=${id}`);
  await expect(tree(page)).toBeVisible();
  await expect(page.getByText("No changes yet")).toBeVisible();
  await expect(page.getByText("Unsaved changes")).toHaveCount(0);
});

test("a depth-4 rule fits at 1180", async ({ page }) => {
  const id = await createDraft(page, "Deep", all(all(all(all(leaf, leaf), leaf), leaf), leaf));
  await openDesk(page, `/strategies?id=${id}`);
  await expect(node(page, "1.1.1.1.1")).toBeVisible();
  const overflow = await page.locator('[aria-label="Strategy Deep"]').evaluate((pane) => pane.scrollWidth - pane.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
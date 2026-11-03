import type { Page } from "@playwright/test";
import { OPERAND_CATALOG } from "../../lib/desk/operands.ts";
import { expect, openDesk, prepareDesk, test } from "./helpers";

// D-205: one box, one name. The error summary above a form names a field exactly as the box under it is labelled, for every operand the
// condition kit offers (the screener's filter editor and the alert setup share it), on both sides of a comparison.
// D-242: the same box is also marked invalid and described by the line under its row that holds the sentence, and unmarked again once the value is good.

const KIT = OPERAND_CATALOG.filter((def) => def.params.length > 0);

/** The summary's lines: the list inside the alert that carries "N problems to fix". */
const summary = (page: Page) => page.getByRole("alert").filter({ hasText: /problems? to fix/ }).first().locator("li");

/** The pickers that hold the kit's number boxes: a condition's two sides, and (in the screener editor) Rank by. */
type Side = "Metric" | "Compared with" | "Rank by";

/** The summary line a box's problem starts with: where the operand sits, then the box's own label. */
const lineStart = (side: Side, box: string) => (side === "Rank by" ? `Rank by · ${box}: ` : `Condition · ${side} · ${box}: `);

const pick = (page: Page, name: string, option: string) => page.getByLabel(name, { exact: true }).first().selectOption({ label: option });

/** Sets one picker to `label` and every other picker to a plain number (or Close), so the only number boxes on screen are the metric's and each label is unique. */
async function setSide(page: Page, side: Side, label: string) {
  if (side !== "Metric") await pick(page, "Metric", "Close");
  if (side !== "Compared with") await pick(page, "Compared with", "Number");
  await pick(page, side, label);
}

/** Puts every number box of the metric one above its allowed top, then checks each summary line names its box as the box itself is labelled
 *  and each box is `aria-invalid` and described by a line that says why (D-242); a good value takes both attributes away again. */
async function expectSummaryNamesBoxes(page: Page, side: Side, def: (typeof KIT)[number]) {
  await setSide(page, side, def.label);
  for (const param of def.params) {
    const box = page.getByLabel(param.label, { exact: true });
    await expect(box, `${def.id}: a box labelled "${param.label}"`).toHaveCount(1);
    await box.fill(String(param.max + 1));
  }
  for (const param of def.params) {
    const line = lineStart(side, param.label);
    await expect.poll(async () => (await summary(page).allInnerTexts()).some((text) => text.startsWith(line)), { message: `${def.id} ${side}: a summary line starts "${line}"` }).toBe(true);
  }
  for (const param of def.params) {
    const box = page.getByLabel(param.label, { exact: true });
    await expect(box, `${def.id} ${side} ${param.label}: aria-invalid`).toHaveAttribute("aria-invalid", "true");
    const line = (await box.getAttribute("aria-describedby")) ?? "";
    expect(line, `${def.id} ${side} ${param.label}: aria-describedby`).not.toBe("");
    // The id holds a spec path (dots), so match it as an attribute, not as `#id`.
    await expect(page.locator(`p[id="${line}"]`), `${def.id} ${side} ${param.label}: the line it points at`).toContainText(`Must be ${param.max} or less.`);
  }
  for (const param of def.params) {
    const box = page.getByLabel(param.label, { exact: true });
    await box.fill(String(param.defaultValue));
    await expect(box, `${def.id} ${side} ${param.label}: a good value is not invalid`).not.toHaveAttribute("aria-invalid", "true");
    await expect(box, `${def.id} ${side} ${param.label}: a good value is not described`).not.toHaveAttribute("aria-describedby", /.+/);
  }
}

test.describe("the error summary names a condition's boxes as the boxes are labelled (D-205)", () => {
  test.beforeEach(async ({ context }) => {
    await prepareDesk(context);
  });

  test("screener filter editor: liquidity days, then every kit metric's number boxes on either side", async ({ page }) => {
    test.setTimeout(240_000);
    await openDesk(page, "/screener/filters");
    const days = page.getByLabel("Average volume days", { exact: true });
    await days.fill("3");
    await expect(summary(page).filter({ hasText: /^Average volume days: Must be 5 or more\.$/ })).toHaveCount(1);
    await days.fill("61");
    await expect(summary(page).filter({ hasText: /^Average volume days: Must be 60 or less\.$/ })).toHaveCount(1);
    await days.fill("20");

    // A new filter ranks by Relative volume, which has its own Days box: switch Rank off while the conditions are checked, then back on.
    const rank = page.getByLabel("Rank the matches");
    await rank.uncheck();
    for (const side of ["Metric", "Compared with"] as const) {
      for (const def of KIT) await expectSummaryNamesBoxes(page, side, def);
    }
    // Rank by is the same picker, so its Days box reads the same in the summary (the list leaves the level rows out).
    await rank.check();
    for (const def of KIT.filter((item) => item.group !== "Levels")) await expectSummaryNamesBoxes(page, "Rank by", def);
  });

  test("alert setup: the same lines for every kit metric on either side", async ({ page }) => {
    test.setTimeout(240_000);
    await openDesk(page, "/alerts/new");
    for (const side of ["Metric", "Compared with"] as const) {
      for (const def of KIT) await expectSummaryNamesBoxes(page, side, def);
    }
  });
});

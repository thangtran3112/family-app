import { describe, expect, it } from "vitest";
import {
  APPLY_CONDITION,
  TRUSTED_PLAN_CONDITION,
  conditionIsExactly,
} from "./check-cloudflare-infrastructure.mjs";

describe("Cloudflare workflow condition checks", () => {
  it("accepts equivalent whitespace in trusted plan condition", () => {
    expect(conditionIsExactly(
      "(github.event_name == 'push' && github.ref == 'refs/heads/main') ||\n" +
        "(github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')",
      TRUSTED_PLAN_CONDITION,
    )).toBe(true);
  });

  it("rejects additional trusted plan branches", () => {
    expect(conditionIsExactly(
      `${TRUSTED_PLAN_CONDITION} || github.event_name == 'schedule'`,
      TRUSTED_PLAN_CONDITION,
    )).toBe(false);
  });

  it("requires manual apply and explicit approval on main", () => {
    expect(conditionIsExactly(
      "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && inputs.apply == true",
      APPLY_CONDITION,
    )).toBe(true);
    expect(conditionIsExactly(
      "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
      APPLY_CONDITION,
    )).toBe(false);
  });
});

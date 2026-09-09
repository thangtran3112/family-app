import { describe, expect, it } from "vitest";
import { filterExpenses } from "./fixtures";
describe("ledger fixtures", () => {
  it("filters exact visible fields", () => {
    expect(filterExpenses("deli")).toHaveLength(1);
    expect(filterExpenses("review")).toHaveLength(2);
    expect(filterExpenses("")).toHaveLength(3);
  });
});

import type { StrategySpecV1 } from "@ai-trading/contracts";

export type StrategySpecForm = StrategySpecV1;
export type SpecBlock = "Watch" | "When" | "Then" | "Limits";
export type SpecFormError = { path: string; message: string };
export type SpecBlockErrors = Partial<Record<SpecBlock, SpecFormError[]>>;
type ValidationIssue = {
  code?: string;
  path: readonly PropertyKey[];
  message: string;
  received?: string;
  errors?: readonly (readonly ValidationIssue[])[];
};

export function specToForm(spec: StrategySpecV1): StrategySpecForm {
  return structuredClone(spec);
}

export function formToSpec(form: StrategySpecForm): unknown {
  return structuredClone(form);
}

export function groupSpecErrors(error: { issues: readonly ValidationIssue[] }): SpecBlockErrors {
  const grouped: SpecBlockErrors = {};
  const details: SpecFormError[] = [];
  function flatten(issues: readonly ValidationIssue[], prefix: readonly PropertyKey[]) {
    for (const issue of issues) {
      const path = [...prefix, ...issue.path];
      if (issue.code === "invalid_union" && issue.errors) {
        for (const branch of issue.errors) flatten(branch, path);
      } else if (
        path.length > 0
        && (issue.code === "invalid_format"
          || issue.code === "too_small"
          || issue.code === "too_big"
          || issue.code === "custom"
          || issue.code === "invalid_type" && ["NaN", "Infinity", "-Infinity"].includes(issue.received ?? ""))
      ) {
        details.push({ path: path.map(String).join("."), message: issue.message });
      }
    }
  }
  flatten(error.issues, []);

  for (const detail of details) {
    const root = detail.path.split(".")[0];
    const block: SpecBlock = root === "when"
      ? "When"
      : root === "then"
        ? "Then"
        : root === "limits"
          ? "Limits"
          : "Watch";
    const entries = grouped[block] ??= [];
    if (!entries.some(({ path }) => path === detail.path)) entries.push(detail);
  }
  return grouped;
}

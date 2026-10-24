import { AlertStrategySpecV1Schema, type AlertStrategySpecV1 } from "@ai-trading/contracts/alert-strategy";
import { FilterStrategySpecV1Schema, type FilterStrategySpecV1 } from "@ai-trading/contracts/filter-strategy-spec-v1";

// The API returns specs as plain JSON objects. Screens that describe or edit one parse it here; a spec that
// does not parse (an older version, a hand-edited row) reads as null and the screen shows the raw JSON only.
export const parseFilterSpec = (spec: unknown): FilterStrategySpecV1 | null => {
  const parsed = FilterStrategySpecV1Schema.safeParse(spec);
  return parsed.success ? parsed.data : null;
};

export const parseAlertSpec = (spec: unknown): AlertStrategySpecV1 | null => {
  const parsed = AlertStrategySpecV1Schema.safeParse(spec);
  return parsed.success ? parsed.data : null;
};

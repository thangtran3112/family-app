import { StrategySpecV1Schema, type StrategySpecV1 } from "@ai-trading/contracts";
import type { StrategyTemplate } from "../templates.ts";

type StrategyRecord = { id: number; name: string };
type CreateVersionBody = { spec: StrategySpecV1; change_note: string };

export type StrategyCreationApi = {
  createStrategy: (name: string) => Promise<StrategyRecord>;
  createVersion: (strategyId: number, body: CreateVersionBody) => Promise<unknown>;
};

export class StrategyVersionCreateError extends Error {
  readonly strategyId: number;

  constructor(strategyId: number, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Strategy ${strategyId} exists, but its first version failed: ${detail}`, { cause });
    this.name = "StrategyVersionCreateError";
    this.strategyId = strategyId;
  }
}

export function prepareTemplateSpec(
  template: StrategyTemplate,
  name: string,
  watchlistName: string,
): StrategySpecV1 {
  const normalizedName = name.trim();
  const normalizedWatchlist = watchlistName.trim();
  if (!normalizedName || normalizedName.length > 80) {
    throw new Error("Strategy name must contain 1–80 characters.");
  }
  if (!normalizedWatchlist || normalizedWatchlist.length > 80) {
    throw new Error("Choose a watchlist with a name of 1–80 characters.");
  }

  const result = StrategySpecV1Schema.safeParse({
    ...template.spec,
    name: normalizedName,
    watch: { ...template.spec.watch, universe: { watchlist: normalizedWatchlist } },
  });
  if (!result.success) {
    throw new Error(`Template does not match StrategySpecV1: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return result.data;
}

export async function createStrategyFromTemplate(
  input: { template: StrategyTemplate; name: string; watchlistName: string },
  api: StrategyCreationApi,
): Promise<StrategyRecord> {
  const spec = prepareTemplateSpec(input.template, input.name, input.watchlistName);
  const strategy = await api.createStrategy(spec.name);
  try {
    await api.createVersion(strategy.id, {
      spec,
      change_note: `from template ${input.template.slug}`,
    });
  } catch (error) {
    throw new StrategyVersionCreateError(strategy.id, error);
  }
  return strategy;
}

import { StrategySpecV1Schema, type StrategySpecV1 } from "@ai-trading/contracts";
import { DeskApiError } from "../api/client.ts";
import type { StrategyTemplate } from "../templates.ts";

type StrategyRecord = { id: number; name: string };
type CreateVersionBody = { spec: StrategySpecV1; change_note: string };

export type StrategyCreationApi = {
  createStrategy: (name: string) => Promise<StrategyRecord>;
  createVersion: (strategyId: number, body: CreateVersionBody) => Promise<unknown>;
};

export type StrategyCreationState =
  | { kind: "ready" }
  | { kind: "submitting" }
  | { kind: "preflight-error" | "rejected"; message: string }
  | { kind: "outcome-unknown"; strategyName: string; message: string }
  | { kind: "version-failed"; strategyId: number; strategyName: string; message: string }
  | { kind: "created"; strategyId: number };

export function canSubmitStrategyCreation(state: StrategyCreationState): boolean {
  return state.kind === "ready" || state.kind === "preflight-error" || state.kind === "rejected";
}

export function selectStrategyTemplate(state: StrategyCreationState): StrategyCreationState {
  return state.kind === "submitting" || state.kind === "outcome-unknown" || state.kind === "version-failed"
    ? state
    : { kind: "ready" };
}

export function strategyCreationRecovery(state: StrategyCreationState): { href: string; label: string } | null {
  if (state.kind === "version-failed") {
    return {
      href: `/strategies?id=${state.strategyId}`,
      label: `Open strategy ${state.strategyId} to add its version`,
    };
  }
  return state.kind === "outcome-unknown"
    ? { href: "/strategies", label: "Review your owned strategies" }
    : null;
}

export function prepareTemplateSpec(
  template: StrategyTemplate,
  name: string,
  watchlistName?: string,
  universe?: StrategySpecV1["watch"]["universe"],
): StrategySpecV1 {
  const normalizedName = name.trim();
  if (!normalizedName || normalizedName.length > 80) {
    throw new Error("Strategy name must contain 1–80 characters.");
  }

  let selectedUniverse = universe;
  if (!selectedUniverse || "watchlist" in selectedUniverse) {
    const normalizedWatchlist = (selectedUniverse?.watchlist ?? watchlistName ?? "").trim();
    if (!normalizedWatchlist || normalizedWatchlist.length > 80) {
      throw new Error("Choose a watchlist with a name of 1–80 characters.");
    }
    selectedUniverse = { watchlist: normalizedWatchlist };
  }

  const result = StrategySpecV1Schema.safeParse({
    ...template.spec,
    name: normalizedName,
    watch: { ...template.spec.watch, universe: selectedUniverse },
  });
  if (!result.success) {
    throw new Error(`Template does not match StrategySpecV1: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  }
  return result.data;
}

function isDefinitiveCreateRejection(error: unknown): boolean {
  return error instanceof DeskApiError && (
    error.kind === "unauthenticated"
    || (error.kind === "http" && error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 408)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function submitStrategyCreation(
  state: StrategyCreationState,
  input: {
    template: StrategyTemplate;
    name: string;
    watchlistName?: string;
    universe?: StrategySpecV1["watch"]["universe"];
  },
  api: StrategyCreationApi,
): Promise<StrategyCreationState> {
  if (!canSubmitStrategyCreation(state)) return state;

  let spec: StrategySpecV1;
  try {
    spec = prepareTemplateSpec(input.template, input.name, input.watchlistName, input.universe);
  } catch (error) {
    return { kind: "preflight-error", message: errorMessage(error) };
  }

  let strategy: StrategyRecord;
  try {
    strategy = await api.createStrategy(spec.name);
  } catch (error) {
    if (isDefinitiveCreateRejection(error)) {
      return { kind: "rejected", message: `Strategy was rejected: ${errorMessage(error)}` };
    }
    return {
      kind: "outcome-unknown",
      strategyName: spec.name,
      message: `We could not confirm whether “${spec.name}” was created. Review your strategies before trying again.`,
    };
  }

  try {
    await api.createVersion(strategy.id, {
      spec,
      change_note: `from template ${input.template.slug}`,
    });
  } catch (error) {
    return {
      kind: "version-failed",
      strategyId: strategy.id,
      strategyName: strategy.name,
      message: `Strategy ${strategy.id} exists, but its first version failed: ${errorMessage(error)}`,
    };
  }
  return { kind: "created", strategyId: strategy.id };
}

import assert from "node:assert/strict";
import test from "node:test";
import { DeskApiError } from "../api/client.ts";
import { STRATEGY_TEMPLATES } from "../templates.ts";
import {
  canSubmitStrategyCreation,
  selectStrategyTemplate,
  strategyCreationRecovery,
  submitStrategyCreation,
} from "./create.ts";

const template = STRATEGY_TEMPLATES.find(({ slug }) => slug === "vwap-reclaim")!;

test("creates a draft strategy and a version bound to the normalized watchlist name", async () => {
  const persistedStrategies: Array<{ id: number; name: string }> = [];
  const persistedVersions: Array<{ strategyId: number; spec: unknown; change_note: string }> = [];
  const calls: string[] = [];

  const created = await submitStrategyCreation(
    { kind: "ready" },
    { template, name: "  Morning reclaim  ", watchlistName: "  Day movers  " },
    {
      createStrategy: async (name) => {
        calls.push("strategy");
        const strategy = { id: 42, name };
        persistedStrategies.push(strategy);
        return strategy;
      },
      createVersion: async (id, body) => {
        calls.push("version");
        persistedVersions.push({ strategyId: id, ...body });
      },
    },
  );

  assert.deepEqual(calls, ["strategy", "version"]);
  assert.deepEqual(persistedStrategies, [{ id: 42, name: "Morning reclaim" }]);
  assert.deepEqual(created, { kind: "created", strategyId: 42 });
  assert.deepEqual(persistedVersions, [{
    strategyId: 42,
    spec: {
      ...template.spec,
      name: "Morning reclaim",
      watch: { ...template.spec.watch, universe: { watchlist: "Day movers" } },
    },
    change_note: "from template vwap-reclaim",
  }]);
});

test("creates a single-symbol universe when user explicitly selects symbol context", async () => {
  let savedSpec: unknown;
  const created = await submitStrategyCreation(
    { kind: "ready" },
    { template, name: "ES setup", universe: { symbols: ["/ES"] } },
    {
      createStrategy: async (name) => ({ id: 44, name }),
      createVersion: async (_id, body) => { savedSpec = body.spec; },
    },
  );

  assert.deepEqual(created, { kind: "created", strategyId: 44 });
  assert.deepEqual((savedSpec as typeof template.spec).watch.universe, { symbols: ["/ES"] });
});

test("rejects invalid name or missing watchlist before creating anything", async () => {
  let calls = 0;
  const api = {
    createStrategy: async () => {
      calls += 1;
      return { id: 1, name: "unused" };
    },
    createVersion: async () => {
      calls += 1;
    },
  };

  const emptyName = await submitStrategyCreation(
    { kind: "ready" }, { template, name: " ", watchlistName: "Day movers" }, api,
  );
  assert.equal(emptyName.kind, "preflight-error");
  if (emptyName.kind === "preflight-error") assert.match(emptyName.message, /name/i);

  const emptyWatchlist = await submitStrategyCreation(
    { kind: "ready" }, { template, name: "Valid", watchlistName: " " }, api,
  );
  assert.equal(emptyWatchlist.kind, "preflight-error");
  if (emptyWatchlist.kind === "preflight-error") assert.match(emptyWatchlist.message, /watchlist/i);

  const longName = await submitStrategyCreation(
    { kind: "ready" }, { template, name: "x".repeat(81), watchlistName: "Day movers" }, api,
  );
  assert.equal(longName.kind, "preflight-error");
  if (longName.kind === "preflight-error") assert.match(longName.message, /80/);
  assert.equal(calls, 0);
});

test("surfaces a failed initial version without retrying or duplicating the strategy", async () => {
  const persistedStrategies: Array<{ id: number; name: string }> = [];
  const persistedVersions: unknown[] = [];
  const calls: string[] = [];

  const state = await submitStrategyCreation({ kind: "ready" }, { template, name: "Morning reclaim", watchlistName: "Day movers" }, {
      createStrategy: async (name) => {
        calls.push("strategy");
        const strategy = { id: 73, name };
        persistedStrategies.push(strategy);
        return strategy;
      },
      createVersion: async () => {
        calls.push("version");
        throw new Error("version endpoint unavailable");
      },
    });

  assert.deepEqual(calls, ["strategy", "version"]);
  assert.deepEqual(persistedStrategies, [{ id: 73, name: "Morning reclaim" }]);
  assert.deepEqual(persistedVersions, []);
  assert.equal(state.kind, "version-failed");
  if (state.kind === "version-failed") {
    assert.equal(state.strategyId, 73);
    assert.match(state.message, /strategy 73 exists/i);
    assert.match(state.message, /version endpoint unavailable/i);
  }
});

test("retains partial-create recovery and blocks duplicate POST after changing templates", async () => {
  const gapTemplate = STRATEGY_TEMPLATES.find(({ slug }) => slug === "gap-and-go")!;
  const persistedStrategies: Array<{ id: number; name: string }> = [];
  const calls: string[] = [];
  const api = {
    createStrategy: async (name: string) => {
      calls.push("strategy");
      const row = { id: 91, name };
      persistedStrategies.push(row);
      return row;
    },
    createVersion: async () => {
      calls.push("version");
      throw new Error("version endpoint unavailable");
    },
  };

  const failed = await submitStrategyCreation(
    { kind: "ready" },
    { template, name: "Morning reclaim", watchlistName: "Day movers" },
    api,
  );
  const afterTemplateChange = selectStrategyTemplate(failed);
  assert.deepEqual(afterTemplateChange, failed);
  assert.deepEqual(strategyCreationRecovery(afterTemplateChange), {
    href: "/strategies?id=91",
    label: "Open strategy 91 to add its version",
  });
  assert.equal(canSubmitStrategyCreation(afterTemplateChange), false);

  const secondSubmit = await submitStrategyCreation(
    afterTemplateChange,
    { template: gapTemplate, name: "Gap and go", watchlistName: "Day movers" },
    api,
  );
  assert.deepEqual(secondSubmit, failed);
  assert.deepEqual(calls, ["strategy", "version"]);
  assert.deepEqual(persistedStrategies, [{ id: 91, name: "Morning reclaim" }]);
});

test("blocks a retry when strategy POST may have committed but its response was malformed", async () => {
  const persistedStrategies: Array<{ id: number; name: string }> = [];
  let calls = 0;
  const api = {
    createStrategy: async (name: string) => {
      calls += 1;
      persistedStrategies.push({ id: 108, name });
      throw new DeskApiError("malformed", 201);
    },
    createVersion: async () => {
      throw new Error("must not create a version without a known strategy id");
    },
  };

  const uncertain = await submitStrategyCreation(
    { kind: "ready" },
    { template, name: "Morning reclaim", watchlistName: "Day movers" },
    api,
  );
  assert.equal(uncertain.kind, "outcome-unknown");
  assert.equal("strategyId" in uncertain, false);
  assert.deepEqual(strategyCreationRecovery(uncertain), {
    href: "/strategies",
    label: "Review your owned strategies",
  });
  assert.equal(canSubmitStrategyCreation(uncertain), false);
  const afterTemplateChange = selectStrategyTemplate(uncertain);
  assert.deepEqual(afterTemplateChange, uncertain);
  assert.deepEqual(await submitStrategyCreation(
    afterTemplateChange,
    { template, name: "Morning reclaim", watchlistName: "Day movers" },
    api,
  ), uncertain);
  assert.equal(calls, 1);
  assert.deepEqual(persistedStrategies, [{ id: 108, name: "Morning reclaim" }]);
});

test("permits a deliberate retry after a definitive 4xx strategy rejection", async () => {
  let calls = 0;
  const api = {
    createStrategy: async (name: string) => {
      calls += 1;
      if (calls === 1) throw new DeskApiError("http", 422);
      return { id: 109, name };
    },
    createVersion: async () => undefined,
  };

  const rejected = await submitStrategyCreation(
    { kind: "ready" },
    { template, name: "Morning reclaim", watchlistName: "Day movers" },
    api,
  );
  assert.equal(rejected.kind, "rejected");
  assert.equal(canSubmitStrategyCreation(rejected), true);
  assert.deepEqual(await submitStrategyCreation(
    rejected,
    { template, name: "Morning reclaim", watchlistName: "Day movers" },
    api,
  ), { kind: "created", strategyId: 109 });
  assert.equal(calls, 2);
});

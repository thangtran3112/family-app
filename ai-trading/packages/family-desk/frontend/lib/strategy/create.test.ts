import assert from "node:assert/strict";
import test from "node:test";
import { STRATEGY_TEMPLATES } from "../templates.ts";
import { createStrategyFromTemplate, StrategyVersionCreateError } from "./create.ts";

const template = STRATEGY_TEMPLATES.find(({ slug }) => slug === "vwap-reclaim")!;

test("creates a draft strategy and a version bound to the normalized watchlist name", async () => {
  const persistedStrategies: Array<{ id: number; name: string }> = [];
  const persistedVersions: Array<{ strategyId: number; spec: unknown; change_note: string }> = [];
  const calls: string[] = [];

  const created = await createStrategyFromTemplate(
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
  assert.equal(created.id, 42);
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

  await assert.rejects(
    createStrategyFromTemplate({ template, name: " ", watchlistName: "Day movers" }, api),
    /name/i,
  );
  await assert.rejects(
    createStrategyFromTemplate({ template, name: "Valid", watchlistName: " " }, api),
    /watchlist/i,
  );
  await assert.rejects(
    createStrategyFromTemplate({ template, name: "x".repeat(81), watchlistName: "Day movers" }, api),
    /80/,
  );
  assert.equal(calls, 0);
});

test("surfaces a failed initial version without retrying or duplicating the strategy", async () => {
  const persistedStrategies: Array<{ id: number; name: string }> = [];
  const persistedVersions: unknown[] = [];
  const calls: string[] = [];

  await assert.rejects(
    createStrategyFromTemplate({ template, name: "Morning reclaim", watchlistName: "Day movers" }, {
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
    }),
    (error: unknown) => {
      assert.ok(error instanceof StrategyVersionCreateError);
      assert.equal(error.strategyId, 73);
      assert.match(error.message, /strategy 73 exists/i);
      assert.match(error.message, /version endpoint unavailable/i);
      return true;
    },
  );

  assert.deepEqual(calls, ["strategy", "version"]);
  assert.deepEqual(persistedStrategies, [{ id: 73, name: "Morning reclaim" }]);
  assert.deepEqual(persistedVersions, []);
});

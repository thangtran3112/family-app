import assert from "node:assert/strict";
import test from "node:test";
import { loadFuturesSnapshot, snapshotForContract } from "./load.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("delayed contract loads keep each actual snapshot attached to its requested /ROOT", async () => {
  const pending = new Map<string, ReturnType<typeof deferred<{ symbol: string; last: number }>>>();
  for (const symbol of ["/MES", "/MNQ"]) {
    for (const timeframe of ["bars", "1d", "4h"]) pending.set(`${symbol}:${timeframe}`, deferred());
  }
  const resolvePath = (path: string) => {
    const symbol = path.includes("%2FMES") ? "/MES" : "/MNQ";
    const timeframe = path.includes("/bars/") ? "bars" : new URLSearchParams(path.split("?")[1]).get("timeframe")!;
    return pending.get(`${symbol}:${timeframe}`)!.promise;
  };
  const fetchBars = (path: string) => resolvePath(path);
  const fetchTechnicals = (path: string) => resolvePath(path);

  const mesLoad = loadFuturesSnapshot("MES", fetchBars, fetchTechnicals);
  const mnqLoad = loadFuturesSnapshot("MNQ", fetchBars, fetchTechnicals);
  pending.get("/MNQ:bars")!.resolve({ symbol: "/MNQ", last: 200 });
  pending.get("/MNQ:1d")!.resolve({ symbol: "/MNQ", last: 200 });
  pending.get("/MNQ:4h")!.resolve({ symbol: "/MNQ", last: 200 });
  const mnq = await mnqLoad;
  assert.equal(snapshotForContract(mnq, "/MNQ")?.bars.last, 200);

  pending.get("/MES:bars")!.resolve({ symbol: "/MES", last: 100 });
  pending.get("/MES:1d")!.resolve({ symbol: "/MES", last: 100 });
  pending.get("/MES:4h")!.resolve({ symbol: "/MES", last: 100 });
  const delayedMes = await mesLoad;
  assert.equal(snapshotForContract(delayedMes, "/MNQ"), null);
  assert.equal(snapshotForContract(delayedMes, "/MES")?.bars.last, 100);
});

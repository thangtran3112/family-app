import assert from "node:assert/strict";
import test from "node:test";
import { createDeskApiClient } from "./api/client.ts";
import {
  countSignalsToday,
  dailyChange,
  formatAsOf,
  formatChange,
  formatPrice,
  loadDailyBars,
  loadOwnedWatchlists,
  loadTodaySignals,
  marketDataPath,
  marketSymbol,
  markAlertRead,
  newYorkDate,
  previousDailyClose,
  quoteAsOfCaption,
} from "./today.ts";

test("future symbols are slash-prefixed once, while unprefixed CL remains a stock", () => {
  assert.equal(marketSymbol("CL", "stock"), "CL");
  assert.equal(marketSymbol("CL", "future"), "/CL");
  assert.equal(marketSymbol("/ES", "future"), "/ES");
  assert.equal(marketDataPath("/api/desk/bars", "ES", "future"), "/api/desk/bars/%2FES");
});

test("New York date keeps date-only values and assigns UTC timestamps to the NY session date", () => {
  assert.equal(newYorkDate("2026-10-16"), "2026-10-16");
  assert.equal(newYorkDate("2026-10-17T03:59:00Z"), "2026-10-16");
  assert.equal(newYorkDate("2026-10-17T04:01:00Z"), "2026-10-17");
  assert.equal(newYorkDate("not-a-date"), null);
  assert.equal(newYorkDate("2026-02-30"), null);
});

test("previous close uses the previous daily bar before quote's New York date", () => {
  const bars = [
    { t: "2026-10-14", c: 98 },
    { t: "2026-10-15", c: 100 },
    { t: "2026-10-16", c: 120 },
  ];

  assert.equal(previousDailyClose(bars, "2026-10-17T02:00:00Z"), 100);
});

test("missing, zero, or malformed prior closes make daily change unavailable", () => {
  assert.equal(previousDailyClose([], "2026-10-17T02:00:00Z"), null);
  assert.equal(previousDailyClose([{ t: "2026-10-15", c: 0 }], "2026-10-17T02:00:00Z"), null);
  assert.equal(previousDailyClose([{ t: "bad", c: 100 }], "2026-10-17T02:00:00Z"), null);
  assert.equal(dailyChange(101, null), null);
  assert.equal(dailyChange(101, 0), null);
  assert.equal(dailyChange(null, 100), null);
});

test("real zero stays visible while absent and non-finite prices stay unavailable", () => {
  assert.equal(formatPrice(0), "0.00");
  assert.equal(formatPrice(null), "not available");
  assert.equal(formatPrice(Number.POSITIVE_INFINITY), "not available");
  assert.deepEqual(dailyChange(105, 100), { amount: 5, percent: 5 });
  assert.equal(formatChange({ amount: -1.25, percent: -1.234 }), "−1.25 (−1.23%)");
  assert.equal(formatChange(null), "not available");
});

test("as-of display preserves date-only bars, converts timestamps to ET, and labels stale quotes", () => {
  assert.equal(formatAsOf("2026-10-16"), "Oct 16, 2026");
  assert.equal(formatAsOf("2026-10-17T02:10:00Z"), "Oct 16, 2026, 10:10 PM ET");
  assert.equal(formatAsOf("broken"), "not available");
  assert.equal(formatAsOf("2026-02-30"), "not available");
  assert.equal(
    quoteAsOfCaption("2026-10-16T14:00:00Z", "delayed-15m", Date.parse("2026-10-16T14:16:00Z")),
    "Last known · as of Oct 16, 2026, 10:00 AM ET",
  );
});

test("today's signal counts use the signal's New York date", () => {
  const signals = [
    { symbol: "AAPL", created_at: "2026-10-17T03:59:00Z" },
    { symbol: "AAPL", created_at: "2026-10-17T04:01:00Z" },
    { symbol: "CL", created_at: "2026-10-17T03:00:00Z" },
    { symbol: "/CL", created_at: "2026-10-17T03:00:00Z" },
  ];

  assert.equal(countSignalsToday(signals, "AAPL", "2026-10-16"), 1);
  assert.equal(countSignalsToday(signals, "CL", "2026-10-16"), 1);
});

test("empty owned watchlists stay empty instead of receiving demo rows", async () => {
  const paths: string[] = [];
  const fetcher = createDeskApiClient(
    async (input) => {
      paths.push(new URL(String(input)).pathname);
      return Response.json([]);
    },
    () => ({ href: "https://trading.tobytran.dev/" }),
  );

  assert.deepEqual(await loadOwnedWatchlists(fetcher), []);
  assert.deepEqual(paths, ["/api/desk/watchlists"]);
});

test("owned watchlist items and future daily bars use the real read routes", async () => {
  const paths: string[] = [];
  const fetcher = createDeskApiClient(
    async (input) => {
      const url = new URL(String(input));
      paths.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/api/desk/watchlists") {
        return Response.json([{ id: 3, name: "Energy", horizon: "swing" }]);
      }
      if (url.pathname === "/api/desk/watchlists/3/items") {
        return Response.json([{ symbol: "CL", asset_type: "future", backfill: "pending" }]);
      }
      return Response.json({ symbol: "/CL", interval: "1d", quality: "unavailable", as_of: null, bars: [] });
    },
    () => ({ href: "https://trading.tobytran.dev/" }),
  );

  assert.deepEqual(await loadOwnedWatchlists(fetcher), [
    { id: 3, name: "Energy", horizon: "swing", items: [{ symbol: "CL", asset_type: "future", backfill: "pending" }] },
  ]);
  await loadDailyBars("CL", "future", fetcher);

  assert.deepEqual(paths, [
    "/api/desk/watchlists",
    "/api/desk/watchlists/3/items",
    "/api/desk/bars/%2FCL?interval=1d&days=30",
  ]);
});

test("watchlist signal counts can read every page of owned signals", async () => {
  const offsets: string[] = [];
  const firstPage = Array.from({ length: 200 }, (_, index) => ({
    id: index + 1,
    strategy_version_id: 10,
    symbol: "AAPL",
    bar_time: "2026-10-16T14:00:00Z",
    evidence: {},
    data_quality: "delayed-15m",
    created_at: "2026-10-16T14:00:00Z",
  }));
  const secondPage = firstPage.slice(0, 3).map((signal, index) => ({ ...signal, id: 201 + index }));
  const fetcher = createDeskApiClient(
    async (input) => {
      const url = new URL(String(input));
      offsets.push(url.searchParams.get("offset") ?? "0");
      return Response.json(url.searchParams.get("offset") === "200" ? secondPage : firstPage);
    },
    () => ({ href: "https://trading.tobytran.dev/" }),
  );

  const signals = await loadTodaySignals(fetcher);

  assert.equal(signals.length, 203);
  assert.deepEqual(offsets, ["0", "200"]);
});

test("mark-read sends the authenticated Desk API POST and validates returned alert", async () => {
  let requestPath = "";
  let requestMethod = "";
  const alert = {
    id: 7,
    kind: "signal",
    severity: "info",
    title: "Signal recorded",
    body: "AAPL crossed its rule.",
    payload: {},
    created_at: "2026-10-16T14:00:00Z",
    read_at: "2026-10-16T14:01:00Z",
  };
  const fetcher = createDeskApiClient(
    async (input, init) => {
      requestPath = new URL(String(input)).pathname;
      requestMethod = init?.method ?? "GET";
      return Response.json(alert);
    },
    () => ({ href: "https://trading.tobytran.dev/" }),
  );

  assert.deepEqual(await markAlertRead(7, fetcher), alert);
  assert.equal(requestPath, "/api/desk/alerts/7/read");
  assert.equal(requestMethod, "POST");
});

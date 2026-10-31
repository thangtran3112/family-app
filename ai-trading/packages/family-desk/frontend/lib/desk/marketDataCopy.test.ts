import assert from "node:assert/strict";
import test from "node:test";
import type { MarketDataCard, MarketDataClass, MarketDataOption } from "../api/schemas.ts";
import {
  COPY,
  classOf,
  optionView,
  optionsFor,
  ownerNote,
  previewText,
  qualityWords,
  reasonWords,
  rowNote,
  servingText,
} from "./marketDataCopy.ts";

// One row per 02t §6 state: the bridge's own state, and the exact words the card shows.
const option = (over: Partial<MarketDataOption> = {}): MarketDataOption => ({
  provider: "ibkr",
  configured: true,
  state: "ok",
  quality: "realtime",
  in_ladder: true,
  detail: null,
  ...over,
});

const states: Array<[string, MarketDataOption, string, string]> = [
  ["live", option(), "ibkr", "Live · realtime"],
  ["gateway off", option({ state: "off", quality: "delayed-15m", detail: "off" }), "alpaca", "Gateway off (outside 08:00–17:00 ET)"],
  ["not reachable", option({ state: "down", quality: null, detail: "edge_unreachable" }), "alpaca", "Gateway not reachable"],
  [
    "competing session",
    option({ state: "down", quality: null, detail: "competing_session" }),
    "alpaca",
    "Signed in elsewhere — IBKR stopped the data",
  ],
  ["no key", option({ configured: false, state: "not_configured", quality: null }), "alpaca", "No key yet"],
  ["serving", option({ provider: "alpaca", quality: "delayed-15m" }), "alpaca", "Serving now · 15-min delayed"],
  ["standby", option({ provider: "alpaca", quality: "delayed-15m" }), "ibkr", "Standby · 15-min delayed"],
];

test("every state the card can show has the §6 words", () => {
  for (const [name, row, serving, expected] of states) {
    assert.equal(optionView("quotes", row, serving).text, expected, name);
  }
});

test("a provider outside the ladder says why it cannot be picked", () => {
  const marketdataApp = option({ provider: "marketdata_app", in_ladder: false, configured: false, state: "unspecified" });
  const quotes = optionView("quotes", marketdataApp, "alpaca");
  assert.deepEqual([quotes.text, quotes.disabled], [COPY.optionsOnly, true]);
  assert.equal(COPY.optionsOnly, "Options only: its stock quotes are 15 minutes delayed on every plan");

  const longbridge = option({ provider: "longbridge", in_ladder: false, configured: false });
  assert.deepEqual([optionView("quotes", longbridge, "alpaca").text, optionView("quotes", longbridge, "alpaca").disabled], [COPY.noAccount, true]);

  assert.equal(optionView("options", option({ in_ladder: false }), "alpaca").text, COPY.notInOptionsLadder);
  assert.equal(optionView("options", marketdataApp, "alpaca").text, COPY.noKey);
  assert.equal(optionView("bars", option({ in_ladder: false }), "alpaca").text, COPY.notABarsSource);
  const alpacaBars = optionView("bars", option({ provider: "alpaca" }), "alpaca");
  assert.deepEqual([alpacaBars.text, alpacaBars.disabled], ["Daily, hourly, 1-minute", true]);
  assert.equal(optionView("options", option({ provider: "alpaca", in_ladder: false }), "alpaca").text, COPY.optionsIndicative);
});

test("the four providers are always offered, in §6's order, even when the bridge omits one", () => {
  const views = optionsFor("quotes", null, "");
  assert.deepEqual(views.map((view) => view.provider), ["ibkr", "longbridge", "alpaca", "marketdata_app"]);
  assert.ok(views.every((view) => view.disabled));
});

const quotes = (over: Partial<MarketDataClass> = {}): MarketDataClass => ({
  data_class: "equity_quotes",
  preferred: "ibkr",
  serving: "alpaca",
  ladder: ["ibkr", "alpaca"],
  options: [
    option({ state: "off", quality: "delayed-15m", detail: "off" }),
    option({ provider: "longbridge", in_ladder: false, configured: false, state: "unspecified", quality: null }),
    option({ provider: "alpaca", quality: "delayed-15m" }),
    option({ provider: "marketdata_app", in_ladder: false, configured: false, state: "unspecified", quality: null }),
  ],
  ...over,
});

const card = (over: Partial<MarketDataCard> = {}): MarketDataCard => ({
  shadow: true,
  owner: true,
  available: true,
  reason: null,
  routing_source: "desk",
  version: 2,
  desk_serving: "alpaca",
  desk_quality: "delayed-15m",
  classes: [
    quotes(),
    { data_class: "option_chain", preferred: "", serving: "alpaca_options", ladder: [], options: [] },
    {
      data_class: "equity_bars",
      preferred: "",
      serving: "alpaca",
      ladder: ["alpaca"],
      options: [option({ provider: "alpaca", quality: "eod" })],
    },
  ],
  ...over,
});

test("the shadow preview says exactly what the bridge would serve, and names the Desk's own vendor", () => {
  const one = card();
  assert.equal(previewText(one), "The Desk still shows Alpaca. This is what the bridge would serve.");
  assert.equal(
    servingText("quotes", one, classOf(one, "equity_quotes")),
    "Serving now: Alpaca · 15-min delayed · the bridge would serve IBKR · 15-min delayed",
  );
});

test("a bridge that can serve nothing says so instead of naming an empty vendor", () => {
  const one = card({ classes: [quotes({ preferred: "", serving: "" })] });
  assert.equal(
    servingText("quotes", one, classOf(one, "equity_quotes")),
    "Serving now: Alpaca · 15-min delayed · nothing on the bridge can serve yet",
  );
});

test("with no preference the bridge serves its own first rung", () => {
  const one = card({ classes: [quotes({ preferred: "", options: [option({ state: "ok", quality: "delayed-15m" })] })] });
  const line = servingText("quotes", one, classOf(one, "equity_quotes"));
  assert.match(line, /the bridge would serve Alpaca · /);
});

test("outside shadow mode the serving line carries the reason the choice is not serving", () => {
  const one = card({ shadow: false });
  assert.equal(
    servingText("quotes", one, classOf(one, "equity_quotes")),
    "Serving now: Alpaca · 15-min delayed · because the IBKR gateway is off",
  );
  assert.equal(reasonWords(classOf(one, "equity_quotes"), "ibkr"), "the IBKR gateway is off");
});

test("the read-only rows keep the M board's words", () => {
  const one = card();
  assert.equal(rowNote("options", classOf(one, "option_chain")), COPY.readOnlyNow);
  assert.equal(servingText("options", one, classOf(one, "option_chain")), COPY.optionChainsNoChoice);
  assert.equal(rowNote("bars", classOf(one, "equity_bars")), "Read-only · Alpaca");
  assert.equal(servingText("bars", one, classOf(one, "equity_bars")), "Serving now: Alpaca · closed bars only");
  assert.equal(rowNote("quotes", classOf(one, "equity_quotes")), "Your choice · IBKR");
  assert.equal(rowNote("quotes", quotes({ preferred: "" })), "Bridge default");
});

test("the owner note differs for the wife's read-only view", () => {
  assert.equal(ownerNote(true), "Only the owner changes data providers. A change saves at once and shows here.");
  assert.equal(ownerNote(false), "Only the owner changes data providers");
});

test("quality words never invent a label", () => {
  assert.equal(qualityWords("eod"), "end of day");
  assert.equal(qualityWords(null), "no quotes yet");
  assert.equal(qualityWords("something-new"), "something-new");
});
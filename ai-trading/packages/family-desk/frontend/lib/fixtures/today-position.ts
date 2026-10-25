import { fixtureBannerText, NEEDS_BROKER } from "./banner.ts";
import { todayPositionFixture } from "./paper.ts";

export function todayPositionPreview() {
  return {
    actionNote: NEEDS_BROKER,
    fixtureLabel: fixtureBannerText(),
    connected: false,
    controlsEnabled: false,
    notice: "Illustrative only; not a connected position, not tied to this chart, and not an order.",
    symbol: todayPositionFixture.symbol,
    strategy: todayPositionFixture.strategy,
    levels: [
      { label: "Entry", value: todayPositionFixture.entry },
      { label: "Stop", value: todayPositionFixture.stop },
      { label: "Target", value: todayPositionFixture.target },
    ],
  } as const;
}

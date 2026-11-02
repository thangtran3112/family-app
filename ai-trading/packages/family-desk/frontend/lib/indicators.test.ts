import assert from "node:assert/strict";
import test from "node:test";
import { calcVWAPWithGaps } from "./indicators-with-gaps.ts";
import { calcMA, calcRSI, calcVWAP, tradingDay } from "./indicators.ts";

test("calcMA keeps warm-up bars unknown and returns the trailing simple mean", () => {
  assert.deepEqual(calcMA([1, 2, 3, 4], 3), [null, null, 2, 3]);
});

test("calcRSI matches the fixed Wilder-seeded golden series", () => {
  const values = calcRSI([1, 2, 3, 2, 1, 2], 3);
  assert.deepEqual(values.slice(0, 3), [null, null, null]);
  assert.ok(Math.abs((values[3] ?? 0) - 66.6666666667) < 1e-8);
  assert.ok(Math.abs((values[4] ?? 0) - 44.4444444444) < 1e-8);
  assert.ok(Math.abs((values[5] ?? 0) - 62.962962963) < 1e-8);
});

test("calcVWAP is the volume-weighted typical price and resets at each New York trading day", () => {
  // Two 15m bars on Thu 2026-10-22 (13:30Z and 13:45Z) and one on Fri 2026-10-23.
  const bars = [
    { t: "2026-10-22T13:30:00Z", h: 12, l: 8, c: 10, v: 100 },
    { t: "2026-10-22T13:45:00Z", h: 15, l: 9, c: 12, v: 300 },
    { t: "2026-10-23T13:30:00Z", h: 21, l: 19, c: 20, v: 50 },
  ];
  const vwap = calcVWAP(bars);
  assert.equal(vwap[0], 10);
  assert.ok(Math.abs((vwap[1] ?? 0) - (10 * 100 + 12 * 300) / 400) < 1e-9);
  assert.equal(vwap[2], 20);
});

test("a late-evening UTC bar belongs to the same New York day", () => {
  assert.equal(tradingDay("2026-10-23T03:30:00Z"), "2026-10-22");
  assert.equal(tradingDay("2026-10-23T13:30:00Z"), "2026-10-23");
  assert.equal(tradingDay("2026-10-23"), "2026-10-23");
});

test("zero volume leaves VWAP unknown", () => {
  assert.deepEqual(calcVWAP([{ t: "2026-10-23T13:30:00Z", h: 2, l: 1, c: 1, v: 0 }]), [null]);
});

test("futures VWAP is the backend's: the 09:30-16:00 New York window only, whatever the session day around it", () => {
  // The backend's `session_vwap(annotate(bars, "future"))` for these bars (EDT, UTC-4), run in `backend/` on 2026-11-01:
  // only bars that START in 09:30-16:00 ET count; the overnight Globex session (18:00 on), the 16:00-17:00 post window and the
  // 17:00 maintenance break read NaN. The API never flags a futures bar `ext`, so the browser must tell them apart by clock.
  // The session day starts at 18:00, but only a regular bar feeds the sum, so the sum restarts at each 09:30.
  const bar = (t: string, price: number, v: number) => ({ t, h: price, l: price, c: price, v });
  const bars = [
    bar("2026-10-13T20:30:00Z", 90, 9000), // 16:30 ET, after the close
    bar("2026-10-13T21:59:00Z", 91, 9000), // 17:59 ET, the maintenance break
    bar("2026-10-13T22:00:00Z", 92, 9000), // 18:00 ET, Globex opens the next session day
    bar("2026-10-14T07:00:00Z", 93, 9000), // 03:00 ET overnight (after the browser's midnight reset)
    bar("2026-10-14T13:29:00Z", 94, 9000), // 09:29 ET, one minute before the open
    bar("2026-10-14T13:30:00Z", 100, 100), // 09:30 ET
    bar("2026-10-14T13:31:00Z", 102, 300),
    bar("2026-10-14T19:59:00Z", 104, 100), // 15:59 ET, the last regular minute
    bar("2026-10-14T20:00:00Z", 95, 9000), // 16:00 ET, after the close
    bar("2026-10-14T22:00:00Z", 96, 9000), // 18:00 ET, the next Globex session
    bar("2026-10-15T13:30:00Z", 110, 200), // the next 09:30 ET
  ];
  const backend = [null, null, null, null, null, 100, 101.5, 102, null, null, 110];
  assert.deepEqual(calcVWAP(bars, "future"), backend);
  assert.deepEqual(calcVWAPWithGaps(bars, "future"), backend);
  // A stock reads the API's `ext` flag instead, and ignores the clock: the same unflagged bars all count.
  assert.ok(calcVWAP(bars).every((value) => value !== null));
});

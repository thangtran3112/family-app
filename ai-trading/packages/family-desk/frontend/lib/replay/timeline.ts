import type { ReplayMark, ReplaySignal } from "./schemas.ts";
import { ms } from "./time.ts";

// The forward-only timeline under the chart (02o §a3): the revealed part is filled and carries ticks for her marks
// and the released signals; the future part is empty. Fractions are of the whole window (a known, public span).

export type TimelineTick = { kind: "mark" | "signal"; at: number; label: string };
export type TimelineModel = { revealed: number; ticks: TimelineTick[] };

const clamp = (value: number) => Math.min(1, Math.max(0, value));

export function timelineModel(
  windowStart: string,
  windowEnd: string,
  revealedThrough: string,
  marks: readonly Pick<ReplayMark, "at" | "kind">[],
  signals: readonly Pick<ReplaySignal, "bar_close" | "name">[],
): TimelineModel {
  const start = ms(windowStart);
  const span = ms(windowEnd) - start;
  if (!(span > 0)) return { revealed: 0, ticks: [] };
  const at = (iso: string) => clamp((ms(iso) - start) / span);
  const revealed = at(revealedThrough);
  const ticks: TimelineTick[] = [
    ...marks.filter((mark) => mark.kind !== "note").map((mark): TimelineTick => ({ kind: "mark", at: at(mark.at), label: "Practice mark" })),
    ...signals.map((signal): TimelineTick => ({ kind: "signal", at: at(signal.bar_close), label: signal.name })),
  ].filter((tick) => tick.at <= revealed);
  return { revealed, ticks: ticks.sort((a, b) => a.at - b.at) };
}

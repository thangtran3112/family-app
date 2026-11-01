"use client";

import { ThreadTiles } from "@/components/practice/journal/thread/ThreadTiles";
import type { SummaryTile } from "@/lib/replay/journalView";

export type SummaryTilesProps = {
  tiles: SummaryTile[];
  /** Muted text under the Adherence tile, e.g. "Add a plan to get an adherence score". */
  hint: string | null;
};

/** Eight journal tiles: the same tile as the thread journal and the week review, so a value scales with its tile and never wraps mid-number (D-086). */
export function SummaryTiles({ tiles, hint }: SummaryTilesProps) {
  return <ThreadTiles tiles={tiles.map((tile) => ({ ...tile, sub: tile.id === "adherence" && hint ? hint : "" }))} />;
}

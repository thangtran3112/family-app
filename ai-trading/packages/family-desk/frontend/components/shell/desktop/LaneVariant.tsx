"use client";

import type { ReactNode } from "react";
import { useDeskUi } from "./DeskContext";

/** A shared route (02n §b1: Today, Settings, More) renders the active lane's variant. Mount it inside the desktop shell only. */
export function LaneVariant({ technical, fundamental }: { technical: ReactNode; fundamental: ReactNode }) {
  const { lane } = useDeskUi();
  return lane === "fundamental" ? fundamental : technical;
}

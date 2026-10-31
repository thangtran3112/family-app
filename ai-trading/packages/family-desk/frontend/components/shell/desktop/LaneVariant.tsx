"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { LANE_HOME } from "@/lib/lanes";
import { useDeskUi } from "./DeskContext";

/** Today renders the mode's variant (02n §b1). Backtest has no Today, so it goes to the mode's home (ADR-0014). Desktop shell only. */
export function LaneVariant({ technical, fundamental }: { technical: ReactNode; fundamental: ReactNode }) {
  const { lane } = useDeskUi();
  const router = useRouter();
  useEffect(() => {
    if (lane === "backtest") router.replace(LANE_HOME.backtest);
  }, [lane, router]);
  if (lane === "backtest") return null;
  return lane === "fundamental" ? fundamental : technical;
}

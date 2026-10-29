"use client";

import { RightRail } from "@/components/shell/desktop/RightRail";

/**
 * The Fundamental right rail for one symbol (02n §b1): the Desk AI verdict card (violet), a covered-call mini card and
 * the upcoming events. A page mounts it with the symbol it is showing; `null` shows the empty prompts.
 */
export function FundamentalRightRail({ symbol }: { symbol: string | null }) {
  return <RightRail label="Selected holding" sections={[{ id: "verdict", label: "Verdict", node: <p>{symbol}</p> }]} />;
}

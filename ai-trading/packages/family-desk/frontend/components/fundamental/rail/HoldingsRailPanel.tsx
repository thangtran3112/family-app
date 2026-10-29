"use client";

import type { ShellBand } from "@/lib/desk/viewport";

/** The Holdings tab of the Fundamental left rail (02n §b1): dense rows of symbol, weight, change and the AI rating dot. */
export function HoldingsRailPanel({ band }: { band: ShellBand }) {
  return <p data-band={band}>Holdings</p>;
}

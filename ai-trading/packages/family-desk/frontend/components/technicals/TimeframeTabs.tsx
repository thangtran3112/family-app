"use client";

import { useId } from "react";
import { Tabs } from "@/components/ui/Tabs";
import type { TimeframeOption } from "@/lib/desk/timeframes";

/** The timeframe choices as `Tabs`: arrows select and wrap, Home and End jump. There is no panel; the chart below follows the choice. */
export function TimeframeTabs({
  options,
  value,
  onChange,
  label = "Timeframe",
}: {
  options: readonly TimeframeOption[];
  value: string;
  onChange: (api: string) => void;
  label?: string;
}) {
  return <Tabs idBase={useId()} label={label} tabs={options.map((option) => ({ id: option.api, label: option.label }))} value={value} onChange={onChange} panelMounted={false} />;
}

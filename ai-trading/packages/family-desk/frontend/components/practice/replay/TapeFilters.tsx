"use client";

import { ChipToggleGroup } from "@/components/ui/ChipToggleGroup";
import { SIZE_FILTERS, type SizeFilterId } from "@/lib/replay/tape";

/** Size chips `All · ≥100 · ≥1,000 · Big only`; the pressed chip is the active filter. */
export function TapeFilters({ value, onChange }: { value: SizeFilterId; onChange: (id: SizeFilterId) => void }) {
  return <ChipToggleGroup label="Minimum print size" options={SIZE_FILTERS} pressed={[value]} onToggle={onChange} />;
}

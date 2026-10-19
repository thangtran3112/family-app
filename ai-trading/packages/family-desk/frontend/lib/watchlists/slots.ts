export type StreamingSlots = { used: number; max: number };

export function slotsText(slots: StreamingSlots | null | undefined): string {
  if (!slots || !Number.isFinite(slots.used) || !Number.isFinite(slots.max)) return "not available";
  return `${slots.used} of ${slots.max}`;
}

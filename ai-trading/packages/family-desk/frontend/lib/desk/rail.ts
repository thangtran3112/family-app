// Right rail at the 1180 band is a 40 px tab strip; one tab at a time opens a 320 px drawer (02l §b3 rule 2).
export type RailTab = { id: string; label: string };

/** Clicking the open tab again closes it. */
export const toggleRailTab = (open: string | null, id: string): string | null => (open === id ? null : id);

/** A tab that no longer exists (the page changed its sections) reads as closed. */
export const activeRailTab = (open: string | null, tabs: readonly RailTab[]): string | null =>
  open !== null && tabs.some((tab) => tab.id === open) ? open : null;

// Right rail at the 1180 band is a 40 px tab strip; one tab at a time opens a 320 px drawer (02l §b3 rule 2).
export type RailTab = { id: string; label: string };

/** Clicking the open tab again closes it. */
export const toggleRailTab = (open: string | null, id: string): string | null => (open === id ? null : id);

/** A tab that no longer exists (the page changed its sections) reads as closed. */
export const activeRailTab = (open: string | null, tabs: readonly RailTab[]): string | null =>
  open !== null && tabs.some((tab) => tab.id === open) ? open : null;

// Practice screens stack their drawers (D-020, D-040): each tab opens and closes its own section and leaves the others as they are.

/** A tab opens its section, or closes it when it was open; every other open section stays. */
export const toggleRailTabs = (open: readonly string[], id: string): string[] => (open.includes(id) ? open.filter((item) => item !== id) : [...open, id]);

/** Opens a section without closing it when it is already open (a key press that needs the drawer). */
export const openRailTab = (open: readonly string[], id: string): string[] => (open.includes(id) ? [...open] : [...open, id]);

/** The open sections that still exist, in the page's own order. */
export const activeRailTabs = (open: readonly string[], tabs: readonly RailTab[]): string[] => tabs.filter((tab) => open.includes(tab.id)).map((tab) => tab.id);

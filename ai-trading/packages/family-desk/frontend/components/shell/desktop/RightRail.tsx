"use client";

import { useContext, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PanelHeader } from "@/components/ui/Panel";
import { activeRailTab, activeRailTabs, toggleRailTab, toggleRailTabs } from "@/lib/desk/rail";
import { useShellBand } from "@/lib/desk/useViewportBand";
import { RailSlotContext } from "./DeskContext";
import { RightRailDrawer } from "./RightRailDrawer";
import styles from "./rail.module.css";

export type RailSection = { id: string; label: string; node: ReactNode };

/**
 * A page's right-rail content (02m §c2). At 1440 the sections stack in the 320 px rail; at 1180 the rail is
 * a 40 px tab strip and one section at a time opens in an overlay drawer. `multi` (Practice, D-020, D-040) lets
 * every tab open on its own: the open sections stack in the one drawer instead of replacing each other.
 * Rendered through a portal into the shell's rail slot, so a page without this component simply has no right rail.
 */
export function RightRail({
  sections,
  label = "Context",
  openId,
  onOpenChange,
  multi = false,
  openIds,
  onOpenIdsChange,
}: {
  sections: readonly RailSection[];
  label?: string;
  /** Controlled drawer at the 1180 band (a row click opens it); leave unset for the tab strip to own it. */
  openId?: string | null;
  onOpenChange?: (id: string | null) => void;
  /** Stacked drawers: tabs toggle independently. Control them with `openIds` and `onOpenIdsChange`, or leave both unset. */
  multi?: boolean;
  openIds?: readonly string[];
  onOpenIdsChange?: (ids: string[]) => void;
}) {
  const slot = useContext(RailSlotContext);
  const band = useShellBand();
  const [ownOpen, setOwnOpen] = useState<string[]>([]);
  const controlled = multi ? openIds !== undefined : openId !== undefined;
  const stored = multi ? (openIds ?? ownOpen) : openId !== undefined ? (openId === null ? [] : [openId]) : ownOpen;
  const open = multi ? activeRailTabs(stored, sections) : [activeRailTab(stored[0] ?? null, sections)].filter((id): id is string => id !== null);
  const setOpen = (ids: string[]) => {
    if (!controlled) setOwnOpen(ids);
    if (multi) onOpenIdsChange?.(ids);
    else onOpenChange?.(ids[0] ?? null);
  };
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const first = open[0] ?? null;
  const close = () => {
    setOpen([]);
    if (first) tabRefs.current[first]?.focus();
  };

  if (!slot) return null;

  if (band === "1440") {
    return createPortal(
      <div className={styles.stack} role="complementary" aria-label={label}>
        {sections.map((section) => (
          <section key={section.id} className={styles.section} aria-labelledby={`rail-${section.id}`}>
            <PanelHeader variant="label" id={`rail-${section.id}`} title={section.label} />
            {section.node}
          </section>
        ))}
      </div>,
      slot,
    );
  }

  const openSections = sections.filter((section) => open.includes(section.id));
  return createPortal(
    <>
      <div className={styles.strip} role="tablist" aria-orientation="vertical" aria-label={label}>
        {sections.map((section) => (
          <button
            key={section.id}
            ref={(element) => { tabRefs.current[section.id] = element; }}
            type="button"
            role="tab"
            className={styles.stripTab}
            aria-selected={open.includes(section.id)}
            aria-expanded={open.includes(section.id)}
            aria-controls="rail-drawer"
            onClick={() => setOpen(multi ? toggleRailTabs(open, section.id) : toggleRailTab(first, section.id) === null ? [] : [section.id])}
          >
            {section.label}
          </button>
        ))}
      </div>
      {openSections.length > 0 && (
        <RightRailDrawer title={openSections.map((section) => section.label).join(", ")} onClose={close}>
          {openSections.map((section) => (
            <div key={section.id} className={styles.drawerSection}>
              <PanelHeader variant="label" title={section.label} />
              {section.node}
            </div>
          ))}
        </RightRailDrawer>
      )}
    </>,
    slot,
  );
}

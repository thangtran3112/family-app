"use client";

import { useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { activeRailTab, toggleRailTab } from "@/lib/desk/rail";
import { useShellBand } from "@/lib/desk/useViewportBand";
import { RailSlotContext } from "./DeskContext";
import { RightRailDrawer } from "./RightRailDrawer";
import styles from "./rail.module.css";

export type RailSection = { id: string; label: string; node: ReactNode };

/**
 * A page's right-rail content (02m §c2). At 1440 the sections stack in the 320 px rail; at 1180 the rail is
 * a 40 px tab strip and one section at a time opens in an overlay drawer. Rendered through a portal into
 * the shell's rail slot, so a page without this component simply has no right rail.
 */
export function RightRail({ sections, label = "Context" }: { sections: readonly RailSection[]; label?: string }) {
  const slot = useContext(RailSlotContext);
  const band = useShellBand();
  const [open, setOpen] = useState<string | null>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const current = activeRailTab(open, sections);
  const close = useCallback(() => {
    setOpen(null);
    if (current) tabRefs.current[current]?.focus();
  }, [current]);

  if (!slot) return null;

  if (band === "1440") {
    return createPortal(
      <div className={styles.stack} role="complementary" aria-label={label}>
        {sections.map((section) => (
          <section key={section.id} className={styles.section} aria-labelledby={`rail-${section.id}`}>
            <h2 id={`rail-${section.id}`} className={styles.sectionTitle}>{section.label}</h2>
            {section.node}
          </section>
        ))}
      </div>,
      slot,
    );
  }

  const openSection = sections.find((section) => section.id === current);
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
            aria-selected={current === section.id}
            aria-controls={current === section.id ? "rail-drawer" : undefined}
            onClick={() => setOpen(toggleRailTab(current, section.id))}
          >
            {section.label}
          </button>
        ))}
      </div>
      {openSection && (
        <RightRailDrawer title={openSection.label} onClose={close}>
          <h2 className={styles.sectionTitle}>{openSection.label}</h2>
          {openSection.node}
        </RightRailDrawer>
      )}
    </>,
    slot,
  );
}

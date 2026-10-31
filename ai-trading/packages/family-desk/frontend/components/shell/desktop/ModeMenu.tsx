"use client";
// Plain links: full document navigation lets the strategy builder's beforeunload guard run.

import { useEffect } from "react";
import { Menu } from "@/components/ui/Menu";
import { LANE_HOME, LANE_LABEL, LANE_SUMMARY, LANES, type Lane } from "@/lib/lanes";
import { isTextField } from "@/lib/replay/keys";
import { useDeskUi } from "./DeskContext";
import styles from "./topbar.module.css";

const SHORTCUT: Record<string, Lane> = { Digit1: "technical", Digit2: "fundamental", Digit3: "backtest" };

/** The mode switcher (ADR-0014, design-modes-cutover §3.5): the mode's full word opens a three-item ui/Menu; Alt+1/2/3 jump.
 * A switch is a navigation to the mode's home: the route then decides the mode, so nothing in the shell keeps stale state. */
export function ModeMenu() {
  const { lane, confirmLeave } = useDeskUi();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = SHORTCUT[event.code];
      if (!target || !event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (isTextField(document.activeElement as HTMLElement | null)) return;
      event.preventDefault();
      if (confirmLeave()) window.location.assign(LANE_HOME[target]);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [confirmLeave]);

  return (
    <Menu
      label="Mode"
      align="start"
      width={300}
      items={LANES.map((mode, index) => ({
        href: LANE_HOME[mode],
        label: LANE_LABEL[mode],
        hint: `Alt ${index + 1}`,
        description: LANE_SUMMARY[mode],
        checked: mode === lane,
        shortcut: `Alt+${index + 1}`,
        onClick: (event) => {
          if (!confirmLeave()) event.preventDefault();
        },
      }))}
      trigger={(props) => (
        <button type="button" className={styles.modeButton} aria-label={`Mode: ${LANE_LABEL[lane]}`} {...props}>
          {LANE_LABEL[lane]}
          <svg className={styles.chevron} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            <path d="m3 4.5 3 3 3-3" />
          </svg>
        </button>
      )}
    />
  );
}

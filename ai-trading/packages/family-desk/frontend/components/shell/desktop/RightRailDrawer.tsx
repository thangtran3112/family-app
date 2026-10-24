"use client";

import { useEffect, useRef, type ReactNode } from "react";
import styles from "./rail.module.css";

/** The 320 px overlay at the 1180 band. Escape closes it; the caller returns focus to the tab. */
export function RightRailDrawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panel.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div ref={panel} className={styles.drawer} role="dialog" aria-label={title} tabIndex={-1}>
      {children}
    </div>
  );
}

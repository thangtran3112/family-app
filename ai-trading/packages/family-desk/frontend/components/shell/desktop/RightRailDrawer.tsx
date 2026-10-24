"use client";

import { useEffect, useRef, type ReactNode } from "react";
import styles from "./rail.module.css";

/** The 320 px overlay at the 1180 band. Escape closes it; the caller returns focus to the tab. */
export function RightRailDrawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);

  useEffect(() => {
    close.current = onClose;
  });

  // Focus moves into the drawer once, when it opens, not on every parent render.
  useEffect(() => {
    panel.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div ref={panel} className={styles.drawer} role="dialog" aria-label={title} tabIndex={-1}>
      {children}
    </div>
  );
}

"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import { SHORTCUT_GROUPS } from "@/lib/replay/keys";
import styles from "./panels.module.css";

// The `?` overlay (02o §a3, the Mercury pattern §j). Focus goes to Close on mount and back to the previous
// element on unmount. The only control is Close, so Tab is held there. Escape and a backdrop click close it;
// the parent's key map also sends Escape, and calling onClose twice is harmless (the parent only sets state).

export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => previous?.focus();
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "Tab") {
      event.preventDefault();
    }
  }

  return (
    <>
      <div className={styles.backdrop} aria-hidden="true" onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" className={styles.dialog} onKeyDown={onKeyDown}>
        <h2 className={styles.dialogTitle}>Keyboard shortcuts</h2>
        {SHORTCUT_GROUPS.map((group) => (
          <section key={group.title} className={styles.group}>
            <h3 className={styles.heading}>{group.title}</h3>
            {group.rows.map((row) => (
              <div key={row.label} className={`${styles.row} ${styles.between}`}>
                <span>{row.label}</span>
                <span className={styles.keys}>
                  {row.keys.map((key) => (
                    <kbd key={key} className={styles.kbd}>{key}</kbd>
                  ))}
                </span>
              </div>
            ))}
          </section>
        ))}
        <div className={styles.dialogFooter}>
          <button ref={closeRef} type="button" className={styles.button} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </>
  );
}

"use client";

import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { SHORTCUT_GROUPS } from "@/lib/replay/keys";
import styles from "./panels.module.css";

// The `?` overlay (02o §a3, the Mercury pattern §j), a `ui/Dialog`: focus starts on Close and Tab stays inside, Escape and a press
// on the dimmed page close it, and focus goes back to where it was. The workspace's own key map also sends Escape and `?`;
// calling onClose twice is harmless (the parent only sets state).

export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} footer={<Button size="md" onClick={onClose}>Close</Button>}>
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
    </Dialog>
  );
}

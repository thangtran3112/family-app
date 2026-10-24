"use client";

import { useEffect, useRef, useState } from "react";
import { initialOf } from "@/lib/desk/format";
import { loadMe } from "@/lib/desk/status";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { AVATAR_MENU } from "@/lib/lanes";
import styles from "./topbar.module.css";

export function AvatarMenu() {
  const me = useDeskQuery("me", (signal) => loadMe({ signal }));
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (event.target instanceof Node && !wrapRef.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={styles.anchor} ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className={styles.avatar}
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {initialOf(me.data?.email)}
      </button>
      {open && (
        <div role="menu" aria-label="Account" className={`${styles.popover} ${styles.menu}`}>
          {AVATAR_MENU.map((item) => (
            <a key={item.href} role="menuitem" className={styles.menuItem} href={item.href}>
              {item.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

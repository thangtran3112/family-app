"use client";

import { usePathname } from "next/navigation";
import { useDeskUi } from "@/components/shell/desktop/DeskContext";
import { activeNavItem, PRIMARY_NAV } from "@/lib/lanes";
import styles from "./topbar.module.css";

export function PrimaryNav() {
  const { lane } = useDeskUi();
  const pathname = usePathname() ?? "/";
  const items = PRIMARY_NAV[lane];
  const active = activeNavItem(items, pathname);
  return (
    <nav className={styles.nav} aria-label="Primary navigation">
      {items.map(({ label, href }) => (
        <a
          key={href}
          className={styles.navLink}
          href={href}
          aria-current={active?.href === href ? "page" : undefined}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}

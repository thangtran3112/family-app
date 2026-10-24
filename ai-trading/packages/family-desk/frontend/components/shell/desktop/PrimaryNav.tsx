"use client";

import { usePathname } from "next/navigation";
import { useDeskUi } from "@/components/shell/desktop/DeskContext";
import { PRIMARY_NAV, isNavActive } from "@/lib/lanes";
import styles from "./topbar.module.css";

export function PrimaryNav() {
  const { lane } = useDeskUi();
  const pathname = usePathname() ?? "/";
  return (
    <nav className={styles.nav} aria-label="Primary navigation">
      {PRIMARY_NAV[lane].map(({ label, href }) => (
        <a
          key={href}
          className={styles.navLink}
          href={href}
          aria-current={isNavActive(href, pathname) ? "page" : undefined}
        >
          {label}
        </a>
      ))}
    </nav>
  );
}

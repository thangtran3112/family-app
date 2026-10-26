"use client";

import { useSyncExternalStore } from "react";
import { MORE_SECTIONS, moreSectionFor } from "@/lib/lanes";
import styles from "./leftrail.module.css";

const subscribeHash = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};

/** The "Settings & More" rail (board `KSZ-0`, 02s §Frontend): the Settings sections, then Feedback. */
export function MoreRail({ pathname }: { pathname: string }) {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash, () => "");
  const current = moreSectionFor(pathname, hash);
  return (
    <nav className={styles.more} aria-label="Settings and More sections">
      <h2 className={styles.moreTitle}>Settings &amp; More</h2>
      <ul className={styles.list}>
        {MORE_SECTIONS.map((section) => (
          <li key={section.id}>
            <a href={section.href} className={styles.moreLink} aria-current={section.id === current ? "page" : undefined}>
              {section.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

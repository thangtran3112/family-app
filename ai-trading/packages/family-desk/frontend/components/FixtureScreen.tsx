import type { ReactNode } from "react";
import { fixtureBannerText } from "../lib/fixtures/banner.ts";
import styles from "./FixtureScreen.module.css";

export function FixtureScreen({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <main className={styles.screen}>
      <header className={styles.header}>
        <div>
          <p className={styles.kicker}>FAMILY DESK</p>
          <h1>{title}</h1>
        </div>
        <p className={styles.banner} role="status">
          <strong>{fixtureBannerText()}</strong>
          <span>Illustrative sample data only · no live account or market connection</span>
        </p>
      </header>
      {children}
    </main>
  );
}

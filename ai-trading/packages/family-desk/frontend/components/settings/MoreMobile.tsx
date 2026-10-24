import Link from "next/link";
import { Fixtures } from "./Fixtures.tsx";
import styles from "../../app/more/More.module.css";

const links = [
  ["Watchlists", "/watchlists", "Saved lists and symbols"],
  ["Holdings", "/holdings", "Portfolio views"],
  ["Settings", "/settings", "Alerts and system status"],
] as const;

export function MoreMobile() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>More</h1>
        <p>Desk preferences and account views.</p>
      </header>

      <Fixtures items={["offSwitch"]} />

      <nav className={styles.links} aria-label="More pages">
        {links.map(([label, href, description]) => (
          <Link className={styles.link} href={href} key={href}>
            <span className={styles.linkText}>
              <strong>{label}</strong>
              <span>{description}</span>
            </span>
            <svg className={styles.chevron} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
              <path d="m9 6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
        ))}
      </nav>
    </main>
  );
}

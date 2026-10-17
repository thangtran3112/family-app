import Link from "next/link";
import styles from "@/components/watchlists/watchlists.module.css";

export default function HomePage() {
  return (
    <main className={styles.page}>
      <section className={styles.emptyState}>
        <h1>Today</h1>
        <p>Create a watchlist or open an owned list to start with actual Desk data.</p>
        <Link className={styles.primaryLink} href="/watchlists">Create your first watchlist</Link>
      </section>
    </main>
  );
}

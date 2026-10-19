import { Suspense } from "react";
import { TechnicalsScreen } from "@/components/technicals/TechnicalsScreen";
import styles from "@/components/technicals/technicals.module.css";

export default function TechnicalsPage() {
  return <Suspense fallback={<main className={styles.page}><p role="status">Loading technicals…</p></main>}><TechnicalsScreen /></Suspense>;
}

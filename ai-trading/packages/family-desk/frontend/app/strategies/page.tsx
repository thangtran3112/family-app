import { Suspense } from "react";
import { StrategyRoute } from "@/components/builder/StrategyRoute";
import styles from "@/components/builder/builder.module.css";

export default function StrategiesPage() {
  return (
    <Suspense fallback={<main className={styles.workspace}><p>Loading strategies…</p></main>}>
      <StrategyRoute />
    </Suspense>
  );
}

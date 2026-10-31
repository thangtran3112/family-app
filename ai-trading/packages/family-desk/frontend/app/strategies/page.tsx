import type { Metadata } from "next";
import { Suspense } from "react";
import { StrategyRoute } from "@/components/builder/StrategyRoute";
import styles from "@/components/builder/builder.module.css";

export const metadata: Metadata = { title: "Strategies" };

export default function StrategiesPage() {
  return (
    <Suspense fallback={<div className={styles.workspace}><p>Loading strategies…</p></div>}>
      <StrategyRoute />
    </Suspense>
  );
}

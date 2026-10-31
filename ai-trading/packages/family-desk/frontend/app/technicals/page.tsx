import type { Metadata } from "next";
import { Suspense } from "react";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";
import { TechnicalsDesktop } from "@/components/technicals/TechnicalsDesktop";
import { TechnicalsScreen } from "@/components/technicals/TechnicalsScreen";
import styles from "@/components/technicals/technicals.module.css";

export const metadata: Metadata = { title: "Technicals" };

export default function TechnicalsPage() {
  const loading = <div className={styles.page}><p role="status">Loading technicals…</p></div>;
  return (
    <Suspense fallback={loading}>
      <DeskResponsive desktop={<TechnicalsDesktop />} mobile={<TechnicalsScreen />} />
    </Suspense>
  );
}

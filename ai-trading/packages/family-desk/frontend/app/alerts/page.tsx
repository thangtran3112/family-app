import type { Metadata } from "next";
import { Suspense } from "react";
import { AlertsScreen } from "@/components/alerts/AlertsScreen";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";

export const metadata: Metadata = { title: "Alerts" };

export default function AlertsPage() {
  return (
    <Suspense fallback={null}>
      <DeskResponsive desktop={<AlertsScreen />} />
    </Suspense>
  );
}

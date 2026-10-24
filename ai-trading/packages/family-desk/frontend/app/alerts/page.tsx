import { Suspense } from "react";
import { AlertsScreen } from "@/components/alerts/AlertsScreen";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";

export default function AlertsPage() {
  return (
    <Suspense fallback={null}>
      <DeskResponsive desktop={<AlertsScreen />} />
    </Suspense>
  );
}

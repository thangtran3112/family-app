import { Suspense } from "react";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";
import { ScreenerScreen } from "@/components/screener/ScreenerScreen";

export default function ScreenerPage() {
  return (
    <Suspense fallback={null}>
      <DeskResponsive desktop={<ScreenerScreen />} />
    </Suspense>
  );
}

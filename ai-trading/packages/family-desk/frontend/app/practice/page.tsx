import { Suspense } from "react";
import { PracticeHub } from "@/components/practice/hub/PracticeHub";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";

export default function PracticePage() {
  return (
    <Suspense fallback={null}>
      <DeskResponsive desktop={<PracticeHub />} />
    </Suspense>
  );
}

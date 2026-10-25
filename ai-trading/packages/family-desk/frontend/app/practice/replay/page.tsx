import { Suspense } from "react";
import { ReplayWorkspace } from "@/components/practice/replay/ReplayWorkspace";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";

export default function PracticeReplayPage() {
  return (
    <Suspense fallback={null}>
      <DeskResponsive desktop={<ReplayWorkspace />} />
    </Suspense>
  );
}

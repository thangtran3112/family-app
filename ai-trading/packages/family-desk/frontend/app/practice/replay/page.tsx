import type { Metadata } from "next";
import { Suspense } from "react";
import { ReplayWorkspace } from "@/components/practice/replay/ReplayWorkspace";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";

export const metadata: Metadata = { title: "Practice replay" };

export default function PracticeReplayPage() {
  return (
    <Suspense fallback={null}>
      <DeskResponsive desktop={<ReplayWorkspace />} />
    </Suspense>
  );
}

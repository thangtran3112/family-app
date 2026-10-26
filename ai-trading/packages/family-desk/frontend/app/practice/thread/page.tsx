import type { Metadata } from "next";
import { Suspense } from "react";
import { ThreadOverview } from "@/components/practice/hub/ThreadOverview";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";

export const metadata: Metadata = { title: "Practice thread" };

export default function PracticeThreadPage() {
  return (
    <Suspense fallback={null}>
      <DeskResponsive desktop={<ThreadOverview />} />
    </Suspense>
  );
}

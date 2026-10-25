import type { Metadata } from "next";
import { Suspense } from "react";
import { PracticeHub } from "@/components/practice/hub/PracticeHub";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";

export const metadata: Metadata = { title: "Practice" };

export default function PracticePage() {
  return (
    <Suspense fallback={null}>
      <DeskResponsive desktop={<PracticeHub />} />
    </Suspense>
  );
}

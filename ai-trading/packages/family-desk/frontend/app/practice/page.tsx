import type { Metadata } from "next";
import { Suspense } from "react";
import { PracticeLanding } from "@/components/practice/hub/PracticeLanding";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";

export const metadata: Metadata = { title: "Practice" };

export default function PracticePage() {
  return (
    <Suspense fallback={null}>
      <DeskResponsive desktop={<PracticeLanding />} />
    </Suspense>
  );
}

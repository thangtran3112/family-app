import type { Metadata } from "next";
import { Suspense } from "react";
import { ScreenView } from "@/components/practice/screen/ScreenView";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";

export const metadata: Metadata = { title: "Practice screen" };

export default function PracticeScreenPage() {
  return (
    <Suspense fallback={null}>
      <DeskResponsive desktop={<ScreenView />} />
    </Suspense>
  );
}

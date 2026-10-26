import type { Metadata } from "next";
import { Suspense } from "react";
import { FeedbackScreen } from "@/components/feedback/FeedbackScreen";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";

export const metadata: Metadata = { title: "Feedback" };

export default function FeedbackPage() {
  return (
    <Suspense fallback={null}>
      <DeskResponsive desktop={<FeedbackScreen />} />
    </Suspense>
  );
}

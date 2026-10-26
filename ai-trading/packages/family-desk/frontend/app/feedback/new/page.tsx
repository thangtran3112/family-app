import type { Metadata } from "next";
import { Suspense } from "react";
import { FeedbackForm } from "@/components/feedback/FeedbackForm";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";

export const metadata: Metadata = { title: "Report a problem" };

export default function NewFeedbackPage() {
  return (
    <Suspense fallback={null}>
      <DeskResponsive desktop={<FeedbackForm />} />
    </Suspense>
  );
}

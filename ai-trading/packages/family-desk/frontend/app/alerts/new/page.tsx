import type { Metadata } from "next";
import { Suspense } from "react";
import { AlertSetupForm } from "@/components/alerts/setup/AlertSetupForm";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";

export const metadata: Metadata = { title: "New alert" };

export default function NewAlertPage() {
  return (
    <Suspense fallback={null}>
      <DeskResponsive desktop={<AlertSetupForm />} />
    </Suspense>
  );
}

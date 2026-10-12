import type { Metadata } from "next";
import { PageShell } from "@/components/page-shell";
import { AppControlsPanel } from "@/components/app-controls-panel";

export const metadata: Metadata = { title: "Settings | Trading Hub" };

export default function SettingsPage() {
  return (
    <PageShell breadcrumb="Settings">
      <AppControlsPanel />
    </PageShell>
  );
}

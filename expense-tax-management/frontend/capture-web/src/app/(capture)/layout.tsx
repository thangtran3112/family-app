import type { ReactNode } from "react";

import { CaptureShell } from "@/components/capture-shell";
import { OfflineIndicator } from "@/components/offline-indicator";

export default function AppLayout({ children }: { children: ReactNode }) {
  return <CaptureShell><OfflineIndicator />{children}</CaptureShell>;
}

import type { ReactNode } from "react";

import { CaptureShell } from "@/components/capture-shell";
import { CaptureAuthGate } from "@/components/capture-auth-gate";
import { OfflineIndicator } from "@/components/offline-indicator";

export default function AppLayout({ children }: { children: ReactNode }) {
  return <CaptureAuthGate><CaptureShell><OfflineIndicator />{children}</CaptureShell></CaptureAuthGate>;
}

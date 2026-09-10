import type { ReactNode } from "react";
import { OfficeShell } from "@/components/office-shell";
import { OfficeAuthGate } from "@/components/office-auth-gate";
export default function OfficeLayout({ children }: { children: ReactNode }) { return <OfficeAuthGate><OfficeShell>{children}</OfficeShell></OfficeAuthGate>; }

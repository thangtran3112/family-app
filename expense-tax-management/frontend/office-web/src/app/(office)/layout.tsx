import type { ReactNode } from "react";
import { OfficeShell } from "@/components/office-shell";
export default function OfficeLayout({ children }: { children: ReactNode }) { return <OfficeShell>{children}</OfficeShell>; }

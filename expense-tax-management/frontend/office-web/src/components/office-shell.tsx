"use client";
import { Archive, Building2, ChartNoAxesCombined, FileDown, Forward, LayoutDashboard, List, Settings, Tags } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
const nav = [
  ["/dashboard", "Dashboard", LayoutDashboard], ["/expenses", "Expenses", List],
  ["/businesses", "Businesses", Building2], ["/projects", "Projects", ChartNoAxesCombined],
  ["/tax", "Tax", Tags], ["/exports", "Exports", FileDown],
  ["/forwarding", "Forwarding", Forward], ["/settings", "Settings", Settings],
] as const;
export function OfficeShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  return <div className="office-shell"><aside><Link className="brand" href="/dashboard"><span>O</span>ExpenseTax Office</Link><nav aria-label="Office navigation">{nav.map(([href,label,Icon]) => <Link key={href} href={href} aria-current={path.startsWith(href) ? "page" : undefined}><Icon size={17} />{label}</Link>)}</nav><p><Archive size={15} /> Preparation + export<br />Never tax filing</p></aside><main><div className="small-handoff"><h1>Use Capture on this screen.</h1><p>Office needs at least 1024px for safe ledger and tax review.</p><Link href={process.env.NEXT_PUBLIC_CAPTURE_URL ?? "http://localhost:7301/capture"}>Open Capture</Link></div><div className="desktop-content">{children}</div></main></div>;
}

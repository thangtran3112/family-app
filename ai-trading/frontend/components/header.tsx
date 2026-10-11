import Link from "next/link";
import { CandlestickChart, LockKeyhole } from "lucide-react";
import { AppsMenu } from "@/components/apps-menu";
import { AccountMenu } from "@/components/account-menu";

export function HubBrand() {
  return (
    <Link href="/" className="flex min-h-11 shrink-0 items-center gap-3 rounded-md text-lg font-semibold tracking-[-0.03em] text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-on-accent">
        <CandlestickChart aria-hidden size={20} strokeWidth={1.8} />
      </span>
      Trading Hub
    </Link>
  );
}

export function Header({ breadcrumb }: { breadcrumb?: string }) {
  return (
    <header className="z-10 h-[72px] shrink-0 border-b border-border bg-background">
      <div className="flex h-full w-full items-center justify-between gap-3 px-6 md:px-8 xl:px-10">
        <div className="xl:hidden"><HubBrand /></div>
        <div className="hidden min-w-0 items-center gap-3 text-[13px] leading-5 xl:flex">
          <Link href="/" className="flex min-h-11 items-center rounded text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
            {breadcrumb ? "All applications" : "Workspace"}
          </Link>
          <span aria-hidden className="text-muted-foreground">/</span>
          <span className="truncate">{breadcrumb ?? "Overview"}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2 xl:hidden">
          <AppsMenu /><AccountMenu />
        </div>
        <div className="hidden items-center gap-2 text-xs text-muted-foreground xl:flex">
          <LockKeyhole aria-hidden size={14} />Private workspace
        </div>
      </div>
    </header>
  );
}

import Link from "next/link";
import { LayoutGrid } from "lucide-react";
import { appIcons, hubApps } from "@/lib/apps";
import { HubBrand } from "@/components/header";
import { AccountMenu } from "@/components/account-menu";

const NAV_LINK = "flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors duration-150 hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none";

export function WorkspaceSidebar({ breadcrumb }: { breadcrumb?: string }) {
  return (
    <aside className="hidden w-56 shrink-0 flex-col gap-7 border-r border-border px-4 pb-5 pt-7 xl:flex">
      <div className="px-2">
        <HubBrand />
        <p className="mt-2 text-[11px] leading-4 tracking-[0.1em] text-muted-foreground">PRIVATE FAMILY WORKSPACE</p>
      </div>
      <nav aria-label="Workspace" className="space-y-7">
        <Link href="/" aria-current={!breadcrumb ? "page" : undefined} className={`${NAV_LINK} ${!breadcrumb ? "bg-card font-semibold text-accent" : "text-muted-foreground"}`}>
          <LayoutGrid aria-hidden size={18} className="shrink-0" />All applications
        </Link>
        <div>
          <p className="px-3 pb-2 text-[11px] leading-4 tracking-[0.1em] text-muted-foreground">YOUR TOOLS</p>
          <div className="space-y-1.5">
            {hubApps.filter((app) => app.status !== "planned").map((app) => {
              const Icon = appIcons[app.icon];
              const active = breadcrumb === app.name;
              return (
                <Link key={app.slug} href={`/apps/${app.slug}`} aria-current={active ? "page" : undefined} className={`${NAV_LINK} ${active ? "bg-card font-semibold text-accent" : "text-muted-foreground"}`}>
                  <Icon aria-hidden size={18} strokeWidth={1.6} className="shrink-0" /><span className="min-w-0 truncate">{app.name}</span>
                </Link>
              );
            })}
          </div>
        </div>
      </nav>
      <div className="mt-auto space-y-4">
        <div className="border-t border-border px-3 pt-4">
          <p className="text-[13px] leading-[18px]">One hub. One sign-in.</p>
          <p className="mt-2 text-xs leading-[18px] text-muted-foreground">Your research tools, together.</p>
        </div>
        <AccountMenu sidebar />
      </div>
    </aside>
  );
}

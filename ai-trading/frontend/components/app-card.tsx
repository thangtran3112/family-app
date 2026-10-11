"use client";

import Link from "next/link";
import { ArrowUpRight, Clock3, RefreshCw, Settings } from "lucide-react";
import { appIcons, getAppLaunch, type HubApp } from "@/lib/apps";
import { appLaunchGate, launchGuidance } from "@/lib/controls";
import { useAppControls } from "@/components/app-controls-provider";

const FOCUS_RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function AppCard({ app }: { app: HubApp }) {
  const Icon = appIcons[app.icon];
  const launch = getAppLaunch(app);
  const { state, error, refresh } = useAppControls();

  if (!launch) {
    return (
      <div role="group" aria-disabled="true" className="grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-3 rounded-xl border border-border p-5 xl:px-6">
        <div className="flex h-10 w-10 items-center justify-center rounded-[10px] border border-border text-muted-foreground md:row-span-2">
          <Icon aria-hidden size={20} strokeWidth={1.5} />
        </div>
        <h2 className="text-base leading-[22px] font-semibold">{app.name}</h2>
        <span className="flex items-center gap-1.5 text-xs leading-[18px] text-muted-foreground md:row-span-2">
          <Clock3 aria-hidden size={14} />Planned
        </span>
        <p className="col-span-3 text-sm leading-[22px] text-muted-foreground md:col-span-1 md:col-start-2 md:text-[13px] md:leading-5">
          {app.summary}<span className="hidden xl:inline"> Separate from these research tools.</span>
        </p>
      </div>
    );
  }

  const primary = app.slug === "tradingagents";
  const badge = app.kind === "terminal" ? "Terminal" : app.kind === "upstream-setup" ? "Setup required" : app.slug === "mirofish" ? "Experimental" : "Web app";
  // Status-specific, never a blanket "stopped": available only once `status`
  // is confirmed Running; every other status gets its own truthful guidance
  // (never claiming Running or Stopped beyond what the live status says). A
  // failed refresh (`error` set) must not keep presenting a now-unconfirmed
  // cached snapshot as live availability, so it's treated the same as
  // "unknown" as the initial unloaded state -- and `launchGuidance` gives
  // "unknown" its own distinct, non-launching copy (never the normal CTA,
  // never "Stopped" either).
  const gate = appLaunchGate(error ? null : state, app.slug);
  const guidance = launchGuidance(gate);

  return (
    <article className="flex min-h-[232px] min-w-0 flex-col gap-4 rounded-xl border border-border bg-card p-5 md:min-h-[244px] xl:min-h-[208px] xl:px-6 xl:py-[22px]">
      <div className="flex items-center gap-3">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-muted ${primary ? "text-accent" : "text-foreground"}`}>
          <Icon aria-hidden size={22} strokeWidth={1.5} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-xl leading-[26px] font-semibold tracking-[-0.025em]">
            <Link href={`/apps/${app.slug}`} className={`rounded hover:text-accent ${FOCUS_RING}`}>{app.name}</Link>
          </h2>
          <p className="mt-0.5 text-xs leading-[18px] text-muted-foreground">{app.subtitle}</p>
        </div>
        <span className="shrink-0 rounded-[5px] border border-border px-2 py-1 text-[11px] leading-4 text-muted-foreground">{badge}</span>
      </div>
      <p className="max-w-[450px] text-[15px] leading-[22px] text-muted-foreground">{app.summary}</p>
      <div className="mt-auto flex items-center justify-between gap-4">
        <p className="min-w-0 text-xs leading-[18px] text-muted-foreground">{guidance ? guidance.detail : app.launchNote}</p>
        {guidance ? (
          <div className="flex shrink-0 items-center gap-2">
            {guidance.showRefresh && (
              <button
                type="button"
                onClick={refresh}
                aria-label={`Retry checking ${app.name}'s status`}
                className={`flex h-11 w-11 items-center justify-center rounded-[7px] border border-border text-foreground transition-colors duration-150 hover:bg-muted motion-reduce:transition-none ${FOCUS_RING}`}
              >
                <RefreshCw aria-hidden size={15} />
              </button>
            )}
            <Link
              href="/settings"
              aria-label={`${app.name} ${guidance.headline} Open Settings.`}
              className={`inline-flex min-h-11 items-center justify-center gap-2.5 rounded-[7px] bg-muted px-4 text-[13px] leading-5 font-semibold text-foreground transition-colors duration-150 hover:bg-muted/70 motion-reduce:transition-none ${FOCUS_RING}`}
            >
              Open Settings<Settings aria-hidden size={15} strokeWidth={1.6} />
            </Link>
          </div>
        ) : (
          <Link
            href={launch.href}
            target={launch.newTab ? "_blank" : undefined}
            rel={launch.newTab ? "noopener" : undefined}
            aria-label={`${launch.label}: ${app.name}${launch.newTab ? " (opens in a new tab)" : ""}`}
            className={`inline-flex min-h-11 shrink-0 items-center justify-center gap-2.5 rounded-[7px] px-4 text-[13px] leading-5 font-semibold transition-colors duration-150 motion-reduce:transition-none ${primary ? "bg-accent text-on-accent hover:bg-accent/90" : "bg-muted text-foreground hover:bg-muted/70"} ${FOCUS_RING}`}
          >
            {launch.label}<ArrowUpRight aria-hidden size={15} strokeWidth={1.6} />
          </Link>
        )}
      </div>
    </article>
  );
}

"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, ExternalLink, Info, RotateCw, Settings, Terminal } from "lucide-react";
import { appIcons, type ExternalApp, type TerminalApp } from "@/lib/apps";
import { isAppKnownStopped } from "@/lib/controls";
import { useAppControls } from "@/components/app-controls-provider";

const FOCUS_RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function TerminalFrame({ app }: { app: TerminalApp }) {
  const [connection, setConnection] = useState(0);
  const Icon = appIcons[app.icon];
  const { state } = useAppControls();
  const stopped = isAppKnownStopped(state, app.slug);

  return (
    <div className="mx-auto w-full max-w-[1440px] px-6 pt-7 pb-8 md:p-8 xl:px-10 xl:pt-9 xl:pb-7">
      <div className="flex flex-wrap items-center justify-between gap-6">
        <div className="max-w-[590px]">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[10px] bg-muted text-accent"><Icon aria-hidden size={24} strokeWidth={1.5} /></div>
            <h1 className="text-[28px] leading-9 font-semibold tracking-[-0.04em] md:text-4xl md:leading-[44px]">{app.name}</h1>
          </div>
          <p className="mt-3 text-[15px] leading-6 text-muted-foreground">{app.summary} Run the original app here.</p>
        </div>
        {stopped ? (
          <Link
            href="/settings"
            aria-label={`${app.name} is off. Open Settings to turn it back on.`}
            className={`inline-flex min-h-11 shrink-0 items-center justify-center gap-2.5 rounded-[7px] bg-muted px-[18px] text-[13px] leading-5 font-semibold text-foreground transition-colors duration-150 hover:bg-muted/70 motion-reduce:transition-none ${FOCUS_RING}`}
          >
            Open Settings<Settings aria-hidden size={16} strokeWidth={1.6} />
          </Link>
        ) : (
          <>
            <a href={app.hostUrl} target="_blank" rel="noopener" aria-label={`Open ${app.name} full-screen (opens in a new tab)`} className={`inline-flex min-h-11 shrink-0 items-center justify-center gap-2.5 rounded-[7px] bg-accent px-[18px] text-[13px] leading-5 font-semibold text-on-accent transition-colors duration-150 hover:bg-accent/90 motion-reduce:transition-none ${FOCUS_RING}`}>
              Open full-screen<ArrowUpRight aria-hidden size={16} strokeWidth={1.6} />
            </a>
            {app.slug === "tradingagents" && (
              <a
                href={new URL("research", app.hostUrl).toString()}
                target="_blank"
                rel="noopener"
                aria-label="Open TradingAgents research dashboard (opens in a new tab)"
                className={`inline-flex min-h-11 shrink-0 items-center justify-center gap-2.5 rounded-[7px] border border-border px-[18px] text-[13px] leading-5 font-semibold text-foreground transition-colors duration-150 hover:bg-muted motion-reduce:transition-none ${FOCUS_RING}`}
              >
                Research dashboard<ArrowUpRight aria-hidden size={16} strokeWidth={1.6} />
              </a>
            )}
          </>
        )}
      </div>

      <div className="mt-7 grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_276px]">
        {stopped ? (
          <section aria-label={`${app.name} status`} className="flex min-h-[200px] flex-col items-center justify-center gap-3 rounded-xl border border-border p-8 text-center">
            <p className="font-medium">{app.name} is turned off right now.</p>
            <p className="text-sm text-muted-foreground">Turn it back on in Settings. Your existing data stays put.</p>
            <Link href="/settings" className={`mt-2 inline-flex min-h-11 items-center gap-2 rounded-[7px] border border-border px-4 text-[13px] font-semibold transition-colors duration-150 hover:bg-muted motion-reduce:transition-none ${FOCUS_RING}`}>
              Open Settings<Settings aria-hidden size={16} />
            </Link>
          </section>
        ) : (
          <section aria-label={`${app.name} terminal`} className="min-w-0 overflow-hidden rounded-xl border border-border">
            <div className="flex min-h-14 items-center justify-between gap-3 border-b border-border bg-card px-5">
              <div className="flex items-center gap-2.5 text-[13px] font-medium"><Terminal aria-hidden size={17} strokeWidth={1.6} className="text-muted-foreground" />Terminal</div>
              <button type="button" onClick={() => setConnection((n) => n + 1)} className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-2 text-xs text-foreground transition-colors duration-150 hover:bg-muted motion-reduce:transition-none ${FOCUS_RING}`}><RotateCw aria-hidden size={14} />Reconnect</button>
            </div>
            <iframe key={connection} src={app.terminalPath} title={`${app.name} terminal`} className="block h-[378px] w-full border-0 bg-black xl:h-[max(378px,calc(100dvh-522px))]" />
            <div className="flex items-center gap-2.5 border-t border-border bg-card px-5 py-3.5 text-xs leading-[18px] text-muted-foreground"><Info aria-hidden size={15} className="shrink-0" /><p>Closing this page keeps your terminal session running.</p></div>
          </section>
        )}

        <aside aria-label="App guidance" className="space-y-7">
          <section>
            <h2 className="text-[11px] leading-4 tracking-[0.08em] text-muted-foreground">GOOD FOR</h2>
            <p className="mt-3 text-xl leading-7 font-medium tracking-[-0.025em]">{app.goodFor}</p>
            <p className="mt-3 text-sm leading-[22px] text-muted-foreground">Compare the results with your own research before forming a judgment.</p>
          </section>
          <section className="border-t border-border pt-6">
            <h2 className="text-[13px] leading-5 font-semibold">Before you start</h2>
            <p className="mt-3 text-sm leading-[22px] text-muted-foreground">Use a keyboard for the terminal.</p>
            <p className="mt-3 text-sm leading-[22px] text-muted-foreground">{app.costNote}</p>
          </section>
          <section className="rounded-[10px] border border-border p-[18px]">
            <h2 className="text-[13px] leading-5 font-medium">Research, not execution.</h2>
            <p className="mt-2.5 text-[13px] leading-5 text-muted-foreground">These reports are not trade instructions. Review sources and make your own decisions.</p>
          </section>
        </aside>
      </div>
    </div>
  );
}

// The interactive half of the external-app detail page (app/apps/[slug]/
// page.tsx): that page stays a Server Component for generateStaticParams/
// generateMetadata, so the controls-aware launch CTA lives here instead,
// alongside TerminalFrame's identical running/stopped split.
export function ExternalLaunch({ app }: { app: ExternalApp }) {
  const { state } = useAppControls();
  const stopped = isAppKnownStopped(state, app.slug);

  if (stopped) {
    return (
      <div className="mt-6 rounded-[10px] border border-border p-4 text-left">
        <p className="text-sm font-medium text-foreground">{app.name} is turned off right now.</p>
        <p className="mt-2 text-sm text-muted-foreground">Turn it back on in Settings. Your existing data stays put.</p>
        <Link
          href="/settings"
          className={`mt-4 inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-[7px] bg-muted px-4 py-3 text-[13px] font-semibold text-foreground transition-colors duration-150 hover:bg-muted/70 motion-reduce:transition-none ${FOCUS_RING}`}
        >
          Open Settings<Settings aria-hidden size={16} />
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="mt-6 text-left">
        <h2 className="text-sm font-semibold text-foreground">First visit in this browser</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          {app.firstVisitNote.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </div>
      <a
        href={app.url}
        target="_blank"
        rel="noopener"
        className={`mt-6 inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-[7px] bg-accent px-4 py-3 text-[13px] font-semibold text-on-accent transition-opacity duration-150 hover:opacity-90 motion-reduce:transition-none ${FOCUS_RING}`}
      >
        Open {app.name}
        <ExternalLink aria-hidden size={16} />
      </a>
      <p className="mt-6 text-xs text-muted-foreground">
        {app.name} opens in its own tab because it does not allow embedding in other pages.
      </p>
    </>
  );
}

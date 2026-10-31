"use client";

import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { hasMoreLeftRail, hasPracticeLeftRail, isPracticePath, isWrongLane } from "@/lib/lanes";
import type { ShellBand } from "@/lib/desk/viewport";
import { DeskHoldingsProvider, DeskStatusProvider, DeskUiProvider, LeftSlotContext, RailSlotContext, useDeskUi } from "./DeskContext";
import { LeftRail } from "./LeftRail";
import { MoreRail } from "./MoreRail";
import { PracticeBand, PracticeChromeProvider } from "./PracticeChrome";
import { StatusBar } from "./StatusBar";
import { TopBar } from "./TopBar";
import { WrongLaneInterstitial } from "./WrongLaneInterstitial";
import leftStyles from "./leftrail.module.css";

/** The desktop shell (>= 1100 px, 02m §c1): 48 px top bar, left rail, center, right rail slot, 24 px status bar. */
export function DesktopShell({ band, children }: { band: ShellBand; children: ReactNode }) {
  return (
    <DeskStatusProvider>
      <DeskUiProvider>
        <DeskHoldingsProvider>
          <PracticeChromeProvider>
            <ShellFrame band={band}>{children}</ShellFrame>
          </PracticeChromeProvider>
        </DeskHoldingsProvider>
      </DeskUiProvider>
    </DeskStatusProvider>
  );
}

function ShellFrame({ band, children }: { band: ShellBand; children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const { lane, leftCollapsed, chartFocus } = useDeskUi();
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [leftSlot, setLeftSlot] = useState<HTMLElement | null>(null);
  // Practice pages (02o §a1) get the amber band; the replay, the day list and the journal swap the watchlists for their own left panel.
  const practice = isPracticePath(pathname);
  const ownLeft = hasPracticeLeftRail(pathname);
  // Settings, More and the Feedback log (02s) show the "Settings & More" sections instead of the watchlists.
  const moreLeft = hasMoreLeftRail(pathname);

  return (
    <RailSlotContext.Provider value={slot}>
      <LeftSlotContext.Provider value={ownLeft ? leftSlot : null}>
      <div className="dk-shell" data-band={band} data-left={leftCollapsed && !ownLeft && !moreLeft ? "collapsed" : "open"} data-practice={practice ? "true" : undefined} data-focus={practice && chartFocus ? "chart" : undefined}>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <div className="dk-top"><TopBar band={band} /></div>
        {practice && <div className="dk-band"><PracticeBand /></div>}
        <div className="dk-left">
          {moreLeft ? (
            <aside className={leftStyles.root} aria-label="Settings and More"><MoreRail pathname={pathname} /></aside>
          ) : ownLeft ? (
            <aside className={leftStyles.root} aria-label="Practice side panel" ref={setLeftSlot} />
          ) : (
            <LeftRail band={band} />
          )}
        </div>
        <div className="dk-center" id="main-content" tabIndex={-1}>
          {isWrongLane(lane, pathname) ? <WrongLaneInterstitial pathname={pathname} /> : children}
        </div>
        <aside className="dk-right" ref={setSlot} aria-label="Context" />
        <div className="dk-status"><StatusBar /></div>
      </div>
      </LeftSlotContext.Provider>
    </RailSlotContext.Provider>
  );
}

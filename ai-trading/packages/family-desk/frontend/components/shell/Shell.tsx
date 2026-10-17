"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { DesktopNav } from "./DesktopNav";
import { MobileTabs } from "./MobileTabs";

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";

  return (
    <div className="desk-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="desk-header">
        <div className="header-brand-nav">
          <Link className="desk-brand" href="/" aria-label="Family Desk home">
            <span className="brand-mark" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M9 5v4M9 15v4M15 3v6M15 15v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <rect x="7" y="9" width="4" height="6" rx="1" stroke="currentColor" strokeWidth="2" />
                <rect x="13" y="9" width="4" height="6" rx="1" stroke="currentColor" strokeWidth="2" />
              </svg>
            </span>
            <span>Family Desk</span>
          </Link>
          <DesktopNav pathname={pathname} />
        </div>
        <div className="header-actions">
          <span className="connection-status connection-status-desktop">IBKR not configured</span>
          <span className="connection-status connection-status-mobile">Awaiting data user</span>
          <Link className="header-settings" href="/settings" aria-label="Settings">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
              <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" stroke="currentColor" strokeWidth="1.8" />
              <path d="m19.4 15 .1.1 1.1.9-1.5 2.6-1.4-.6a1.8 1.8 0 0 0-1.7.1l-.2.1a1.8 1.8 0 0 0-.9 1.4L14.7 21h-3l-.2-1.5a1.8 1.8 0 0 0-1.1-1.4l-.2-.1a1.8 1.8 0 0 0-1.7-.1l-1.4.6-1.5-2.6 1.2-.9a1.8 1.8 0 0 0 .7-1.6v-.2a1.8 1.8 0 0 0-.7-1.6l-1.2-.9 1.5-2.6 1.4.6a1.8 1.8 0 0 0 1.7-.1l.2-.1a1.8 1.8 0 0 0 .9-1.4L11.7 3h3l.2 1.5A1.8 1.8 0 0 0 16 5.9l.2.1a1.8 1.8 0 0 0 1.7.1l1.4-.6 1.5 2.6-1.2.9a1.8 1.8 0 0 0-.7 1.6v.2a1.8 1.8 0 0 0 .5 1.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            <span>Settings</span>
          </Link>
        </div>
      </header>
      <div className="desk-shell-content" id="main-content" tabIndex={-1}>{children}</div>
      <MobileTabs pathname={pathname} />
    </div>
  );
}

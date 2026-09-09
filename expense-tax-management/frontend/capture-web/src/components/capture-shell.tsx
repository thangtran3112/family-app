"use client";

import { Camera, Inbox, ListTodo, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const nav = [
  { href: "/capture", label: "Capture", Icon: Camera },
  { href: "/queue", label: "Queue", Icon: ListTodo },
  { href: "/inbox", label: "Inbox", Icon: Inbox },
  { href: "/settings", label: "Settings", Icon: Settings },
];

export function CaptureShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="capture-shell">
      <aside className="side-rail">
        <Link href="/capture" className="brand"><span>ET</span> Capture</Link>
        <nav aria-label="Capture navigation">
          {nav.map(({ href, label, Icon }) => (
            <Link key={href} href={href} aria-current={pathname.startsWith(href) ? "page" : undefined}>
              <Icon aria-hidden="true" size={18} />{label}
            </Link>
          ))}
        </nav>
        <p>Phone + tablet workspace<br />Office opens dense reports.</p>
      </aside>
      <main>{children}</main>
      <nav className="bottom-nav" aria-label="Capture navigation">
        {nav.map(({ href, label, Icon }) => (
          <Link key={href} href={href} aria-current={pathname.startsWith(href) ? "page" : undefined}>
            <Icon aria-hidden="true" size={19} /><span>{label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}

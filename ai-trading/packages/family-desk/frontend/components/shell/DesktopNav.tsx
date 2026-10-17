import Link from "next/link";

const tabs = [
  ["Today", "/"],
  ["Strategies", "/strategies"],
  ["Paper", "/paper"],
  ["Ask", "/ask"],
  ["Watchlists", "/watchlists"],
  ["Holdings", "/holdings"],
] as const;

export function DesktopNav({ pathname }: { pathname: string }) {
  return (
    <nav className="desktop-nav" aria-label="Primary navigation">
      {tabs.map(([label, href]) => {
        const active = href === "/" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link key={href} href={href} aria-current={active ? "page" : undefined}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

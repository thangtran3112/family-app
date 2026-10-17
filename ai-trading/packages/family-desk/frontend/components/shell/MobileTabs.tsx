const tabs = [
  ["Today", "/", "M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z"],
  ["Strategies", "/strategies", "M3 12h4l3-8 4 16 3-8h4"],
  ["Paper", "/paper", "M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3"],
  ["Ask", "/ask", "M4 5h16v11H9l-5 4z"],
  ["More", "/more", "M6 12h.01M12 12h.01M18 12h.01"],
] as const;

export function MobileTabs({ pathname }: { pathname: string }) {
  return (
    <nav className="mobile-tabs" aria-label="Primary navigation">
      {tabs.map(([label, href, icon]) => {
        const active = href === "/"
          ? pathname === href
          : label === "More"
            ? pathname === "/more" || pathname === "/settings"
            : pathname === href || pathname.startsWith(`${href}/`);

        return (
          <a key={href} href={href} aria-current={active ? "page" : undefined}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
              {label === "More" ? (
                <>
                  <circle cx="6" cy="12" r="1.6" fill="currentColor" />
                  <circle cx="12" cy="12" r="1.6" fill="currentColor" />
                  <circle cx="18" cy="12" r="1.6" fill="currentColor" />
                </>
              ) : (
                <path d={icon} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              )}
            </svg>
            <span>{label}</span>
          </a>
        );
      })}
    </nav>
  );
}

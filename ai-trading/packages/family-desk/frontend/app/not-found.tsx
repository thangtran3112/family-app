import Link from "next/link";

/** The 404 inside the shell. A static export has no server redirects, so an old address such as `/journal?thread=2` ends here: say what happened and link to where things live now (D-135). */
export default function NotFound() {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: "var(--space-2)", padding: "var(--space-6)" }}>
      <h1 style={{ margin: 0, fontSize: "var(--text-row)" }}>This page does not exist</h1>
      <p style={{ margin: 0, color: "var(--color-muted)", fontSize: "var(--text-label)" }}>
        The address may be old: the journal now lives under Practice.
      </p>
      <p style={{ display: "flex", gap: "var(--space-4)", margin: 0, fontSize: "var(--text-label)" }}>
        <Link href="/practice" style={{ color: "var(--color-amber)", fontWeight: 600 }}>Open Practice</Link>
        <Link href="/practice/journal" style={{ color: "var(--color-amber)", fontWeight: 600 }}>Open the journal</Link>
        <Link href="/" style={{ color: "var(--color-amber)", fontWeight: 600 }}>Today</Link>
      </p>
    </div>
  );
}

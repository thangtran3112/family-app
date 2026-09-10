"use client";
import { FoundryData } from "@/components/foundry-data";
import { Badge, Head, Panel } from "@/components/ui";
import { loadModes } from "@/lib/page-data";

export default function Modes() {
  return <FoundryData load={loadModes}>{(data) => <><Head eyebrow="Immutable routing" title="Curated modes" /><Panel title="Receipt OCR routes"><div className="route-grid">{data.items.map((mode) => <article key={mode.id}><b>{mode.displayName}</b><span className="mono">{mode.key}</span><Badge tone={mode.status === "active" ? "ok" : "warn"}>{mode.status}</Badge></article>)}</div><p>Publishing a new route flips current; prior versions remain visible and immutable.</p></Panel></>}</FoundryData>;
}

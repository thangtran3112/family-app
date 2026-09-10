"use client";
import { FoundryData } from "@/components/foundry-data";
import { Head, Panel } from "@/components/ui";
import { loadAudit } from "@/lib/page-data";

export default function Audit() {
  return <FoundryData load={loadAudit}>{(data) => <><Head eyebrow="Append-only operations" title="Audit history" /><Panel title="Recent events"><table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Resource</th><th>Outcome</th></tr></thead><tbody>{data.items.map((row) => <tr key={row.id}><td className="mono">{row.createdAt}</td><td>{row.actorPlatformSubject ?? row.actorServicePrincipal ?? "-"}</td><td className="mono">{row.action}</td><td>{row.resourceType}:{row.resourceId ?? "-"}</td><td>{row.outcome}</td></tr>)}</tbody></table></Panel></>}</FoundryData>;
}

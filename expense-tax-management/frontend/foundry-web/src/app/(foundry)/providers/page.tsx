"use client";
import { FoundryData } from "@/components/foundry-data";
import { Badge, Head, Panel } from "@/components/ui";
import { loadProviders } from "@/lib/page-data";

export default function Providers() {
  return <FoundryData load={loadProviders}>{(data) => <><Head eyebrow="Control plane" title="Provider connections" /><div className="grid"><Panel title="Connections" wide><table><thead><tr><th>Name</th><th>Kind</th><th>State</th><th>Credential</th></tr></thead><tbody>{data.items.map((row) => <tr key={row.id}><td>{row.displayName}</td><td className="mono">{row.providerKind}</td><td><Badge tone={row.status === "active" ? "ok" : "warn"}>{row.status}</Badge></td><td>{row.secretReference}</td></tr>)}</tbody></table></Panel><Panel title="Failure contract"><p>Secret Manager outage stops safely. No environment fallback and no secret value in any response.</p><Badge tone="bad">Tenant token rejected</Badge></Panel></div></>}</FoundryData>;
}

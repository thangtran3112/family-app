"use client";
import { FoundryData } from "@/components/foundry-data";
import { Badge, Head, Panel } from "@/components/ui";
import { loadQuotas } from "@/lib/page-data";

export default function Quotas() {
  return <FoundryData load={loadQuotas}>{(data) => <><Head eyebrow="Current UTC period" title="Aggregate + model ceilings" /><Panel title="Quota periods"><table><thead><tr><th>Tenant</th><th>Operation</th><th>Model</th><th>Consumed</th><th>Reserved</th><th>Ceiling</th></tr></thead><tbody>{data.items.map((row) => <tr key={row.id}><td className="mono">{row.tenantId}</td><td>{row.operation}</td><td className="mono">{row.aiModelId ?? "Aggregate"}</td><td>{row.consumedJobs}</td><td>{row.reservedJobs}</td><td>{row.maxJobs ?? "-"}</td></tr>)}</tbody></table><div className="tags"><Badge>Live quota data</Badge><Badge tone="warn">{data.items.filter((row) => row.reservedJobs > 0).length} in flight</Badge></div></Panel></>}</FoundryData>;
}

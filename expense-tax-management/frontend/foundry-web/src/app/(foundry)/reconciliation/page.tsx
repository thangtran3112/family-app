"use client";
import { FoundryData } from "@/components/foundry-data";
import { Badge, Head, Panel } from "@/components/ui";
import { loadReconciliation } from "@/lib/page-data";

export default function Reconciliation() {
  return <FoundryData load={loadReconciliation}>{(data) => <><Head eyebrow="Quota reconciler only" title="Ambiguity stops here" role="Quota reconciler" /><Panel title="Reconciliation queue"><table><thead><tr><th>Reservation</th><th>Tenant</th><th>Operation</th><th>Status</th><th>Approvals</th></tr></thead><tbody>{data.items.map((row) => <tr key={row.reservationId}><td className="mono">{row.reservationId}</td><td className="mono">{row.tenantId}</td><td>{row.operation}</td><td><Badge tone={row.status === "RECONCILIATION_REQUIRED" ? "warn" : "ok"}>{row.status}</Badge></td><td>{row.releasedApprovalCount}</td></tr>)}</tbody></table><p>Provider evidence pending. Original request is never retried while billability is unknown.</p></Panel></>}</FoundryData>;
}

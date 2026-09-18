"use client";
import { PageHead, Panel, Status } from "@/components/ui";
import { readOfficeSession } from "@/lib/session";

function PersonalScopeUnavailable({ feature }: { feature: string }) {
  return (
    <main>
      <PageHead eyebrow="Unavailable" title={feature} />
      <Panel title={`${feature} requires Business scope`}>
        <div className="empty" role="status" aria-label={`${feature} unavailable in Personal scope`}>
          <p>This feature is only available in Business scope.</p>
          <p>Switch to a Business scope to access {feature.toLowerCase()}.</p>
        </div>
      </Panel>
    </main>
  );
}

export default function Businesses() {
  const session = readOfficeSession();
  if (session?.scope.kind === "personal") {
    return <PersonalScopeUnavailable feature="Businesses" />;
  }
  return (
    <>
      <PageHead eyebrow="Profiles + roles" title="Business boundaries stay visible." />
      <div className="two">
        <Panel title="Tran Studio">
          <p>Restaurant · America/New_York · USD</p>
          <p><Status>Owner</Status> 3 members · 2 projects</p>
        </Panel>
        <Panel title="Personal">
          <p>Separate membership and ledger. Tenant ownership grants no implicit access.</p>
          <Status tone="warn">Business-only invitee denied</Status>
        </Panel>
      </div>
    </>
  );
}

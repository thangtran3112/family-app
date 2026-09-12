"use client";

import { useAuth, useOrganization } from "@clerk/nextjs";
import type { DuplicateResolutionAction } from "@expense-tax/contracts";
import { useState } from "react";

import { OfficeData } from "@/components/office-data";
import { PageHead, Panel, Status } from "@/components/ui";
import { DuplicateReviewError, fetchDuplicateMatches, getDuplicateReviewState, getSourceBadge, resolveDuplicateMatch } from "@/lib/api";
import { loadDuplicates } from "@/lib/page-data";
import { readOfficeSession } from "@/lib/session";

type DuplicateMatch = Awaited<ReturnType<typeof loadDuplicates>>["items"][number];

function amount(minorUnits: number | undefined, currency: string | undefined) {
  if (minorUnits === undefined || !currency) return "Not available";
  return `${(minorUnits / 100).toFixed(2)} ${currency}`;
}

function Comparison({ match }: { match: DuplicateMatch }) {
  const evidence = match.evidence;
  return <div className="toolbar" aria-label="Expense comparison"><div><strong>Existing expense</strong><p>{match.existingExpenseId}</p><p>{amount(evidence.existingAmountMinorUnits, evidence.currency)}</p><p>{evidence.existingIncurredOn ?? "Date not available"}</p></div><div><strong>Candidate expense</strong><p>{match.candidateExpenseId}</p><p>{amount(evidence.candidateAmountMinorUnits, evidence.currency)}</p><p>{evidence.candidateIncurredOn ?? "Date not available"}</p></div></div>;
}

function DuplicateReviewPanel({ initialItems }: { initialItems: DuplicateMatch[] }) {
  const { getToken } = useAuth();
  const { organization } = useOrganization();
  const [items, setItems] = useState(initialItems);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function refresh() {
    const session = readOfficeSession();
    if (!session || !organization) throw new DuplicateReviewError("Active Office scope unavailable");
    const data = await fetchDuplicateMatches(session, getToken, organization.id);
    setItems(data.items);
  }

  async function refreshList() {
    try {
      await refresh();
      setActionError(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not refresh matches");
    }
  }

  async function resolve(match: DuplicateMatch, action: DuplicateResolutionAction) {
    const session = readOfficeSession();
    if (!session || !organization) {
      setActionError("Active Office scope unavailable. Sign in again.");
      return;
    }
    setWorkingId(match.id);
    setConflict(false);
    setActionError(null);
    try {
      await resolveDuplicateMatch(session, match.id, action, match.version, getToken, organization.id);
      setItems((current) => current.filter((item) => item.id !== match.id));
    } catch (error) {
      if (error instanceof DuplicateReviewError && error.status === 409) {
        setConflict(true);
        try {
          await refresh();
        } catch {
          setActionError("Could not refresh changed matches. Try again.");
        }
      } else {
        setActionError(error instanceof Error ? error.message : "Resolution failed");
      }
    } finally {
      setWorkingId(null);
    }
  }

  const reviewState = getDuplicateReviewState({ isLoaded: true, isSignedIn: true, organizationLoaded: true, hasSession: true, hasOrganization: true, items, conflict });
  if (reviewState === "empty") return <Panel title="Nothing waiting"><div className="empty">No pending duplicate matches. New evidence will appear here for review.</div></Panel>;

  return <Panel title={`${items.length} pending match${items.length === 1 ? "" : "es"}`}>
    {reviewState === "conflict" && <div className="empty" role="alert">Match changed while you were reviewing. List refreshed; confirm comparison again before resolving.</div>}
    {actionError && <div className="empty" role="alert">{actionError}</div>}
    <div className="toolbar"><span>{items.length} pending in current business scope</span><button onClick={() => void refreshList()}>Refresh list</button></div>
    {items.map((match) => {
      const badge = getSourceBadge(match.matchType);
      return <article className="panel" key={match.id} aria-labelledby={`match-${match.id}`}><div className="toolbar"><div><Status tone={badge.tone}>{badge.label}</Status><Status tone={match.confidence >= 0.9 ? "bad" : "warn"}>{Math.round(match.confidence * 100)}% confidence</Status></div><span>Match version {match.version}</span></div><h3 id={`match-${match.id}`}>Possible duplicate</h3><p>Review authorized expense details only. Provider controls and receipt content stay outside Office.</p><Comparison match={match}/><div className="toolbar"><button className="primary" disabled={workingId !== null} onClick={() => void resolve(match, "merge")}>Merge</button><button disabled={workingId !== null} onClick={() => void resolve(match, "keep_both")}>Keep both</button><button disabled={workingId !== null} onClick={() => void resolve(match, "discard_new")}>Discard new</button></div></article>;
    })}
  </Panel>;
}

export default function Duplicates() {
  return <OfficeData load={loadDuplicates}>{data => <><PageHead eyebrow="Review queue" title="Resolve duplicates with evidence."><p>Business-scoped matches from App API. Choose one resolution per pair.</p></PageHead><DuplicateReviewPanel initialItems={data.items} /></>}</OfficeData>;
}

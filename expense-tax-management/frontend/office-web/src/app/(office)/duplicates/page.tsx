"use client";

import { useAuth, useOrganization } from "@clerk/nextjs";
import type { DuplicateResolutionAction } from "@expense-tax/contracts";
import { useState } from "react";

import { OfficeData } from "@/components/office-data";
import { PageHead, Panel, Status } from "@/components/ui";
import { DuplicateReviewError, announceDuplicateReviewUpdated, fetchDuplicateMatches, getDuplicateReviewState, getSourceBadge, resolveDuplicateMatch } from "@/lib/api";
import { loadDuplicates } from "@/lib/page-data";
import { readOfficeSession } from "@/lib/session";

type DuplicateMatch = Awaited<ReturnType<typeof loadDuplicates>>["items"][number];

function amount(minorUnits: number | undefined, currency: string | undefined) {
  if (minorUnits === undefined || !currency) return "Not available";
  return `${(minorUnits / 100).toFixed(2)} ${currency}`;
}

function Comparison({ match }: { match: DuplicateMatch }) {
  const evidence = match.evidence;
  return <section className="toolbar" aria-label="Expense comparison"><div><h4>Existing expense</h4><p>{match.existingExpenseId}</p><p>{amount(evidence.existingAmountMinorUnits, evidence.currency)}</p><p>{evidence.existingIncurredOn ?? "Date not available"}</p></div><div><h4>Candidate expense</h4><p>{match.candidateExpenseId}</p><p>{amount(evidence.candidateAmountMinorUnits, evidence.currency)}</p><p>{evidence.candidateIncurredOn ?? "Date not available"}</p></div></section>;
}

export function DuplicateReviewPanel({ initialItems, initialNextCursor }: { initialItems: DuplicateMatch[]; initialNextCursor: string | null }) {
  const { getToken } = useAuth();
  const { organization } = useOrganization();
  const [items, setItems] = useState(initialItems);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [unauthorized, setUnauthorized] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [paginationError, setPaginationError] = useState<string | null>(null);
  const [resolvedMessage, setResolvedMessage] = useState<string | null>(null);

  function requireDuplicateScope() {
    try {
      if (!organization) throw new Error("Active organization required");
      const session = readOfficeSession();
      if (!session) throw new Error("Office session unavailable");
      return { session, organizationId: organization.id };
    } catch (error) {
      if (error instanceof DuplicateReviewError) throw error;
      throw new DuplicateReviewError("Office authorization required", 401);
    }
  }

  async function refresh() {
    const { session, organizationId } = requireDuplicateScope();
    const data = await fetchDuplicateMatches(session, getToken, organizationId);
    setItems(data.items);
    setNextCursor(data.nextCursor);
  }

  async function loadMore() {
    if (!nextCursor || refreshing || workingId !== null) return;
    setLoadingMore(true);
    setPaginationError(null);
    try {
      const { session, organizationId } = requireDuplicateScope();
      const data = await fetchDuplicateMatches(session, getToken, organizationId, undefined, nextCursor);
      setItems((current) => [...current, ...data.items]);
      setNextCursor(data.nextCursor);
    } catch (error) {
      if (error instanceof DuplicateReviewError && (error.status === 401 || error.status === 403)) setUnauthorized(true);
      else setPaginationError(error instanceof Error ? error.message : "Could not load more matches");
    } finally {
      setLoadingMore(false);
    }
  }

  async function refreshList() {
    if (refreshing || loadingMore || workingId !== null) return;
    setRefreshing(true);
    try {
      await refresh();
      setActionError(null);
    } catch (error) {
      if (error instanceof DuplicateReviewError && (error.status === 401 || error.status === 403)) setUnauthorized(true);
      else setActionError(error instanceof Error ? error.message : "Could not refresh matches");
    } finally {
      setRefreshing(false);
    }
  }

  async function resolve(match: DuplicateMatch, action: DuplicateResolutionAction) {
    setWorkingId(match.id);
    setConflict(false);
    setActionError(null);
    try {
      const { session, organizationId } = requireDuplicateScope();
      await resolveDuplicateMatch(session, match.id, action, match.version, getToken, organizationId);
      setItems((current) => current.filter((item) => item.id !== match.id));
      setResolvedMessage(`${action === "keep_both" ? "Kept both" : action === "discard_new" ? "Discarded new expense" : "Merged"} duplicate review.`);
      announceDuplicateReviewUpdated();
    } catch (error) {
      if (error instanceof DuplicateReviewError && (error.status === 401 || error.status === 403)) {
        setUnauthorized(true);
      } else if (error instanceof DuplicateReviewError && error.status === 409) {
        setConflict(true);
        setRefreshing(true);
        try {
          await refresh();
        } catch (refreshError) {
          if (refreshError instanceof DuplicateReviewError && (refreshError.status === 401 || refreshError.status === 403)) setUnauthorized(true);
          else setActionError("Could not refresh changed matches. Try again.");
        } finally {
          setRefreshing(false);
        }
      } else {
        setActionError(error instanceof Error ? error.message : "Resolution failed");
      }
    } finally {
      setWorkingId(null);
    }
  }

  if (unauthorized) return <Panel title="Office authorization required"><div className="empty" role="alert">Office authorization required. Sign in again before reviewing duplicate matches.</div></Panel>;

  const reviewState = getDuplicateReviewState({ isLoaded: true, isSignedIn: true, organizationLoaded: true, hasSession: true, hasOrganization: true, items, conflict });
  const successAnnouncement = resolvedMessage && <div className="empty" role="status" aria-live="polite">{resolvedMessage}</div>;
  if (reviewState === "empty") return <Panel title="Nothing waiting">{successAnnouncement}<div className="empty" role="status">No pending duplicate matches. New evidence will appear here for review.</div></Panel>;

  return <Panel title={`${items.length} pending match${items.length === 1 ? "" : "es"}`}>
    {successAnnouncement}
    {reviewState === "conflict" && <div className="empty" role="alert">Match changed while you were reviewing. List refreshed; confirm comparison again before resolving.</div>}
    {actionError && <div className="empty" role="alert">{actionError}</div>}
    {paginationError && <div className="empty" role="alert">{paginationError}</div>}
    <div className="toolbar" aria-busy={workingId !== null || loadingMore || refreshing}><span role="status" aria-live="polite">{refreshing ? "Refreshing duplicate list…" : workingId ? "Resolving duplicate…" : loadingMore ? "Loading more duplicate matches…" : `${items.length} pending duplicate matches`}</span><button disabled={workingId !== null || loadingMore || refreshing} onClick={() => void refreshList()}>Refresh list</button></div>
    {items.map((match) => {
      const badge = getSourceBadge(match.matchType);
      return <article className="panel" key={match.id} aria-labelledby={`match-${match.id}`}><div className="toolbar"><div><Status tone={badge.tone}>{badge.label}</Status><Status tone={match.confidence >= 0.9 ? "bad" : "warn"}>{Math.round(match.confidence * 100)}% confidence</Status></div><span>Match version {match.version}</span></div><h3 id={`match-${match.id}`}>Possible duplicate</h3><p>Review authorized expense details only. Provider controls and receipt content stay outside Office.</p><Comparison match={match}/><div className="toolbar"><button className="primary" disabled={workingId !== null || loadingMore || refreshing} onClick={() => void resolve(match, "merge")}>Merge</button><button disabled={workingId !== null || loadingMore || refreshing} onClick={() => void resolve(match, "keep_both")}>Keep both</button><button disabled={workingId !== null || loadingMore || refreshing} onClick={() => void resolve(match, "discard_new")}>Discard new</button></div></article>;
    })}
    {nextCursor && <button disabled={workingId !== null || loadingMore || refreshing} aria-busy={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading more…" : "Load more"}</button>}
  </Panel>;
}

export default function Duplicates() {
  return <OfficeData load={loadDuplicates}>{data => <><PageHead eyebrow="Review queue" title="Resolve duplicates with evidence."><p>Business-scoped matches from App API. Choose one resolution per pair.</p></PageHead><DuplicateReviewPanel initialItems={data.items} initialNextCursor={data.nextCursor} /></>}</OfficeData>;
}

"use client";
import { useAuth, useOrganization } from "@clerk/nextjs";
import Link from "next/link";
import { useState, useCallback } from "react";
import { OfficeData } from "@/components/office-data";
import { PageHead, Panel, Status } from "@/components/ui";
import { fetchLedger } from "@/lib/api";
import { readOfficeSession } from "@/lib/session";
import { loadExpenses } from "@/lib/page-data";

type LedgerItem = Awaited<ReturnType<typeof loadExpenses>>["items"][number];

// Active tag chip component
function TagChip({ tagId, onRemove }: { tagId: string; onRemove: (id: string) => void }) {
  return (
    <span className="tag-chip">
      <span>{tagId}</span>
      <button
        type="button"
        onClick={() => onRemove(tagId)}
        aria-label={`Remove tag filter ${tagId}`}
      >
        x
      </button>
    </span>
  );
}

function LedgerTable({ items }: { items: LedgerItem[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th aria-sort="descending">Date</th>
          <th>Merchant</th>
          <th>Project</th>
          <th>Tax</th>
          <th>Status</th>
          <th>Amount</th>
          <th>Tags</th>
          <th><span className="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        {items.map((row) => (
          <tr key={row.id}>
            <td>{row.incurredOn}</td>
            <td>{row.merchant}</td>
            <td>{row.projectId ?? "-"}</td>
            <td>{row.spendingCategoryId ?? "-"}</td>
            <td><Status tone={row.status === "ready" ? "ok" : "warn"}>{row.status}</Status></td>
            <td className="money">{row.amount} {row.currency}</td>
            <td>
              {row.tags && row.tags.length > 0 ? (
                <span className="tag-list" aria-label={`Tags: ${row.tags.map((t) => t.name).join(", ")}`}>
                  {row.tags.map((t) => (
                    <span key={t.id} className="tag-chip-display">{t.name}</span>
                  ))}
                </span>
              ) : "-"}
            </td>
            <td>
              <Link href={`/expenses/${row.id}`} aria-label={`Review expense from ${row.merchant}`}>Review</Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ExpenseLedgerWithFilters() {
  const { getToken } = useAuth();
  const { organization } = useOrganization();
  const [activeTagIds, setActiveTagIds] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [sort] = useState("incurredOn");
  const [direction] = useState<"asc" | "desc">("desc");
  const [items, setItems] = useState<LedgerItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(async (opts: { tagId?: string[]; cursor?: string; reset?: boolean }) => {
    const session = readOfficeSession();
    if (!session || !organization) return;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchLedger(session, getToken, organization.id, undefined, {
        tagId: opts.tagId,
        cursor: opts.cursor,
        sort,
        direction,
        limit: 50,
      });
      if (opts.reset) {
        setItems(data.items as LedgerItem[]);
      } else {
        setItems((prev) => [...(prev ?? []), ...(data.items as LedgerItem[])]);
      }
      setNextCursor(data.nextCursor ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ledger unavailable");
    } finally {
      setLoading(false);
    }
  }, [getToken, organization, sort, direction]);

  // Initial + filter-change load handled by OfficeData wrapper below;
  // this panel handles pagination and tag-filter changes.

  function addTagFilter() {
    const id = tagInput.trim();
    if (!id || activeTagIds.includes(id)) return;
    const next = [...activeTagIds, id];
    setActiveTagIds(next);
    setTagInput("");
    void loadPage({ tagId: next, reset: true });
  }

  function removeTagFilter(id: string) {
    const next = activeTagIds.filter((t) => t !== id);
    setActiveTagIds(next);
    void loadPage({ tagId: next.length ? next : undefined, reset: true });
  }

  function loadMore() {
    if (!nextCursor || loading) return;
    void loadPage({ tagId: activeTagIds.length ? activeTagIds : undefined, cursor: nextCursor });
  }

  return (
    <OfficeData load={loadExpenses}>
      {(data) => {
        const displayItems = items ?? data.items as LedgerItem[];
        const displayNextCursor = items !== null ? nextCursor : data.nextCursor ?? null;
        return (
          <>
            <PageHead eyebrow="Ledger" title="Every expense, one scope.">
              <p>Server-paginated, cursor-stable, tag-filtered. No client-side data.items filtering.</p>
            </PageHead>
            <Panel title="Expense ledger">
              <div className="toolbar" role="toolbar" aria-label="Ledger filters">
                <div className="tag-filter-row">
                  <label htmlFor="tag-filter-input">Filter by tag ID</label>
                  <input
                    id="tag-filter-input"
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addTagFilter()}
                    placeholder="Enter tag ID and press Enter"
                    aria-describedby="tag-filter-hint"
                  />
                  <button type="button" onClick={addTagFilter} disabled={!tagInput.trim()}>Add tag filter</button>
                  <span id="tag-filter-hint" className="sr-only">Type a tag ID and press Enter or Add tag filter to filter expenses.</span>
                </div>
                {activeTagIds.length > 0 && (
                  <div className="active-chips" role="group" aria-label="Active tag filters">
                    {activeTagIds.map((id) => (
                      <TagChip key={id} tagId={id} onRemove={removeTagFilter} />
                    ))}
                  </div>
                )}
                <button type="button">Date range</button>
                <button type="button">Review state</button>
                <button type="button">Project</button>
              </div>
              {error && <div role="alert" className="empty">{error}</div>}
              {loading && <div role="status" aria-live="polite" className="empty">Loading expenses...</div>}
              <LedgerTable items={displayItems} />
              {displayItems.length === 0 && !loading && <div className="empty">No expenses match current filters.</div>}
              {displayNextCursor && (
                <button type="button" onClick={loadMore} disabled={loading} aria-busy={loading}>
                  {loading ? "Loading more..." : "Load more"}
                </button>
              )}
            </Panel>
          </>
        );
      }}
    </OfficeData>
  );
}

export default function Expenses() {
  return <ExpenseLedgerWithFilters />;
}

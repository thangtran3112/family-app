"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { PanelHeader } from "@/components/ui/Panel";
import { AddSymbol } from "@/components/watchlists/AddSymbol";
import { createWatchlist, deleteWatchlist, removeWatchlistItem, renameWatchlist, reorderWatchlist } from "@/lib/desk/watchlists";
import { manageErrorMessage, moveSymbol, orderChange, validateListName } from "@/lib/desk/watchlistView";
import styles from "./watchlistDesktop.module.css";

type Named = { id: number; name: string };
type Item = { symbol: string; asset_type: string; backfill: "ready" | "pending" };
type Horizon = "intraday" | "swing" | "long_term";
type Action = Parameters<typeof manageErrorMessage>[1];

const HORIZONS: Array<{ value: Horizon; label: string }> = [
  { value: "intraday", label: "Intraday" },
  { value: "swing", label: "Swing" },
  { value: "long_term", label: "Long term" },
];

/** One section's request: "Saving…" on its button, a plain error (role="alert"), or a Saved status. */
function useRequest() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  async function send(request: () => Promise<unknown>, action: Action, onDone: () => void) {
    setPending(true);
    setError("");
    setSaved(false);
    try {
      await request();
      setSaved(true);
      onDone();
    } catch (cause) {
      setError(manageErrorMessage(cause, action));
    } finally {
      setPending(false);
    }
  }
  return { pending, error, saved, send };
}

type Request = ReturnType<typeof useRequest>;

function Status({ request }: { request: Request }) {
  if (request.error) return <p className={styles.error} role="alert">{request.error}</p>;
  return request.saved ? <p className={styles.feedback} role="status">Saved</p> : null;
}

/** D7 manage mode (02m §a3.5). `list` is null when she has no lists yet, so only "New list" shows. */
export function ManageMode({
  list,
  lists,
  items,
  onChanged,
  onListsChanged,
  onDeleted,
}: {
  list: Named | null;
  lists: Named[];
  items: Item[];
  onChanged: () => void;
  onListsChanged: () => void;
  onDeleted: () => void;
}) {
  const names = lists.map((item) => item.name);

  const [name, setName] = useState(list?.name ?? "");
  const rename = useRequest();
  const renameProblem = list && name !== list.name ? validateListName(name, names, list.name) : null;

  // `draft` is the order she is arranging; null means the saved order.
  const [draft, setDraft] = useState<string[] | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const symbols = useRequest();
  const original = items.map((item) => item.symbol);
  const order = draft ?? original;
  const change = orderChange(original, order);
  const backfilling = new Set(items.filter((item) => item.backfill === "pending").map((item) => item.symbol));

  const [newName, setNewName] = useState("");
  const [horizon, setHorizon] = useState<Horizon>("intraday");
  const create = useRequest();
  const createProblem = newName.trim() ? validateListName(newName, names) : null;

  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = useRequest();

  // Any symbol change drops an unsaved arrangement and reloads the table.
  function symbolsChanged() {
    setDraft(null);
    setConfirmRemove(null);
    onChanged();
  }

  function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!list || renameProblem || name === list.name) return;
    void rename.send(() => renameWatchlist(list.id, name), "rename", onListsChanged);
  }

  function saveOrder() {
    if (!list || !change) return;
    void symbols.send(() => reorderWatchlist(list.id, change), "reorder", symbolsChanged);
  }

  function removeSymbol(symbol: string) {
    if (!list) return;
    void symbols.send(() => removeWatchlistItem(list.id, symbol), "remove", symbolsChanged);
  }

  function createList(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newName.trim() || createProblem) return;
    // A duplicate name on create reads the same as on rename, so the rename wording applies.
    void create.send(() => createWatchlist(newName, horizon), "rename", () => {
      setNewName("");
      onListsChanged();
    });
  }

  function deleteList() {
    if (!list) return;
    void remove.send(() => deleteWatchlist(list.id), "delete", onDeleted);
  }

  return (
    <>
      {list && (
        <>
          <form className={styles.section} onSubmit={saveName}>
            <PanelHeader variant="label" level={2} title="Rename list" />
            <div className={styles.row}>
              <label className={styles.field}>
                <span>List name</span>
                <input autoComplete="off" value={name} onChange={(event) => setName(event.currentTarget.value)} />
              </label>
              <Button type="submit" variant="primary" loading={rename.pending} disabled={renameProblem !== null || name === list.name}>
                {rename.pending ? "Saving…" : "Save name"}
              </Button>
            </div>
            {renameProblem && <p className={styles.muted}>{renameProblem}</p>}
            <Status request={rename} />
          </form>

          <section className={styles.section}>
            <PanelHeader variant="label" level={2} title="Symbols" />
            {order.length === 0 ? <p className={styles.muted}>No symbols yet</p> : (
              <ol className={styles.rows}>
                {order.map((symbol, index) => (
                  <li key={symbol} className={styles.symbolRow}>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Move ${symbol} up`}
                      disabled={index === 0 || symbols.pending}
                      onClick={() => setDraft(moveSymbol(order, index, -1))}
                    >
                      ▲
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Move ${symbol} down`}
                      disabled={index === order.length - 1 || symbols.pending}
                      onClick={() => setDraft(moveSymbol(order, index, 1))}
                    >
                      ▼
                    </Button>
                    <span className={styles.symbol}>{symbol}</span>
                    {backfilling.has(symbol) && <span className={styles.pending}>Backfilling history</span>}
                    <span className={styles.grow} />
                    {confirmRemove === symbol ? (
                      <span className={styles.confirm}>
                        Remove {symbol}?
                        <Button variant="danger" size="sm" loading={symbols.pending} onClick={() => removeSymbol(symbol)}>
                          {symbols.pending ? "Removing…" : "Yes, remove"}
                        </Button>
                        <Button size="sm" onClick={() => setConfirmRemove(null)}>Cancel</Button>
                      </span>
                    ) : (
                      <Button size="sm" aria-label={`Remove ${symbol}`} onClick={() => setConfirmRemove(symbol)}>Remove</Button>
                    )}
                  </li>
                ))}
              </ol>
            )}
            <div className={styles.row}>
              <Button variant="primary" loading={symbols.pending} disabled={change === null} onClick={saveOrder}>
                {symbols.pending ? "Saving…" : "Save order"}
              </Button>
            </div>
            <Status request={symbols} />
            <AddSymbol watchlistId={list.id} onAdded={symbolsChanged} />
          </section>
        </>
      )}

      <form className={styles.section} onSubmit={createList}>
        <PanelHeader variant="label" level={2} title="New list" />
        <div className={styles.row}>
          <label className={styles.field}>
            <span>Name</span>
            <input autoComplete="off" value={newName} onChange={(event) => setNewName(event.currentTarget.value)} />
          </label>
          <label className={styles.field}>
            <span>Horizon</span>
            <select value={horizon} onChange={(event) => setHorizon(event.currentTarget.value as Horizon)}>
              {HORIZONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <Button type="submit" variant="primary" loading={create.pending} disabled={!newName.trim() || createProblem !== null}>
            {create.pending ? "Saving…" : "Create list"}
          </Button>
        </div>
        {createProblem && <p className={styles.muted}>{createProblem}</p>}
        <Status request={create} />
      </form>

      {list && (
        <section className={styles.section}>
          <PanelHeader variant="label" level={2} title="Delete this list" />
          <div className={styles.row}>
            {confirmDelete ? (
              <>
                <span className={styles.confirm}>Delete {list.name}?</span>
                <Button variant="danger" loading={remove.pending} onClick={deleteList}>
                  {remove.pending ? "Deleting…" : "Yes, delete list"}
                </Button>
                <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
              </>
            ) : (
              <Button variant="danger" onClick={() => setConfirmDelete(true)}>Delete list</Button>
            )}
          </div>
          <Status request={remove} />
        </section>
      )}
    </>
  );
}

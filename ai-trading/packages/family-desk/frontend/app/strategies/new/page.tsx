"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { TemplateCard } from "@/components/strategies/TemplateCard";
import { deskFetch } from "@/lib/api/client";
import { StrategyOutSchema, StrategyVersionOutSchema, WatchlistsResponseSchema } from "@/lib/api/schemas";
import { describeSpec } from "@/lib/spec/describe";
import {
  canSubmitStrategyCreation,
  selectStrategyTemplate,
  strategyCreationRecovery,
  submitStrategyCreation,
  type StrategyCreationState,
} from "@/lib/strategy/create";
import { navigateToStrategyBuilder } from "@/lib/strategy/navigation";
import { STRATEGY_TEMPLATES } from "@/lib/templates";
import type { StrategyTemplate } from "@/lib/templates";
import { applyStrategyContext, parseStrategyContext } from "@/lib/watchlists/context";
import styles from "@/components/strategies/strategies.module.css";

type Watchlist = ReturnType<typeof WatchlistsResponseSchema.parse>[number];

export default function NewStrategyPage() {
  return <Suspense fallback={<main className={styles.page}><p role="status">Loading strategy context…</p></main>}><NewStrategyContent /></Suspense>;
}

function NewStrategyContent() {
  const searchParams = useSearchParams();
  const context = useMemo(
    () => parseStrategyContext(new URLSearchParams(searchParams.toString()), STRATEGY_TEMPLATES),
    [searchParams],
  );
  const [selectedSlug, setSelectedSlug] = useState(() => context.kind === "ready"
    ? context.template.slug
    : STRATEGY_TEMPLATES[0]?.slug ?? "");
  const [manualChoice, setManualChoice] = useState(context.kind === "none");
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [universeChoice, setUniverseChoice] = useState<"watchlist" | "symbol" | "">(context.kind === "none" ? "watchlist" : "");
  const [contextSymbol, setContextSymbol] = useState(context.kind === "ready" ? context.symbol : "");
  const [name, setName] = useState(context.kind === "ready"
    ? context.template.spec.name
    : STRATEGY_TEMPLATES[0]?.spec.name ?? "");
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [watchlistId, setWatchlistId] = useState("");
  const [loadingWatchlists, setLoadingWatchlists] = useState(true);
  const [watchlistError, setWatchlistError] = useState("");
  const [creationState, setCreationState] = useState<StrategyCreationState>({ kind: "ready" });
  const submissionLock = useRef(false);

  const selectedTemplate = STRATEGY_TEMPLATES.find(({ slug }) => slug === selectedSlug)
    ?? STRATEGY_TEMPLATES[0];
  const selectedWatchlist = watchlists.find(({ id }) => String(id) === watchlistId);
  const recoveryLink = strategyCreationRecovery(creationState);
  const hasContext = context.kind !== "none";
  const contextApplied = context.kind === "ready" && !manualChoice && context.template.slug === selectedTemplate?.slug;
  const canonicalSymbol = contextSymbol.trim().toUpperCase();
  const validSingleSymbol = /^\/?[A-Z][A-Z0-9.]{0,9}$/.test(canonicalSymbol);
  const chosenUniverse = !hasContext
    ? selectedWatchlist ? { watchlist: selectedWatchlist.name } : null
    : universeChoice === "watchlist"
      ? selectedWatchlist ? { watchlist: selectedWatchlist.name } : null
      : universeChoice === "symbol" && validSingleSymbol ? { symbols: [canonicalSymbol] } : null;
  const previewTemplate = selectedTemplate && contextApplied && context.kind === "ready"
    ? applyStrategyContext(context, chosenUniverse ?? { symbols: [context.symbol] })
    : selectedTemplate;
  const canReviewContext = context.kind !== "unsupported" || manualChoice;

  const loadWatchlists = useCallback(() => deskFetch("/api/desk/watchlists", WatchlistsResponseSchema), []);

  const retryWatchlists = useCallback(() => {
    setLoadingWatchlists(true);
    setWatchlistError("");
    void loadWatchlists().then((result) => {
      setWatchlists(result);
      setWatchlistId((current) => result.some(({ id }) => String(id) === current)
        ? current
        : String(result[0]?.id ?? ""));
    }).catch((cause: unknown) => {
      setWatchlistError(cause instanceof Error ? cause.message : "Could not load watchlists.");
    }).finally(() => setLoadingWatchlists(false));
  }, [loadWatchlists]);

  useEffect(() => {
    let active = true;
    void loadWatchlists().then((result) => {
      if (!active) return;
      setWatchlists(result);
      setWatchlistId(String(result[0]?.id ?? ""));
    }).catch((cause: unknown) => {
      if (active) setWatchlistError(cause instanceof Error ? cause.message : "Could not load watchlists.");
    }).finally(() => {
      if (active) setLoadingWatchlists(false);
    });
    return () => { active = false; };
  }, [loadWatchlists]);

  function selectTemplate(template: StrategyTemplate) {
    if (submissionLock.current) return;
    setSelectedSlug(template.slug);
    setName(template.spec.name);
    setManualChoice(true);
    setUniverseChoice(hasContext ? "" : "watchlist");
    setReviewConfirmed(false);
    setCreationState((state) => selectStrategyTemplate(state));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTemplate || !chosenUniverse || !reviewConfirmed || !canReviewContext
      || submissionLock.current || !canSubmitStrategyCreation(creationState)) return;
    submissionLock.current = true;
    setCreationState({ kind: "submitting" });
    try {
      const templateForSubmit = selectedTemplate && contextApplied && context.kind === "ready"
        ? applyStrategyContext(context, chosenUniverse)
        : selectedTemplate;
      const result = await submitStrategyCreation(
        creationState,
        {
          template: templateForSubmit,
          name,
          ...( "watchlist" in chosenUniverse ? { watchlistName: chosenUniverse.watchlist } : {}),
          universe: chosenUniverse,
        },
        {
          createStrategy: (strategyName) => deskFetch("/api/desk/strategies", StrategyOutSchema, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: strategyName }),
          }),
          createVersion: (strategyId, body) => deskFetch(
            `/api/desk/strategies/${strategyId}/versions`,
            StrategyVersionOutSchema,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
          ),
        },
      );
      setCreationState(result);
      if (result.kind === "created") navigateToStrategyBuilder(result.strategyId);
    } finally {
      submissionLock.current = false;
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.newHeader}>
        <div>
            <p className={styles.eyebrow}><Link href="/strategies">Strategies</Link> / New</p>
          <h1 className={styles.pageTitle}>Start from a template</h1>
        </div>
        <p className={styles.headerNote}>Every new strategy starts as a draft. Nothing runs until you change its stage.</p>
      </div>

      <div className={styles.newLayout}>
        <section aria-label="Strategy templates" className={styles.templateGrid}>
          {STRATEGY_TEMPLATES.map((template) => (
            <TemplateCard
              key={template.slug}
              onSelect={() => selectTemplate(template)}
              selected={template.slug === selectedTemplate?.slug}
              disabled={creationState.kind === "submitting"}
              template={template}
            />
          ))}
        </section>

        {selectedTemplate && (
          <form className={styles.previewPanel} onSubmit={submit}>
            <div className={styles.previewIntro}>
              <p className={styles.eyebrow}>PREVIEW</p>
              <h2 className={styles.previewTitle}>{selectedTemplate.spec.name}</h2>
              <p className={styles.previewDescription}>{describeSpec(previewTemplate?.spec ?? selectedTemplate.spec)}</p>
            </div>

            {context.kind === "ready" && contextApplied && (
              <section className={styles.contextNotice} aria-label="Strategy context from technicals">
                <strong>Review this technicals context</strong>
                <p>{context.template.spec.name} · {context.symbol} · {context.timeframe} → {context.runOn} · {context.block}</p>
                {context.note && <p>{context.note}</p>}
                <p>Choose one symbol only, or an owned watchlist (all its symbols). The URL never creates a strategy by itself.</p>
              </section>
            )}
            {context.kind === "unsupported" && (
              <section className={styles.contextNotice} role="alert" aria-label="Unsupported strategy context">
                <strong>URL context not applied</strong>
                <ul>{context.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
                {manualChoice
                  ? <p>You chose a template manually. None of the unsupported URL values will be prefilled.</p>
                  : <p>Select a shipped template below to continue manually; unsupported context stays unapplied.</p>}
              </section>
            )}
            {context.kind === "ready" && manualChoice && (
              <p className={styles.contextNotice}>Manual template selected. The URL symbol, timeframe, and series block are not being applied.</p>
            )}

            <label className={styles.field}>
              <span>Strategy name</span>
              <input
                autoComplete="off"
                maxLength={80}
                onChange={(event) => { setName(event.currentTarget.value); setReviewConfirmed(false); }}
                required
                value={name}
              />
              <span className={styles.fieldHint}>{name.trim().length}/80 characters</span>
            </label>

            {hasContext ? (
              <fieldset className={styles.universeChoice} disabled={context.kind === "unsupported" && !manualChoice}>
                <legend>Strategy universe · choose explicitly</legend>
                <label className={styles.universeOption}>
                  <input checked={universeChoice === "watchlist"} name="universe-choice" onChange={() => { setUniverseChoice("watchlist"); setReviewConfirmed(false); }} type="radio" />
                  <span>Use an owned watchlist <small>Includes every symbol in that list.</small></span>
                </label>
                {universeChoice === "watchlist" && <label className={styles.field}>
                  <span>Watchlist</span>
                  <select disabled={loadingWatchlists || watchlists.length === 0} onChange={(event) => { setWatchlistId(event.currentTarget.value); setReviewConfirmed(false); }} required value={watchlistId}>
                    {loadingWatchlists && <option value="">Loading watchlists…</option>}
                    {!loadingWatchlists && watchlists.length === 0 && <option value="">No watchlists available</option>}
                    {watchlists.map((watchlist) => <option key={watchlist.id} value={watchlist.id}>{watchlist.name}</option>)}
                  </select>
                </label>}
                <label className={styles.universeOption}>
                  <input checked={universeChoice === "symbol"} name="universe-choice" onChange={() => { setUniverseChoice("symbol"); setReviewConfirmed(false); }} type="radio" />
                  <span>Use one symbol only <small>Does not expand to a watchlist.</small></span>
                </label>
                {universeChoice === "symbol" && <label className={styles.field}>
                  <span>Single symbol</span>
                  <input autoCapitalize="characters" autoComplete="off" maxLength={11} onChange={(event) => { setContextSymbol(event.currentTarget.value); setReviewConfirmed(false); }} placeholder="AAPL or /ES" value={contextSymbol} />
                  {!validSingleSymbol && <span className={styles.fieldHint}>Enter a symbol supported by StrategySpecV1.</span>}
                </label>}
              </fieldset>
            ) : (
              <label className={styles.field}>
                <span>Watchlist</span>
                <select disabled={loadingWatchlists || watchlists.length === 0} onChange={(event) => { setWatchlistId(event.currentTarget.value); setReviewConfirmed(false); }} required value={watchlistId}>
                  {loadingWatchlists && <option value="">Loading watchlists…</option>}
                  {!loadingWatchlists && watchlists.length === 0 && <option value="">No watchlists available</option>}
                  {watchlists.map((watchlist) => <option key={watchlist.id} value={watchlist.id}>{watchlist.name}</option>)}
                </select>
              </label>
            )}
            {watchlistError && (
              <div className={styles.error} role="alert">
                <span>{watchlistError}</span>
                <button className={styles.secondaryButton} onClick={retryWatchlists} type="button">Retry</button>
              </div>
            )}
            {!loadingWatchlists && watchlists.length === 0 && !watchlistError && (
              <p className={styles.emptyHelp}>Create a watchlist before making a strategy. <Link href="/watchlists">Go to Watchlists</Link></p>
            )}

            <fieldset className={styles.stageField}>
              <legend>Starting stage</legend>
              <label className={styles.stageOption}>
                <input checked name="stage" readOnly type="radio" value="draft" />
                <span><strong>Draft</strong><small>Saved for editing. No alerts are sent.</small></span>
              </label>
              <label aria-describedby="phase-six-note" className={`${styles.stageOption} ${styles.disabledOption}`}>
                <input disabled name="stage" type="radio" value="alert_only" />
                <span><strong>Alert + paper</strong><small id="phase-six-note">Available in Phase 6</small></span>
              </label>
            </fieldset>

            <label className={styles.reviewConfirm}>
              <input checked={reviewConfirmed} onChange={(event) => setReviewConfirmed(event.currentTarget.checked)} type="checkbox" />
              <span>I reviewed the template, timeframe, and universe. Create this as a draft only.</span>
            </label>
            <button
              className={styles.submitButton}
              disabled={!canReviewContext || !chosenUniverse || hasContext && !universeChoice || universeChoice === "symbol" && !validSingleSymbol
                || !name.trim() || name.trim().length > 80 || !reviewConfirmed || !canSubmitStrategyCreation(creationState)
                || !hasContext && (loadingWatchlists || watchlists.length === 0 || !selectedWatchlist)}
              type="submit"
            >
              {creationState.kind === "submitting" ? "Creating draft…" : "Create reviewed draft"}
            </button>
            {(creationState.kind === "preflight-error" || creationState.kind === "rejected") && (
              <div className={styles.error} role="alert">
                <span>{creationState.message}</span>
              </div>
            )}
            {creationState.kind === "version-failed" && recoveryLink && (
              <div className={styles.error} role="alert">
                <span>{creationState.message}</span>
                <a href={recoveryLink.href}>{recoveryLink.label}</a>
              </div>
            )}
            {creationState.kind === "outcome-unknown" && recoveryLink && (
              <div className={styles.error} role="alert">
                <span>{creationState.message}</span>
                <a href={recoveryLink.href}>{recoveryLink.label}</a>
              </div>
            )}
            {creationState.kind !== "version-failed" && creationState.kind !== "outcome-unknown" && (
              <p className={styles.formNote}>Creates draft v1 that you own. It sends nothing until its stage changes.</p>
            )}
          </form>
        )}
      </div>
    </main>
  );
}

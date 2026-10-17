"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
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
import styles from "@/components/strategies/strategies.module.css";

type Watchlist = ReturnType<typeof WatchlistsResponseSchema.parse>[number];

export default function NewStrategyPage() {
  const [selectedSlug, setSelectedSlug] = useState(STRATEGY_TEMPLATES[0]?.slug ?? "");
  const [name, setName] = useState(STRATEGY_TEMPLATES[0]?.spec.name ?? "");
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
    setCreationState((state) => selectStrategyTemplate(state));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTemplate || !selectedWatchlist || submissionLock.current || !canSubmitStrategyCreation(creationState)) return;
    submissionLock.current = true;
    setCreationState({ kind: "submitting" });
    try {
      const result = await submitStrategyCreation(
        creationState,
        { template: selectedTemplate, name, watchlistName: selectedWatchlist.name },
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
              <p className={styles.previewDescription}>{describeSpec(selectedTemplate.spec)}</p>
            </div>

            <label className={styles.field}>
              <span>Strategy name</span>
              <input
                autoComplete="off"
                maxLength={80}
                onChange={(event) => setName(event.currentTarget.value)}
                required
                value={name}
              />
              <span className={styles.fieldHint}>{name.trim().length}/80 characters</span>
            </label>

            <label className={styles.field}>
              <span>Watchlist</span>
              <select
                disabled={loadingWatchlists || watchlists.length === 0}
                onChange={(event) => setWatchlistId(event.currentTarget.value)}
                required
                value={watchlistId}
              >
                {loadingWatchlists && <option value="">Loading watchlists…</option>}
                {!loadingWatchlists && watchlists.length === 0 && <option value="">No watchlists available</option>}
                {watchlists.map((watchlist) => (
                  <option key={watchlist.id} value={watchlist.id}>{watchlist.name}</option>
                ))}
              </select>
            </label>
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

            <button
              className={styles.submitButton}
              disabled={loadingWatchlists || watchlists.length === 0 || !selectedWatchlist || !name.trim() || name.trim().length > 80 || !canSubmitStrategyCreation(creationState)}
              type="submit"
            >
              {creationState.kind === "submitting" ? "Creating draft…" : "Use this template"}
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

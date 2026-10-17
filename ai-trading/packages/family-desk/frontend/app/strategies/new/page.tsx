"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { TemplateCard } from "@/components/strategies/TemplateCard";
import { deskFetch } from "@/lib/api/client";
import { StrategyOutSchema, StrategyVersionOutSchema, WatchlistsResponseSchema } from "@/lib/api/schemas";
import { describeSpec } from "@/lib/spec/describe";
import { createStrategyFromTemplate, StrategyVersionCreateError } from "@/lib/strategy/create";
import { STRATEGY_TEMPLATES } from "@/lib/templates";
import type { StrategyTemplate } from "@/lib/templates";
import styles from "@/components/strategies/strategies.module.css";

type Watchlist = ReturnType<typeof WatchlistsResponseSchema.parse>[number];

export default function NewStrategyPage() {
  const router = useRouter();
  const [selectedSlug, setSelectedSlug] = useState(STRATEGY_TEMPLATES[0]?.slug ?? "");
  const [name, setName] = useState(STRATEGY_TEMPLATES[0]?.spec.name ?? "");
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [watchlistId, setWatchlistId] = useState("");
  const [loadingWatchlists, setLoadingWatchlists] = useState(true);
  const [watchlistError, setWatchlistError] = useState("");
  const [creating, setCreating] = useState(false);
  const [createdId, setCreatedId] = useState<number | null>(null);
  const [createError, setCreateError] = useState("");

  const selectedTemplate = STRATEGY_TEMPLATES.find(({ slug }) => slug === selectedSlug)
    ?? STRATEGY_TEMPLATES[0];
  const selectedWatchlist = watchlists.find(({ id }) => String(id) === watchlistId);

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
    setSelectedSlug(template.slug);
    setName(template.spec.name);
    setCreateError("");
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTemplate || !selectedWatchlist || creating || createdId !== null) return;
    setCreating(true);
    setCreateError("");
    try {
      const strategy = await createStrategyFromTemplate(
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
      router.push(`/strategies?id=${strategy.id}`);
    } catch (cause) {
      if (cause instanceof StrategyVersionCreateError) setCreatedId(cause.strategyId);
      setCreateError(cause instanceof Error ? cause.message : "Could not create strategy.");
    } finally {
      setCreating(false);
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
              disabled={loadingWatchlists || watchlists.length === 0 || !selectedWatchlist || !name.trim() || name.trim().length > 80 || creating || createdId !== null}
              type="submit"
            >
              {creating ? "Creating draft…" : "Use this template"}
            </button>
            {createError && (
              <div className={styles.error} role="alert">
                <span>{createError}</span>
                {createdId !== null && <Link href={`/strategies?id=${createdId}`}>Open strategy {createdId} to add its version</Link>}
              </div>
            )}
            {createdId === null && <p className={styles.formNote}>Creates draft v1 that you own. It sends nothing until its stage changes.</p>}
          </form>
        )}
      </div>
    </main>
  );
}

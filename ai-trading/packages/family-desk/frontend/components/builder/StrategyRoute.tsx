"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { StrategyList } from "@/components/strategies/StrategyList";
import { deskFetch } from "@/lib/api/client";
import {
  StrategiesResponseSchema,
  StrategyOutSchema,
  StrategyVersionOutSchema,
  StrategyVersionsResponseSchema,
  WatchlistsResponseSchema,
} from "@/lib/api/schemas";
import { StrategySpecV1Schema } from "@ai-trading/contracts";
import { specToForm } from "@/lib/spec/form";
import type { StrategySpecForm } from "@/lib/spec/form";
import { nextStage, type StrategyStage } from "@/lib/strategy/stage";
import { positiveStrategyId } from "@/lib/strategy/id";
import { STRATEGY_TEMPLATES } from "@/lib/templates";
import type { StrategyVersion } from "./types";
import { JsonView } from "./JsonView";
import { SaveBar } from "./SaveBar";
import { SpecForm, validateSpecForm } from "./SpecForm";
import { StageControl } from "./StageControl";
import { VersionList } from "./VersionList";
import styles from "./builder.module.css";
import strategiesStyles from "@/components/strategies/strategies.module.css";

type Strategy = ReturnType<typeof StrategyOutSchema.parse>;
type Watchlist = ReturnType<typeof WatchlistsResponseSchema.parse>[number];
type LoadedStrategy = { strategy: Strategy; versions: StrategyVersion[]; watchlists: Watchlist[] };

export function StrategyRoute() {
  const searchParams = useSearchParams();
  const strategyId = positiveStrategyId(searchParams.get("id"));
  if (strategyId === null) {
    return <div className={strategiesStyles.page}><StrategyList /></div>;
  }
  return (
    <div className={styles.workspace}>
      <div className={styles.layout}>
        <aside className={styles.listPane} aria-label="Strategies list"><StrategyList /></aside>
        <StrategyBuilder key={strategyId} strategyId={strategyId} />
      </div>
    </div>
  );
}

function initialForm(spec: unknown): StrategySpecForm | null {
  const result = StrategySpecV1Schema.safeParse(spec);
  return result.success ? specToForm(result.data) : null;
}

function StrategyBuilder({ strategyId }: { strategyId: number }) {
  const [loaded, setLoaded] = useState<LoadedStrategy | null>(null);
  const [form, setForm] = useState<StrategySpecForm | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingError, setLoadingError] = useState("");
  const [formError, setFormError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [stageError, setStageError] = useState("");
  const [saving, setSaving] = useState(false);
  const [stagePending, setStagePending] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [initialTemplate, setInitialTemplate] = useState(STRATEGY_TEMPLATES[0]?.slug ?? "");

  const load = useCallback(async () => {
    try {
      const [strategies, watchlists] = await Promise.all([
        deskFetch("/api/desk/strategies", StrategiesResponseSchema),
        deskFetch("/api/desk/watchlists", WatchlistsResponseSchema),
      ]);
      const strategy = strategies.find((item) => item.id === strategyId);
      if (!strategy) throw new Error("Strategy not found or no longer available.");
      const versions = await deskFetch(`/api/desk/strategies/${strategyId}/versions`, StrategyVersionsResponseSchema);
      const current = strategy.current_version_id === null
        ? null
        : versions.find((version) => version.id === strategy.current_version_id) ?? null;
      if (strategy.current_version_id !== null && current === null) {
        throw new Error("Current strategy version was not returned.");
      }

      const selectedForm = current
        ? initialForm(current.spec)
        : (() => {
            const template = STRATEGY_TEMPLATES[0];
            return template ? initialForm({ ...template.spec, name: strategy.name }) : null;
          })();
      if (!selectedForm) setFormError("Stored strategy specification does not match the current schema. View JSON to inspect it.");
      else setFormError("");
      setLoadingError("");
      setLoaded({ strategy, versions, watchlists });
      setSelectedVersionId(current?.id ?? null);
      setForm(selectedForm);
      setDirty(false);
    } catch (cause) {
      setLoaded(null);
      setForm(null);
      setLoadingError(cause instanceof Error ? cause.message : "Could not load strategy.");
    } finally {
      setLoading(false);
    }
  }, [strategyId]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load, loadAttempt]);

  useEffect(() => {
    if (!dirty) return;
    function guardUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", guardUnload);
    return () => window.removeEventListener("beforeunload", guardUnload);
  }, [dirty]);

  const selectedVersion = loaded?.versions.find((version) => version.id === selectedVersionId) ?? null;
  const currentVersionId = loaded?.strategy.current_version_id ?? null;
  const readOnly = selectedVersion !== null && selectedVersion.id !== currentVersionId;
  const hasVersion = currentVersionId !== null;
  const nextVersion = Math.max(0, ...(loaded?.versions.map(({ version }) => version) ?? [])) + 1;
  const validation = useMemo(() => form ? validateSpecForm(form) : null, [form]);
  const canSave = validation?.result.success === true;

  function confirmDiscard(): boolean {
    return !dirty || window.confirm("You have unsaved changes. Discard them?");
  }

  function selectVersion(version: StrategyVersion) {
    if (!confirmDiscard()) return;
    const nextForm = initialForm(version.spec);
    setSelectedVersionId(version.id);
    setDirty(false);
    setSaveError("");
    if (!nextForm) {
      setForm(null);
      setFormError("This stored version does not match the current schema. Its exact stored JSON remains available below.");
      return;
    }
    setFormError("");
    setForm(nextForm);
  }

  function selectInitialTemplate(slug: string) {
    if (!confirmDiscard()) return;
    const template = STRATEGY_TEMPLATES.find((item) => item.slug === slug);
    if (!template || !loaded) return;
    const nextForm = initialForm({ ...template.spec, name: loaded.strategy.name });
    setInitialTemplate(slug);
    setForm(nextForm);
    setFormError("");
    setDirty(true);
  }

  async function saveVersion() {
    if (!loaded || !form || !validation?.result.success || readOnly || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      const version = await deskFetch(`/api/desk/strategies/${strategyId}/versions`, StrategyVersionOutSchema, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec: validation.result.data, change_note: hasVersion ? "edited in builder" : "initial version" }),
      });
      if (version.strategy_id !== strategyId || version.version !== nextVersion || !StrategySpecV1Schema.safeParse(version.spec).success) {
        throw new Error("Save response did not contain the expected immutable version.");
      }
      setLoaded((current) => current ? {
        ...current,
        strategy: { ...current.strategy, current_version_id: version.id },
        versions: [...current.versions, version].sort((left, right) => left.version - right.version),
      } : current);
      setSelectedVersionId(version.id);
      setForm(initialForm(version.spec));
      setDirty(false);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Could not save a new strategy version.");
    } finally {
      setSaving(false);
    }
  }

  async function changeStage(target: StrategyStage) {
    if (!loaded || !hasVersion || stagePending || nextStage(loaded.strategy.stage as StrategyStage) !== target) return;
    setStagePending(true);
    setStageError("");
    try {
      const updated = await deskFetch(`/api/desk/strategies/${strategyId}/stage`, StrategyOutSchema, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: target, confirm: true }),
      });
      if (updated.id !== strategyId || updated.stage !== target) throw new Error("Stage response did not confirm the requested transition.");
      setLoaded((current) => current ? { ...current, strategy: updated } : current);
    } catch (cause) {
      setStageError(cause instanceof Error ? cause.message : "Could not change strategy stage.");
    } finally {
      setStagePending(false);
    }
  }

  if (loading) return <section className={styles.detail} aria-busy="true"><p className={styles.feedback}>Loading strategy…</p></section>;
  if (loadingError || !loaded) {
    return (
      <section className={styles.detail}>
        <div className={styles.routeError} role="alert">
          <p>{loadingError || "Could not load strategy."}</p>
          <button className={styles.secondaryButton} onClick={() => {
            setLoading(true);
            setLoadingError("");
            setLoadAttempt((attempt) => attempt + 1);
          }} type="button">Try again</button>
        </div>
        <p><a className={styles.backLink} href="/strategies">Back to strategies</a></p>
      </section>
    );
  }

  const storedSpec = selectedVersion?.spec;
  const isInitial = currentVersionId === null;
  const stage = loaded.strategy.stage;
  const errors = validation?.errors ?? {};

  return (
    <section className={styles.detail} aria-label={`Strategy ${loaded.strategy.name}`}>
      <header className={styles.detailHeader}>
        <div>
          <p className={styles.eyebrow}><a href="/strategies">Strategies</a> / {isInitial ? "Initial version" : `v${selectedVersion?.version ?? "?"}`}</p>
          <h1 className={styles.title}>{loaded.strategy.name}</h1>
          <p className={styles.feedback}>Owner-scoped strategy · {stage.replaceAll("_", " ")}</p>
        </div>
        <a className={styles.backLink} href="/strategies">Back to strategies</a>
      </header>

      <div className={styles.detailActions}>
        <VersionList
          currentVersionId={currentVersionId}
          disabled={saving || stagePending}
          onSelect={selectVersion}
          selectedVersionId={selectedVersionId}
          versions={loaded.versions}
        />
        {selectedVersion && <JsonView spec={storedSpec} />}
      </div>

      <StageControl
        stage={stage}
        hasVersion={hasVersion}
        pending={stagePending}
        error={stageError}
        onChange={(target) => void changeStage(target)}
      />

      {isInitial && (
        <label className={styles.field}>
          <span>Initial template (strategy already exists)</span>
          <select disabled={saving} onChange={(event) => selectInitialTemplate(event.currentTarget.value)} value={initialTemplate}>
            {STRATEGY_TEMPLATES.map(({ slug, spec }) => <option key={slug} value={slug}>{spec.name}</option>)}
          </select>
        </label>
      )}

      {formError && <p className={styles.error} role="alert">{formError}</p>}
      {form && (
        <SpecForm
          errors={errors}
          form={form}
          watchlists={loaded.watchlists}
          onChange={(next) => { setForm(next); setDirty(true); setSaveError(""); }}
          readOnly={readOnly || saving}
        />
      )}
      {saveError && <p className={styles.error} role="alert">{saveError}</p>}
      {form && (
        <SaveBar
          stage={stage as StrategyStage}
          nextVersion={nextVersion}
          dirty={dirty}
          hasVersion={hasVersion}
          valid={canSave}
          readOnly={readOnly || formError !== ""}
          saving={saving}
          onSave={() => void saveVersion()}
        />
      )}
    </section>
  );
}

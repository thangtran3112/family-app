"use client";

import type { FilterStrategySpecV1 } from "@ai-trading/contracts/filter-strategy-spec-v1";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useDeskUi } from "@/components/shell/desktop/DeskContext";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { DeskApiError } from "@/lib/api/client";
import type { Problem, ScreenerFilterDetail } from "@/lib/api/schemas";
import { formToSpec, isDirty, problemsFor, specToForm, unplacedProblems, type FilterForm } from "@/lib/desk/filterForm";
import { createFilter, loadFilterDetail, previewFilter, updateFilter } from "@/lib/desk/screener";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { parseFilterSpec } from "@/lib/spec/parse";
import { ConditionRows } from "./ConditionRows";
import { JsonPanel } from "./JsonPanel";
import { LiquidityFields } from "./LiquidityFields";
import { LiveMatches } from "./LiveMatches";
import { RankFields } from "./RankFields";
import { SessionRunOnFields } from "./SessionRunOnFields";
import { UniverseFields } from "./UniverseFields";
import { UnsavedBar } from "./UnsavedBar";
import styles from "./editor.module.css";

export function FilterEditor() {
  const id = Number(useSearchParams().get("id"));
  const valid = Number.isInteger(id) && id > 0;
  const [notice, setNotice] = useState("");
  const detail = useDeskQuery(`filter-edit:${id}`, (signal) => loadFilterDetail(id, { signal }), { enabled: valid });

  if (!valid) {
    return <EmptyBlock title="Pick a filter to edit"><Link href="/screener">Go to the screener</Link></EmptyBlock>;
  }
  if (detail.loading) return <LoadingBlock label="Loading filter…" />;
  if (detail.data === null) return <ErrorBlock subject="filter" onRetry={detail.refresh} />;

  const filter = detail.data;
  const spec = parseFilterSpec(filter.spec);
  return (
    <div className={styles.editor}>
      <header className={styles.header}>
        <h1 className={styles.title}>{filter.name}</h1>
        {notice && <p role="status" className={styles.notice}>{notice}</p>}
      </header>
      {spec ? (
        // Keyed by version: a saved draft re-initialises the form from the new answer.
        <EditorForm key={`${filter.id}:${filter.version}`} filter={filter} spec={spec} refresh={detail.refresh} onNotice={setNotice} />
      ) : (
        <>
          <p className={styles.notice}>This filter can&apos;t be edited here</p>
          <pre className={styles.pre}>{JSON.stringify(filter.spec, null, 2)}</pre>
        </>
      )}
    </div>
  );
}

function EditorForm({ filter, spec, refresh, onNotice }: {
  filter: ScreenerFilterDetail;
  spec: FilterStrategySpecV1;
  refresh: () => void;
  onNotice: (text: string) => void;
}) {
  const router = useRouter();
  const { invalidate } = useDeskUi();
  const [original] = useState(() => specToForm(spec));
  const [form, setForm] = useState(original);
  const [previewSpecJson, setPreviewSpecJson] = useState(() => JSON.stringify(formToSpec(original)));
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saveProblems, setSaveProblems] = useState<Problem[]>([]);
  const [saveNote, setSaveNote] = useState("");
  const [copying, setCopying] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const preview = useDeskQuery(`filter-preview:${previewSpecJson}`, (signal) => previewFilter(JSON.parse(previewSpecJson), { signal }));

  const dirty = isDirty(original, form);
  const readOnly = filter.read_only;
  const defaultSpec = parseFilterSpec(filter.default_spec);
  const defaultForm = defaultSpec ? specToForm(defaultSpec) : null;
  // A save's 422 replaces the live check's problems until the next change.
  const problems = saveProblems.length > 0 ? saveProblems : (preview.data?.problems ?? []);
  const unplaced = unplacedProblems(problems, form);

  useEffect(() => () => clearTimeout(previewTimer.current), []);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Every change goes through here: the form updates now, the live check follows 500 ms after the last change.
  function change(next: FilterForm) {
    setForm(next);
    setSaveProblems([]);
    setSaveNote("");
    onNotice("");
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => setPreviewSpecJson(JSON.stringify(formToSpec(next))), 500);
  }

  async function save() {
    setSaving(true);
    try {
      await updateFilter(filter.id, formToSpec(form));
      onNotice("Saved");
      invalidate("filters");
      refresh();
    } catch (error) {
      if (error instanceof DeskApiError && error.status === 422 && error.problems.length > 0) setSaveProblems(error.problems);
      else if (error instanceof DeskApiError && error.status === 409) setSaveNote(error.detail ?? "Default filters can't be changed");
      else setSaveNote("Couldn't save · Try again");
    } finally {
      setSaving(false);
    }
  }

  async function copy() {
    setCopying(true);
    setCopyFailed(false);
    try {
      const created = await createFilter({ copy_of: filter.id });
      invalidate("filters");
      router.push(`/screener/filters?id=${created.id}`);
    } catch {
      setCopyFailed(true);
    } finally {
      setCopying(false);
    }
  }

  return (
    <>
      {readOnly && (
        <div className={styles.banner}>
          <div className={styles.row}>
            <span>Default filters are read-only</span>
            <button type="button" className={`${styles.button} ${styles.primary}`} onClick={copy} disabled={copying}>
              {copying ? "Copying…" : "Copy to edit"}
            </button>
          </div>
          {copyFailed && <span className={styles.problem}>Couldn&apos;t copy · Try again</span>}
        </div>
      )}
      {problems.length > 0 && (
        <div className={styles.banner} role="alert">
          <p className={styles.bannerTitle}>{problems.length === 1 ? "1 problem to fix" : `${problems.length} problems to fix`}</p>
          {unplaced.map((problem, index) => (
            <span key={index} className={styles.problem}>{problem.message}<span className={styles.problemPath}>{problem.path}</span></span>
          ))}
        </div>
      )}
      {saveNote && <p role="alert" className={styles.problem}>{saveNote}</p>}
      {!readOnly && defaultForm && (
        <div className={styles.row}>
          <button type="button" className={styles.button} onClick={() => change(defaultForm)}>Reset to default</button>
        </div>
      )}
      <fieldset className={styles.fields} disabled={readOnly}>
        <label className={styles.field}>
          <span>Name</span>
          <input type="text" maxLength={80} value={form.name} onChange={(event) => change({ ...form, name: event.target.value })} />
        </label>
        {problemsFor(problems, "name").map((problem, index) => (
          <span key={index} className={styles.problem}>{problem.message}<span className={styles.problemPath}>{problem.path}</span></span>
        ))}
        <UniverseFields form={form} onChange={change} problems={problems} />
        <LiquidityFields form={form} onChange={change} problems={problems} />
        <SessionRunOnFields form={form} onChange={change} problems={problems} />
        <ConditionRows form={form} onChange={change} problems={problems} />
        <RankFields form={form} onChange={change} problems={problems} />
        <label className={styles.field}>
          <span>Max results (1 to 100)</span>
          <input type="number" min={1} max={100} value={form.maxResults} onChange={(event) => change({ ...form, maxResults: event.target.value })} />
        </label>
        {problemsFor(problems, "maxResults").map((problem, index) => (
          <span key={index} className={styles.problem}>{problem.message}<span className={styles.problemPath}>{problem.path}</span></span>
        ))}
      </fieldset>
      {dirty && <UnsavedBar onSave={save} onDiscard={() => change(original)} saving={saving} canSave={!saving} />}
      <RightRail
        label="Filter preview"
        sections={[
          { id: "live", label: "Live matches", node: <LiveMatches preview={preview.data} loading={preview.loading} failed={preview.error !== null} /> },
          { id: "json", label: "JSON", node: <JsonPanel spec={formToSpec(form)} /> },
        ]}
      />
    </>
  );
}

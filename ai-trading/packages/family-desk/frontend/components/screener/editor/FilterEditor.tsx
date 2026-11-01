"use client";

import type { FilterStrategySpecV1 } from "@ai-trading/contracts/filter-strategy-spec-v1";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useDeskUi } from "@/components/shell/desktop/DeskContext";
import { ConditionRows } from "@/components/conditions/ConditionRows";
import { JsonPanel } from "@/components/conditions/JsonPanel";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { EmptyBlock, ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { DeskApiError } from "@/lib/api/client";
import type { Problem, ScreenerFilterDetail } from "@/lib/api/schemas";
import { formToSpec, isDirty, problemsFor, specToForm, type FilterForm } from "@/lib/desk/filterForm";
import { createFilter, loadFilterDetail, loadFilters, previewFilter, updateFilter } from "@/lib/desk/screener";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { COPY } from "@/lib/desk/freshness";
import { NEW_FILTER_SPEC } from "@/lib/desk/screenerView";
import { parseFilterSpec } from "@/lib/spec/parse";
import { LiquidityFields } from "./LiquidityFields";
import { LiveMatches } from "./LiveMatches";
import { RankFields } from "./RankFields";
import { SessionRunOnFields } from "./SessionRunOnFields";
import { UniverseFields } from "./UniverseFields";
import { UnsavedBar } from "./UnsavedBar";
import styles from "./editor.module.css";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { ErrorSummary } from "@/components/ui/ErrorSummary";
import { Field, FieldError, FieldRow, Input, NumberInput } from "@/components/ui/Field";
import { fieldError, formProblems } from "@/lib/desk/problems";

export function FilterEditor() {
  const param = useSearchParams().get("id");
  const id = Number(param);
  const valid = Number.isInteger(id) && id > 0;
  const [notice, setNotice] = useState("");
  const detail = useDeskQuery(`filter-edit:${id}`, (signal) => loadFilterDetail(id, { signal }), { enabled: valid });

  // No `id` at all is the create path (the screener's "New filter"); a malformed one is a bad link.
  if (param === null) {
    return (
      <div className={styles.editor}>
        <header className={styles.header}>
          <h1 className={styles.title}>{COPY.newFilter}</h1>
          {notice && <p role="status" className={styles.notice}>{notice}</p>}
        </header>
        <EditorForm key="new" filter={null} spec={parseFilterSpec(NEW_FILTER_SPEC)!} refresh={() => undefined} onNotice={setNotice} />
      </div>
    );
  }
  if (!valid) {
    return <EmptyBlock title="That filter link isn't valid"><Link href="/screener">Go to the screener</Link></EmptyBlock>;
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

/** `filter` is null while a new filter is being made: nothing is saved until Create filter. */
function EditorForm({ filter, spec, refresh, onNotice }: {
  filter: ScreenerFilterDetail | null;
  spec: FilterStrategySpecV1;
  refresh: () => void;
  onNotice: (text: string) => void;
}) {
  const router = useRouter();
  const { invalidate, setDirty } = useDeskUi();
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
  // The scheduled run the screener shows, for the Live matches comparison. A save remounts this form (keyed by version).
  const listed = useDeskQuery(`filter-last-run:${filter?.id}`, (signal) => loadFilters({ signal }), { enabled: filter !== null });
  const lastRun = listed.data?.find((row) => row.id === filter?.id)?.last_run ?? null;

  const dirty = isDirty(original, form);
  const readOnly = filter?.read_only ?? false;
  const defaultSpec = parseFilterSpec(filter?.default_spec);
  const defaultForm = defaultSpec ? specToForm(defaultSpec) : null;
  // A save's 422 replaces the live check's problems until the next change.
  const problems = saveProblems.length > 0 ? saveProblems : (preview.data?.problems ?? []);

  useEffect(() => () => clearTimeout(previewTimer.current), []);

  useEffect(() => {
    setDirty(dirty);
    return () => setDirty(false);
  }, [dirty, setDirty]);

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
      if (filter === null) {
        const created = await createFilter({ spec: formToSpec(form) });
        invalidate("filters");
        router.replace(`/screener/filters?id=${created.id}`);
        return;
      }
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
    if (filter === null) return;
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
        <>
          <Banner
            tone="neutral"
            action={<Button variant="primary" onClick={copy} loading={copying}>{copying ? "Copying…" : "Copy to edit"}</Button>}
          >
            Default filters are read-only
          </Banner>
          {copyFailed && <FieldError>Couldn&apos;t copy · Try again</FieldError>}
        </>
      )}
      <ErrorSummary problems={formProblems(problems)} />
      {saveNote && <FieldError>{saveNote}</FieldError>}
      {!readOnly && defaultForm && (
        <FieldRow>
          <Button onClick={() => change({ ...defaultForm, name: form.name })}>Reset to default</Button>
        </FieldRow>
      )}
      <fieldset className={styles.fields} disabled={readOnly}>
        <Field id="filter-name" label="Name" error={fieldError(problemsFor(problems, "name"))}>
          <Input maxLength={80} value={form.name} onChange={(event) => change({ ...form, name: event.target.value })} />
        </Field>
        <UniverseFields form={form} onChange={change} problems={problems} />
        <LiquidityFields form={form} onChange={change} problems={problems} />
        <SessionRunOnFields form={form} onChange={change} problems={problems} />
        <ConditionRows form={form} onChange={change} problems={problems} />
        <RankFields form={form} onChange={change} problems={problems} />
        <Field id="filter-max-results" label="Max results (1 to 100)" error={fieldError(problemsFor(problems, "maxResults"))}>
          <NumberInput min={1} max={100} value={form.maxResults} onChange={(event) => change({ ...form, maxResults: event.target.value })} />
        </Field>
      </fieldset>
      {filter === null && (
        <FieldRow>
          <Button variant="primary" onClick={save} loading={saving}>{saving ? "Creating…" : "Create filter"}</Button>
          <Button href="/screener" client>Cancel</Button>
        </FieldRow>
      )}
      {dirty && filter !== null && <UnsavedBar onSave={save} onDiscard={() => change(original)} saving={saving} canSave={!saving} />}
      <RightRail
        label="Filter preview"
        sections={[
          { id: "live", label: "Live matches", node: <LiveMatches preview={preview.data} lastRun={lastRun} loading={preview.loading} failed={preview.error !== null} /> },
          { id: "json", label: "JSON", node: <JsonPanel spec={formToSpec(form)} /> },
        ]}
      />
    </>
  );
}

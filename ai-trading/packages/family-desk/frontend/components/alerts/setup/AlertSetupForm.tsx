"use client";

import type { AlertStrategySpecV1 } from "@ai-trading/contracts/alert-strategy";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useDeskStatus, useDeskUi } from "@/components/shell/desktop/DeskContext";
import { RightRail } from "@/components/shell/desktop/RightRail";
import editorStyles from "@/components/screener/editor/editor.module.css";
import { ErrorSummary } from "@/components/ui/ErrorSummary";
import { ErrorBlock, LoadingBlock } from "@/components/ui/StateBlocks";
import { DeskApiError } from "@/lib/api/client";
import type { Problem, SettingsChannel } from "@/lib/api/schemas";
import {
  alertFormFromSpec,
  alertFormToSpec,
  applyPrefill,
  defaultAlertForm,
  groupProblems,
  isAlertFormDirty,
  parsePrefill,
  stepOf,
  turnOnState,
  type AlertForm,
  type SourcePrefill,
} from "@/lib/desk/alertForm";
import { createAlertStrategy, loadAlertStrategy, resumeAlertStrategy, updateAlertStrategy, validateAlertStrategy } from "@/lib/desk/alerts";
import { formProblems } from "@/lib/desk/problems";
import { loadChannels } from "@/lib/desk/settings";
import { loadFilters } from "@/lib/desk/screener";
import { loadWatchlists } from "@/lib/desk/watchlists";
import { useDeskQuery, type DeskQueryResult } from "@/lib/desk/useDeskQuery";
import { parseAlertSpec } from "@/lib/spec/parse";
import { ConditionStep } from "./ConditionStep";
import { DeliverStep } from "./DeliverStep";
import { SourceStep } from "./SourceStep";
import { SummaryPane } from "./SummaryPane";
import { TriggerStep } from "./TriggerStep";
import styles from "./setup.module.css";

type Named = { id: number; name: string };

const hasSource = (form: AlertForm) => (form.sourceKind === "symbol" ? form.symbol.trim() !== "" : form.sourceKind === "watchlist" ? form.watchlist !== "" : form.filter !== "");

/** `/alerts/new`: four steps, a live check and summary, `Save draft` or `Turn on` (02l D10). `?edit=ID` edits a saved alert. */
export function AlertSetupForm() {
  const params = useSearchParams();
  const editId = Number(params.get("edit"));
  const editing = Number.isInteger(editId) && editId > 0;
  const prefill = parsePrefill({ source: params.get("source"), from: params.get("from") });
  const lists = useDeskQuery("setup-lists", (signal) => loadWatchlists({ signal }));
  const filters = useDeskQuery("setup-filters", (signal) => loadFilters({ signal }));
  const channels = useDeskQuery("setup-channels", (signal) => loadChannels({ signal }));
  const strategy = useDeskQuery(`setup-strategy:${editing ? editId : "new"}`, (signal) => loadAlertStrategy(editId, { signal }), { enabled: editing });
  const spec = editing && strategy.data ? parseAlertSpec(strategy.data.spec) : null;

  let body: ReactNode;
  if (editing && !strategy.loading && strategy.data === null) {
    body = <ErrorBlock subject="alert" onRetry={strategy.refresh} />;
  } else if (lists.loading || filters.loading || (editing && strategy.loading)) {
    body = <LoadingBlock label="Loading…" />;
  } else if (editing && spec === null) {
    body = (
      <>
        <p className={editorStyles.notice}>This alert strategy can&apos;t be edited here</p>
        <pre className={editorStyles.pre}>{JSON.stringify(strategy.data?.spec, null, 2)}</pre>
      </>
    );
  } else {
    // Keyed by the URL, so a new `?source=` or `?edit=` starts the form again from its own answer.
    body = (
      <SetupBody
        key={`${editing ? editId : "new"}:${params.toString()}`}
        editId={editing ? editId : null}
        spec={spec}
        prefill={prefill}
        lists={lists}
        filters={filters}
        channels={channels}
      />
    );
  }

  return (
    <div className={editorStyles.editor}>
      <header className={editorStyles.header}>
        <h1 className={editorStyles.title}>{editing ? "Edit alert strategy" : "New alert strategy"}</h1>
      </header>
      {body}
    </div>
  );
}

function SetupBody({ editId, spec, prefill, lists, filters, channels }: {
  editId: number | null;
  spec: AlertStrategySpecV1 | null;
  prefill: SourcePrefill | null;
  lists: DeskQueryResult<Named[]>;
  filters: DeskQueryResult<Named[]>;
  channels: DeskQueryResult<SettingsChannel[]>;
}) {
  // Computed once: from the saved spec, or the defaults plus the URL prefill. After that the form belongs to the user.
  const [original, setOriginal] = useState(() =>
    spec ? alertFormFromSpec(spec) : applyPrefill(defaultAlertForm(), prefill, lists.data ?? [], filters.data ?? []),
  );
  const [form, setForm] = useState(original);
  // The spec the live check runs on; null until the first change, so a fresh form does not open with errors.
  const [specJson, setSpecJson] = useState<string | null>(() => (hasSource(original) ? JSON.stringify(alertFormToSpec(original)) : null));
  const { setDirty } = useDeskUi();
  const [createdId, setCreatedId] = useState<number | null>(null);
  const targetId = editId ?? createdId;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [saving, setSaving] = useState<"draft" | "on" | "edit" | null>(null);
  const [saveProblems, setSaveProblems] = useState<Problem[]>([]);
  const [saveNote, setSaveNote] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const validate = useDeskQuery(`setup-validate:${specJson}`, (signal) => validateAlertStrategy(JSON.parse(specJson ?? "null"), { signal }), {
    enabled: specJson !== null,
  });
  const turn = turnOnState(useDeskStatus().status?.alerts.state ?? null);

  // A save's 422 replaces the live check's problems until the next change.
  const problems = saveProblems.length > 0 ? saveProblems : (validate.data?.problems ?? []);
  const groups = groupProblems(problems);
  const resolved = validate.data?.resolved_symbols ?? [];
  const dirty = isAlertFormDirty(original, form);
  const listsFailed = lists.data === null && lists.error !== null;
  const filtersFailed = filters.data === null && filters.error !== null;
  const channelsFailed = channels.data === null && channels.error !== null;

  useEffect(() => () => clearTimeout(timer.current), []);

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
  function change(next: AlertForm) {
    setForm(next);
    setSaved(null);
    setSaveProblems([]);
    setSaveNote("");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSpecJson(JSON.stringify(alertFormToSpec(next))), 500);
  }

  async function save(mode: "draft" | "on" | "edit") {
    const body = alertFormToSpec(form);
    setSaving(mode);
    setSaveProblems([]);
    setSaveNote("");
    try {
      if (targetId !== null) {
        // Saved once already: later saves update that strategy instead of creating a second one.
        const detail = await updateAlertStrategy(targetId, body);
        if (mode === "on" && editId === null) await resumeAlertStrategy(targetId);
        setSaved(mode === "on" && editId === null ? "Turned on" : editId === null ? "Saved as a draft" : `Saved as version ${detail.version}`);
      } else {
        const created = await createAlertStrategy(body, mode === "on" ? "on" : "draft");
        setCreatedId(created.id);
        setSaved(mode === "on" ? "Turned on" : "Saved as a draft");
      }
      setOriginal(form);
    } catch (error) {
      if (error instanceof DeskApiError && error.status === 422 && error.problems.length > 0) setSaveProblems(error.problems);
      else if (error instanceof DeskApiError && error.status === 409 && error.detail) setSaveNote(error.detail);
      else setSaveNote("Couldn't save the alert · Try again");
    } finally {
      setSaving(null);
    }
  }

  return (
    <>
      <ErrorSummary
        problems={formProblems(problems)}
        // Each line jumps to the step it belongs to; a problem outside the four steps has nowhere to jump.
        hrefFor={(problem) => {
          const step = stepOf(problem.path);
          return step === "other" ? null : `#alert-step-${step}`;
        }}
      />
      {saved && (
        <div className={styles.saved} role="status">
          <p>{saved}</p>
          <div className={editorStyles.controls}>
            <Link href="/alerts" className={styles.link}>View alerts</Link>
            <Link href="/alerts/new" className={styles.link}>Set up another</Link>
          </div>
        </div>
      )}
      {saveNote && <p role="alert" className={editorStyles.problem}>{saveNote}</p>}
      {(listsFailed || filtersFailed) && (
        <ErrorBlock
          message="Couldn't load your watchlists or filters · Try again"
          onRetry={() => {
            lists.refresh();
            filters.refresh();
          }}
        />
      )}
      <SourceStep form={form} onChange={change} problems={groups.source} lists={lists.data ?? []} filters={filters.data ?? []} />
      <ConditionStep form={form} onChange={change} problems={groups.condition} />
      <TriggerStep form={form} onChange={change} problems={groups.trigger} />
      <DeliverStep
        form={form}
        onChange={change}
        problems={groups.deliver}
        channels={channels.data}
        channelsFailed={channelsFailed}
        onRetryChannels={channels.refresh}
      />
      <div className={editorStyles.unsaved}>
        {dirty && <p>You have unsaved changes</p>}
        <div className={editorStyles.actions}>
          {editId !== null ? (
            <button type="button" className={`${editorStyles.button} ${editorStyles.primary}`} disabled={saving !== null} onClick={() => void save("edit")}>
              {saving ? "Saving…" : "Save changes"}
            </button>
          ) : (
            <>
              <button type="button" className={`${editorStyles.button} ${editorStyles.primary}`} disabled={saving !== null} onClick={() => void save("draft")}>
                {saving === "draft" ? "Saving…" : createdId !== null ? "Save changes" : "Save draft"}
              </button>
              <div className={styles.turn}>
                <button type="button" className={editorStyles.button} disabled={saving !== null || !turn.enabled} onClick={() => void save("on")}>
                  {saving === "on" ? "Saving…" : "Turn on"}
                </button>
                {turn.reason && <p className={editorStyles.note}>{turn.reason}</p>}
              </div>
            </>
          )}
        </div>
      </div>
      <RightRail
        label="Alert summary"
        sections={[
          {
            id: "summary",
            label: "Summary",
            node: <SummaryPane form={form} specJson={specJson ?? JSON.stringify(alertFormToSpec(original))} resolvedSymbols={resolved} />,
          },
        ]}
      />
    </>
  );
}

"use client";

import { JsonPanel } from "@/components/conditions/JsonPanel";
import editorStyles from "@/components/screener/editor/editor.module.css";
import { type AlertForm } from "@/lib/desk/alertForm";
import { describeSpec } from "@/lib/spec/describe";
import { parseAlertSpec } from "@/lib/spec/parse";
import { MiniChart } from "./MiniChart";
import styles from "./setup.module.css";

const SHOWN_SYMBOLS = 8;

function jsonOf(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function SummaryPane({ form, specJson, resolvedSymbols }: {
  form: AlertForm;
  specJson: string;
  resolvedSymbols: readonly string[];
}) {
  const json = jsonOf(specJson);
  const spec = json === null ? null : parseAlertSpec(json);
  const more = resolvedSymbols.length - SHOWN_SYMBOLS;
  return (
    <div className={styles.summary}>
      {spec ? <p className={styles.sentence}>{describeSpec(spec)}</p> : <p className={editorStyles.note}>Fill in the form to see a summary</p>}
      {resolvedSymbols.length > 0 && (
        <p className={editorStyles.note}>
          Watches {resolvedSymbols.slice(0, SHOWN_SYMBOLS).join(", ")}
          {more > 0 && ` and ${more} more`}
        </p>
      )}
      <MiniChart form={form} resolvedSymbols={resolvedSymbols} />
      {json && <JsonPanel spec={json} />}
    </div>
  );
}

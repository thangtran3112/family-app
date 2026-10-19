import type { StrategyTemplate } from "@/lib/templates";
import { describeSpec } from "@/lib/spec/describe";
import styles from "./strategies.module.css";

export function TemplateCard({
  template,
  selected,
  disabled = false,
  onSelect,
}: {
  template: StrategyTemplate;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      aria-pressed={selected}
      className={`${styles.templateCard} ${selected ? styles.templateSelected : ""}`}
      onClick={onSelect}
      disabled={disabled}
      type="button"
    >
      <span className={styles.templateTitle}>{template.spec.name}</span>
      <span className={styles.templateDescription}>{describeSpec(template.spec)}</span>
      <span className={styles.templateCadence}>{template.spec.watch.runOn.replaceAll("_", " ")}</span>
    </button>
  );
}

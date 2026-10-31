import { problemsTitle, type FormProblem } from "@/lib/desk/problems";
import styles from "./ErrorSummary.module.css";

/**
 * The count and the list of what to fix, above a form. Words come from lib/desk/problems.ts only: a field name and a plain
 * sentence, never a schema path. `hrefFor` turns a line into a jump link to its field or step; no link, plain text.
 * Errors announce as an alert, warnings as a status.
 */
export function ErrorSummary({ problems, hrefFor, className }: { problems: readonly FormProblem[]; hrefFor?: (problem: FormProblem) => string | null; className?: string }) {
  const title = problemsTitle(problems.length);
  if (title === null) return null;
  const warning = problems.every((problem) => problem.severity === "warning");
  return (
    <div className={`${styles.root} ${className ?? ""}`} role={warning ? "status" : "alert"} data-severity={warning ? "warning" : "error"}>
      <p className={styles.title}>{title}</p>
      <ul className={styles.list}>
        {problems.map((problem, index) => {
          const href = hrefFor?.(problem) ?? null;
          const line = `${problem.field}: ${problem.text}`;
          return <li key={index}>{href === null ? <span className={styles.item}>{line}</span> : <a href={href} className={`${styles.item} ${styles.link}`}>{line}</a>}</li>;
        })}
      </ul>
    </div>
  );
}

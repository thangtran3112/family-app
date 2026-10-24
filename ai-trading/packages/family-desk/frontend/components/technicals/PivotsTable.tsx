import type { Technicals } from "@/lib/api/schemas";
import { formatPrice } from "@/lib/desk/format";
import { PIVOT_METHODS, pivotRows, type PivotMethod } from "@/lib/desk/summary";
import { qualityLabel } from "@/lib/labels";
import styles from "./summary.module.css";

const METHOD_LABEL: Record<PivotMethod, string> = { classic: "Classic", fibonacci: "Fibonacci", camarilla: "Camarilla" };

export function PivotsTable({
  pivots,
  quality,
  asOf,
}: {
  pivots: Technicals["pivots"];
  quality: Technicals["quality"];
  asOf: string | null;
}) {
  return (
    <section className={styles.pivots}>
      <header className={styles.header}>
        <h2>Pivot points</h2>
        <span className={styles.meta}>
          {qualityLabel(quality)} · <time dateTime={asOf ?? undefined}>{asOf ? `Source bar · ${asOf}` : "Source bar unavailable"}</time>
        </span>
      </header>
      <table className={styles.table}>
        <caption className={styles.visuallyHidden}>Pivot points by method, S3 to R3</caption>
        <thead>
          <tr>
            <th scope="col">Level</th>
            {PIVOT_METHODS.map((method) => <th key={method} scope="col">{METHOD_LABEL[method]}</th>)}
          </tr>
        </thead>
        <tbody>
          {pivotRows(pivots).map((row) => (
            <tr key={row.point} className={row.point === "P" ? styles.pivotP : undefined}>
              <th scope="row">{row.point}</th>
              {PIVOT_METHODS.map((method) => <td key={method}>{formatPrice(row[method])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

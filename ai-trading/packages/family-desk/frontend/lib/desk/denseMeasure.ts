// When DenseTable has to measure its pane fit again (D-241). Pure, so node --test can pin it (components/ui/DenseTable.tsx uses it).

/** What a column adds to the table's widths: everything about it that can change a header's or a cell's width. Not `render`: a new closure over the same column is not a new width. */
type MeasuredColumn = { key: string; label: string; kind?: string; align?: string; priority?: number; fill?: boolean; truncate?: unknown; minWidth?: number };

/**
 * The inputs of one measure, as a string: the columns by value, the row count, whether there is an actions cell, whether the empty state shows. DenseTable measures
 * again only when this changes. Comparing the columns by identity measured a table again at every render of a parent that builds its `columns` inline (the replay
 * Portfolio tab) and at every poll of a table whose `hideWhenEmpty` column is dropped (`dropEmptyColumns` returns a new array then): two forced layouts each time.
 */
export function measureKey(columns: readonly MeasuredColumn[], rowCount: number, hasActions: boolean, showEmpty: boolean): string {
  const set = columns.map((c) => [c.key, c.label, c.kind ?? "", c.align ?? "", c.priority ?? "", c.fill ? 1 : 0, c.truncate ? 1 : 0, c.minWidth ?? ""].join("~")).join("|");
  return `${rowCount}#${hasActions ? 1 : 0}${showEmpty ? 1 : 0}#${set}`;
}

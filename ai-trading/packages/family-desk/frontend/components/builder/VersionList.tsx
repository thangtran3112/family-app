"use client";

import type { StrategyVersion } from "./types";
import styles from "./builder.module.css";

export function VersionList({
  versions,
  currentVersionId,
  selectedVersionId,
  onSelect,
  disabled,
}: {
  versions: StrategyVersion[];
  currentVersionId: number | null;
  selectedVersionId: number | null;
  onSelect: (version: StrategyVersion) => void;
  disabled?: boolean;
}) {
  return (
    <section className={styles.versionList} aria-label="Version history">
      <h3>Versions · {versions.length}</h3>
      {!versions.length && <p>No versions yet. Save an initial version below.</p>}
      {versions.map((version) => {
        const current = version.id === currentVersionId;
        const selected = version.id === selectedVersionId;
        return (
          <button
            aria-current={selected ? "true" : undefined}
            className={selected ? styles.selectedVersion : styles.versionButton}
            disabled={disabled || selected}
            key={version.id}
            onClick={() => onSelect(version)}
            type="button"
          >
            <span>v{version.version}{current ? " · current" : ""}</span>
            <small>{version.change_note ?? "Saved version"}</small>
          </button>
        );
      })}
    </section>
  );
}

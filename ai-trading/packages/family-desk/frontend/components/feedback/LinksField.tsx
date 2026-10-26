"use client";

import { isWebAddress, MAX_LINKS, type LinkDraft } from "@/lib/desk/feedbackView";
import styles from "./feedbackForm.module.css";

function CrossIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M2 2L10 10M10 2L2 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Optional links, label and address, as many rows as she needs up to ten (02s). One empty row stays open; blank rows are never sent. */
export function LinksField({ links, onChange }: { links: readonly LinkDraft[]; onChange: (next: LinkDraft[]) => void }) {
  const edit = (index: number, change: Partial<LinkDraft>) => onChange(links.map((link, at) => (at === index ? { ...link, ...change } : link)));
  const remove = (index: number) => {
    const next = links.filter((_, at) => at !== index);
    onChange(next.length > 0 ? next : [{ label: "", url: "" }]);
  };
  const removable = links.length > 1 || links[0]?.label !== "" || links[0]?.url !== "";
  return (
    <div className={styles.field} role="group" aria-labelledby="feedback-links">
      <div className={styles.labelGroup}>
        <span id="feedback-links" className={styles.label}>Links</span>
        <span className={styles.hint}>Optional · label and URL</span>
      </div>
      <div className={styles.linkRows}>
        {links.map((link, index) => {
          const invalid = link.url.trim() !== "" && !isWebAddress(link.url);
          return (
            <div key={index} className={styles.linkRow}>
              <input
                type="text"
                className={`${styles.input} ${styles.linkLabelInput}`}
                aria-label={`Link ${index + 1} label`}
                placeholder="Label (optional)"
                maxLength={80}
                value={link.label}
                onChange={(event) => edit(index, { label: event.target.value })}
              />
              <input
                type="url"
                className={`${styles.input} ${styles.linkUrlInput}`}
                aria-label={`Link ${index + 1} address`}
                aria-invalid={invalid}
                placeholder="https://"
                maxLength={2000}
                value={link.url}
                onChange={(event) => edit(index, { url: event.target.value })}
              />
              <span className={styles.slot}>
                {removable && (
                  <button type="button" className={styles.iconButton} aria-label={`Remove link ${index + 1}`} onClick={() => remove(index)}>
                    <CrossIcon />
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      {links.some((link) => link.url.trim() !== "" && !isWebAddress(link.url)) && (
        <p className={styles.problem} role="alert">A link needs a web address that starts with http:// or https://</p>
      )}
      <button type="button" className={styles.addLink} disabled={links.length >= MAX_LINKS} onClick={() => onChange([...links, { label: "", url: "" }])}>
        + Add link
      </button>
    </div>
  );
}

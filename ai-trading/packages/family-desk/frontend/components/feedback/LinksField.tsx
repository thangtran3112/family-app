"use client";

import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { isWebAddress, MAX_LINKS, type LinkDraft } from "@/lib/desk/feedbackView";
import styles from "./feedbackForm.module.css";

/** Optional links, label and address, as many rows as she needs up to ten (02s). One empty row stays open; blank rows are never sent. */
export function LinksField({ links, onChange }: { links: readonly LinkDraft[]; onChange: (next: LinkDraft[]) => void }) {
  const edit = (index: number, change: Partial<LinkDraft>) => onChange(links.map((link, at) => (at === index ? { ...link, ...change } : link)));
  const remove = (index: number) => {
    const next = links.filter((_, at) => at !== index);
    onChange(next.length > 0 ? next : [{ label: "", url: "" }]);
  };
  const removable = links.length > 1 || links[0]?.label !== "" || links[0]?.url !== "";
  return (
    <Field
      id="feedback-links"
      label="Links"
      group
      optional
      hint="label and URL"
      error={links.some((link) => link.url.trim() !== "" && !isWebAddress(link.url)) ? "A link needs a web address that starts with http:// or https://" : null}
    >
      <div className={styles.linkRows}>
        {links.map((link, index) => {
          const invalid = link.url.trim() !== "" && !isWebAddress(link.url);
          return (
            <div key={index} className={styles.linkRow}>
              <Input
                className={styles.linkLabelInput}
                aria-label={`Link ${index + 1} label`}
                placeholder="Label (optional)"
                maxLength={80}
                value={link.label}
                onChange={(event) => edit(index, { label: event.target.value })}
              />
              <Input
                type="url"
                className={styles.linkUrlInput}
                aria-label={`Link ${index + 1} address`}
                aria-invalid={invalid}
                placeholder="https://"
                maxLength={2000}
                value={link.url}
                onChange={(event) => edit(index, { url: event.target.value })}
              />
              <span className={styles.slot}>
                {removable && (
                  <Button variant="ghost" size="md" iconOnly aria-label={`Remove link ${index + 1}`} onClick={() => remove(index)}>
                    <Icon name="cross" size={12} />
                  </Button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <Button variant="ghost" size="md" className={styles.addLink} disabled={links.length >= MAX_LINKS} onClick={() => onChange([...links, { label: "", url: "" }])}>
        + Add link
      </Button>
    </Field>
  );
}

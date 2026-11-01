import type { ReactNode } from "react";
import { bannerRole } from "@/lib/desk/primitivesView";
import { Button } from "./Button";
import { Icon } from "./Icon";
import styles from "./Banner.module.css";
import type { Tone } from "./tone";

/**
 * One callout: a message on a toned outline, with an optional `action` (a `<Button>`) and, when `onDismiss` is set, a close button.
 * A `down` banner interrupts (`role="alert"`); every other tone is a `status`. Replaces every local `.banner` and `.notice`.
 */
export function Banner({ tone = "warn", action, onDismiss, children, className }: { tone?: Tone; action?: ReactNode; onDismiss?: () => void; children: ReactNode; className?: string }) {
  return (
    <div role={bannerRole(tone)} className={`${styles.root} ${className ?? ""}`} data-tone={tone}>
      <p className={styles.text}>{children}</p>
      {action}
      {onDismiss && (
        <Button variant="ghost" size="sm" iconOnly aria-label="Dismiss" onClick={onDismiss}>
          <Icon name="cross" size={12} />
        </Button>
      )}
    </div>
  );
}

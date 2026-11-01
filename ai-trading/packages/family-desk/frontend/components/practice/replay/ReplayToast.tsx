import { Button } from "@/components/ui/Button";
import { PRACTICE_COPY, withoutRetryHint } from "@/lib/desk/freshness";
import type { Toast } from "@/lib/replay/useReplaySession";
import styles from "./replay.module.css";

/**
 * The workspace's one message line. Both live regions are in the page before any message exists (a region that mounts with its
 * text is often not announced): a plain note goes to the polite one, an error to the assertive one. A note clears itself; an
 * error stays until she dismisses it. The countdown pauses while the pointer or focus is on the message.
 */
export function ReplayToast({ toast, onDismiss, onHold, onRelease }: { toast: Toast | null; onDismiss: () => void; onHold: () => void; onRelease: () => void }) {
  const line = (tone: Toast["tone"]) =>
    toast !== null && toast.tone === tone ? (
      <p className={styles.toast} data-tone={tone} onMouseEnter={onHold} onMouseLeave={onRelease} onFocus={onHold} onBlur={onRelease}>
        {/* A message has no Try again button of its own: the action it names is the one she just pressed. */}
        <span>{withoutRetryHint(toast.text)}</span>
        <Button size="md" variant="ghost" iconOnly aria-label={PRACTICE_COPY.dismissMessage} onClick={onDismiss}>×</Button>
      </p>
    ) : null;
  return (
    <>
      <div role="status" aria-live="polite">{line("info")}</div>
      <div role="alert">{line("error")}</div>
    </>
  );
}

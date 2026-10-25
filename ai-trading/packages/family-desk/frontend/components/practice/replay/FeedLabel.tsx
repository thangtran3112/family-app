import type { TapeFeed } from "@/lib/replay/schemas";
import { feedLabel } from "@/lib/replay/tape";
import styles from "./panels.module.css";

/** The tape's source in words. Consolidated reads as muted text; the IEX fallback is an amber chip. */
export function FeedLabel({ feed }: { feed: TapeFeed }) {
  const text = feedLabel(feed);
  return <span className={feed === "iex" ? `${styles.feed} ${styles.feedIex}` : styles.feed} title={text}>{text}</span>;
}

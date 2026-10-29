import type { Rating } from "@/lib/api/fundamentalSchemas";
import { ratingText } from "@/lib/desk/fundamentalView";
import styles from "../fundamental.module.css";

/** The violet Desk AI rating: a dot alone in dense rows (`compact`), dot and word elsewhere. No rating renders nothing, never a guess. */
export function AiRatingChip({ rating, compact = false }: { rating: Rating | null | undefined; compact?: boolean }) {
  if (!rating) return null;
  const text = ratingText(rating);
  return compact ? (
    <span className={styles.ratingDot} data-rating={rating} role="img" aria-label={`Desk AI: ${text}`} title={`Desk AI: ${text}`} />
  ) : (
    <span className={styles.rating}>
      <span className={styles.ratingDot} data-rating={rating} aria-hidden="true" />
      {text}
    </span>
  );
}

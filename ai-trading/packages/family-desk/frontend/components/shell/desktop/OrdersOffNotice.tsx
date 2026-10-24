import { COPY } from "@/lib/desk/freshness";
import styles from "./interstitial.module.css";

/** Stands where an order control would be: the Desk never places orders (02m §e). */
export function OrdersOffNotice() {
  return (
    <p className={styles.ordersOff} role="note">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
        <rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" strokeWidth="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="2" />
      </svg>
      <span>{COPY.ordersOff}</span>
    </p>
  );
}

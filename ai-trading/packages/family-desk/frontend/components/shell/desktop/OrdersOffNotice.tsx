import { Icon } from "@/components/ui/Icon";
import { COPY } from "@/lib/desk/freshness";
import styles from "./OrdersOffNotice.module.css";

/** Stands where an order control would be: the Desk never places orders (02m §e). */
export function OrdersOffNotice() {
  return (
    <p className={styles.ordersOff} role="note">
      <Icon name="lock" size={14} />
      <span>{COPY.ordersOff}</span>
    </p>
  );
}

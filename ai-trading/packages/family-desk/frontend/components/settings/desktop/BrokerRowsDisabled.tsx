import { Switch } from "@/components/ui/Field";
import { OrdersOffNotice } from "@/components/shell/desktop/OrdersOffNotice";
import styles from "./settingsDesktop.module.css";

const ROWS = [
  { id: "broker-place-orders", title: "Place orders" },
  { id: "broker-order-permission", title: "IBKR order permission" },
] as const;

/** Static broker rows, always off: the Desk never places orders (02m §a3.8). No handlers. */
export function BrokerRowsDisabled() {
  return (
    <>
      {ROWS.map((row) => (
        <div className={styles.row} key={row.id}>
          <label className={styles.rowTitle} htmlFor={row.id}>{row.title}</label>
          <Switch
            id={row.id}
            checked={false}
            disabled
            aria-disabled="true"
            aria-describedby="orders-off-note"
          />
        </div>
      ))}
      <div id="orders-off-note">
        <OrdersOffNotice />
      </div>
    </>
  );
}

import { Switch } from "@/components/ui/Field";
import { COPY } from "@/lib/desk/freshness";
import { ALERT_TEMPLATES } from "@/lib/settings/fundamentalView";
import styles from "./settingsDesktop.module.css";

/** The three Fundamental alert templates (02n §c3 #16). Their routes are gated until the data behind them exists, so each switch is off and disabled; nothing here calls them. */
export function AlertTemplatesCard() {
  return (
    <section className={styles.card} aria-labelledby="settings-alert-templates" data-testid="settings-alert-templates">
      <h2 id="settings-alert-templates" className={styles.eyebrow}>Fundamental alert templates</h2>
      {ALERT_TEMPLATES.map((template) => (
        <div className={styles.row} key={template.id}>
          <div className={styles.rowText}>
            <label className={styles.rowTitle} htmlFor={`template-${template.id}`}>{template.title}</label>
            <p className={styles.note}>{template.note}</p>
          </div>
          <Switch
            id={`template-${template.id}`}
            checked={false}
            disabled
            aria-disabled="true"
            aria-describedby="alert-templates-note"
          />
        </div>
      ))}
      <p className={styles.helper} id="alert-templates-note" data-testid="alert-templates-not-started">{COPY.alertTemplatesNotStarted}</p>
    </section>
  );
}

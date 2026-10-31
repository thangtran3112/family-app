import { createElement, type ReactNode } from "react";
import { panelHeadingTag } from "@/lib/desk/primitivesView";
import styles from "./Panel.module.css";

type Layout = { /** Layout only (grid-area, margin, width); never colour, size or type. */ className?: string };

/** The one box: a hairline, the panel surface, and the Desk's padding. Compose PanelHeader, PanelBody and PanelFooter inside it. */
export function Panel({ children, className, ...label }: Layout & { children: ReactNode; "aria-label"?: string; "aria-labelledby"?: string }) {
  return <section className={`${styles.panel} ${className ?? ""}`} {...label}>{children}</section>;
}

/**
 * A panel's title and, at the right, its actions. `variant="title"` is a panel heading; `"label"` is the small caps label that
 * heads a rail section or a group (no box). `level` picks h2 to h4; the page owns the h1.
 */
export function PanelHeader({ title, level, variant = "title", actions, id, className }: Layout & { title: ReactNode; level?: number; variant?: "title" | "label"; actions?: ReactNode; id?: string }) {
  return (
    <header className={`${styles.header} ${className ?? ""}`} data-variant={variant}>
      {createElement(panelHeadingTag(level), { id, className: styles.title }, title)}
      {actions && <div className={styles.actions}>{actions}</div>}
    </header>
  );
}

/** The panel's content, spaced the way the Desk spaces a panel. */
export function PanelBody({ children, className }: Layout & { children: ReactNode }) {
  return <div className={`${styles.body} ${className ?? ""}`}>{children}</div>;
}

/** A rule, then the panel's closing actions. */
export function PanelFooter({ children, className }: Layout & { children: ReactNode }) {
  return <footer className={`${styles.footer} ${className ?? ""}`}>{children}</footer>;
}

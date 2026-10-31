"use client";

import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { moveActive } from "@/lib/desk/listNav";
import { Popover, type PopoverTriggerProps } from "./Popover";
import styles from "./Menu.module.css";

export type MenuTriggerProps = PopoverTriggerProps & { onKeyDown: (event: KeyboardEvent<HTMLElement>) => void };

export type MenuItem = {
  href: string;
  label: ReactNode;
  /** Muted text at the right of the label (a shortcut). */
  hint?: ReactNode;
  /** A second muted line under the label. */
  description?: ReactNode;
  /** Set it and the row is a `menuitemradio` with `aria-checked`; leave it out for a plain `menuitem`. */
  checked?: boolean;
  /** `aria-keyshortcuts`. */
  shortcut?: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
};

type MenuProps = {
  label: string;
  trigger: (props: MenuTriggerProps) => ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
  width: number;
};

const ITEMS = '[role^="menuitem"]';
const NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

/** The checked row, else the first one: where focus lands when the menu opens. */
function focusInitial(panel: HTMLElement) {
  (panel.querySelector<HTMLElement>('[aria-checked="true"]') ?? panel.querySelector<HTMLElement>(ITEMS))?.focus();
}

function onPanelKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (!NAV_KEYS.has(event.key)) return;
  event.preventDefault();
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(ITEMS)];
  const current = items.findIndex((item) => item === document.activeElement);
  items[moveActive(current, event.key as "ArrowDown" | "ArrowUp" | "Home" | "End", items.length)]?.focus();
}

/**
 * A menu button over a list of link rows (WAI-ARIA menu button): opens on click or ArrowDown, puts focus on the checked or
 * first row, ArrowUp/ArrowDown wrap, Home/End jump, Escape or a press outside closes (Popover). Enter on a row follows its link.
 * The menu owns its open state; a row's `onClick` may `preventDefault` to cancel the navigation.
 */
export function Menu({ label, trigger, items, align, width }: MenuProps) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      role="menu"
      label={label}
      align={align}
      width={width}
      onOpen={focusInitial}
      onKeyDown={onPanelKeyDown}
      trigger={(props) =>
        trigger({
          ...props,
          onKeyDown: (event) => {
            if (event.key !== "ArrowDown") return;
            event.preventDefault();
            setOpen(true);
          },
        })
      }
    >
      {items.map((item) => (
        <a
          key={item.href}
          role={item.checked === undefined ? "menuitem" : "menuitemradio"}
          aria-checked={item.checked}
          aria-keyshortcuts={item.shortcut}
          className={styles.item}
          href={item.href}
          onClick={item.onClick}
        >
          <span className={styles.label}>{item.label}</span>
          {item.hint && <span className={styles.hint}>{item.hint}</span>}
          {item.description && <span className={styles.description}>{item.description}</span>}
        </a>
      ))}
    </Popover>
  );
}

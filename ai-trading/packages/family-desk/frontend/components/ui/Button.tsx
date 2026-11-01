import Link from "next/link";
import type { ComponentPropsWithoutRef, ComponentPropsWithRef } from "react";
import { buttonState } from "@/lib/desk/primitivesView";
import styles from "./Button.module.css";

type Look = {
  /** primary = the screen's one main action (amber outline), secondary = the default, ghost = no outline, danger = destructive. */
  variant?: "primary" | "secondary" | "ghost" | "danger";
  /** sm 24 px (a dense table row), md 28 px, lg 32 px (page actions and form controls). */
  size?: "sm" | "md" | "lg";
  /** Disables the button and marks it busy; keep the visible label saying what is happening ("Working…"). */
  loading?: boolean;
  /** Layout only (grid-area, margin, width); never colour, size or type. */
  className?: string;
};
/** An icon-only button is a square and must carry its name. */
type Icon = { iconOnly: true; "aria-label": string } | { iconOnly?: false };

export type ButtonProps =
  | (Look & Icon & Omit<ComponentPropsWithRef<"button">, "className"> & { href?: undefined; client?: undefined })
  /** `href` renders an anchor. It is a plain one (full navigation: the shell's beforeunload guard runs); `client` uses next/link. */
  | (Look & Icon & Omit<ComponentPropsWithoutRef<"a">, "className" | "href"> & { href: string; client?: boolean });

/** The one button. Replaces every local `.button`; a link that acts like a button takes `href`. */
export function Button(props: ButtonProps) {
  const { variant = "secondary", size = "lg", loading = false, iconOnly = false, className, ...rest } = props;
  const cls = `${styles.root} ${className ?? ""}`;
  const look = { "data-variant": variant, "data-size": size, "data-icon": iconOnly ? "true" : undefined };
  if (rest.href !== undefined) {
    const { client, href, ...anchor } = rest as Extract<ButtonProps, { href: string }>;
    return client ? <Link href={href} className={cls} {...look} {...anchor} /> : <a href={href} className={cls} {...look} {...anchor} />;
  }
  const { disabled, type = "button", ...button } = rest as Extract<ButtonProps, { href?: undefined }>;
  return <button type={type} className={cls} {...look} {...button} {...buttonState({ disabled, loading })} />;
}

import Link from "next/link";
import { setupLinkParts } from "@/lib/desk/fundamentalView";
import styles from "../fundamental.module.css";

/** An import-state sentence; the "set up the IBKR import in Settings" step is a real link, since that sentence is the user's only way there. */
export function ImportText({ text }: { text: string }) {
  const parts = setupLinkParts(text);
  if (!parts) return <>{text}</>;
  return <>{parts.lead}<Link className={styles.inlineLink} href={parts.href}>{parts.link}</Link></>;
}

import { iconA11y } from "@/lib/desk/primitivesView";
import styles from "./Icon.module.css";

// The one icon set the desk uses: stroke-only paths on a 24 grid, drawn at 1.5 px whatever the size (Icon.module.css).
const PATHS = {
  bell: ["M6 9a6 6 0 1 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9Z", "M10 19a2 2 0 0 0 4 0"],
  search: ["M17.5 11a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0Z", "m16 16 4.5 4.5"],
  eye: ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z", "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"],
  "eye-off": ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z", "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z", "m4 4 16 16"],
  lock: ["M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z", "M8 11V8a4 4 0 0 1 8 0v3"],
  cross: ["M6 6l12 12M18 6 6 18"],
  "chevron-left": ["M15 5.25 8.25 12l6.75 6.75"],
  "chevron-right": ["M9 5.25 15.75 12 9 18.75"],
  "chevron-down": ["m6 9 6 6 6-6"],
  list: ["M9 6h12M9 12h12M9 18h12M3.75 6h.75M3.75 12h.75M3.75 18h.75"],
  filter: ["M3.75 5.25h16.5L13.5 12.75v6l-3 1.5v-7.5z"],
  mark: ["M9 5v4M9 15v4M15 3v6M15 15v6", "M8 9h2a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1Z", "M14 9h2a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1Z"],
} as const;

export type IconName = keyof typeof PATHS;

/** An inline icon in the current text colour. Decoration unless `label` is set, then an image with that name. `size` is px. */
export function Icon({ name, size = 16, label, className }: { name: IconName; size?: number; label?: string; className?: string }) {
  return (
    <svg className={`${styles.icon} ${className ?? ""}`} width={size} height={size} viewBox="0 0 24 24" focusable="false" {...iconA11y(label)}>
      {PATHS[name].map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

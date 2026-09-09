import type { ReactNode } from "react";
export function PageHead({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) { return <header className="page-head"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{children}</div><button className="profile"><i />Tran Studio · 2025</button></header>; }
export function Panel({ title, className = "", children }: { title: string; className?: string; children: ReactNode }) { return <section className={`panel ${className}`}><h2>{title}</h2>{children}</section>; }
export function Metric({ label, value, note, warn }: { label: string; value: string; note: string; warn?: boolean }) { return <article className="metric"><h2>{label}</h2><strong className={warn ? "warn" : ""}>{value}</strong><p>{note}</p></article>; }
export function Status({ children, tone = "ok" }: { children: ReactNode; tone?: "ok" | "warn" | "bad" }) { return <span className={`status ${tone}`}>{children}</span>; }

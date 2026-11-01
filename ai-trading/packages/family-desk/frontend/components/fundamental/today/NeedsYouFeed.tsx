import Link from "next/link";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { LoadingBlock } from "@/components/ui/StateBlocks";
import { feedKindView, type FeedItem } from "@/lib/desk/fundamentalToday";
import styles from "../fundamental.module.css";
import local from "./today.module.css";

function FeedRow({ item }: { item: FeedItem }) {
  const kind = feedKindView(item.kind);
  return (
    <li>
      <Link className={local.item} href={item.href} data-testid="fund-feed-item">
        <span className={local.kind} data-tone={kind.tone}>{kind.label}</span>
        <span className={local.itemBody}>
          <span className={local.itemTitle}>{item.title}</span>
          <span className={local.itemDetail}>{item.detail}</span>
        </span>
      </Link>
    </li>
  );
}

/** The "Needs you" feed (FD2): what the holdings and open calls ask of the owner today, built in lib/desk/fundamentalToday.ts. */
export function NeedsYouFeed({ items, loading = false, dim = false }: { items: readonly FeedItem[]; loading?: boolean; dim?: boolean }) {
  return (
    <Panel className={dim ? styles.dim : undefined} aria-labelledby="fund-feed-title">
      <PanelHeader id="fund-feed-title" title="Needs you" />
      {loading ? (
        <LoadingBlock label="Loading what needs you…" height={96} />
      ) : items.length === 0 ? (
        <p className={styles.muted} data-testid="fund-feed-empty">Nothing needs you right now</p>
      ) : (
        <ul className={styles.list} data-testid="fund-feed">
          {items.map((item, index) => <FeedRow key={`${item.kind}-${item.symbol ?? "all"}-${index}`} item={item} />)}
        </ul>
      )}
    </Panel>
  );
}

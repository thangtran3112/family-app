"use client";

import { Menu } from "@/components/ui/Menu";
import { initialOf } from "@/lib/desk/format";
import { loadMe } from "@/lib/desk/status";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { AVATAR_MENU } from "@/lib/lanes";
import styles from "./topbar.module.css";

export function AvatarMenu() {
  const me = useDeskQuery("me", (signal) => loadMe({ signal }));
  return (
    <Menu
      label="Account"
      width={180}
      items={AVATAR_MENU.map((item) => ({ href: item.href, label: item.label }))}
      trigger={(props) => (
        <button type="button" className={styles.avatar} aria-label="Account menu" {...props}>
          {initialOf(me.data?.email)}
        </button>
      )}
    />
  );
}

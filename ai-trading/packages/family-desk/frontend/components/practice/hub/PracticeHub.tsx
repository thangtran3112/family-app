"use client";

import { useState } from "react";
import { useRegisterSymbolPicker } from "@/components/shell/desktop/PracticeChrome";
import { RightRail } from "@/components/shell/desktop/RightRail";
import { PRACTICE_COPY } from "@/lib/desk/freshness";
import { loadReplayDays, loadReplaySessions } from "@/lib/desk/replay";
import { useDeskQuery } from "@/lib/desk/useDeskQuery";
import { withNotableDay, defaultDraft, type SetupDraft } from "@/lib/replay/setup";
import type { ReplayDay } from "@/lib/replay/schemas";
import { DailyListCard } from "./DailyListCard";
import { NotableDaysTable } from "./NotableDaysTable";
import { RecentSessionsTable } from "./RecentSessionsTable";
import { ResumeCard } from "./ResumeCard";
import { SessionSetup } from "./SessionSetup";
import { ThreadsSection } from "./ThreadsSection";
import styles from "./hub.module.css";

/** Practice hub (02o §a2): set up a replay of a past day, pick a notable day, and resume or review sessions. */
export function PracticeHub() {
  const [draft, setDraft] = useState<SetupDraft>(defaultDraft);
  const [showDates, setShowDates] = useState(false);
  // Bumped when a thread changes (created here), so the threads band and the daily-list card both refetch.
  const [threadRevision, setThreadRevision] = useState(0);
  useRegisterSymbolPicker((symbol) => setDraft((current) => ({ ...current, symbol })));

  // All notable days first: the answer also says which symbols are on her watchlists. A typed symbol on that list
  // gets its own query (its days, not just the top 20 overall); any other symbol sees the full list plus a hint.
  const all = useDeskQuery("replay-days:all", (signal) => loadReplayDays({ limit: 20 }, { signal }));
  const typed = draft.symbol.trim().toUpperCase();
  const scoped = typed !== "" && (all.data?.symbols.includes(typed) ?? false);
  const picked = useDeskQuery(`replay-days:${typed}`, (signal) => loadReplayDays({ symbol: typed, limit: 20 }, { signal }), { enabled: scoped });
  const days = scoped ? picked : all;

  const sessions = useDeskQuery("replay-sessions", (signal) => loadReplaySessions({ limit: 20 }, { signal }));
  const sessionsError = sessions.data === null ? sessions.error : null;
  const active = (sessions.data ?? [])
    .filter((row) => row.status === "active")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] ?? null;

  function onPick(row: ReplayDay) {
    setDraft((current) => withNotableDay(current, row, !showDates));
    document.getElementById("start-practice")?.scrollIntoView({ block: "start" });
  }

  return (
    <div className={styles.root}>
      <header className={styles.header}>
        <h1 className={styles.title}>Practice</h1>
      </header>
      <div className={styles.body}>
        <ThreadsSection revision={threadRevision} onChanged={() => setThreadRevision((n) => n + 1)} />
        <section id="daily-list" aria-labelledby="daily-title" className={styles.section}>
          <h2 id="daily-title" className={styles.sectionTitle}>{PRACTICE_COPY.planTitle}</h2>
          <DailyListCard revision={threadRevision} />
        </section>
        <section id="start-practice" aria-labelledby="start-title" className={styles.section}>
          <h2 id="start-title" className={styles.sectionTitle}>Start a practice session</h2>
          <SessionSetup draft={draft} onDraft={setDraft} />
        </section>
        <NotableDaysTable
          days={days.data?.days ?? []}
          loading={days.loading}
          error={days.data === null ? days.error : null}
          onRetry={days.refresh}
          symbol={typed}
          symbols={all.data?.symbols ?? []}
          showDates={showDates}
          onShowDates={setShowDates}
          onPick={onPick}
        />
      </div>
      <RightRail
        label="Practice sessions"
        sections={[
          {
            id: "resume",
            label: "Resume",
            node: <ResumeCard session={active} loading={sessions.loading} error={sessionsError} onRetry={sessions.refresh} />,
          },
          {
            id: "recent",
            label: "Recent",
            node: <RecentSessionsTable sessions={sessions.data ?? []} loading={sessions.loading} error={sessionsError} onRetry={sessions.refresh} />,
          },
        ]}
      />
    </div>
  );
}

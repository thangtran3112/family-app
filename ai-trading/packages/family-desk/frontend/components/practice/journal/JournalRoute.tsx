"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { JournalScreen } from "@/components/practice/journal/JournalScreen";
import { ThreadJournalScreen } from "@/components/practice/journal/thread/ThreadJournalScreen";

/**
 * `/practice/journal`: `?thread=` opens a practice thread's journal (02r), `?id=` the scored replay session. A journal exists only inside
 * a thread, so the bare address (no global thread picker, no top-bar tab) sends her to Practice, where she opens a thread.
 */
export function JournalRoute() {
  const params = useSearchParams();
  const router = useRouter();
  const scoped = params.get("thread") !== null || params.get("id") !== null;
  useEffect(() => {
    if (!scoped) router.replace("/practice");
  }, [scoped, router]);
  if (params.get("thread") !== null) return <ThreadJournalScreen />;
  if (params.get("id") !== null) return <JournalScreen />;
  return null;
}

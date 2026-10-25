"use client";

import { useSearchParams } from "next/navigation";
import { JournalScreen } from "@/components/practice/journal/JournalScreen";
import { ThreadJournalScreen } from "@/components/practice/journal/thread/ThreadJournalScreen";

/** `/practice/journal`: `?thread=` opens a practice thread's journal (02r); otherwise the scored replay session (`?id=`). */
export function JournalRoute() {
  const thread = useSearchParams().get("thread");
  return thread !== null ? <ThreadJournalScreen /> : <JournalScreen />;
}

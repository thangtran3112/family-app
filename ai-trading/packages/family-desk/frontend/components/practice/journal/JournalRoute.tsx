"use client";

import { useSearchParams } from "next/navigation";
import { JournalScreen } from "@/components/practice/journal/JournalScreen";
import { ThreadJournalScreen } from "@/components/practice/journal/thread/ThreadJournalScreen";
import { ThreadPicker } from "@/components/practice/journal/thread/ThreadPicker";

/** `/practice/journal`: `?thread=` opens a practice thread's journal (02r), `?id=` the scored replay session; neither lists her threads (D-037). */
export function JournalRoute() {
  const params = useSearchParams();
  if (params.get("thread") !== null) return <ThreadJournalScreen />;
  if (params.get("id") !== null) return <JournalScreen />;
  return <ThreadPicker />;
}

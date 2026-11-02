import { EmptyBlock } from "@/components/ui/StateBlocks";
import { PRACTICE_COPY } from "@/lib/desk/freshness";

/**
 * The one absence shape for a practice route (D-164). Three cases, one pattern:
 * - no id chosen: `ThreadPicker` (the journal's list, "No practice thread selected" and a way to pick);
 * - an id the server does not know (404): `PracticeNotice` with "not found" and the way back to Practice;
 * - a failed load: `ErrorBlock` with "Try again", and nothing else.
 * A new route takes this shape: use these two, do not write a local empty block.
 */
export function PracticeNotice({ title }: { title: string }) {
  return <EmptyBlock framed title={title} action={{ label: PRACTICE_COPY.openPractice, href: "/practice", primary: true }} />;
}

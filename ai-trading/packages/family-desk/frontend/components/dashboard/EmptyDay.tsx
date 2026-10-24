import { EmptyBlock } from "@/components/ui/StateBlocks";
import { COPY } from "@/lib/desk/freshness";

/** The empty-day state of "Today's signals" (02l D2). */
export function EmptyDay() {
  return <EmptyBlock title={COPY.noSignalsToday} />;
}

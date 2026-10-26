import { PlanChecklist } from "@/components/practice/replay/PlanChecklist";
import replay from "@/components/practice/replay/replay.module.css";
import { SimulatedBadge } from "@/components/practice/thread/SimulatedBadge";
import { SWING_PLAY_COPY } from "@/lib/replay/playView";
import type { PlanItem } from "@/lib/replay/planView";

/** The swing plan in the left rail (02p b2): open holds against the limit, then the week's entries and loss limit. Ticks, never blocks. */
export function SwingPlanChecklist({ items }: { items: PlanItem[] }) {
  return (
    <section className={replay.sessionSection} aria-label={SWING_PLAY_COPY.planTitle}>
      <div className={replay.railHead}>
        <h2 className={replay.railTitle}>{SWING_PLAY_COPY.planTitle}</h2>
        <SimulatedBadge />
      </div>
      <PlanChecklist items={items} shares={null} />
    </section>
  );
}

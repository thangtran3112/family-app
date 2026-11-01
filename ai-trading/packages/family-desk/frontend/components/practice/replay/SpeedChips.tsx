import { ChipToggleGroup } from "@/components/ui/ChipToggleGroup";
import { SPEEDS, type Speed } from "@/lib/replay/clock";

/** 1x 2x 5x 10x. */
export function SpeedChips({ speed, onSpeed }: { speed: Speed; onSpeed: (speed: Speed) => void }) {
  const options = SPEEDS.map((value) => ({ id: String(value), label: `${value}x`, title: `${value}x speed` }));
  return <ChipToggleGroup label="Replay speed" size="touch" options={options} pressed={[String(speed)]} onToggle={(id) => onSpeed(Number(id) as Speed)} />;
}

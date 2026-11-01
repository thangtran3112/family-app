import { ChipToggleGroup } from "@/components/ui/ChipToggleGroup";
import { SPEEDS, type Speed } from "@/lib/replay/clock";

/** 1x 2x 5x 10x. Keys 1 to 4 pick them in order. */
export function SpeedChips({ speed, onSpeed }: { speed: Speed; onSpeed: (speed: Speed) => void }) {
  const options = SPEEDS.map((value, index) => ({ id: String(value), label: `${value}x`, title: `${value}x speed (key ${index + 1})` }));
  return <ChipToggleGroup label="Replay speed" options={options} pressed={[String(speed)]} onToggle={(id) => onSpeed(Number(id) as Speed)} />;
}

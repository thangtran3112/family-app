import { FieldGroup, Radio } from "@/components/ui/Field";
import { LANE_LABEL, LANES, type Lane } from "@/lib/lanes";

/** Which mode the Desk opens on (`default_view`, 02m §a3.9, ADR-0014). The parent saves it; this screen stays put. */
export function DefaultView({ value, disabled, onChange }: Readonly<{ value: Lane; disabled: boolean; onChange: (view: Lane) => void }>) {
  return (
    <FieldGroup legend="Default mode" hideLegend disabled={disabled}>
      {LANES.map((lane) => (
        <Radio key={lane} name="default-view" value={lane} label={LANE_LABEL[lane]} checked={value === lane} onChange={() => onChange(lane)} />
      ))}
    </FieldGroup>
  );
}

import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";
import { MoreMobile } from "@/components/settings/MoreMobile";
import { SettingsDesktop } from "@/components/settings/desktop/SettingsDesktop";

export default function MorePage() {
  return <DeskResponsive desktop={<SettingsDesktop title="More" />} mobile={<MoreMobile />} />;
}

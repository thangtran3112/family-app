import type { Metadata } from "next";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";
import { MoreMobile } from "@/components/settings/MoreMobile";
import { SettingsDesktop } from "@/components/settings/desktop/SettingsDesktop";

export const metadata: Metadata = { title: "More" };

export default function MorePage() {
  return <DeskResponsive desktop={<SettingsDesktop title="More" />} mobile={<MoreMobile />} />;
}

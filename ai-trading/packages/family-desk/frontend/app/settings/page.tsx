import type { Metadata } from "next";
import { DeskResponsive } from "@/components/shell/desktop/DeskResponsive";
import { SettingsDesktop } from "@/components/settings/desktop/SettingsDesktop";
import { SettingsMobile } from "@/components/settings/SettingsMobile";

export const metadata: Metadata = { title: "Settings" };

export default function SettingsPage() {
  return <DeskResponsive desktop={<SettingsDesktop title="Settings" />} mobile={<SettingsMobile />} />;
}

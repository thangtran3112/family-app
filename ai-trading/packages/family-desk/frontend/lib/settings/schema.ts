import { z } from "zod";

const hhmm = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

export const DEFAULT_QUIET_HOURS = { start: "22:00", end: "07:00" } as const;

export const QuietHoursSchema = z.object({
  start: hhmm,
  end: hhmm,
}).passthrough();

export type QuietHours = { start: string; end: string };
export type DeliveryPreferences = { telegram: boolean; slack: boolean };
export type OwnedSettings = {
  quietHours: QuietHours;
  channels: DeliveryPreferences;
  warnings: string[];
};
export type SettingsRecord = Record<string, unknown>;

function isRecord(value: unknown): value is SettingsRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readOwnedSettings(settings: SettingsRecord): OwnedSettings {
  const warnings: string[] = [];
  let quietHours: QuietHours = { ...DEFAULT_QUIET_HOURS };
  const storedQuietHours = settings.quiet_hours;

  if (storedQuietHours !== undefined && storedQuietHours !== null) {
    if (!isRecord(storedQuietHours)) {
      warnings.push("quiet_hours");
    } else if (Object.keys(storedQuietHours).length > 0) {
      const candidate = QuietHoursSchema.safeParse({
        start: Object.hasOwn(storedQuietHours, "start") ? storedQuietHours.start : DEFAULT_QUIET_HOURS.start,
        end: Object.hasOwn(storedQuietHours, "end") ? storedQuietHours.end : DEFAULT_QUIET_HOURS.end,
      });
      if (candidate.success) {
        quietHours = { start: candidate.data.start, end: candidate.data.end };
      } else {
        warnings.push("quiet_hours");
      }
    }
  }

  const storedChannels = settings.channels;
  let channels: DeliveryPreferences;
  if (!Object.hasOwn(settings, "channels")) {
    channels = { telegram: true, slack: true };
  } else if (
    Array.isArray(storedChannels)
    && storedChannels.every((channel) => typeof channel === "string" && ["inbox", "telegram", "slack"].includes(channel))
  ) {
    channels = {
      telegram: storedChannels.includes("telegram"),
      slack: storedChannels.includes("slack"),
    };
  } else {
    channels = { telegram: false, slack: false };
    warnings.push("channels");
  }

  return { quietHours, channels, warnings };
}

export function mergeOwnedSettings(
  settings: SettingsRecord,
  owned: Pick<OwnedSettings, "quietHours" | "channels">,
): SettingsRecord {
  const storedQuietHours = isRecord(settings.quiet_hours) ? settings.quiet_hours : {};
  return {
    ...settings,
    quiet_hours: { ...storedQuietHours, ...owned.quietHours },
    channels: ["inbox", ...(owned.channels.telegram ? ["telegram"] : []), ...(owned.channels.slack ? ["slack"] : [])],
  };
}

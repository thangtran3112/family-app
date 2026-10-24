import { SettingsBodySchema, SettingsChannelSchema, SettingsChannelsSchema, SettingsChannelTestSchema } from "../api/schemas.ts";
import { clientOf, deskPath, jsonInit, readInit, type RequestOptions } from "./api.ts";

export const loadSettings = (options?: RequestOptions) => clientOf(options)(deskPath("/settings"), SettingsBodySchema, readInit(options));
export const saveSettings = (settings: Record<string, unknown>, options?: RequestOptions) =>
  clientOf(options)(deskPath("/settings"), SettingsBodySchema, jsonInit("PUT", { settings }, options));
export const loadChannels = (options?: RequestOptions) => clientOf(options)(deskPath("/settings/channels"), SettingsChannelsSchema, readInit(options));
export const linkTelegram = (chatId: string, options?: RequestOptions) =>
  clientOf(options)(deskPath("/settings/channels/telegram"), SettingsChannelSchema, jsonInit("PUT", { chat_id: chatId }, options));
export const testChannel = (channel: "inbox" | "telegram" | "slack", options?: RequestOptions) =>
  clientOf(options)(deskPath(`/settings/channels/${channel}/test`), SettingsChannelTestSchema, jsonInit("POST", {}, options));

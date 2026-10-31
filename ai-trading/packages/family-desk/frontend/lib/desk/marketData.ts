import { MarketDataCardSchema, MarketDataChoiceSchema } from "../api/schemas.ts";
import { clientOf, deskPath, jsonInit, readInit, type RequestOptions } from "./api.ts";

// The Market-data card's two calls (02t §6): the read every viewer gets, and the owner's one-class choice.
export const loadMarketDataCard = (options?: RequestOptions) =>
  clientOf(options)(deskPath("/settings/market-data"), MarketDataCardSchema, readInit(options));

export const saveMarketDataChoice = (
  choice: { data_class: "equity_quotes" | "equity_bars" | "option_chain"; provider: string },
  options?: RequestOptions,
) => clientOf(options)(deskPath("/settings/market-data"), MarketDataChoiceSchema, jsonInit("PUT", choice, options));
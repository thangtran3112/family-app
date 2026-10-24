import { DashboardSchema } from "../api/schemas.ts";
import { clientOf, deskPath, readInit, type RequestOptions } from "./api.ts";

export const loadDashboard = (watchlistId?: number, options?: RequestOptions) =>
  clientOf(options)(deskPath("/dashboard", { watchlist_id: watchlistId }), DashboardSchema, readInit(options));

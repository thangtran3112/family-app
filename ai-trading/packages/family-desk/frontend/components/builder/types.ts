import type { StrategyVersionsResponseSchema } from "@/lib/api/schemas";

export type StrategyVersion = ReturnType<typeof StrategyVersionsResponseSchema.parse>[number];

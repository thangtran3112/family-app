import { z } from "zod";

export const ServiceNameSchema = z.enum(["app-api", "foundry-service"]);

export type ServiceName = z.infer<typeof ServiceNameSchema>;

export const HealthStatusSchema = z.enum(["ok", "degraded"]);

export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const HealthResponseSchema = z.strictObject({
  status: HealthStatusSchema,
  service: ServiceNameSchema,
  version: z.string(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

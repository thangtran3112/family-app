import { z } from "zod";

export const JobResultSubmitRequestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.enum(["SUCCEEDED", "FAILED"]),
  idempotencyKey: z.string().min(1),
  expectedJobVersion: z.int().min(1),
  resultSchemaVersion: z.string().min(1),
  result: z.record(z.string(), z.unknown()),
  message: z.string().max(2000).optional(),
});

export type JobResultSubmitRequestV1 = z.infer<
  typeof JobResultSubmitRequestV1Schema
>;

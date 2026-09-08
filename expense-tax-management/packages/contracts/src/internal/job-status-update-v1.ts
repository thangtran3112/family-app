import { z } from "zod";

export const JobStatusUpdateRequestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.enum(["RUNNING", "FAILED"]),
  idempotencyKey: z.string().min(1),
  expectedJobVersion: z.int().min(1),
  message: z.string().max(2000).optional(),
});

export type JobStatusUpdateRequestV1 = z.infer<
  typeof JobStatusUpdateRequestV1Schema
>;

import { z } from "zod";

export const JobReferenceV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  jobId: z.uuid(),
  workflowType: z.string().min(1),
  workflowId: z.string().min(1),
});

export type JobReferenceV1 = z.infer<typeof JobReferenceV1Schema>;

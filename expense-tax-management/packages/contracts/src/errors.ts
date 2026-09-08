import { z } from "zod";

export const ErrorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

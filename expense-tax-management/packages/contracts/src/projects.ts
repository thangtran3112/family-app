import { z } from "zod";

const TimestampSchema = z.string().datetime({ offset: true });
const VersionSchema = z.number().int().positive();
const DateSchema = z.iso.date();

function orderedDates(value: {
  startsOn?: string | null | undefined;
  endsOn?: string | null | undefined;
}): boolean {
  return !value.startsOn || !value.endsOn || value.endsOn >= value.startsOn;
}

export const ProjectStatusSchema = z.enum([
  "active",
  "completed",
  "archived",
]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const ProjectSchema = z.strictObject({
  id: z.uuid(),
  tenantId: z.uuid(),
  businessId: z.uuid(),
  name: z.string().min(1).max(100),
  clientName: z.string().max(100).nullable(),
  description: z.string().max(1_000).nullable(),
  status: ProjectStatusSchema,
  startsOn: DateSchema.nullable(),
  endsOn: DateSchema.nullable(),
  version: VersionSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

export const ProjectCreateRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(100),
    clientName: z.string().trim().max(100).nullable().optional(),
    description: z.string().trim().max(1_000).nullable().optional(),
    startsOn: DateSchema.nullable().optional(),
    endsOn: DateSchema.nullable().optional(),
  })
  .refine(orderedDates, { message: "Project end date precedes start date" });
export type ProjectCreateRequest = z.infer<
  typeof ProjectCreateRequestSchema
>;

export const ProjectUpdateRequestSchema = z
  .strictObject({
    expectedVersion: VersionSchema,
    name: z.string().trim().min(1).max(100).optional(),
    clientName: z.string().trim().max(100).nullable().optional(),
    description: z.string().trim().max(1_000).nullable().optional(),
    status: z.enum(["active", "completed"]).optional(),
    startsOn: DateSchema.nullable().optional(),
    endsOn: DateSchema.nullable().optional(),
  })
  .refine(
    (value) =>
      value.name !== undefined ||
      value.clientName !== undefined ||
      value.description !== undefined ||
      value.status !== undefined ||
      value.startsOn !== undefined ||
      value.endsOn !== undefined,
    { message: "At least one project change is required" },
  )
  .refine(orderedDates, { message: "Project end date precedes start date" });
export type ProjectUpdateRequest = z.infer<
  typeof ProjectUpdateRequestSchema
>;

export const ProjectArchiveRequestSchema = z.strictObject({
  expectedVersion: VersionSchema,
});
export type ProjectArchiveRequest = z.infer<typeof ProjectArchiveRequestSchema>;

export const ProjectListSchema = z.strictObject({ items: z.array(ProjectSchema) });
export type ProjectList = z.infer<typeof ProjectListSchema>;

export const ProjectCollectionParamsSchema = z.strictObject({
  tenantId: z.uuid(),
  businessId: z.uuid(),
});
export type ProjectCollectionParams = z.infer<
  typeof ProjectCollectionParamsSchema
>;

export const ProjectParamsSchema = ProjectCollectionParamsSchema.extend({
  projectId: z.uuid(),
});
export type ProjectParams = z.infer<typeof ProjectParamsSchema>;

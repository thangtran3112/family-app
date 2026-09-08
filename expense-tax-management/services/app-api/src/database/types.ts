import type { ColumnType, Generated } from "kysely";

export type JsonValue =
  | boolean
  | number
  | string
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ServiceMetadataTable {
  readonly key: string;
  readonly value: JsonValue;
  readonly updated_at: Generated<Date>;
}

type Timestamp = ColumnType<Date, Date | string, Date | string>;
type GeneratedTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type NullableText = ColumnType<
  string | null,
  string | null | undefined,
  string | null
>;
type NullableDate = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type MoneyAmount = ColumnType<string, string | number, string>;

export interface UserTable {
  readonly id: string;
  primary_email: string;
  display_name: string;
  status: "active" | "disabled";
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface AuthIdentityTable {
  readonly id: string;
  readonly user_id: string;
  issuer: string;
  subject: string;
  verified_email: string;
  email_verified: boolean;
  last_authenticated_at: GeneratedTimestamp;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface TenantTable {
  readonly id: string;
  name: string;
  readonly slug: string;
  status: "active" | "archived";
  version: Generated<number>;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  archived_at: NullableTimestamp;
}

export interface TenantMembershipTable {
  readonly tenant_id: string;
  readonly user_id: string;
  role: "owner" | "admin" | "member";
  status: "active" | "inactive";
  version: Generated<number>;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PersonalProfileTable {
  readonly id: string;
  readonly tenant_id: string;
  name: string;
  version: Generated<number>;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface PersonalMembershipTable {
  readonly personal_profile_id: string;
  readonly tenant_id: string;
  readonly user_id: string;
  role: "owner" | "editor" | "viewer";
  status: "active" | "inactive";
  version: Generated<number>;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface TenantInvitationTable {
  readonly id: string;
  readonly tenant_id: string;
  normalized_email: string;
  tenant_role: "owner" | "admin" | "member";
  personal_profile_id: string | null;
  personal_role: "owner" | "editor" | "viewer" | null;
  business_id: NullableText;
  business_role: ColumnType<
    "owner" | "editor" | "viewer" | null,
    "owner" | "editor" | "viewer" | null | undefined,
    "owner" | "editor" | "viewer" | null
  >;
  readonly token_hash: string;
  expires_at: Timestamp;
  accepted_at: NullableTimestamp;
  revoked_at: NullableTimestamp;
  readonly created_by_user_id: string;
  accepted_by_user_id: string | null;
  readonly created_at: GeneratedTimestamp;
}

export interface BusinessIndustryTable {
  readonly code: string;
  name: string;
  status: "active" | "inactive";
  readonly created_at: GeneratedTimestamp;
}

export interface SpendingCategoryTemplateTable {
  readonly template_key: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  readonly created_at: GeneratedTimestamp;
}

export interface IndustrySpendingCategoryTemplateTable {
  readonly industry_code: string;
  readonly template_key: string;
  sort_order: number;
}

export interface BusinessTable {
  readonly id: string;
  readonly tenant_id: string;
  name: string;
  industry_code: string;
  timezone: string;
  base_currency: string;
  status: "active" | "archived";
  version: Generated<number>;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  archived_at: NullableTimestamp;
}

export interface BusinessMembershipTable {
  readonly business_id: string;
  readonly tenant_id: string;
  readonly user_id: string;
  role: "owner" | "editor" | "viewer";
  status: "active" | "inactive";
  version: Generated<number>;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface SpendingCategoryTable {
  readonly id: string;
  readonly tenant_id: string;
  readonly template_key: NullableText;
  name: string;
  description: NullableText;
  color: string;
  icon: string;
  status: "active" | "archived";
  version: Generated<number>;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  archived_at: NullableTimestamp;
}

export interface ProjectTable {
  readonly id: string;
  readonly tenant_id: string;
  readonly business_id: string;
  name: string;
  client_name: NullableText;
  description: NullableText;
  status: "active" | "completed" | "archived";
  starts_on: NullableDate;
  ends_on: NullableDate;
  version: Generated<number>;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  archived_at: NullableTimestamp;
}

export interface TaxonomyVersionTable {
  readonly id: string;
  readonly jurisdiction_code: "US-FEDERAL";
  readonly tax_year: number;
  readonly code: string;
  name: string;
  status: "active" | "superseded";
  source_url: string;
  source_revision: string;
  source_checksum: string;
  readonly created_at: GeneratedTimestamp;
}

export interface TaxCategoryDefinitionTable {
  readonly id: string;
  readonly taxonomy_version_id: string;
  code: string;
  name: string;
  description: NullableText;
  official_form: NullableText;
  official_line: NullableText;
  status: "active" | "inactive";
  sort_order: number;
}

export interface ExpenseTable {
  readonly id: string;
  readonly tenant_id: string;
  readonly created_by_user_id: string;
  personal_profile_id: NullableText;
  business_id: NullableText;
  project_id: NullableText;
  spending_category_id: NullableText;
  merchant: string;
  description: NullableText;
  amount: MoneyAmount;
  currency: string;
  incurred_on: NullableDate;
  readonly tax_year: Generated<number>;
  source: "manual";
  status: "draft" | "ready" | "archived";
  version: Generated<number>;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
  archived_at: NullableTimestamp;
}

export interface BusinessTaxProfileTable {
  readonly id: string;
  readonly tenant_id: string;
  readonly business_id: string;
  tax_year: number;
  taxonomy_version_id: string;
  tax_form: "schedule_c";
  accounting_method: "cash" | "accrual";
  status: "draft" | "active" | "closed";
  version: Generated<number>;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface ExpenseTaxTreatmentTable {
  readonly expense_id: string;
  readonly tenant_id: string;
  readonly business_id: string;
  readonly tax_year: number;
  business_tax_profile_id: string;
  taxonomy_version_id: string;
  tax_category_definition_id: string;
  deductible_percent: MoneyAmount;
  review_status: "unreviewed" | "reviewed" | "excluded";
  note: NullableText;
  version: Generated<number>;
  readonly created_by_user_id: string;
  updated_by_user_id: string;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface AppAuditEventTable {
  readonly id: string;
  readonly tenant_id: string | null;
  readonly actor_user_id: string | null;
  readonly actor_service_principal: string | null;
  readonly action: string;
  readonly outcome: "success" | "denied" | "failure";
  readonly resource_type: string;
  readonly resource_id: string | null;
  readonly request_id: string;
  readonly metadata: Generated<JsonValue>;
  readonly created_at: GeneratedTimestamp;
}

export interface IdempotencyRecordTable {
  readonly id: string;
  readonly actor_key: string;
  readonly operation_key: string;
  readonly idempotency_key: string;
  readonly request_hash: string;
  readonly response_status: number;
  readonly response_body: JsonValue;
  readonly resource_type: string | null;
  readonly resource_id: string | null;
  readonly expires_at: Timestamp;
  readonly created_at: GeneratedTimestamp;
}

export interface AppDatabase {
  readonly "app.service_metadata": ServiceMetadataTable;
  readonly "app.users": UserTable;
  readonly "app.auth_identities": AuthIdentityTable;
  readonly "app.tenants": TenantTable;
  readonly "app.tenant_memberships": TenantMembershipTable;
  readonly "app.personal_profiles": PersonalProfileTable;
  readonly "app.personal_memberships": PersonalMembershipTable;
  readonly "app.tenant_invitations": TenantInvitationTable;
  readonly "app.business_industries": BusinessIndustryTable;
  readonly "app.spending_category_templates": SpendingCategoryTemplateTable;
  readonly "app.industry_spending_category_templates": IndustrySpendingCategoryTemplateTable;
  readonly "app.businesses": BusinessTable;
  readonly "app.business_memberships": BusinessMembershipTable;
  readonly "app.spending_categories": SpendingCategoryTable;
  readonly "app.projects": ProjectTable;
  readonly "app.taxonomy_versions": TaxonomyVersionTable;
  readonly "app.tax_category_definitions": TaxCategoryDefinitionTable;
  readonly "app.expenses": ExpenseTable;
  readonly "app.business_tax_profiles": BusinessTaxProfileTable;
  readonly "app.expense_tax_treatments": ExpenseTaxTreatmentTable;
  readonly "app.app_audit_events": AppAuditEventTable;
  readonly "app.idempotency_records": IdempotencyRecordTable;
}

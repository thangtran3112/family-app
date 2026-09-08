import type { ColumnType, Generated } from "kysely";

export type JsonValue =
  | boolean
  | number
  | string
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type GeneratedTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
type NullableText = ColumnType<
  string | null,
  string | null | undefined,
  string | null
>;

export interface ServiceMetadataTable {
  readonly key: string;
  readonly value: JsonValue;
  readonly updated_at: Generated<Date>;
}

export interface ProviderSecretTable {
  readonly id: string;
  readonly value: string;
  readonly created_at: GeneratedTimestamp;
}

export interface ProviderConnectionTable {
  readonly id: string;
  readonly key: string;
  provider_kind: "openai" | "openrouter" | "anthropic" | "google" | "paddleocr";
  display_name: string;
  secret_reference: string;
  status: Generated<"active" | "disabled">;
  readonly created_at: GeneratedTimestamp;
  updated_at: GeneratedTimestamp;
}

export interface AiModelTable {
  readonly id: string;
  readonly provider_connection_id: string;
  readonly provider_model_id: string;
  metered_model_key: string;
  status: Generated<"active" | "disabled">;
  readonly created_at: GeneratedTimestamp;
}

export interface AiModeTable {
  readonly id: string;
  readonly key: string;
  display_name: string;
  description: NullableText;
  readonly operation: "RECEIPT_OCR" | "AI_SEARCH";
  status: Generated<"active" | "disabled">;
  readonly created_at: GeneratedTimestamp;
}

export interface AiModeRouteVersionTable {
  readonly id: string;
  readonly ai_mode_id: string;
  readonly version_number: number;
  readonly ai_model_id: string;
  is_current: Generated<boolean>;
  readonly created_at: GeneratedTimestamp;
}

export interface FoundryAuditEventTable {
  readonly id: string;
  actor_platform_subject: NullableText;
  actor_service_principal: NullableText;
  readonly action: string;
  readonly outcome: "success" | "denied" | "failure";
  readonly resource_type: string;
  resource_id: NullableText;
  readonly request_id: string;
  readonly metadata: JsonValue;
  readonly created_at: GeneratedTimestamp;
}

export interface FoundryDatabase {
  readonly "foundry.service_metadata": ServiceMetadataTable;
  readonly "foundry.provider_secrets": ProviderSecretTable;
  readonly "foundry.provider_connections": ProviderConnectionTable;
  readonly "foundry.ai_models": AiModelTable;
  readonly "foundry.ai_modes": AiModeTable;
  readonly "foundry.ai_mode_route_versions": AiModeRouteVersionTable;
  readonly "foundry.foundry_audit_events": FoundryAuditEventTable;
}

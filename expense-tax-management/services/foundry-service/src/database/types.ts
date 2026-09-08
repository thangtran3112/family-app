import type { Generated } from "kysely";

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

export interface FoundryDatabase {
  readonly "foundry.service_metadata": ServiceMetadataTable;
}

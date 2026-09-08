import { randomUUID } from "node:crypto";

import type { Kysely } from "kysely";

import type { FoundryDatabase } from "../database/types.js";

/**
 * Secret boundary for provider credentials (design doc §11.4: "Secret
 * values never cross Foundry execution/read APIs... Operator credential
 * updates use write-only request fields... and redacted responses").
 *
 * `store()` accepts a raw secret value and returns an opaque reference;
 * `exists()` only confirms a reference is still valid (used to validate
 * catalog CRUD requests, e.g. secret rotation). Deliberately no
 * `retrieve()` in this interface -- nothing in the Wave A catalog needs
 * the raw value back. A retrieval path is added when the execution
 * handoff (Wave B reservations / Phase 0L worker) actually needs to hand
 * a Secret Manager reference to a worker, keeping today's surface
 * minimal.
 *
 * This default implementation is Postgres-backed (local to this
 * service's own database, not shared, not logged -- see
 * `providerApiKey`/`providerCredentials` in app.ts's log redaction
 * list). GCP is infra-gated; swap this for a Secret Manager-backed
 * implementation of the same interface when that gate opens, matching
 * Phase 0D's local/GCS storage-adapter boundary philosophy. No caller
 * outside this module should depend on how references are structured.
 */
export interface SecretStore {
  store(value: string): Promise<string>;
  exists(reference: string): Promise<boolean>;
}

export function createPostgresSecretStore(
  database: Kysely<FoundryDatabase>,
): SecretStore {
  return {
    async store(value) {
      const id = randomUUID();
      await database
        .insertInto("foundry.provider_secrets")
        .values({ id, value })
        .execute();
      return id;
    },
    async exists(reference) {
      const row = await database
        .selectFrom("foundry.provider_secrets")
        .select("id")
        .where("id", "=", reference)
        .executeTakeFirst();
      return row !== undefined;
    },
  };
}

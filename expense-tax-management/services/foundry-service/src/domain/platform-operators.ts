import type { Kysely } from "kysely";
import type { FoundryDatabase } from "../database/types.js";

export interface PlatformOperatorDomain {
  hasRole(subject: string, role: string): Promise<boolean>;
}

export function createPlatformOperatorDomain(
  database: Kysely<FoundryDatabase>,
): PlatformOperatorDomain {
  return {
    async hasRole(subject, role) {
      const identity = await database
        .selectFrom("foundry.platform_operator_identities")
        .select("clerk_user_id")
        .where("clerk_user_id", "=", subject)
        .where("role", "=", role)
        .where("status", "=", "active")
        .executeTakeFirst();
      return identity !== undefined;
    },
  };
}

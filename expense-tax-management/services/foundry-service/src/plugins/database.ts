import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import type { FoundryDatabase } from "../database/types.js";

export type DatabaseReadinessProbe = () => Promise<void>;

export interface DatabasePluginOptions {
  readonly database: Kysely<FoundryDatabase>;
  readonly readinessProbe?: DatabaseReadinessProbe;
  readonly destroyOnClose?: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    database: Kysely<FoundryDatabase>;
    databaseReadinessProbe: DatabaseReadinessProbe;
  }
}

export function registerDatabasePlugin(
  app: FastifyInstance,
  options: DatabasePluginOptions,
): void {
  const readinessProbe =
    options.readinessProbe ??
    (async () => {
      await sql`select 1`.execute(options.database);
    });

  app.decorate("database", options.database);
  app.decorate("databaseReadinessProbe", readinessProbe);

  if (options.destroyOnClose) {
    app.addHook("onClose", async () => {
      await options.database.destroy();
    });
  }
}

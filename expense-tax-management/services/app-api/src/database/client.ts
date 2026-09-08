import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { AppDatabase } from "./types.js";

const RUNTIME_POOL_MAX_CONNECTIONS = 10;
const RUNTIME_POOL_IDLE_TIMEOUT_MS = 30_000;
const RUNTIME_POOL_CONNECTION_TIMEOUT_MS = 5_000;

export function createAppDatabase(databaseUrl: string): Kysely<AppDatabase> {
  return new Kysely<AppDatabase>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: databaseUrl,
        max: RUNTIME_POOL_MAX_CONNECTIONS,
        idleTimeoutMillis: RUNTIME_POOL_IDLE_TIMEOUT_MS,
        connectionTimeoutMillis: RUNTIME_POOL_CONNECTION_TIMEOUT_MS,
      }),
    }),
  });
}

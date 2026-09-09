import { createLocalStorageAdapter } from "./local.js";
import type { StorageAdapter } from "./types.js";

export interface StorageFactoryConfig {
  readonly backend: string;
  readonly localDir: string;
  readonly baseUrl: string;
  readonly urlSigningKey: string;
}

export function createStorageAdapter(
  config: StorageFactoryConfig,
): StorageAdapter {
  if (config.backend === "local") {
    return createLocalStorageAdapter({
      rootDir: config.localDir,
      baseUrl: config.baseUrl,
      signingKey: config.urlSigningKey,
    });
  }
  if (config.backend === "gcs") {
    throw new Error(
      "GCS storage backend is not configured until the GCP infrastructure gate: no credentials exist in this environment, and shipping an unverifiable GCS implementation would violate this repo's TDD bar. See plans/sub-plans/phase-0d-uploads-storage-implementation.md.",
    );
  }
  throw new Error(`Unknown storage backend: ${config.backend}`);
}

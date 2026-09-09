import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { createContentSignature, toEpochSec } from "./signing.js";
import type {
  IssueReadUrlInput,
  IssueUploadTargetInput,
  ObjectStat,
  StorageAdapter,
  WriteObjectInput,
} from "./types.js";

export interface LocalStorageConfig {
  readonly rootDir: string;
  readonly baseUrl: string;
  readonly signingKey: string;
}

function resolveObjectPath(rootDir: string, storageKey: string): string {
  if (!storageKey || storageKey.startsWith("/") || storageKey.includes("..")) {
    throw new Error("Invalid storage key");
  }
  const resolved = path.resolve(rootDir, storageKey);
  const root = path.resolve(rootDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("Invalid storage key");
  }
  return resolved;
}

function contentUrl(
  baseUrl: string,
  signingKey: string,
  method: "PUT" | "GET",
  fileId: string,
  expiresAt: Date,
): string {
  const expiresEpochSec = toEpochSec(expiresAt);
  const signature = createContentSignature({
    signingKey,
    method,
    fileId,
    expiresEpochSec,
  });
  return `${baseUrl.replace(/\/$/, "")}/api/v1/file-content/${fileId}?expires=${expiresEpochSec}&signature=${signature}`;
}

export function createLocalStorageAdapter(
  config: LocalStorageConfig,
): StorageAdapter {
  return {
    async issueUploadTarget(input: IssueUploadTargetInput) {
      return {
        url: contentUrl(
          config.baseUrl,
          config.signingKey,
          "PUT",
          input.fileId,
          input.expiresAt,
        ),
        requiredHeaders: { "Content-Type": input.contentType },
      };
    },

    async issueReadUrl(input: IssueReadUrlInput) {
      return {
        url: contentUrl(
          config.baseUrl,
          config.signingKey,
          "GET",
          input.fileId,
          input.expiresAt,
        ),
      };
    },

    async statObject(storageKey: string): Promise<ObjectStat | null> {
      const objectPath = resolveObjectPath(config.rootDir, storageKey);
      try {
        const stats = await stat(objectPath);
        if (!stats.isFile()) return null;
        return { exists: true, sizeBytes: stats.size };
      } catch (error: unknown) {
        if ((error as { code?: string }).code === "ENOENT") return null;
        throw error;
      }
    },

    async readObject(storageKey: string): Promise<Buffer> {
      return readFile(resolveObjectPath(config.rootDir, storageKey));
    },

    async writeObject(input: WriteObjectInput): Promise<void> {
      const objectPath = resolveObjectPath(config.rootDir, input.storageKey);
      await mkdir(path.dirname(objectPath), { recursive: true });
      await writeFile(objectPath, input.data);
    },

    async deleteObject(storageKey: string): Promise<void> {
      try {
        await unlink(resolveObjectPath(config.rootDir, storageKey));
      } catch (error: unknown) {
        if ((error as { code?: string }).code === "ENOENT") return;
        throw error;
      }
    },
  };
}

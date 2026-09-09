export type SignedContentMethod = "PUT" | "GET";

export interface IssueUploadTargetInput {
  readonly fileId: string;
  readonly storageKey: string;
  readonly contentType: string;
  readonly expiresAt: Date;
}

export interface UploadTarget {
  readonly url: string;
  readonly requiredHeaders: Readonly<Record<string, string>>;
}

export interface IssueReadUrlInput {
  readonly fileId: string;
  readonly storageKey: string;
  readonly expiresAt: Date;
}

export interface ObjectStat {
  readonly exists: true;
  readonly sizeBytes: number;
}

export interface WriteObjectInput {
  readonly storageKey: string;
  readonly data: Buffer;
  readonly contentType: string;
}

/**
 * Storage adapter boundary. Shaped like GCS semantics (signed URLs with
 * expiry, stat/head, delete) so a future GCS implementation slots in
 * without changing the domain. URL issuance takes both fileId and
 * storageKey: GCS-style backends sign the storageKey directly and ignore
 * fileId; the local backend serves bytes through App API's own
 * bearer-free content routes, which address objects by fileId (never a
 * raw storage key in the URL path, so clients can't traverse the bucket).
 */
export interface StorageAdapter {
  issueUploadTarget(input: IssueUploadTargetInput): Promise<UploadTarget>;
  issueReadUrl(input: IssueReadUrlInput): Promise<{ readonly url: string }>;
  statObject(storageKey: string): Promise<ObjectStat | null>;
  readObject(storageKey: string): Promise<Buffer>;
  writeObject(input: WriteObjectInput): Promise<void>;
  deleteObject(storageKey: string): Promise<void>;
}

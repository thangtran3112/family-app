import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface VerificationNotifier {
  send(input: { readonly senderId: string; readonly email: string; readonly token: string }): Promise<void>;
}

/** Local credential-free challenge delivery: one 0600 file per sender under
 * /tmp (or configured dir). Never logs or returns the token through API. */
export function createLocalVerificationNotifier(directory: string): VerificationNotifier {
  return {
    async send(input) {
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, `${input.senderId}.txt`), input.token, {
        encoding: "utf8",
        mode: 0o600,
      });
    },
  };
}

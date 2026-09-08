import createClient from "openapi-fetch";
import type { paths } from "../../generated/typescript/app-api.paths.js";

export function createAppApiClient(baseUrl: string) {
  return createClient<paths>({ baseUrl });
}

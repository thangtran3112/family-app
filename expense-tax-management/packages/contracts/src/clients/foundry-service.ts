import createClient from "openapi-fetch";
import type { paths } from "../../generated/typescript/foundry-service.paths.js";

export function createFoundryServiceClient(baseUrl: string) {
  return createClient<paths>({ baseUrl });
}

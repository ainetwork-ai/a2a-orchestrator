import { createAinStateStore } from "../storage/config";
import { createAinStoreStateClient } from "../storage/ain-store-state-client";
import type { StateClient } from "../storage/state-client";
export type { StateClient } from "../storage/state-client";

let stateClient: StateClient | null = null;
export function rethrowAuthoritativeStateError(error: unknown): never {
  throw error;
}
export async function initStateStore(): Promise<StateClient> {
  if (stateClient) return stateClient;
  const backend = process.env.STATE_BACKEND ?? "ain-blockchain";
  if (backend === "redis") {
    throw Error("Redis state is deprecated. Use STATE_BACKEND=ain-store or ain-blockchain.");
  }
  if (backend === "ain-store") {
    // Documents in this project's AIN Store (bodies on AinDrive, write records + MMR on chain).
    stateClient = await createAinStoreStateClient(process.env.AIN_STORE_CONFIG ?? "");
    return stateClient;
  }
  if (backend !== "ain-blockchain") throw Error(`Unsupported STATE_BACKEND: ${backend}`);
  stateClient = await createAinStateStore(process.env.AIN_STATE_CONFIG ?? "");
  return stateClient;
}
export function getStateClient(): StateClient {
  if (!stateClient) throw Error("State client not initialized. Call initStateStore() first.");
  return stateClient;
}
export async function closeStateStore(): Promise<void> {
  if (stateClient) {
    await stateClient.quit();
    stateClient = null;
  }
}


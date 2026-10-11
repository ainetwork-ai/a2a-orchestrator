import { createClient } from "redis";
import { createAinStateStore } from "../storage/config";
import type { StateClient } from "../storage/state-client";

export type RedisClient = StateClient;

let redisClient: RedisClient | null = null;
export function rethrowAuthoritativeStateError(error: unknown): void {
  if (process.env.STATE_BACKEND === "ain-blockchain") throw error;
}

export async function initRedis(): Promise<RedisClient> {
  if (redisClient) {
    return redisClient;
  }

  const backend = process.env.STATE_BACKEND ?? "redis";
  if (backend === "ain-blockchain") {
    // No fallback: an unavailable chain or invalid organization configuration
    // must never silently persist conversations to the previous datastore.
    const client = await createAinStateStore(process.env.AIN_STATE_CONFIG ?? "");
    redisClient = client;
    return client;
  }
  if (backend !== "redis") throw Error("Unsupported STATE_BACKEND");
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

  const client = createClient({
    url: redisUrl,
  });

  client.on("error", (err) => {
    console.error("Redis Client Error:", err);
  });

  client.on("connect", () => {
    console.log("✅ Redis connected");
  });

  await client.connect();
  redisClient = client;

  return redisClient;
}

export function getRedisClient(): RedisClient {
  if (!redisClient) {
    throw new Error("Redis client not initialized. Call initRedis() first.");
  }
  return redisClient;
}

export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

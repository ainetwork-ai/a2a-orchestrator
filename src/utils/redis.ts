import { createClient } from "redis";

export type RedisClient = ReturnType<typeof createClient>;

let redisClient: RedisClient | null = null;

export async function initRedis(): Promise<RedisClient> {
  if (redisClient) {
    return redisClient;
  }

  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

  redisClient = createClient({
    url: redisUrl,
  });

  redisClient.on("error", (err) => {
    console.error("Redis Client Error:", err);
  });

  redisClient.on("connect", () => {
    console.log("✅ Redis connected");
  });

  await redisClient.connect();

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

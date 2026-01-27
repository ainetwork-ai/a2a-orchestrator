/**
 * Embedder for TRD 12: Embedding-based Clustering Pipeline
 *
 * Generates embeddings for messages using OpenAI's text-embedding-3-small model
 * with Redis caching for efficiency.
 */

import crypto from "crypto";
import { getRedisClient } from "../../utils/redis";
import { ParsedMessage } from "../../types/report";
import {
  EmbeddedMessage,
  EmbedderResult,
  EmbedFunction,
  EMBEDDING_CONFIG,
} from "../../types/embedding";

/**
 * Create an OpenAI embedder function
 * Uses dependency injection pattern for testability
 */
export function createOpenAIEmbedder(apiKey: string): EmbedFunction {
  return async (texts: string[]): Promise<number[][]> => {
    // Dynamic import to avoid issues if openai is not installed
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey });

    const response = await openai.embeddings.create({
      model: EMBEDDING_CONFIG.model,
      input: texts,
    });

    return response.data.map((d) => d.embedding);
  };
}

/**
 * Generate SHA256 hash of content (first 16 characters)
 */
export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Generate embeddings for messages with Redis caching
 *
 * @param messages - Messages to embed
 * @param embedFn - Function to generate embeddings (dependency injection)
 * @returns Embedded messages with cache statistics
 */
export async function embedMessages(
  messages: ParsedMessage[],
  embedFn: EmbedFunction
): Promise<EmbedderResult> {
  if (messages.length === 0) {
    return {
      messages: [],
      cacheHits: 0,
      newEmbeddings: 0,
    };
  }

  const redis = getRedisClient();
  const results: EmbeddedMessage[] = new Array(messages.length);
  const toEmbed: { index: number; message: ParsedMessage; hash: string }[] = [];
  let cacheHits = 0;

  // Generate hashes for all messages
  const hashes = messages.map((msg) => hashContent(msg.content));
  const cacheKeys = hashes.map((h) => `${EMBEDDING_CONFIG.cachePrefix}${h}`);

  // Batch cache lookup using mGet
  const cachedValues = await redis.mGet(cacheKeys);

  // Process cache results
  for (let i = 0; i < messages.length; i++) {
    const cached = cachedValues[i];
    if (cached) {
      try {
        const embedding = JSON.parse(cached) as number[];
        results[i] = { ...messages[i], embedding };
        cacheHits++;
      } catch {
        // Invalid cache entry, re-embed
        toEmbed.push({ index: i, message: messages[i], hash: hashes[i] });
      }
    } else {
      toEmbed.push({ index: i, message: messages[i], hash: hashes[i] });
    }
  }

  console.log(
    `[Embedder] Cache: ${cacheHits} hits, ${toEmbed.length} misses (${messages.length} total)`
  );

  // Batch embed new messages
  const batchSize = EMBEDDING_CONFIG.batchSize;
  for (let i = 0; i < toEmbed.length; i += batchSize) {
    const batch = toEmbed.slice(i, i + batchSize);
    const texts = batch.map((b) => b.message.content);
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(toEmbed.length / batchSize);

    console.log(`[Embedder] Generating embeddings: batch ${batchNum}/${totalBatches}`);

    try {
      const embeddings = await embedFn(texts);

      // Store results and prepare cache entries
      const pipeline = redis.multi();
      for (let j = 0; j < batch.length; j++) {
        const { index, message, hash } = batch[j];
        const embedding = embeddings[j];

        results[index] = { ...message, embedding };

        // Add to cache pipeline
        const cacheKey = `${EMBEDDING_CONFIG.cachePrefix}${hash}`;
        pipeline.setEx(cacheKey, EMBEDDING_CONFIG.cacheTTLSeconds, JSON.stringify(embedding));
      }

      // Execute cache writes in batch
      await pipeline.exec();
    } catch (error) {
      console.error(`[Embedder] Error embedding batch ${batchNum}:`, error);
      throw error;
    }
  }

  console.log(
    `[Embedder] Complete: ${cacheHits} cached, ${toEmbed.length} new embeddings`
  );

  return {
    messages: results,
    cacheHits,
    newEmbeddings: toEmbed.length,
  };
}

/**
 * Get embedding for a single text (used for category embeddings)
 */
export async function embedSingleText(
  text: string,
  embedFn: EmbedFunction
): Promise<number[]> {
  const embeddings = await embedFn([text]);
  return embeddings[0];
}

/**
 * Get embeddings for multiple texts (without caching, for category embeddings)
 */
export async function embedTexts(
  texts: string[],
  embedFn: EmbedFunction
): Promise<number[][]> {
  return embedFn(texts);
}

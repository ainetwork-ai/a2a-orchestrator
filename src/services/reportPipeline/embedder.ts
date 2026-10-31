/**
 * Embedder for TRD 12: Embedding-based Clustering Pipeline
 *
 * Generates embeddings for messages using OpenAI or Azure OpenAI,
 * cached in process memory.
 *
 * The cache deliberately stays off the state store: organization state lives on
 * AIN Blockchain, where a 1536-float vector costs ~160 KB of state and a single
 * large report could exhaust the free-tier state budget shared by every app.
 * Embeddings are cheap to recompute; a restart only costs one re-embedding pass.
 */

import crypto from "crypto";
import { ParsedMessage } from "../../types/report";
import {
  EmbeddedMessage,
  EmbedderResult,
  EmbedFunction,
  EMBEDDING_CONFIG,
} from "../../types/embedding";

/**
 * Azure OpenAI configuration
 */
export interface AzureOpenAIConfig {
  baseUrl: string;
  apiKey: string;
  apiVersion: string;
  deploymentName: string;
}

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
 * Create an Azure OpenAI embedder function
 */
export function createAzureOpenAIEmbedder(config: AzureOpenAIConfig): EmbedFunction {
  return async (texts: string[]): Promise<number[][]> => {
    const { default: OpenAI } = await import("openai");

    // Azure OpenAI uses a different base URL format
    const openai = new OpenAI({
      apiKey: config.apiKey,
      baseURL: `${config.baseUrl}/openai/deployments/${config.deploymentName}`,
      defaultQuery: { "api-version": config.apiVersion },
      defaultHeaders: { "api-key": config.apiKey },
    });

    const response = await openai.embeddings.create({
      model: config.deploymentName, // Azure uses deployment name as model
      input: texts,
    });

    return response.data.map((d) => d.embedding);
  };
}

/** Least-recently-used embedding cache keyed by content hash. */
const embeddingCache = new Map<string, Float32Array>();
const cacheEntries = () => Number(process.env.EMBEDDING_CACHE_ENTRIES ?? EMBEDDING_CONFIG.cacheEntries);
function cacheGet(hash: string): number[] | null {
  const vector = embeddingCache.get(hash);
  if (!vector) return null;
  embeddingCache.delete(hash);
  embeddingCache.set(hash, vector);
  return Array.from(vector);
}
function cacheSet(hash: string, embedding: number[]): void {
  embeddingCache.delete(hash);
  embeddingCache.set(hash, Float32Array.from(embedding));
  for (const oldest of embeddingCache.keys()) {
    if (embeddingCache.size <= cacheEntries()) break;
    embeddingCache.delete(oldest);
  }
}
export function clearEmbeddingCache(): void { embeddingCache.clear(); }

/**
 * Generate SHA256 hash of content (first 16 characters)
 */
export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Generate embeddings for messages, reusing cached vectors
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

  const results: EmbeddedMessage[] = new Array(messages.length);
  const toEmbed: { index: number; message: ParsedMessage; hash: string }[] = [];
  let cacheHits = 0;

  // Generate hashes for all messages
  const hashes = messages.map((msg) => hashContent(msg.content));

  for (let i = 0; i < messages.length; i++) {
    const embedding = cacheGet(hashes[i]);
    if (embedding) {
      results[i] = { ...messages[i], embedding };
      cacheHits++;
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

      for (let j = 0; j < batch.length; j++) {
        const { index, message, hash } = batch[j];
        const embedding = embeddings[j];
        results[index] = { ...message, embedding };
        cacheSet(hash, embedding);
      }
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

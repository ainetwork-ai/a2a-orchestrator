/**
 * Embedding-related types for TRD 12: Embedding-based Clustering Pipeline
 */

import { ParsedMessage } from "./report";

/**
 * Message with embedding vector
 */
export interface EmbeddedMessage extends ParsedMessage {
  embedding: number[];
}

/**
 * Result of embedding generation
 */
export interface EmbedderResult {
  messages: EmbeddedMessage[];
  cacheHits: number;
  newEmbeddings: number;
}

/**
 * Function type for embedding generation (dependency injection)
 */
export type EmbedFunction = (texts: string[]) => Promise<number[][]>;

/**
 * Point data for cluster visualization
 */
export interface ClusterVisualizationPoint {
  id: string;
  x: number;
  y: number;
  clusterId: number;
}

/**
 * Visualization data from clusterer
 */
export interface ClustererVisualization {
  points: ClusterVisualizationPoint[];
}

/**
 * Configuration for embedding model
 */
export const EMBEDDING_CONFIG = {
  model: "text-embedding-3-small",
  dimensions: 1536,
  batchSize: 100,
  cacheTTLSeconds: 30 * 24 * 60 * 60, // 30 days
  cachePrefix: "emb:msg:",
} as const;


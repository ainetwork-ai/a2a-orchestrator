/**
 * Embedding-related types for TRD 12: Embedding-based Clustering Pipeline
 */

import { ParsedMessage, CategorizedMessage } from "./report";

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
 * Categorized message with embedding (for clustering)
 */
export interface CategorizedEmbeddedMessage extends CategorizedMessage {
  embedding: number[];
}

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
 * Result of clustering operation
 */
export interface EmbeddingClustererResult {
  clusters: import("./report").MessageCluster[];
  visualization: ClustererVisualization;
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

/**
 * Configuration for category embeddings
 */
export const CATEGORY_EMBEDDING_CONFIG = {
  cacheKey: "emb:categories:v1",
  cacheTTLSeconds: 7 * 24 * 60 * 60, // 7 days
} as const;

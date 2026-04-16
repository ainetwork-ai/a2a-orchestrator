/**
 * Embedding-based Clusterer for TRD 12
 *
 * Replaces LLM-based clustering with UMAP dimensionality reduction + K-means.
 * Provides deterministic, cacheable clustering with lower cost.
 */

import { UMAP } from "umap-js";
import { Topic, ParsedMessage } from "../../types/report";
import {
  EmbeddedMessage,
  ClustererVisualization,
} from "../../types/embedding";

/**
 * Internal Topic with messages — used during pipeline, stripped in final Report
 */
export interface PipelineTopic extends Topic {
  messages: ParsedMessage[];
}

export interface ClustererResult {
  clusters: PipelineTopic[];
  visualization: ClustererVisualization;
}

/**
 * Default configuration for clustering
 */
const CLUSTER_CONFIG = {
  defaultNumClusters: 8,
  minMessagesForClustering: 10,
  umapNComponents: 2,
  umapNNeighbors: 15,
  umapMinDist: 0.1,
  umapSpread: 1.0,
  kMeansMaxIterations: 100,
} as const;

/**
 * Cluster messages using UMAP + K-means
 *
 * @param messages - Categorized messages with embeddings
 * @param numClusters - Target number of clusters (default: 8)
 * @returns Clusters with visualization data
 */
export async function clusterByEmbedding(
  messages: EmbeddedMessage[],
  numClusters: number = CLUSTER_CONFIG.defaultNumClusters
): Promise<ClustererResult> {
  console.log(`[Clusterer] Starting clustering: ${messages.length} messages, target ${numClusters} clusters`);

  // Handle edge cases
  if (messages.length === 0) {
    return {
      clusters: [],
      visualization: { points: [] },
    };
  }

  if (messages.length < CLUSTER_CONFIG.minMessagesForClustering) {
    console.log(`[Clusterer] Too few messages (${messages.length}), creating single cluster`);
    return createSingleCluster(messages);
  }

  // Adjust cluster count if necessary
  const effectiveNumClusters = Math.min(numClusters, Math.floor(messages.length / 2));

  // 1. UMAP dimensionality reduction (1536D → 2D)
  console.log(`[Clusterer] Running UMAP dimensionality reduction...`);
  const embeddings = messages.map((m) => m.embedding);

  const umap = new UMAP({
    nComponents: CLUSTER_CONFIG.umapNComponents,
    nNeighbors: Math.min(CLUSTER_CONFIG.umapNNeighbors, messages.length - 1),
    minDist: CLUSTER_CONFIG.umapMinDist,
    spread: CLUSTER_CONFIG.umapSpread,
  });

  const reduced = umap.fit(embeddings);
  console.log(`[Clusterer] UMAP complete: ${reduced.length} points in 2D`);

  // 2. K-means clustering
  console.log(`[Clusterer] Running K-means with ${effectiveNumClusters} clusters...`);
  const clusterAssignments = kMeans(reduced, effectiveNumClusters);

  // 3. Group messages by cluster
  const clusterMap = new Map<number, Array<EmbeddedMessage & { x: number; y: number }>>();

  messages.forEach((msg, i) => {
    const clusterId = clusterAssignments[i];
    const [x, y] = reduced[i];

    if (!clusterMap.has(clusterId)) {
      clusterMap.set(clusterId, []);
    }

    clusterMap.get(clusterId)!.push({
      ...msg,
      x,
      y,
    });
  });

  // 4. Convert to PipelineTopic format (labels will be added by ClusterAnalyzer)
  const clusters: PipelineTopic[] = Array.from(clusterMap.entries())
    .filter(([_, msgs]) => msgs.length > 0)
    .map(([clusterId, msgs]) => ({
      id: `cluster-${clusterId}`,
      title: `Cluster ${clusterId + 1}`,
      description: "",
      messages: msgs,
      claims: [],
      summary: {
        text: "",
        sentiment: "neutral" as const,
      },
    }));

  // 5. Build visualization data
  const visualization: ClustererVisualization = {
    points: messages.map((msg, i) => ({
      id: msg.id,
      x: reduced[i][0],
      y: reduced[i][1],
      clusterId: clusterAssignments[i],
    })),
  };

  console.log(`[Clusterer] Complete: ${clusters.length} clusters created`);
  const clusterSizes = clusters.map((c) => `${c.title}(${c.messages.length})`).join(", ");
  console.log(`[Clusterer] Cluster sizes: ${clusterSizes}`);

  return { clusters, visualization };
}

/**
 * K-means clustering algorithm with deterministic seeding
 * Exported for reuse in subtopic clustering (TRD 13)
 */
export function kMeans(
  data: number[][],
  k: number,
  maxIterations: number = CLUSTER_CONFIG.kMeansMaxIterations
): number[] {
  const n = data.length;

  if (n === 0) return [];
  if (k >= n) {
    // Each point is its own cluster
    return data.map((_, i) => i);
  }

  // Deterministic initialization: select evenly spaced points
  const centroids: number[][] = [];
  const step = Math.floor(n / k);
  for (let i = 0; i < k; i++) {
    centroids.push([...data[i * step]]);
  }

  let assignments = new Array(n).fill(0);

  for (let iter = 0; iter < maxIterations; iter++) {
    // Assign each point to nearest centroid
    const newAssignments = data.map((point) => {
      let minDist = Infinity;
      let minIdx = 0;

      for (let c = 0; c < k; c++) {
        const dist = euclideanDistance(point, centroids[c]);
        if (dist < minDist) {
          minDist = dist;
          minIdx = c;
        }
      }

      return minIdx;
    });

    // Check for convergence
    if (arraysEqual(assignments, newAssignments)) {
      break;
    }
    assignments = newAssignments;

    // Update centroids
    for (let c = 0; c < k; c++) {
      const clusterPoints = data.filter((_, i) => assignments[i] === c);
      if (clusterPoints.length > 0) {
        const dim = data[0].length;
        centroids[c] = new Array(dim).fill(0).map((_, d) =>
          clusterPoints.reduce((sum, p) => sum + p[d], 0) / clusterPoints.length
        );
      }
    }
  }

  return assignments;
}

/**
 * Calculate Euclidean distance between two points
 */
function euclideanDistance(a: number[], b: number[]): number {
  return Math.sqrt(a.reduce((sum, val, i) => sum + (val - b[i]) ** 2, 0));
}

/**
 * Check if two arrays are equal
 */
function arraysEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Create a single cluster for small datasets
 */
function createSingleCluster(
  messages: EmbeddedMessage[]
): ClustererResult {
  const cluster: PipelineTopic = {
    id: "cluster-0",
    title: "All Messages",
    description: "",
    messages,
    claims: [],
    summary: {
      text: "",
      sentiment: "neutral",
    },
  };

  const visualization: ClustererVisualization = {
    points: messages.map((m, i) => ({
      id: m.id,
      x: i % 10, // Simple grid layout for small datasets
      y: Math.floor(i / 10),
      clusterId: 0,
    })),
  };

  return { clusters: [cluster], visualization };
}

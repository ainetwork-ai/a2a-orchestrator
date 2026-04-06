/**
 * Subtopic Clusterer for TRD 13: T3C-style Dot Grid Visualization
 *
 * Clusters messages within each topic into subtopics using K-means.
 * Calculates unique user counts for "N claims by M people" statistics.
 */

import {
  MessageCluster,
  Subtopic,
  MessageClusterWithSubtopics,
  ParsedMessage,
  CategorizedMessage,
} from "../../types/report";
import { CategorizedEmbeddedMessage } from "../../types/embedding";
import { kMeans } from "./clusterer";

/**
 * Subtopic clustering configuration
 */
const SUBTOPIC_CONFIG = {
  minMessagesForSubtopic: 20,  // Minimum messages to create subtopics
  minSubtopicSize: 3,          // Minimum messages per subtopic
  maxSubtopicCount: 10,        // Maximum number of subtopics
  messagesPerSubtopic: 20,     // Target messages per subtopic (for k calculation)
} as const;

/**
 * Count unique users based on threadId (Privacy-safe)
 * Same thread = same user assumption
 *
 * @param messages - Messages with threadId
 * @returns Number of unique users (threads)
 */
export function countUniqueUsers(messages: ParsedMessage[]): number {
  const uniqueThreads = new Set(messages.map((m) => m.threadId));
  return uniqueThreads.size;
}

/**
 * Count unique users for a subset of messages by IDs
 *
 * @param messageIds - IDs of messages to count
 * @param allMessages - All messages to look up threadId
 * @returns Number of unique users
 */
function countUniqueUsersByIds(
  messageIds: string[],
  allMessages: ParsedMessage[]
): number {
  const messageIdSet = new Set(messageIds);
  const relevantMessages = allMessages.filter((m) => messageIdSet.has(m.id));
  return countUniqueUsers(relevantMessages);
}

/**
 * Cluster messages within a topic into subtopics
 *
 * @param cluster - Original cluster with messages
 * @param embeddedMessages - All messages with embeddings (for K-means)
 * @returns Cluster with subtopics added
 */
export async function clusterSubtopics(
  cluster: MessageCluster,
  embeddedMessages: CategorizedEmbeddedMessage[]
): Promise<MessageClusterWithSubtopics> {
  const clusterMessageIds = new Set(cluster.messages.map((m) => m.id));

  // Filter embedded messages for this cluster
  const clusterEmbeddings = embeddedMessages.filter((m) =>
    clusterMessageIds.has(m.id)
  );

  // Calculate unique user count for the entire cluster
  const clusterUniqueUserCount = countUniqueUsers(
    cluster.messages as ParsedMessage[]
  );

  // Skip subtopic creation if too few messages
  if (clusterEmbeddings.length < SUBTOPIC_CONFIG.minMessagesForSubtopic) {
    console.log(
      `[SubtopicClusterer] Cluster "${cluster.topic}" has ${clusterEmbeddings.length} messages, skipping subtopic clustering`
    );
    return {
      ...cluster,
      subtopics: [],
      uniqueUserCount: clusterUniqueUserCount,
    };
  }

  // Calculate target number of subtopics
  const targetK = Math.min(
    Math.max(3, Math.floor(clusterEmbeddings.length / SUBTOPIC_CONFIG.messagesPerSubtopic)),
    SUBTOPIC_CONFIG.maxSubtopicCount
  );

  console.log(
    `[SubtopicClusterer] Clustering "${cluster.topic}" (${clusterEmbeddings.length} messages) into ${targetK} subtopics`
  );

  // Run K-means on the embeddings
  const embeddings = clusterEmbeddings.map((m) => m.embedding);
  const assignments = kMeans(embeddings, targetK);

  // Group messages by subtopic
  const subtopicMap = new Map<number, string[]>();
  clusterEmbeddings.forEach((msg, idx) => {
    const subtopicIdx = assignments[idx];
    if (!subtopicMap.has(subtopicIdx)) {
      subtopicMap.set(subtopicIdx, []);
    }
    subtopicMap.get(subtopicIdx)!.push(msg.id);
  });

  // Calculate centroids for each subtopic (average of UMAP coordinates if available)
  const subtopicCentroids = new Map<number, { x: number; y: number }>();

  // Create Subtopic objects
  const subtopics: Subtopic[] = Array.from(subtopicMap.entries())
    .filter(([_, ids]) => ids.length >= SUBTOPIC_CONFIG.minSubtopicSize)
    .sort((a, b) => b[1].length - a[1].length) // Sort by size descending
    .map(([_, messageIds], index) => ({
      id: `${cluster.id}-sub-${index}`,
      index, // For frontend color generation
      label: `Subtopic ${index + 1}`, // Will be updated by ClusterAnalyzer
      messageIds,
      messageCount: messageIds.length,
      uniqueUserCount: countUniqueUsersByIds(
        messageIds,
        cluster.messages as ParsedMessage[]
      ),
    }));

  console.log(
    `[SubtopicClusterer] Created ${subtopics.length} subtopics: ${subtopics
      .map((s) => `${s.label}(${s.messageCount})`)
      .join(", ")}`
  );

  return {
    ...cluster,
    subtopics,
    uniqueUserCount: clusterUniqueUserCount,
  };
}

/**
 * Add subtopics to all clusters
 *
 * @param clusters - Original clusters
 * @param embeddedMessages - All messages with embeddings
 * @returns Clusters with subtopics
 */
export async function addSubtopicsToAllClusters(
  clusters: MessageCluster[],
  embeddedMessages: CategorizedEmbeddedMessage[]
): Promise<MessageClusterWithSubtopics[]> {
  console.log(
    `[SubtopicClusterer] Processing ${clusters.length} clusters for subtopic clustering`
  );

  const results = await Promise.all(
    clusters.map((cluster) => clusterSubtopics(cluster, embeddedMessages))
  );

  const totalSubtopics = results.reduce((sum, c) => sum + c.subtopics.length, 0);
  console.log(
    `[SubtopicClusterer] Complete: ${totalSubtopics} subtopics across ${clusters.length} clusters`
  );

  return results;
}

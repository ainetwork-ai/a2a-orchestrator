/**
 * Dot Grid Generator for TRD 13: T3C-style Dot Grid Visualization
 *
 * Generates dot grid visualization data from clusters with subtopics.
 * Uses UMAP coordinates from the clusterer for point positioning.
 * Colors are NOT included - frontend generates colors from subtopicIndex.
 */

import {
  DotGridVisualization,
  TopicDotGrid,
  DotGridPoint,
  Bounds,
} from "../../types/visualization";
import {
  MessageClusterWithSubtopics,
  ParsedMessage,
} from "../../types/report";
import { ClustererVisualization } from "../../types/embedding";
import { countUniqueUsers } from "./subtopicClusterer";

/**
 * Calculate bounds from an array of points
 */
function calculateBounds(points: Array<{ x: number; y: number }>): Bounds {
  if (points.length === 0) {
    return { minX: 0, maxX: 1, minY: 0, maxY: 1 };
  }

  let minX = Infinity,
    maxX = -Infinity;
  let minY = Infinity,
    maxY = -Infinity;

  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  return { minX, maxX, minY, maxY };
}

/**
 * Normalize a value to 0-1 range
 */
function normalize(value: number, min: number, max: number): number {
  if (max === min) return 0.5;
  return (value - min) / (max - min);
}

/**
 * Generate dot grid visualization data
 *
 * @param clusters - Clusters with subtopics
 * @param umapVisualization - UMAP coordinates from clusterer
 * @returns Dot grid visualization data
 */
export function generateDotGridData(
  clusters: MessageClusterWithSubtopics[],
  umapVisualization: ClustererVisualization
): DotGridVisualization {
  console.log(
    `[DotGridGenerator] Generating dot grid for ${clusters.length} clusters`
  );

  // Build coordinate map from UMAP visualization
  const coordsMap = new Map<string, { x: number; y: number }>();
  for (const point of umapVisualization.points) {
    coordsMap.set(point.id, { x: point.x, y: point.y });
  }

  // Calculate global bounds for normalization
  const globalBounds = calculateBounds(umapVisualization.points);
  console.log(
    `[DotGridGenerator] Global bounds: x=[${globalBounds.minX.toFixed(2)}, ${globalBounds.maxX.toFixed(2)}], ` +
      `y=[${globalBounds.minY.toFixed(2)}, ${globalBounds.maxY.toFixed(2)}]`
  );

  // Generate topic dot grids
  const topics: TopicDotGrid[] = clusters.map((cluster) => {
    // Build message ID to subtopic info map
    const messageSubtopicMap = new Map<
      string,
      { id: string; index: number }
    >();
    cluster.subtopics.forEach((sub) => {
      sub.messageIds.forEach((msgId) => {
        messageSubtopicMap.set(msgId, { id: sub.id, index: sub.index });
      });
    });

    // Generate points for this topic
    const points: DotGridPoint[] = [];
    const topicCoords: Array<{ x: number; y: number }> = [];

    for (const message of cluster.messages) {
      const coords = coordsMap.get(message.id);
      if (!coords) continue;

      const subtopicInfo = messageSubtopicMap.get(message.id);

      // Normalize coordinates to 0-1
      const normalizedX = normalize(
        coords.x,
        globalBounds.minX,
        globalBounds.maxX
      );
      const normalizedY = normalize(
        coords.y,
        globalBounds.minY,
        globalBounds.maxY
      );

      points.push({
        id: message.id,
        x: normalizedX,
        y: normalizedY,
        topicId: cluster.id,
        subtopicId: subtopicInfo?.id,
        subtopicIndex: subtopicInfo?.index,
      });

      topicCoords.push({ x: normalizedX, y: normalizedY });
    }

    // Calculate topic-specific bounds (already normalized)
    const topicBounds = calculateBounds(topicCoords);

    // Calculate subtopic centroids
    const subtopicsWithCentroids = cluster.subtopics.map((sub) => {
      const subtopicPoints = points.filter((p) => p.subtopicId === sub.id);
      if (subtopicPoints.length === 0) {
        return sub;
      }

      const centroidX =
        subtopicPoints.reduce((sum, p) => sum + p.x, 0) / subtopicPoints.length;
      const centroidY =
        subtopicPoints.reduce((sum, p) => sum + p.y, 0) / subtopicPoints.length;

      return {
        ...sub,
        centroid: { x: centroidX, y: centroidY },
      };
    });

    return {
      topicId: cluster.id,
      topic: cluster.topic,
      description: cluster.description,
      messageCount: cluster.messages.length,
      uniqueUserCount: cluster.uniqueUserCount,
      subtopicCount: cluster.subtopics.length,
      subtopics: subtopicsWithCentroids,
      points,
      bounds: topicBounds,
    };
  });

  // Calculate total statistics
  const totalMessages = clusters.reduce(
    (sum, c) => sum + c.messages.length,
    0
  );

  // Calculate total unique users across all clusters
  // (same user may appear in multiple clusters, so we need to recalculate)
  const allMessages = clusters.flatMap((c) => c.messages) as ParsedMessage[];
  const totalUniqueUsers = countUniqueUsers(allMessages);

  console.log(
    `[DotGridGenerator] Complete: ${topics.length} topics, ` +
      `${totalMessages} messages, ${totalUniqueUsers} unique users`
  );

  return {
    topics,
    globalBounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 }, // Already normalized
    totalMessages,
    totalUniqueUsers,
  };
}

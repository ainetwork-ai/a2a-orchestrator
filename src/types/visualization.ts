/**
 * TRD 13: Dot Grid Visualization Types
 *
 * Data structures for T3C-style dot grid visualization.
 * Colors are NOT included - frontend generates colors from subtopicIndex.
 */

import { Subtopic } from "./report";

/**
 * Single point in the dot grid
 * Note: No userId for privacy - uniqueUserCount is stored at topic/subtopic level
 */
export interface DotGridPoint {
  id: string;              // Message ID
  x: number;               // UMAP x coordinate (0-1 normalized)
  y: number;               // UMAP y coordinate (0-1 normalized)
  topicId: string;         // Parent topic ID
  subtopicId?: string;     // Subtopic ID (for color mapping)
  subtopicIndex?: number;  // Subtopic order (for color generation)
}

/**
 * Bounds for a set of points
 */
export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * Dot grid data for a single topic
 */
export interface TopicDotGrid {
  topicId: string;
  topic: string;              // Topic label
  description: string;
  messageCount: number;
  uniqueUserCount: number;
  subtopicCount: number;      // Number of subtopics (for color palette size)
  subtopics: Subtopic[];
  points: DotGridPoint[];     // All points in this topic
  bounds: Bounds;             // Bounding box for rendering
}

/**
 * Complete dot grid visualization data
 * Note: No color palette - frontend generates from subtopicIndex
 */
export interface DotGridVisualization {
  topics: TopicDotGrid[];
  globalBounds: Bounds;
  totalMessages: number;
  totalUniqueUsers: number;
}

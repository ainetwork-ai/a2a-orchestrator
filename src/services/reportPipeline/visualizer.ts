import {
  MessageCluster,
  CategorizedMessage,
  ReportStatistics,
  VisualizationData,
  VisualizerResult,
  ScatterPlotData,
  ScatterPoint,
  TopicTreeData,
  TreeNode,
  TreeLink,
  ChartData,
} from "../../types/report";
import { ClustererVisualization } from "../../types/embedding";

/**
 * Scatter plot configuration
 */
export interface ScatterPlotConfig {
  xAxis: "sentiment" | "time" | "priority" | "custom";
  yAxis: "sentiment" | "time" | "priority" | "custom";
  pointType: "message" | "topic" | "both";
}

const DEFAULT_CONFIG: ScatterPlotConfig = {
  xAxis: "sentiment",
  yAxis: "priority",
  pointType: "both",
};

/** Performance target for visualization generation (TRD 02) */
const PERFORMANCE_TARGET_MS = 500;

/**
 * Generate all visualization data for the report
 *
 * @param clusters - Message clusters
 * @param statistics - Report statistics
 * @param umapVisualization - Optional UMAP coordinates from TRD 12 clusterer
 */
export async function generateVisualizationData(
  clusters: MessageCluster[],
  statistics: ReportStatistics,
  umapVisualization?: ClustererVisualization
): Promise<VisualizerResult> {
  const startTime = performance.now();

  console.log(
    `[Visualizer] Generating visualization data for ${clusters.length} clusters`
  );

  // Use UMAP coordinates if available, otherwise generate synthetic positions
  const scatterPlot = umapVisualization
    ? generateScatterPlotFromUMAP(clusters, umapVisualization)
    : generateScatterPlot(clusters, statistics, DEFAULT_CONFIG);

  const visualization: VisualizationData = {
    scatterPlot,
    topicTree: generateTopicTree(clusters, false),
    charts: generateChartData(statistics, clusters),
  };

  const endTime = performance.now();
  const durationMs = Math.round(endTime - startTime);

  console.log(
    `[Visualizer] Generated ${visualization.scatterPlot.points.length} scatter points`
  );
  console.log(
    `[Visualizer] Generated ${visualization.topicTree.nodes.length} tree nodes`
  );
  console.log(
    `[Visualizer] Visualization generation completed in ${durationMs}ms`
  );

  // Performance warning if exceeds target (TRD 02 requirement: <500ms)
  if (durationMs > PERFORMANCE_TARGET_MS) {
    console.warn(
      `[Visualizer] WARNING: Visualization generation took ${durationMs}ms, exceeding ${PERFORMANCE_TARGET_MS}ms target. Consider optimizing for large datasets.`
    );
  }

  return {
    visualization,
    performanceMs: durationMs,
  };
}

/**
 * Generate scatter plot from UMAP coordinates (TRD 12)
 */
function generateScatterPlotFromUMAP(
  clusters: MessageCluster[],
  umapVisualization: ClustererVisualization
): ScatterPlotData {
  const points: ScatterPoint[] = [];

  // Create a map of message ID to UMAP coordinates
  const coordsMap = new Map<string, { x: number; y: number; clusterId: number }>();
  for (const point of umapVisualization.points) {
    coordsMap.set(point.id, { x: point.x, y: point.y, clusterId: point.clusterId });
  }

  // Calculate bounds for normalization
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const point of umapVisualization.points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  // Add cluster center points
  for (const cluster of clusters) {
    const clusterMessages = cluster.messages.filter((m) => coordsMap.has(m.id));
    if (clusterMessages.length === 0) continue;

    // Calculate cluster center
    let sumX = 0, sumY = 0;
    for (const msg of clusterMessages) {
      const coords = coordsMap.get(msg.id)!;
      sumX += coords.x;
      sumY += coords.y;
    }
    const centerX = (sumX / clusterMessages.length - minX) / rangeX;
    const centerY = (sumY / clusterMessages.length - minY) / rangeY;

    // Topic point (cluster center)
    points.push({
      id: cluster.id,
      type: "topic",
      x: centerX,
      y: centerY,
      label: cluster.topic,
      size: 0.2 + Math.min(cluster.messages.length / 100, 1) * 0.8,
      color: getSentimentColor(cluster.summary.sentiment),
      metadata: {
        sentiment: cluster.summary.sentiment,
        messageCount: cluster.messages.length,
      },
    });

    // Message points (limit for performance)
    const messagesToPlot = clusterMessages.slice(0, 50);
    for (const message of messagesToPlot) {
      if (!message.isSubstantive) continue;

      const coords = coordsMap.get(message.id);
      if (!coords) continue;

      points.push({
        id: message.id,
        type: "message",
        x: (coords.x - minX) / rangeX,
        y: (coords.y - minY) / rangeY,
        label: message.content.length > 50
          ? message.content.substring(0, 50) + "..."
          : message.content,
        size: 0.3,
        color: getSentimentColor(message.sentiment || "neutral"),
        metadata: {
          sentiment: message.sentiment,
          category: message.category,
          topicId: cluster.id,
        },
      });
    }
  }

  return {
    points,
    axes: {
      x: { label: "UMAP Dimension 1", min: 0, max: 1 },
      y: { label: "UMAP Dimension 2", min: 0, max: 1 },
    },
  };
}

/**
 * Generate scatter plot data for messages and topics
 */
function generateScatterPlot(
  clusters: MessageCluster[],
  statistics: ReportStatistics,
  config: ScatterPlotConfig
): ScatterPlotData {
  const points: ScatterPoint[] = [];
  const dateRange = statistics.dateRange;

  for (const cluster of clusters) {
    // Add topic point
    const topicPoint = createTopicPoint(cluster, config, dateRange);
    points.push(topicPoint);

    // Add message points if requested
    if (config.pointType === "message" || config.pointType === "both") {
      // Limit to 50 messages per topic for performance
      const messagesToPlot = cluster.messages.slice(0, 50);
      for (const message of messagesToPlot) {
        // Only include substantive messages
        if (!message.isSubstantive) continue;

        const messagePoint = createMessagePoint(
          message,
          cluster,
          config,
          dateRange
        );
        if (messagePoint) {
          points.push(messagePoint);
        }
      }
    }
  }

  return {
    points,
    axes: {
      x: getAxisConfig(config.xAxis),
      y: getAxisConfig(config.yAxis),
    },
  };
}

/**
 * Create a scatter point for a topic
 */
function createTopicPoint(
  cluster: MessageCluster,
  config: ScatterPlotConfig,
  dateRange: { start: number; end: number }
): ScatterPoint {
  const x = calculateCoordinate(cluster, config.xAxis, "topic", dateRange);
  const y = calculateCoordinate(cluster, config.yAxis, "topic", dateRange);

  // Calculate size based on message count (normalized to 0.2-1.0)
  const maxMessages = 100;
  const size = 0.2 + Math.min(cluster.messages.length / maxMessages, 1) * 0.8;

  const color = getSentimentColor(cluster.summary.sentiment);

  return {
    id: cluster.id,
    type: "topic",
    x,
    y,
    label: cluster.topic,
    size,
    color,
    metadata: {
      sentiment: cluster.summary.sentiment,
      messageCount: cluster.messages.length,
    },
  };
}

/**
 * Create a scatter point for a message
 */
function createMessagePoint(
  message: CategorizedMessage,
  cluster: MessageCluster,
  config: ScatterPlotConfig,
  dateRange: { start: number; end: number }
): ScatterPoint | null {
  // Skip non-substantive messages
  if (!message.isSubstantive) {
    return null;
  }

  const x = calculateCoordinate(message, config.xAxis, "message", dateRange);
  const y = calculateCoordinate(message, config.yAxis, "message", dateRange);
  const color = getSentimentColor(message.sentiment || "neutral");

  return {
    id: message.id,
    type: "message",
    x,
    y,
    label:
      message.content.length > 50
        ? message.content.substring(0, 50) + "..."
        : message.content,
    size: 0.3,
    color,
    metadata: {
      sentiment: message.sentiment,
      category: message.category,
      topicId: cluster.id,
    },
  };
}

/**
 * Calculate coordinate value based on axis type
 */
function calculateCoordinate(
  item: MessageCluster | CategorizedMessage,
  axis: "sentiment" | "time" | "priority" | "custom",
  itemType: "topic" | "message",
  dateRange: { start: number; end: number }
): number {
  switch (axis) {
    case "sentiment":
      return calculateSentimentScore(item);
    case "time":
      return calculateTimePosition(item, dateRange);
    case "priority":
      return calculatePriorityScore(item);
    case "custom":
    default:
      // Random position with jitter for custom
      return Math.random();
  }
}

/**
 * Convert sentiment to numerical score
 * Positive: 0.5 to 1.0
 * Neutral: -0.2 to 0.5
 * Negative: -1.0 to -0.2
 */
function calculateSentimentScore(
  item: MessageCluster | CategorizedMessage
): number {
  let sentiment: string;

  if ("summary" in item) {
    // MessageCluster
    sentiment = item.summary.sentiment;
  } else {
    // CategorizedMessage
    sentiment = item.sentiment || "neutral";
  }

  // Add jitter for visual separation
  const jitter = (Math.random() - 0.5) * 0.15;

  switch (sentiment) {
    case "positive":
      return 0.7 + jitter;
    case "negative":
      return -0.7 + jitter;
    case "neutral":
      return 0.0 + jitter;
    case "mixed":
      return 0.1 + jitter;
    default:
      return 0.0 + jitter;
  }
}

/**
 * Calculate time-based position (0 to 1)
 */
function calculateTimePosition(
  item: MessageCluster | CategorizedMessage,
  dateRange: { start: number; end: number }
): number {
  let timestamp: number;

  if ("messages" in item) {
    // MessageCluster - use average timestamp
    if (item.messages.length === 0) return 0.5;
    const timestamps = item.messages.map((m) => m.timestamp);
    timestamp = timestamps.reduce((a, b) => a + b, 0) / timestamps.length;
  } else {
    // CategorizedMessage
    timestamp = item.timestamp;
  }

  // Normalize to 0-1 range
  const range = dateRange.end - dateRange.start;
  if (range === 0) return 0.5;

  return Math.max(0, Math.min(1, (timestamp - dateRange.start) / range));
}

/**
 * Calculate priority score based on action items or sentiment
 */
function calculatePriorityScore(
  item: MessageCluster | CategorizedMessage
): number {
  // Add jitter for visual separation
  const jitter = (Math.random() - 0.5) * 0.1;

  if ("nextSteps" in item) {
    // MessageCluster - use highest priority from next steps
    const priorities = item.nextSteps.map((step) => step.priority);
    if (priorities.includes("high")) return 0.85 + jitter;
    if (priorities.includes("medium")) return 0.5 + jitter;
    if (priorities.includes("low")) return 0.2 + jitter;
    return 0.3 + jitter;
  } else {
    // CategorizedMessage - use sentiment as proxy for urgency
    const sentiment = item.sentiment || "neutral";
    switch (sentiment) {
      case "negative":
        return 0.8 + jitter; // Negative = higher priority
      case "positive":
        return 0.3 + jitter;
      case "neutral":
      default:
        return 0.5 + jitter;
    }
  }
}

/**
 * Get sentiment-based color
 */
function getSentimentColor(sentiment: string): string {
  const colors: Record<string, string> = {
    positive: "#4CAF50",
    negative: "#F44336",
    neutral: "#9E9E9E",
    mixed: "#FFC107",
  };
  return colors[sentiment] || colors.neutral;
}

/**
 * Get axis configuration
 */
function getAxisConfig(axis: string): { label: string; min: number; max: number } {
  const configs: Record<string, { label: string; min: number; max: number }> = {
    sentiment: { label: "Sentiment", min: -1, max: 1 },
    time: { label: "Time", min: 0, max: 1 },
    priority: { label: "Priority", min: 0, max: 1 },
    custom: { label: "Custom", min: 0, max: 1 },
  };
  return configs[axis] || configs.sentiment;
}

/**
 * Generate hierarchical tree structure
 */
function generateTopicTree(
  clusters: MessageCluster[],
  includeMessages: boolean = false
): TopicTreeData {
  const nodes: TreeNode[] = [];
  const links: TreeLink[] = [];

  // Root node
  const totalMessages = clusters.reduce(
    (sum, c) => sum + c.messages.length,
    0
  );
  const rootNode: TreeNode = {
    id: "root",
    label: "All Topics",
    type: "topic",
    value: totalMessages,
    metadata: {
      clusterCount: clusters.length,
    },
  };
  nodes.push(rootNode);

  // Topic nodes
  for (const cluster of clusters) {
    const topicNode: TreeNode = {
      id: cluster.id,
      label: cluster.topic,
      type: "topic",
      parentId: "root",
      value: cluster.messages.length,
      metadata: {
        sentiment: cluster.summary.sentiment,
        opinionCount: cluster.opinions.length,
        description: cluster.description,
      },
    };
    nodes.push(topicNode);

    // Link to root
    links.push({
      source: "root",
      target: cluster.id,
      weight: cluster.messages.length,
    });

    // Message nodes (optional, limited for performance)
    if (includeMessages) {
      // Only include top 10 messages per topic
      const messagesToInclude = cluster.messages
        .filter((m) => m.isSubstantive)
        .slice(0, 10);

      for (const message of messagesToInclude) {
        const messageNode: TreeNode = {
          id: message.id,
          label:
            message.content.length > 30
              ? message.content.substring(0, 30) + "..."
              : message.content,
          type: "message",
          parentId: cluster.id,
          value: 1,
          metadata: {
            sentiment: message.sentiment,
            category: message.category,
            timestamp: message.timestamp,
          },
        };
        nodes.push(messageNode);

        links.push({
          source: cluster.id,
          target: message.id,
          weight: 1,
        });
      }
    }
  }

  return { nodes, links };
}

/**
 * Generate chart data for various visualizations
 */
function generateChartData(
  statistics: ReportStatistics,
  clusters: MessageCluster[]
): {
  sentiment?: ChartData;
  categories?: ChartData;
  topics?: ChartData;
  timeline?: ChartData;
} {
  return {
    sentiment: generateSentimentChart(statistics),
    categories: generateCategoryChart(statistics),
    topics: generateTopicChart(clusters),
    timeline: generateTimelineChart(clusters),
  };
}

/**
 * Generate sentiment distribution chart
 */
function generateSentimentChart(statistics: ReportStatistics): ChartData {
  const { sentimentDistribution } = statistics;

  return {
    type: "pie",
    data: [
      {
        label: "Positive",
        value: sentimentDistribution.positive || 0,
        color: "#4CAF50",
      },
      {
        label: "Negative",
        value: sentimentDistribution.negative || 0,
        color: "#F44336",
      },
      {
        label: "Neutral",
        value: sentimentDistribution.neutral || 0,
        color: "#9E9E9E",
      },
    ].filter((d) => d.value > 0),
  };
}

/**
 * Generate category distribution chart
 */
function generateCategoryChart(statistics: ReportStatistics): ChartData {
  const { categoryDistribution } = statistics;

  const categoryColors: Record<string, string> = {
    question: "#2196F3",
    request: "#4ECDC4",
    feedback: "#95E1D3",
    complaint: "#FF6B6B",
    information: "#FFA07A",
    other: "#9E9E9E",
  };

  return {
    type: "bar",
    data: Object.entries(categoryDistribution)
      .map(([label, value]) => ({
        label: capitalize(label),
        value,
        color: categoryColors[label.toLowerCase()] || categoryColors.other,
      }))
      .sort((a, b) => b.value - a.value),
  };
}

/**
 * Generate topic distribution chart
 */
function generateTopicChart(clusters: MessageCluster[]): ChartData {
  return {
    type: "bar",
    data: clusters
      .map((cluster) => ({
        label: cluster.topic,
        value: cluster.messages.length,
        color: getSentimentColor(cluster.summary.sentiment),
        metadata: {
          topicId: cluster.id,
          sentiment: cluster.summary.sentiment,
        },
      }))
      .sort((a, b) => b.value - a.value),
  };
}

/**
 * Generate timeline chart
 */
function generateTimelineChart(clusters: MessageCluster[]): ChartData {
  // Group messages by time period (monthly)
  const timeGroups = new Map<string, number>();

  for (const cluster of clusters) {
    for (const message of cluster.messages) {
      if (!message.isSubstantive) continue;

      const date = new Date(message.timestamp);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      timeGroups.set(key, (timeGroups.get(key) || 0) + 1);
    }
  }

  return {
    type: "line",
    data: Array.from(timeGroups.entries())
      .map(([label, value]) => ({
        label,
        value,
        color: "#2196F3",
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

/**
 * Capitalize first letter
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

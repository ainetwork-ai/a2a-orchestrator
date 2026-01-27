import {
  Report,
  ReportJob,
  T3CReport,
  Topic,
  Opinion,
  MessageRef,
  ReportMetadata,
  VisualizationData,
  CategorizedMessage,
} from "../types/report";

/**
 * Transform internal Report format to T3C format
 */
export function transformToT3CFormat(
  report: Report,
  job: ReportJob,
  includeMessages: boolean = true
): T3CReport {
  const topics: Topic[] = report.clusters.map((cluster) => {
    const sentimentDistribution = calculateSentimentDistribution(cluster.messages);

    return {
      id: cluster.id,
      name: cluster.topic,
      description: cluster.description,
      parentId: null,
      level: 0,
      messageCount: cluster.messages.length,
      percentage: calculatePercentage(
        cluster.messages.length,
        report.statistics.totalMessages
      ),
      sentiment: {
        overall: cluster.summary.sentiment,
        distribution: sentimentDistribution,
      },
      // TRD 05: cluster.opinions is now Opinion[] with grounding info
      opinions: transformOpinions(cluster.opinions, cluster.id),
      messages: includeMessages
        ? cluster.messages.map((msg) => transformMessage(msg))
        : [],
      summary: cluster.summary,
      nextSteps: cluster.nextSteps,
      position: findTopicPosition(report.visualization, cluster.id),
      color: findTopicColor(report.visualization, cluster.id),
    };
  });

  const metadata = createMetadata(report, job);

  return {
    id: report.id,
    title: report.title,
    createdAt: report.createdAt,
    version: "1.0.0",
    metadata,
    statistics: report.statistics,
    synthesis: report.synthesis,
    topics,
    visualization: report.visualization || createDefaultVisualization(),
  };
}

/**
 * Transform opinions to ensure proper format (TRD 05)
 * Handles both old string[] format and new Opinion[] format for backward compatibility
 */
function transformOpinions(opinions: Opinion[] | string[], clusterId: string): Opinion[] {
  if (opinions.length === 0) return [];

  // Check if already Opinion objects (TRD 05 format)
  const firstOpinion = opinions[0];
  if (typeof firstOpinion === "object" && firstOpinion !== null && "id" in firstOpinion) {
    // Already Opinion[] format - return as-is
    return opinions as Opinion[];
  }

  // Legacy string[] format - convert to Opinion objects
  return (opinions as string[]).map((text, idx) => ({
    id: `${clusterId}-op-${idx}`,
    text,
    type: "general" as const,
    supportingMessages: [],
    mentionCount: 0,
  }));
}

/**
 * Transform a CategorizedMessage to MessageRef
 */
function transformMessage(msg: CategorizedMessage): MessageRef {
  return {
    id: msg.id,
    content: msg.content,
    timestamp: msg.timestamp,
    category: msg.category,
    subCategory: msg.subCategory,
    intent: msg.intent,
    sentiment: msg.sentiment || "neutral",
    isSubstantive: msg.isSubstantive,
  };
}

/**
 * Create report metadata
 */
function createMetadata(report: Report, job: ReportJob): ReportMetadata {
  const processingTime = job.updatedAt - job.createdAt;
  const totalBeforeFiltering = report.statistics.totalMessages + report.statistics.nonSubstantiveCount;

  return {
    params: job.params,
    processingTime,
    pipelineVersion: "1.0.0",
    wasCached: !!job.cachedAt,
    cachedAt: job.cachedAt,
    scope: {
      totalThreads: report.statistics.totalThreads,
      totalMessages: report.statistics.totalMessages,
      substantiveMessages: report.statistics.totalMessages,
      filteredMessages: report.statistics.nonSubstantiveCount,
      dateRange: report.statistics.dateRange,
    },
    filtering: {
      totalBeforeFiltering,
      substantiveCount: report.statistics.totalMessages,
      nonSubstantiveCount: report.statistics.nonSubstantiveCount,
      filteringRate: totalBeforeFiltering > 0
        ? parseFloat(((report.statistics.nonSubstantiveCount / totalBeforeFiltering) * 100).toFixed(1))
        : 0,
      filterReasons: report.statistics.filteringBreakdown,
    },
  };
}

/**
 * Calculate percentage with 1 decimal place
 */
function calculatePercentage(count: number, total: number): number {
  return total > 0 ? parseFloat(((count / total) * 100).toFixed(1)) : 0;
}

/**
 * Calculate sentiment distribution from messages
 */
function calculateSentimentDistribution(messages: CategorizedMessage[]): {
  positive: number;
  negative: number;
  neutral: number;
} {
  const dist = { positive: 0, negative: 0, neutral: 0 };
  for (const msg of messages) {
    const sentiment = msg.sentiment || "neutral";
    if (sentiment in dist) {
      dist[sentiment as keyof typeof dist]++;
    }
  }
  return dist;
}

/**
 * Find topic position from visualization data
 */
function findTopicPosition(
  visualization: VisualizationData | undefined,
  topicId: string
): { x: number; y: number } | undefined {
  if (!visualization?.scatterPlot?.points) return undefined;

  const point = visualization.scatterPlot.points.find(
    (p) => p.id === topicId && p.type === "topic"
  );

  return point ? { x: point.x, y: point.y } : undefined;
}

/**
 * Find topic color from visualization data
 */
function findTopicColor(
  visualization: VisualizationData | undefined,
  topicId: string
): string | undefined {
  if (!visualization?.scatterPlot?.points) return undefined;

  const point = visualization.scatterPlot.points.find(
    (p) => p.id === topicId && p.type === "topic"
  );

  return point?.color;
}

/**
 * Create default visualization data
 */
function createDefaultVisualization(): VisualizationData {
  return {
    scatterPlot: {
      points: [],
      axes: {
        x: { label: "Sentiment", min: -1, max: 1 },
        y: { label: "Priority", min: 0, max: 1 },
      },
    },
    topicTree: {
      nodes: [],
      links: [],
    },
    charts: {},
  };
}

/**
 * Extract topics summary for lightweight endpoint
 */
export function extractTopicsSummary(
  report: Report
): Array<{
  id: string;
  name: string;
  description: string;
  messageCount: number;
  percentage: number;
  sentiment: {
    overall: "positive" | "negative" | "mixed" | "neutral";
    distribution: { positive: number; negative: number; neutral: number };
  };
}> {
  return report.clusters.map((cluster) => ({
    id: cluster.id,
    name: cluster.topic,
    description: cluster.description,
    messageCount: cluster.messages.length,
    percentage: calculatePercentage(
      cluster.messages.length,
      report.statistics.totalMessages
    ),
    sentiment: {
      overall: cluster.summary.sentiment,
      distribution: calculateSentimentDistribution(cluster.messages),
    },
  }));
}

/**
 * Extract statistics for lightweight endpoint
 */
export function extractStatistics(report: Report): {
  statistics: typeof report.statistics;
  synthesis: typeof report.synthesis;
} {
  return {
    statistics: report.statistics,
    synthesis: report.synthesis,
  };
}

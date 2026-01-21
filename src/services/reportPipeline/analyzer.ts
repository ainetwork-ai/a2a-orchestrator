import { CategorizedMessage, MessageCluster, ReportStatistics, AnalyzerResult } from "../../types/report";

/**
 * Analyze categorized messages and clusters to generate statistics
 */
export function analyzeData(
  messages: CategorizedMessage[],
  clusters: MessageCluster[],
  threadCount: number,
  totalMessagesBeforeSampling: number,
  wasSampled: boolean,
  nonSubstantiveCount: number
): AnalyzerResult {
  const statistics: ReportStatistics = {
    totalMessages: messages.length,
    totalThreads: threadCount,
    dateRange: calculateDateRange(messages),
    categoryDistribution: calculateCategoryDistribution(messages),
    sentimentDistribution: calculateSentimentDistribution(messages),
    topTopics: calculateTopTopics(clusters),
    averageMessagesPerThread: threadCount > 0 ? messages.length / threadCount : 0,
    totalMessagesBeforeSampling,
    wasSampled,
    nonSubstantiveCount,
  };

  return { statistics };
}

function calculateDateRange(messages: CategorizedMessage[]): { start: number; end: number } {
  if (messages.length === 0) {
    const now = Date.now();
    return { start: now, end: now };
  }

  const timestamps = messages.map(m => m.timestamp);
  return {
    start: Math.min(...timestamps),
    end: Math.max(...timestamps),
  };
}

function calculateCategoryDistribution(messages: CategorizedMessage[]): Record<string, number> {
  const distribution: Record<string, number> = {};

  for (const msg of messages) {
    const category = msg.category || "other";
    distribution[category] = (distribution[category] || 0) + 1;
  }

  return distribution;
}

function calculateSentimentDistribution(messages: CategorizedMessage[]): Record<string, number> {
  const distribution: Record<string, number> = {
    positive: 0,
    negative: 0,
    neutral: 0,
  };

  for (const msg of messages) {
    const sentiment = msg.sentiment || "neutral";
    distribution[sentiment] = (distribution[sentiment] || 0) + 1;
  }

  return distribution;
}

function calculateTopTopics(clusters: MessageCluster[]): Array<{
  topic: string;
  count: number;
  percentage: number;
}> {
  const totalMessages = clusters.reduce((sum, c) => sum + c.messages.length, 0);

  return clusters
    .map(cluster => ({
      topic: cluster.topic,
      count: cluster.messages.length,
      percentage: totalMessages > 0
        ? Math.round((cluster.messages.length / totalMessages) * 100 * 10) / 10
        : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

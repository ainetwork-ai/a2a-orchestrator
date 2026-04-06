import { MessageCluster, ReportStatistics, AnalyzerResult, ExtractedOpinion } from "../../types/report";

/**
 * Analyze extracted opinions and clusters to generate statistics
 */
export function analyzeData(
  opinions: ExtractedOpinion[],
  clusters: MessageCluster[],
  threadCount: number,
): AnalyzerResult {
  const statistics: ReportStatistics = {
    totalOpinions: opinions.length,
    totalThreads: threadCount,
    dateRange: calculateDateRange(opinions),
    stanceDistribution: calculateStanceDistribution(opinions),
    topTopics: calculateTopTopics(clusters),
    deliberation: {
      totalOpinions: opinions.length,
      evolvedCount: opinions.filter((op) => op.evolved).length,
    },
  };

  return { statistics };
}

function calculateDateRange(opinions: ExtractedOpinion[]): { start: number; end: number } {
  if (opinions.length === 0) {
    const now = Date.now();
    return { start: now, end: now };
  }

  const timestamps = opinions.map((op) => op.timestamp);
  return {
    start: Math.min(...timestamps),
    end: Math.max(...timestamps),
  };
}

function calculateStanceDistribution(opinions: ExtractedOpinion[]): Record<string, number> {
  const distribution: Record<string, number> = {};

  for (const op of opinions) {
    const stance = op.stance || "neutral";
    distribution[stance] = (distribution[stance] || 0) + 1;
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
    .map((cluster) => ({
      topic: cluster.topic,
      count: cluster.messages.length,
      percentage: totalMessages > 0
        ? Math.round((cluster.messages.length / totalMessages) * 100 * 10) / 10
        : 0,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

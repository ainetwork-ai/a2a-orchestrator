/**
 * ClusterAnalyzer for TRD 12
 *
 * Uses LLM to analyze clusters and generate:
 * - Topic labels and descriptions
 * - Opinions (distinct viewpoints)
 * - Summaries (consensus, conflicting)
 * - Next steps (actionable recommendations)
 *
 * Uses contrastive prompting (inside/outside examples) for accurate labeling.
 */

import { v4 as uuidv4 } from "uuid";
import RequestManager from "../../world/requestManager";
import {
  MessageCluster,
  CategorizedMessage,
  Opinion,
  ClusterSummary,
  ActionItem,
  ReportLanguage,
} from "../../types/report";
import { parseJsonResponse } from "../../utils/llm";

/**
 * Configuration for cluster analysis
 */
const ANALYZER_CONFIG = {
  maxInsideExamples: 10,
  maxOutsideExamples: 5,
  maxContentLength: 150,
  maxTokens: 2000,
  temperature: 0.3,
} as const;

/**
 * Analyze all clusters using LLM
 *
 * @param clusters - Clusters from the clusterer
 * @param apiUrl - LLM API URL
 * @param model - LLM model to use
 * @param language - Output language (ko or en)
 * @returns Clusters with labels, opinions, summaries, and next steps
 */
export async function analyzeClusters(
  clusters: MessageCluster[],
  apiUrl: string,
  model: string,
  language: ReportLanguage = "ko"
): Promise<MessageCluster[]> {
  console.log(`[ClusterAnalyzer] Analyzing ${clusters.length} clusters`);

  if (clusters.length === 0) {
    return [];
  }

  // Collect all messages for contrastive examples
  const allMessages = clusters.flatMap((c) => c.messages);

  // Analyze each cluster (can be parallelized but rate limiting may apply)
  const analyzedClusters = await Promise.all(
    clusters.map((cluster) =>
      analyzeCluster(cluster, allMessages, apiUrl, model, language)
    )
  );

  console.log(`[ClusterAnalyzer] Complete: ${analyzedClusters.length} clusters analyzed`);

  return analyzedClusters;
}

/**
 * Analyze a single cluster
 */
async function analyzeCluster(
  cluster: MessageCluster,
  allMessages: CategorizedMessage[],
  apiUrl: string,
  model: string,
  language: ReportLanguage
): Promise<MessageCluster> {
  const clusterId = cluster.id || uuidv4();

  // Build inside examples (from this cluster)
  const insideExamples = cluster.messages
    .slice(0, ANALYZER_CONFIG.maxInsideExamples)
    .map((m) => `- "${truncate(m.content, ANALYZER_CONFIG.maxContentLength)}"`)
    .join("\n");

  // Build outside examples (from other clusters, for contrast)
  const outsideMessages = allMessages.filter(
    (m) => !cluster.messages.some((cm) => cm.id === m.id)
  );
  const outsideExamples = outsideMessages
    .slice(0, ANALYZER_CONFIG.maxOutsideExamples)
    .map((m) => `- "${truncate(m.content, ANALYZER_CONFIG.maxContentLength / 1.5)}"`)
    .join("\n");

  // Calculate sentiment distribution
  const sentimentCounts = { positive: 0, negative: 0, neutral: 0 };
  for (const msg of cluster.messages) {
    if (msg.sentiment) {
      sentimentCounts[msg.sentiment]++;
    }
  }

  // Build prompt
  const langInstruction =
    language === "ko"
      ? "IMPORTANT: Write ALL text content in Korean."
      : "Write all text content in English.";

  const prompt = `You are analyzing a cluster of user feedback messages.

${langInstruction}

## Context
Total messages in cluster: ${cluster.messages.length}
Sentiment distribution: ${sentimentCounts.positive} positive, ${sentimentCounts.negative} negative, ${sentimentCounts.neutral} neutral

## Examples OUTSIDE this cluster (for contrast):
${outsideExamples || "No outside examples available"}

## Examples INSIDE this cluster:
${insideExamples}

## Tasks
Based on the contrast between messages inside and outside the cluster, provide:

1. **Topic Label**: A short, descriptive topic name (3-5 words)
2. **Description**: One sentence describing what this cluster is about
3. **Opinions**: 3-7 distinct opinions expressed by users in this cluster
4. **Summary**:
   - consensus: Common opinions shared by most users
   - conflicting: Conflicting opinions (if any)
   - sentiment: Overall sentiment ("positive", "negative", "mixed", "neutral")
5. **Next Steps**: 1-3 actionable recommendations based on the feedback

Respond in JSON format only:
{
  "topic": "토픽 라벨",
  "description": "이 클러스터에 대한 설명",
  "opinions": [
    "Opinion 1: ...",
    "Opinion 2: ..."
  ],
  "summary": {
    "consensus": ["Common opinion 1", "Common opinion 2"],
    "conflicting": ["Some users want X while others prefer Y"],
    "sentiment": "mixed"
  },
  "nextSteps": [
    {
      "action": "Specific action to take",
      "priority": "high",
      "rationale": "Why this is important"
    }
  ]
}`;

  try {
    const requestManager = RequestManager.getInstance();
    const response = await requestManager.request(
      apiUrl,
      model,
      [{ role: "user", content: prompt }],
      ANALYZER_CONFIG.maxTokens,
      ANALYZER_CONFIG.temperature
    );

    const parsed = parseJsonResponse<{
      topic?: string;
      description?: string;
      opinions?: any[];
      summary?: { consensus?: string[]; conflicting?: string[]; sentiment?: string };
      nextSteps?: { action?: string; priority?: string; rationale?: string }[];
    }>(response);

    // Build Opinion objects
    const opinions: Opinion[] = (parsed.opinions || []).map((op: any, idx: number) => {
      const text = typeof op === "string" ? op : op.text || op.opinion || String(op);
      return {
        id: `${clusterId}-op-${idx}`,
        text,
        type: "general" as const,
        supportingMessages: [], // Grounding will populate
        mentionCount: 0, // Grounding will populate
      };
    });

    // Build Summary
    const summary: ClusterSummary = {
      consensus: parsed.summary?.consensus || [],
      conflicting: parsed.summary?.conflicting || [],
      sentiment: (parsed.summary?.sentiment as ClusterSummary["sentiment"]) || "neutral",
    };

    // Build NextSteps
    const nextSteps: ActionItem[] = (parsed.nextSteps || [])
      .map((step: any) => ({
        action: step.action || "",
        priority: (step.priority || "medium") as ActionItem["priority"],
        rationale: step.rationale || "",
      }))
      .filter((step: ActionItem) => step.action);

    return {
      ...cluster,
      id: clusterId,
      topic: parsed.topic || cluster.topic,
      description: parsed.description || cluster.description,
      opinions,
      summary,
      nextSteps,
    };
  } catch (error) {
    console.error(`[ClusterAnalyzer] Error analyzing cluster ${cluster.id}:`, error);

    // Return cluster with minimal analysis on error
    return {
      ...cluster,
      id: clusterId,
      opinions: [
        {
          id: `${clusterId}-op-0`,
          text: `${cluster.messages.length} messages about this topic`,
          type: "general" as const,
          supportingMessages: [],
          mentionCount: 0,
        },
      ],
      summary: {
        consensus: [],
        conflicting: [],
        sentiment: cluster.summary?.sentiment || "neutral",
      },
      nextSteps: [],
    };
  }
}

/**
 * Truncate text to a maximum length
 */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

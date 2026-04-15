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
  ParsedMessage,
  ClusterSummary,
  ReportLanguage,
  ExtractedOpinion,
} from "../../types/report";
import { PipelineTopic } from "./clusterer";
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
 * @returns Clusters with labels, summaries, and next steps
 */
export async function analyzeClusters(
  clusters: PipelineTopic[],
  apiUrl: string,
  model: string,
  language: ReportLanguage = "ko",
  extractedOpinions?: ExtractedOpinion[]
): Promise<PipelineTopic[]> {
  console.log(`[ClusterAnalyzer] Analyzing ${clusters.length} clusters`);

  if (clusters.length === 0) {
    return [];
  }

  const allMessages = clusters.flatMap((c) => c.messages);
  const opinionMap = extractedOpinions
    ? new Map(extractedOpinions.map((op) => [op.id, op]))
    : undefined;

  const analyzedClusters = await Promise.all(
    clusters.map((cluster) =>
      analyzeCluster(cluster, allMessages, apiUrl, model, language, opinionMap)
    )
  );

  console.log(`[ClusterAnalyzer] Complete: ${analyzedClusters.length} clusters analyzed`);

  return analyzedClusters;
}

/**
 * Analyze a single cluster
 */
async function analyzeCluster(
  cluster: PipelineTopic,
  allMessages: ParsedMessage[],
  apiUrl: string,
  model: string,
  language: ReportLanguage,
  opinionMap?: Map<string, ExtractedOpinion>
): Promise<PipelineTopic> {
  const clusterId = cluster.id || uuidv4();

  // Build opinion context with stance/confidence metadata
  const opinionContext = opinionMap
    ? cluster.messages
        .filter((m) => opinionMap.has(m.id))
        .map((m) => {
          const op = opinionMap.get(m.id)!;
          return `- "${truncate(op.statement, ANALYZER_CONFIG.maxContentLength)}" (${op.stance}, confidence: ${op.confidence})`;
        })
        .join("\n")
    : null;

  // Build inside examples as fallback (when no opinion metadata)
  const insideExamples = !opinionContext
    ? cluster.messages
        .slice(0, ANALYZER_CONFIG.maxInsideExamples)
        .map((m) => `- "${truncate(m.content, ANALYZER_CONFIG.maxContentLength)}"`)
        .join("\n")
    : null;

  // Build outside examples (from other clusters, for contrast)
  const outsideMessages = allMessages.filter(
    (m) => !cluster.messages.some((cm) => cm.id === m.id)
  );
  const outsideExamples = outsideMessages
    .slice(0, ANALYZER_CONFIG.maxOutsideExamples)
    .map((m) => `- "${truncate(m.content, ANALYZER_CONFIG.maxContentLength / 1.5)}"`)
    .join("\n");

  // Build prompt
  const langInstruction =
    language === "ko"
      ? "CRITICAL: You MUST write ALL text content in Korean (한국어). Even if the input messages are in English, your output MUST be in Korean. Do NOT write any text in English."
      : "Write all text content in English.";

  const insideSection = opinionContext
    ? `## Opinions extracted from conversations (with stance and confidence):\n${opinionContext}`
    : `## Examples INSIDE this cluster:\n${insideExamples}`;

  const prompt = `You are analyzing a cluster of user feedback messages.

${langInstruction}

## Context
Total messages in cluster: ${cluster.messages.length}

## Examples OUTSIDE this cluster (for contrast):
${outsideExamples || "No outside examples available"}

${insideSection}

## Tasks
Based on the contrast between messages inside and outside the cluster, provide:

1. **Topic Label**: A short, descriptive topic name (3-5 words)
2. **Description**: One sentence describing what this cluster is about
3. **Summary**:
   - consensus: Common opinions shared by most users
   - conflicting: Conflicting opinions (if any)
   - sentiment: Overall sentiment ("positive", "negative", "mixed", "neutral")

Respond in JSON format only:
{
  "topic": "토픽 라벨",
  "description": "이 클러스터에 대한 설명",
  "summary": {
    "consensus": ["Common opinion 1", "Common opinion 2"],
    "conflicting": ["Some users want X while others prefer Y"],
    "sentiment": "mixed"
  }
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
      summary?: { consensus?: string[]; conflicting?: string[]; sentiment?: string };
    }>(response);

    const summary: ClusterSummary = {
      consensus: parsed.summary?.consensus || [],
      conflicting: parsed.summary?.conflicting || [],
      sentiment: (parsed.summary?.sentiment as ClusterSummary["sentiment"]) || "neutral",
    };

    return {
      ...cluster,
      id: clusterId,
      title: parsed.topic || cluster.title,
      description: parsed.description || cluster.description,
      claims: [],
      summary,
    };
  } catch (error) {
    console.error(`[ClusterAnalyzer] Error analyzing cluster ${cluster.id}:`, error);

    // Return cluster with minimal analysis on error
    return {
      ...cluster,
      id: clusterId,
      claims: [],
      summary: {
        consensus: [],
        conflicting: [],
        sentiment: cluster.summary?.sentiment || "neutral",
      },
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


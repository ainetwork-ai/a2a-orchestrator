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
  language: ReportLanguage = "ko"
): Promise<PipelineTopic[]> {
  console.log(`[ClusterAnalyzer] Analyzing ${clusters.length} clusters`);

  if (clusters.length === 0) {
    return [];
  }

  const allMessages = clusters.flatMap((c) => c.messages);

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
  cluster: PipelineTopic,
  allMessages: ParsedMessage[],
  apiUrl: string,
  model: string,
  language: ReportLanguage
): Promise<PipelineTopic> {
  const clusterId = cluster.id || uuidv4();

  // Build subtopic-grouped claims context
  const hasSubtopics = cluster.subtopics.length > 0 &&
    cluster.subtopics.some((s) => s.claims.length > 0);

  const subtopicSections = hasSubtopics
    ? cluster.subtopics.map((subtopic, i) => {
        const claimLines = subtopic.claims.map((claim) => {
          const quoteText = claim.quotes.length > 0
            ? `\n    Quote: "${truncate(claim.quotes[0].text, ANALYZER_CONFIG.maxContentLength)}"`
            : "";
          return `  - Claim: "${truncate(claim.title, ANALYZER_CONFIG.maxContentLength)}" (${claim.stance}, confidence: ${claim.confidence})${quoteText}`;
        }).join("\n");
        return `### Group ${i + 1} (${subtopic.claims.length} claims):\n${claimLines}`;
      }).join("\n\n")
    : null;

  // Fallback: raw messages
  const insideExamples = !subtopicSections
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

  const langInstruction =
    language === "ko"
      ? "CRITICAL: You MUST write ALL text content in Korean (한국어). Even if the input messages are in English, your output MUST be in Korean. Do NOT write any text in English."
      : "Write all text content in English.";

  const insideSection = subtopicSections
    ? `## Claims grouped by subtopic:\n${subtopicSections}`
    : `## Examples INSIDE this cluster:\n${insideExamples}`;

  const subtopicInstruction = hasSubtopics
    ? `5. **Subtopic Labels**: For each of the ${cluster.subtopics.length} groups above, provide a short name (2-6 words) and one-sentence description`
    : "";

  const subtopicJson = hasSubtopics
    ? `,\n  "subtopics": [\n    { "name": "서브토픽 라벨", "description": "설명" }\n  ]`
    : "";

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
3. **Summary**: Generate a detailed summary (100-140 words) that:
   - Synthesizes the key themes and patterns across all claims
   - Highlights the main perspectives and stances expressed
   - Captures the breadth of discussion on this topic
   - Is comprehensive yet concise
4. **Sentiment**: Overall sentiment ("positive", "negative", "mixed", "neutral")
${subtopicInstruction}

Respond in JSON format only:
{
  "topic": "토픽 라벨",
  "description": "이 클러스터에 대한 설명",
  "summary": {
    "text": "100-140 단어의 자연어 요약 문단",
    "sentiment": "mixed"
  }${subtopicJson}
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
      summary?: { text?: string; sentiment?: string };
      subtopics?: Array<{ name?: string; description?: string }>;
    }>(response);

    const summary: ClusterSummary = {
      text: parsed.summary?.text || "",
      sentiment: (parsed.summary?.sentiment as ClusterSummary["sentiment"]) || "neutral",
    };

    if (parsed.subtopics && parsed.subtopics.length !== cluster.subtopics.length) {
      console.warn(
        `[ClusterAnalyzer] Subtopic count mismatch for ${cluster.id}: ` +
        `expected ${cluster.subtopics.length}, got ${parsed.subtopics.length}`
      );
    }

    const updatedSubtopics = cluster.subtopics.map((subtopic, i) => {
      const llmSubtopic = parsed.subtopics?.[i];
      return {
        ...subtopic,
        title: llmSubtopic?.name || subtopic.title,
        description: llmSubtopic?.description || subtopic.description,
      };
    });

    return {
      ...cluster,
      id: clusterId,
      title: parsed.topic || cluster.title,
      description: parsed.description || cluster.description,
      subtopics: updatedSubtopics,
      summary,
    };
  } catch (error) {
    console.error(`[ClusterAnalyzer] Error analyzing cluster ${cluster.id}:`, error);

    return {
      ...cluster,
      id: clusterId,
      summary: {
        text: "",
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


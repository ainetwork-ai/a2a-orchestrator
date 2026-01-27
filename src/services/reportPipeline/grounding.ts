/**
 * Grounding service for linking opinions to supporting messages (TRD 05)
 *
 * This module implements "grounded analysis" - linking each AI-generated opinion
 * back to the specific messages that support it. This enables users to verify claims,
 * build trust in AI-generated insights, and explore the diversity of perspectives.
 */

import RequestManager from "../../world/requestManager";
import {
  MessageCluster,
  Opinion,
  CategorizedMessage,
  GroundingResult,
} from "../../types/report";
import { parseJsonResponse } from "../../utils/llm";

/**
 * Ground all opinions in clusters by linking them to supporting messages
 *
 * @param clusters - Clusters with opinions to ground
 * @param apiUrl - LLM API URL
 * @param model - LLM model name
 * @returns Clusters with grounded opinions (including supportingMessages and mentionCount)
 */
export async function groundOpinions(
  clusters: MessageCluster[],
  apiUrl: string,
  model: string
): Promise<GroundingResult> {
  const startTime = Date.now();
  console.log(
    `[Grounding] Starting grounding for ${clusters.length} clusters`
  );

  if (clusters.length === 0) {
    return { clusters: [], performanceMs: Date.now() - startTime };
  }

  // Process clusters in parallel for better performance
  const groundedClusters = await Promise.all(
    clusters.map((cluster) => groundClusterOpinions(cluster, apiUrl, model))
  );

  const performanceMs = Date.now() - startTime;
  console.log(
    `[Grounding] Completed grounding in ${performanceMs}ms for ${clusters.length} clusters`
  );

  return { clusters: groundedClusters, performanceMs };
}

/**
 * Ground opinions for a single cluster by linking to supporting messages
 *
 * @param cluster - Cluster with opinions to ground
 * @param apiUrl - LLM API URL
 * @param model - LLM model name
 * @returns Cluster with grounded opinions
 */
async function groundClusterOpinions(
  cluster: MessageCluster,
  apiUrl: string,
  model: string
): Promise<MessageCluster> {
  // Skip if no opinions or messages
  if (cluster.opinions.length === 0 || cluster.messages.length === 0) {
    console.log(
      `[Grounding] Skipping cluster "${cluster.topic}" - no opinions or messages`
    );
    return cluster;
  }

  console.log(
    `[Grounding] Processing cluster "${cluster.topic}" with ${cluster.opinions.length} opinions and ${cluster.messages.length} messages`
  );

  // Prepare messages for prompt (truncate content for token efficiency)
  const messagesForPrompt = cluster.messages.map((msg, idx) => ({
    index: idx,
    id: msg.id,
    content: msg.content.substring(0, 300), // Truncate to save tokens
  }));

  // Prepare opinions for prompt
  const opinionsForPrompt = cluster.opinions.map((op, idx) => ({
    index: idx,
    id: op.id,
    text: op.text,
    type: op.type,
  }));

  const prompt = buildGroundingPrompt(
    cluster.topic,
    opinionsForPrompt,
    messagesForPrompt
  );

  try {
    const requestManager = RequestManager.getInstance();
    const response = await requestManager.request(
      apiUrl,
      model,
      [{ role: "user", content: prompt }],
      2000,
      0.2 // Low temperature for consistency
    );

    const parsed = parseJsonResponse<{
      groundings?: GroundingEntry[];
    }>(response);
    const groundings = parsed.groundings || [];

    // Apply grounding data to opinions
    const groundedOpinions = applyGroundingsToOpinions(
      cluster.opinions,
      groundings,
      cluster.messages
    );

    console.log(
      `[Grounding] Grounded ${groundedOpinions.filter((op) => op.supportingMessages.length > 0).length}/${groundedOpinions.length} opinions in cluster "${cluster.topic}"`
    );

    return {
      ...cluster,
      opinions: groundedOpinions,
    };
  } catch (error) {
    console.error(
      `[Grounding] Error grounding cluster "${cluster.topic}":`,
      error
    );

    // Return cluster with opinions that have empty supportingMessages
    // (fallback - opinions are still valid, just not grounded)
    const fallbackOpinions = cluster.opinions.map((op) => ({
      ...op,
      supportingMessages: op.supportingMessages || [],
      mentionCount: op.mentionCount || 0,
    }));

    return {
      ...cluster,
      opinions: fallbackOpinions,
    };
  }
}

/**
 * LLM response format for grounding
 */
interface GroundingEntry {
  opinionIndex: number;
  supportingMessageIndices: number[];
  mentionCount: number;
  confidence: number;
}

/**
 * Build the LLM prompt for grounding opinions to messages
 */
function buildGroundingPrompt(
  topic: string,
  opinions: { index: number; id: string; text: string; type: string }[],
  messages: { index: number; id: string; content: string }[]
): string {
  return `You are analyzing a cluster of user messages to link opinions to supporting quotes.

Cluster Topic: "${topic}"

Opinions to ground:
${JSON.stringify(opinions, null, 2)}

Messages in this cluster:
${JSON.stringify(messages, null, 2)}

Instructions:
For each opinion, identify which messages support it:
1. Find messages that express or relate to the opinion (exact match not required - semantic similarity counts)
2. Select the 1-3 BEST representative messages (most clear and relevant)
3. Count the TOTAL number of messages that support this opinion (for mentionCount)
4. Rate your confidence (0-1) in how well the messages support the opinion

Important:
- supportingMessageIndices should use the message "index" values (0, 1, 2, etc.)
- mentionCount should reflect ALL supporting messages, not just the selected representatives
- confidence should be 0.9+ if messages clearly express the opinion, 0.5-0.9 if related, <0.5 if loosely connected
- If an opinion has no clear supporting messages, set supportingMessageIndices to empty array and confidence to 0

Respond in JSON format only:
{
  "groundings": [
    {
      "opinionIndex": 0,
      "supportingMessageIndices": [2, 5, 8],
      "mentionCount": 12,
      "confidence": 0.9
    },
    {
      "opinionIndex": 1,
      "supportingMessageIndices": [1, 3],
      "mentionCount": 5,
      "confidence": 0.75
    }
  ]
}`;
}

/**
 * Apply grounding data to opinions
 *
 * @param opinions - Original opinions
 * @param groundings - Grounding data from LLM
 * @param messages - Cluster messages (for extracting representative quotes)
 * @returns Opinions with grounding data applied
 */
function applyGroundingsToOpinions(
  opinions: Opinion[],
  groundings: GroundingEntry[],
  messages: CategorizedMessage[]
): Opinion[] {
  // Create a map for quick lookup
  const groundingMap = new Map<number, GroundingEntry>();
  for (const grounding of groundings) {
    groundingMap.set(grounding.opinionIndex, grounding);
  }

  return opinions.map((opinion, idx) => {
    const grounding = groundingMap.get(idx);

    if (!grounding) {
      // No grounding found - return opinion with default values
      return {
        ...opinion,
        supportingMessages: opinion.supportingMessages || [],
        mentionCount: opinion.mentionCount || 0,
      };
    }

    // Extract message IDs from indices
    const supportingMessageIds = (grounding.supportingMessageIndices || [])
      .filter((msgIdx) => msgIdx >= 0 && msgIdx < messages.length)
      .map((msgIdx) => messages[msgIdx].id);

    // Get representative quote from first supporting message
    let representativeQuote: string | undefined;
    if (
      grounding.supportingMessageIndices &&
      grounding.supportingMessageIndices.length > 0
    ) {
      const firstMsgIdx = grounding.supportingMessageIndices[0];
      if (firstMsgIdx >= 0 && firstMsgIdx < messages.length) {
        representativeQuote = messages[firstMsgIdx].content;
      }
    }

    return {
      ...opinion,
      supportingMessages: supportingMessageIds,
      mentionCount: grounding.mentionCount || supportingMessageIds.length,
      representativeQuote,
      confidence: grounding.confidence,
    };
  });
}

export { groundClusterOpinions };

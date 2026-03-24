/**
 * LLM-based opinion extractor (EPIC1 - Story 1.2)
 *
 * Extracts structured opinions from conversation segments using LLM.
 * Agent messages are used as context to interpret user intent.
 * Each opinion is a self-contained statement traceable to its source segment.
 */

import { v4 as uuidv4 } from "uuid";
import RequestManager from "../../world/requestManager";
import {
  ConversationSegment,
  ExtractedOpinion,
  OpinionExtractionResult,
  ReportLanguage,
} from "../../types/report";
import { parseJsonResponse } from "../../utils/llm";
import { truncate, getLangInstruction } from "./pipelineUtils";

const EXTRACTOR_CONFIG = {
  maxContentLength: 300,
  maxTokens: 2000,
  temperature: 0.2,
} as const;

const VALID_STANCES = new Set<ExtractedOpinion["stance"]>([
  "support", "oppose", "neutral", "request", "question",
]);

/**
 * Extract opinions from conversation segments using LLM
 */
export async function extractOpinions(
  segments: ConversationSegment[],
  apiUrl: string,
  model: string,
  language: ReportLanguage = "ko"
): Promise<OpinionExtractionResult> {
  console.log(`[OpinionExtractor] Starting extraction from ${segments.length} segments`);

  if (segments.length === 0) {
    return {
      opinions: [], totalSegmentsProcessed: 0,
      emptySegments: 0, failedSegments: 0, evolvedOpinionCount: 0,
    };
  }

  const results = await Promise.all(
    segments.map((segment) => extractFromSegment(segment, apiUrl, model, language))
  );

  const allOpinions: ExtractedOpinion[] = [];
  let emptySegments = 0;
  let failedSegments = 0;
  let evolvedOpinionCount = 0;

  for (const result of results) {
    if (result.failed) {
      failedSegments++;
    } else if (result.opinions.length === 0) {
      emptySegments++;
    } else {
      for (const op of result.opinions) {
        allOpinions.push(op);
        if (op.evolved) evolvedOpinionCount++;
      }
    }
  }

  console.log(
    `[OpinionExtractor] Extracted ${allOpinions.length} opinions from ${segments.length} segments ` +
    `(${emptySegments} empty, ${failedSegments} failed, ${evolvedOpinionCount} evolved)`
  );

  return {
    opinions: allOpinions,
    totalSegmentsProcessed: segments.length,
    emptySegments,
    failedSegments,
    evolvedOpinionCount,
  };
}

interface SegmentExtractionResult {
  opinions: ExtractedOpinion[];
  failed: boolean;
}

/**
 * Extract opinions from a single conversation segment
 */
async function extractFromSegment(
  segment: ConversationSegment,
  apiUrl: string,
  model: string,
  language: ReportLanguage
): Promise<SegmentExtractionResult> {
  const prompt = buildExtractionPrompt(segment, language);

  try {
    const requestManager = RequestManager.getInstance();
    const response = await requestManager.request(
      apiUrl,
      model,
      [{ role: "user", content: prompt }],
      EXTRACTOR_CONFIG.maxTokens,
      EXTRACTOR_CONFIG.temperature
    );

    const parsed = parseJsonResponse<{
      opinions?: Array<{
        statement?: string;
        stance?: string;
        confidence?: number;
        evolved?: boolean;
        keyMessageIds?: string[];
      }>;
    }>(response);

    const messageIdSet = new Set(segment.messages.map((m) => m.id));

    const opinions = (parsed.opinions || [])
      .filter((op) => op.statement && op.statement.trim().length > 0)
      .map((op) => ({
        id: uuidv4(),
        statement: op.statement!.trim(),
        stance: (VALID_STANCES.has(op.stance as ExtractedOpinion["stance"]) ? op.stance : "neutral") as ExtractedOpinion["stance"],
        confidence: Math.max(0, Math.min(1, op.confidence ?? 0.5)),
        evolved: op.evolved ?? false,
        source: {
          segmentId: segment.id,
          keyMessageIds: (op.keyMessageIds || []).filter((id) => messageIdSet.has(id)),
        },
        timestamp: segment.endTimestamp,
        threadId: segment.threadId,
      }));

    return { opinions, failed: false };
  } catch (error) {
    console.error(
      `[OpinionExtractor] Error extracting from segment ${segment.id}:`,
      error
    );
    return { opinions: [], failed: true };
  }
}

/**
 * Build LLM prompt for opinion extraction from a conversation segment
 */
function buildExtractionPrompt(
  segment: ConversationSegment,
  language: ReportLanguage
): string {
  const langInstruction = getLangInstruction(language, "opinion statements");

  const conversationLines = segment.messages.map((m) => {
    const role = m.isUser ? "User" : m.speaker;
    const content = truncate(m.content, EXTRACTOR_CONFIG.maxContentLength);
    return `[${role}] (id: ${m.id}) ${content}`;
  });

  return `You are extracting user opinions from a conversation between a user and an AI agent.

${langInstruction}

## Conversation
${conversationLines.join("\n")}

## Instructions
Extract opinions expressed by the USER only. Agent messages are context to help you understand the user's intent.

For each opinion:
1. Write a self-contained statement that is understandable without the conversation context
2. Determine the stance: "support", "oppose", "neutral", "request", or "question"
3. Rate confidence (0.0-1.0): how firmly the user holds this opinion
4. If the user's opinion changed during the conversation, set evolved to true
5. List the message IDs (from the conversation above) that are the basis for this opinion

Rules:
- Only extract opinions from USER messages. Never extract agent statements as opinions.
- If a user says "yes" or "I agree" in response to an agent, infer what they agree with and write it as a complete statement.
- Skip greetings, thanks, and other non-opinion utterances.
- Each opinion must be a complete, self-contained sentence.

Respond in JSON format only:
{
  "opinions": [
    {
      "statement": "The complete opinion statement",
      "stance": "request",
      "confidence": 0.8,
      "evolved": false,
      "keyMessageIds": ["msg-id-1", "msg-id-3"]
    }
  ]
}

If there are no extractable opinions, return: { "opinions": [] }`;
}

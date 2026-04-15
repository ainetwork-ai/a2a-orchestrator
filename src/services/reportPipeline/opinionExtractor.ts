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
        speaker?: string;
        statement?: string;
        quote?: string;
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
        speaker: op.speaker || "User",
        statement: op.statement!.trim(),
        stance: (VALID_STANCES.has(op.stance as ExtractedOpinion["stance"]) ? op.stance : "neutral") as ExtractedOpinion["stance"],
        confidence: Math.max(0, Math.min(1, op.confidence ?? 0.5)),
        evolved: op.evolved ?? false,
        quote: op.quote?.trim() || undefined,
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

  return `You are extracting opinions from a conversation between a user and an AI agent.

${langInstruction}

## Conversation
${conversationLines.join("\n")}

## Instructions
Extract opinions from ALL participants in the conversation — both users and AI agents. Every participant's ideas are equally valuable.

For each opinion:
1. Identify the speaker (use the exact name from the conversation: "User" or the agent's name)
2. Write a concise, debatable claim that others could agree or disagree with. Write it in the same language as the conversation.
3. Determine the stance: "support", "oppose", "neutral", "request", or "question"
4. Rate confidence using this guide:
   - 0.9+: explicit, decisive expressions ("must", "absolutely", "반드시", "절대")
   - 0.6-0.8: has opinion but hedged ("I think", "it would be nice", "~인 것 같다", "~하면 좋겠다")
   - 0.3-0.5: weak preference or questioning ("maybe?", "what about", "혹시 ~?", "~도 괜찮을까")
   - 0.1-0.2: barely expressed, speculative
5. Set evolved:
   - true ONLY when the user's position clearly shifted during the conversation (e.g., initially opposed then agreed, or stance changed after agent's explanation)
   - false when the user elaborates on the same opinion with more detail or provides additional information without changing stance
6. Provide a concise quote from the conversation that best supports this opinion. Use "[...]" to skip less relevant parts. The quote must be from the actual conversation above.
7. List the message IDs (from the conversation above) that are the basis for this opinion

## Quality Rules
CRITICAL — follow these strictly:
- Extract ZERO opinions for vague, meandering utterances that lack a clear point
- Extract ZERO opinions for anecdotes without a broader principle or stance
- ONLY extract opinions that represent genuinely debatable positions
- DO NOT extract: platitudes ("communication is important"), mere descriptions of experience without a stance, minor variations of the same idea, or questions without clear stances
- If similar points are made, treat them as ONE opinion rather than separate ones. Only separate truly distinct topics.
- If unsure whether something is a substantial opinion, err on the side of extracting NOTHING. Less noise is better than more coverage.
- Rhetorical questions imply a stance (e.g., "isn't it too slow?" = oppose)
- Personal stories often carry implicit opinions (e.g., "I tried it and closed it immediately" = oppose)
- Passive acceptance ("I guess so", "뭐... 그럴 수도") = low confidence, not strong support
- If a user says "yes" or "I agree" in response to an agent, infer what they agree with and write it as a complete statement.
- Skip greetings, thanks, and other non-opinion utterances.

Respond in JSON format only:
{
  "opinions": [
    {
      "speaker": "User",
      "statement": "다른 사람이 동의/반대할 수 있는 구체적인 주장",
      "quote": "대화에서 발췌한 핵심 인용문",
      "stance": "request",
      "confidence": 0.8,
      "evolved": false,
      "keyMessageIds": ["msg-id-1", "msg-id-3"]
    }
  ]
}

If there are no extractable opinions, return: { "opinions": [] }`;
}

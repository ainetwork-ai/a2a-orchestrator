/**
 * Shared utilities for report pipeline parsers (EPIC1)
 */

import ThreadManager from "../../world/threadManager";
import { Thread } from "../../types";
import {
  ReportRequestParams,
  ReportLanguage,
  ParsedMessage,
  ExtractedOpinion,
  MessageClusterWithSubtopics,
  DEFAULT_DATE_RANGE_DAYS,
} from "../../types/report";
import { EmbeddedMessage, CategorizedEmbeddedMessage } from "../../types/embedding";

/**
 * Filter threads by request params (threadIds, agentUrls, agentNames)
 */
export function filterThreads(params: ReportRequestParams, logPrefix: string): Thread[] {
  const threadManager = ThreadManager.getInstance();
  let threads = threadManager.getAllThreads();
  console.log(`[${logPrefix}] Found ${threads.length} total threads`);

  if (params.threadIds && params.threadIds.length > 0) {
    threads = threads.filter((t) => params.threadIds!.includes(t.id));
    console.log(`[${logPrefix}] Filtered to ${threads.length} threads by threadIds`);
  }

  if (params.agentUrls && params.agentUrls.length > 0) {
    threads = threads.filter((t) =>
      t.agents.some((agent) => params.agentUrls!.includes(agent.a2aUrl))
    );
    console.log(`[${logPrefix}] Filtered to ${threads.length} threads by agentUrls`);
  }

  if (params.agentNames && params.agentNames.length > 0) {
    threads = threads.filter((t) =>
      t.agents.some((agent) => params.agentNames!.includes(agent.name))
    );
    console.log(`[${logPrefix}] Filtered to ${threads.length} threads by agentNames`);
  }

  return threads;
}

/**
 * Resolve date range from request params with default fallback
 */
export function resolveDateRange(params: ReportRequestParams): { startDate: number; endDate: number } {
  const now = Date.now();
  const endDate = params.endDate ? new Date(params.endDate).getTime() : now;
  const startDate = params.startDate
    ? new Date(params.startDate).getTime()
    : endDate - DEFAULT_DATE_RANGE_DAYS * 24 * 60 * 60 * 1000;
  return { startDate, endDate };
}

/**
 * Anonymize content by removing potential PII
 * Korean-specific patterns are checked before general patterns to avoid partial matches.
 */
export function anonymizeContent(content: string): string {
  let anonymized = content;

  // Email addresses
  anonymized = anonymized.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    "[EMAIL]"
  );

  // Korean phone numbers (more specific, checked first)
  anonymized = anonymized.replace(/01[0-9]-?\d{3,4}-?\d{4}/g, "[PHONE]");

  // International phone numbers (general pattern)
  anonymized = anonymized.replace(
    /(\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{4}/g,
    "[PHONE]"
  );

  // URLs
  anonymized = anonymized.replace(/https?:\/\/[^\s]+/g, "[URL]");

  // Korean resident registration numbers
  anonymized = anonymized.replace(/\d{6}-?[1-4]\d{6}/g, "[ID_NUMBER]");

  // Credit card numbers
  anonymized = anonymized.replace(
    /\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}/g,
    "[CARD_NUMBER]"
  );

  return anonymized;
}

/**
 * Truncate text to a maximum length, appending "..." if truncated.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Build a language instruction string for LLM prompts.
 */
export function getLangInstruction(language: ReportLanguage, subject: string = "text content"): string {
  return language === "ko"
    ? `IMPORTANT: Write ALL ${subject} in Korean.`
    : `Write all ${subject} in English.`;
}

/**
 * Convert ExtractedOpinions to ParsedMessages for embedding.
 */
export function opinionsToParsedMessages(opinions: ExtractedOpinion[]): ParsedMessage[] {
  return opinions.map((op) => ({
    id: op.id,
    threadId: op.threadId,
    content: op.statement,
    timestamp: op.timestamp,
  }));
}

const STANCE_TO_SENTIMENT: Record<ExtractedOpinion["stance"], "positive" | "negative" | "neutral"> = {
  support: "positive",
  oppose: "negative",
  neutral: "neutral",
  request: "neutral",
  question: "neutral",
};

/**
 * Wrap EmbeddedMessages as CategorizedEmbeddedMessages using ExtractedOpinion metadata.
 * This allows the existing clusterer (which expects CategorizedEmbeddedMessage[]) to work
 * without modification, and populates category/sentiment for downstream stats.
 */
export function toCategorizedEmbedded(
  embeddedMessages: EmbeddedMessage[],
  opinions: ExtractedOpinion[]
): CategorizedEmbeddedMessage[] {
  const opinionMap = new Map(opinions.map((op) => [op.id, op]));

  return embeddedMessages.map((em) => {
    const opinion = opinionMap.get(em.id);
    const stance = opinion?.stance || "neutral";
    return {
      ...em,
      category: stance,
      sentiment: STANCE_TO_SENTIMENT[stance],
      isSubstantive: true,
    };
  });
}

/**
 * Post-process grounded clusters to attach sourceSegmentIds.
 * Links Opinion.supportingMessages (ExtractedOpinion IDs) → ExtractedOpinion.source.segmentId.
 */
export function attachSourceSegmentIds(
  clusters: MessageClusterWithSubtopics[],
  opinions: ExtractedOpinion[]
): MessageClusterWithSubtopics[] {
  const opinionMap = new Map(opinions.map((op) => [op.id, op]));

  return clusters.map((cluster) => ({
    ...cluster,
    opinions: cluster.opinions.map((op) => {
      const segmentIds = new Set<string>();
      for (const msgId of op.supportingMessages) {
        const extracted = opinionMap.get(msgId);
        if (extracted) {
          segmentIds.add(extracted.source.segmentId);
        }
      }
      return {
        ...op,
        sourceSegmentIds: segmentIds.size > 0 ? Array.from(segmentIds) : undefined,
      };
    }),
  }));
}

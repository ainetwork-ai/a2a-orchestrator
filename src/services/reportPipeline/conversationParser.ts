/**
 * Conversation-aware parser (EPIC1 - Story 1.1)
 *
 * Parses threads into conversation segments preserving both user and agent messages.
 * Segments are split by:
 * - Time gap (SEGMENT_TIME_GAP_MS)
 * - Agent change within a thread
 * - Max message count (MAX_SEGMENT_MESSAGES)
 *
 * User messages are anonymized; agent messages are kept as-is (used as context only).
 */

import { v4 as uuidv4 } from "uuid";
import ThreadManager from "../../world/threadManager";
import { Message } from "../../types";
import {
  ConversationSegment,
  ConversationParserResult,
  SegmentMessage,
  ReportRequestParams,
} from "../../types/report";
import { filterThreads, resolveDateRange, anonymizeContent } from "./pipelineUtils";

// Segment splitting constants
export const SEGMENT_TIME_GAP_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_SEGMENT_MESSAGES = 20;

/**
 * Parse threads into conversation segments (user + agent messages preserved)
 */
export async function parseConversations(
  params: ReportRequestParams
): Promise<ConversationParserResult> {
  console.log("[ConversationParser] Starting with params:", JSON.stringify(params));

  const threads = filterThreads(params, "ConversationParser");
  const { startDate, endDate } = resolveDateRange(params);

  console.log(
    `[ConversationParser] Date range: ${new Date(startDate).toISOString()} ~ ${new Date(endDate).toISOString()}`
  );

  const allSegments: ConversationSegment[] = [];
  const threadsWithSegments = new Set<string>();
  let totalMessages = 0;
  const threadManager = ThreadManager.getInstance();

  for (const thread of threads) {
    const world = threadManager.getWorld(thread.id);
    if (!world) continue;

    const history = world.getHistory();

    const dateFiltered = history.filter(
      (m) => m.timestamp >= startDate && m.timestamp <= endDate
    );

    if (dateFiltered.length === 0) continue;

    dateFiltered.sort((a, b) => a.timestamp - b.timestamp);

    const segments = splitIntoSegments(dateFiltered, thread.id);

    for (const segment of segments) {
      allSegments.push(segment);
      totalMessages += segment.messages.length;
      threadsWithSegments.add(thread.id);
    }
  }

  console.log(
    `[ConversationParser] Result: ${allSegments.length} segments, ${totalMessages} messages from ${threadsWithSegments.size} threads`
  );

  return {
    segments: allSegments,
    threadCount: threadsWithSegments.size,
    totalMessages,
  };
}

/**
 * Split a thread's messages into conversation segments
 */
function splitIntoSegments(
  messages: Message[],
  threadId: string
): ConversationSegment[] {
  if (messages.length === 0) return [];

  const segments: ConversationSegment[] = [];
  let currentMessages: SegmentMessage[] = [];
  let hasUserMessage = false;
  let lastTimestamp = messages[0].timestamp;
  // Tracks the last agent speaker to detect agent changes within a segment.
  // Retains its value across user messages intentionally — a user speaking
  // doesn't reset which agent was last active.
  let lastNonUserSpeaker: string | null = null;

  const flushSegment = () => {
    if (currentMessages.length === 0) return;

    if (hasUserMessage) {
      segments.push({
        id: uuidv4(),
        threadId,
        messages: currentMessages,
        startTimestamp: currentMessages[0].timestamp,
        endTimestamp: currentMessages[currentMessages.length - 1].timestamp,
      });
    }

    currentMessages = [];
    hasUserMessage = false;
  };

  for (const msg of messages) {
    const isUser = msg.speaker === "User";
    const currentNonUserSpeaker = isUser ? null : msg.speaker;

    const timeGap = msg.timestamp - lastTimestamp > SEGMENT_TIME_GAP_MS;
    const agentChanged =
      currentNonUserSpeaker !== null &&
      lastNonUserSpeaker !== null &&
      currentNonUserSpeaker !== lastNonUserSpeaker;
    const maxReached = currentMessages.length >= MAX_SEGMENT_MESSAGES;

    if (currentMessages.length > 0 && (timeGap || agentChanged || maxReached)) {
      flushSegment();
    }

    const content = isUser ? anonymizeContent(msg.content.trim()) : msg.content.trim();

    currentMessages.push({
      id: msg.id,
      speaker: msg.speaker,
      content,
      timestamp: msg.timestamp,
      isUser,
    });

    if (isUser) hasUserMessage = true;
    lastTimestamp = msg.timestamp;
    if (currentNonUserSpeaker !== null) {
      lastNonUserSpeaker = currentNonUserSpeaker;
    }
  }

  flushSegment();

  return segments;
}

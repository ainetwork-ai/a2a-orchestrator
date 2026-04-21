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
import { filterThreads, resolveDateRange, anonymizeContent, cosineSimilarity } from "./pipelineUtils";

// Segment splitting constants
export const SEGMENT_TIME_GAP_MS = 5 * 60 * 1000; // 5 minutes
export const MAX_SEGMENT_MESSAGES = 20;
export const TOPIC_SHIFT_THRESHOLD = 0.4; // cosine similarity below this = topic change (0.65 was too aggressive)

/**
 * Collect raw messages from threads grouped by thread ID.
 */
export async function collectRawMessages(
  params: ReportRequestParams
): Promise<{
  threadCount: number;
  totalMessageCount: number;
  threadMessages: Map<string, SegmentMessage[]>;
}> {
  const threads = filterThreads(params, "ConversationParser");
  const { startDate, endDate } = resolveDateRange(params);

  const threadMessages = new Map<string, SegmentMessage[]>();
  let totalMessageCount = 0;
  const threadManager = ThreadManager.getInstance();

  for (const thread of threads) {
    const world = threadManager.getWorld(thread.id);
    if (!world) continue;

    const history = world.getHistory();
    const dateFiltered = history.filter(
      (m) => m.timestamp >= startDate && m.timestamp <= endDate
    );

    if (dateFiltered.length === 0) continue;

    const threadMsgs: SegmentMessage[] = [];
    for (const msg of dateFiltered) {
      const isUser = msg.speaker === "User";
      threadMsgs.push({
        id: msg.id,
        speaker: msg.speaker,
        content: isUser ? anonymizeContent(msg.content.trim()) : msg.content.trim(),
        timestamp: msg.timestamp,
        isUser,
      });
    }
    threadMessages.set(thread.id, threadMsgs);
    totalMessageCount += threadMsgs.length;
  }

  return { threadCount: threadMessages.size, totalMessageCount, threadMessages };
}

/**
 * Parse threads into conversation segments (user + agent messages preserved)
 */
export async function parseConversations(
  params: ReportRequestParams,
  embeddings?: Map<string, number[]>
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

    let segments = splitIntoSegments(dateFiltered, thread.id, embeddings);

    // Filter segments to only those where the requested agent(s) participated
    segments = filterSegmentsByAgent(segments, params);

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
  threadId: string,
  embeddings?: Map<string, number[]>
): ConversationSegment[] {
  if (messages.length === 0) return [];

  const segments: ConversationSegment[] = [];
  let currentMessages: SegmentMessage[] = [];
  let lastTimestamp = messages[0].timestamp;
  // Tracks the last agent speaker to detect agent changes within a segment.
  // Retains its value across user messages intentionally — a user speaking
  // doesn't reset which agent was last active.
  let lastNonUserSpeaker: string | null = null;

  const flushSegment = () => {
    if (currentMessages.length === 0) return;

    segments.push({
      id: uuidv4(),
      threadId,
      messages: currentMessages,
      startTimestamp: currentMessages[0].timestamp,
      endTimestamp: currentMessages[currentMessages.length - 1].timestamp,
    });

    currentMessages = [];
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

    // Topic shift detection via embedding cosine similarity
    let topicShift = false;
    if (embeddings && currentMessages.length > 0) {
      const lastMsg = currentMessages[currentMessages.length - 1];
      const lastEmb = embeddings.get(lastMsg.id);
      const currEmb = embeddings.get(msg.id);
      if (lastEmb && currEmb) {
        topicShift = cosineSimilarity(lastEmb, currEmb) < TOPIC_SHIFT_THRESHOLD;
      }
    }

    if (currentMessages.length > 0 && (timeGap || agentChanged || maxReached || topicShift)) {
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

    lastTimestamp = msg.timestamp;
    if (currentNonUserSpeaker !== null) {
      lastNonUserSpeaker = currentNonUserSpeaker;
    }
  }

  flushSegment();

  return segments;
}

/**
 * Filter segments to only those where the requested agent(s) participated.
 * If no agent filter is specified, all segments pass through.
 */
function filterSegmentsByAgent(
  segments: ConversationSegment[],
  params: ReportRequestParams
): ConversationSegment[] {
  const hasAgentFilter =
    (params.agentNames && params.agentNames.length > 0) ||
    (params.agentUrls && params.agentUrls.length > 0);

  if (!hasAgentFilter) return segments;

  // agentNames filter: keep segments where at least one non-user message is from a requested agent
  const targetNames = new Set(params.agentNames || []);

  return segments.filter((segment) =>
    segment.messages.some((m) => !m.isUser && targetNames.has(m.speaker))
  );
}

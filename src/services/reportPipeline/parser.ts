import ThreadManager from "../../world/threadManager";
import AgentService from "../agentService";
import { Message } from "../../types";
import {
  ParsedMessage,
  ParserResult,
  ReportRequestParams,
  DEFAULT_MAX_MESSAGES,
  DEFAULT_DATE_RANGE_DAYS,
  MIN_MESSAGE_LENGTH,
} from "../../types/report";

// Flag to ensure agent registration only runs once (for migrating existing data)
let agentsMigrated = false;

/**
 * Parse threads and extract user messages with anonymization
 * Applies date filtering and sampling if message count exceeds limit
 */
export async function parseThreads(params: ReportRequestParams): Promise<ParserResult> {
  console.log("[Parser] Starting parseThreads with params:", JSON.stringify(params));
  const threadManager = ThreadManager.getInstance();

  // Get threads to analyze
  let threads = threadManager.getAllThreads();
  console.log(`[Parser] Found ${threads.length} total threads`);

  // Filter by specific thread IDs if provided
  if (params.threadIds && params.threadIds.length > 0) {
    threads = threads.filter(t => params.threadIds!.includes(t.id));
    console.log(`[Parser] Filtered to ${threads.length} threads by threadIds`);
  }

  // Filter by agent URLs if provided (threads that include any of these agents)
  if (params.agentUrls && params.agentUrls.length > 0) {
    threads = threads.filter(t =>
      t.agents.some(agent => params.agentUrls!.includes(agent.a2aUrl))
    );
    console.log(`[Parser] Filtered to ${threads.length} threads by agentUrls`);
  }

  // Filter by agent names if provided (threads that include any of these agents)
  if (params.agentNames && params.agentNames.length > 0) {
    threads = threads.filter(t =>
      t.agents.some(agent => params.agentNames!.includes(agent.name))
    );
    console.log(`[Parser] Filtered to ${threads.length} threads by agentNames`);
  }

  // Apply default date range if not specified (last 30 days)
  const now = Date.now();
  const endDate = params.endDate ? new Date(params.endDate).getTime() : now;
  const startDate = params.startDate
    ? new Date(params.startDate).getTime()
    : endDate - DEFAULT_DATE_RANGE_DAYS * 24 * 60 * 60 * 1000;
  const maxMessages = params.maxMessages || DEFAULT_MAX_MESSAGES;

  console.log(`[Parser] Date range: ${new Date(startDate).toISOString()} ~ ${new Date(endDate).toISOString()}`);
  console.log(`[Parser] Max messages: ${maxMessages}`);

  const parsedMessages: ParsedMessage[] = [];
  const threadsWithMessages = new Set<string>();

  for (const thread of threads) {
    const world = threadManager.getWorld(thread.id);
    if (!world) continue;

    const messages = world.getHistory();

    // Filter user messages only
    const userMessages = messages.filter(m => m.speaker === "User");

    for (const msg of userMessages) {
      // Apply date filter
      if (msg.timestamp < startDate) continue;
      if (msg.timestamp > endDate) continue;

      // Filter out too short messages (likely greetings/noise)
      const trimmedContent = msg.content.trim();
      if (trimmedContent.length < MIN_MESSAGE_LENGTH) {
        continue;
      }

      // Anonymize: remove any potential PII from content
      const anonymizedContent = anonymizeContent(trimmedContent);

      parsedMessages.push({
        id: msg.id,
        content: anonymizedContent,
        timestamp: msg.timestamp,
        // userId is intentionally not included for anonymization
      });

      // Track threads that have at least one valid message
      threadsWithMessages.add(thread.id);
    }
  }

  const totalMessagesBeforeSampling = parsedMessages.length;
  let wasSampled = false;

  // Sample if exceeds max messages, then sort once
  let finalMessages = parsedMessages;
  if (parsedMessages.length > maxMessages) {
    console.log(`[Parser] Sampling ${maxMessages} from ${parsedMessages.length} messages`);
    finalMessages = sampleMessages(parsedMessages, maxMessages);
    wasSampled = true;
  }

  // Sort by timestamp ascending for analysis (single sort)
  finalMessages.sort((a, b) => a.timestamp - b.timestamp);

  const threadCount = threadsWithMessages.size;
  console.log(`[Parser] Result: ${finalMessages.length} messages from ${threadCount} threads (${threads.length - threadCount} empty threads excluded, sampled: ${wasSampled})`);

  // Register agents from threads with messages to Redis Set (one-time migration for existing data)
  if (!agentsMigrated && threadsWithMessages.size > 0) {
    agentsMigrated = true;
    const agentsToRegister = threads
      .filter(t => threadsWithMessages.has(t.id))
      .flatMap(t => t.agents)
      .filter(a => a.name && a.a2aUrl)
      .map(a => ({ name: a.name, a2aUrl: a.a2aUrl }));

    if (agentsToRegister.length > 0) {
      const agentService = AgentService.getInstance();
      agentService.registerAgents(agentsToRegister);
      console.log(`[Parser] Migrated ${agentsToRegister.length} agents to Redis Set (one-time)`);
    }
  }

  return {
    messages: finalMessages,
    threadCount,
    totalMessagesBeforeSampling,
    wasSampled,
  };
}

/**
 * Sample messages with stratified approach (without pre-sorting)
 * - Takes recent messages with higher priority (70%)
 * - Random sample from older messages (30%)
 */
function sampleMessages(messages: ParsedMessage[], maxCount: number): ParsedMessage[] {
  if (messages.length <= maxCount) return messages;

  // Strategy: 70% recent, 30% random from older
  const recentCount = Math.floor(maxCount * 0.7);
  const randomCount = maxCount - recentCount;

  // Find the timestamp threshold for "recent" messages using partial sort (quickselect-like)
  // Sort by timestamp descending, take indices of top recentCount
  const indexed = messages.map((m, i) => ({ idx: i, ts: m.timestamp }));
  indexed.sort((a, b) => b.ts - a.ts); // Sort indices by timestamp desc

  const recentIndices = new Set(indexed.slice(0, recentCount).map(x => x.idx));
  const olderIndices = indexed.slice(recentCount).map(x => x.idx);

  // Random sample from older messages
  for (let i = olderIndices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [olderIndices[i], olderIndices[j]] = [olderIndices[j], olderIndices[i]];
  }
  const sampledOlderIndices = new Set(olderIndices.slice(0, randomCount));

  // Collect sampled messages (preserves original order for final sort)
  const result: ParsedMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (recentIndices.has(i) || sampledOlderIndices.has(i)) {
      result.push(messages[i]);
    }
  }

  return result;
}

/**
 * Anonymize content by removing potential PII
 */
function anonymizeContent(content: string): string {
  let anonymized = content;

  // Remove email addresses
  anonymized = anonymized.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    "[EMAIL]"
  );

  // Remove phone numbers (various formats)
  anonymized = anonymized.replace(
    /(\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{4}/g,
    "[PHONE]"
  );

  // Remove Korean phone numbers
  anonymized = anonymized.replace(
    /01[0-9]-?\d{3,4}-?\d{4}/g,
    "[PHONE]"
  );

  // Remove URLs with potential user info
  anonymized = anonymized.replace(
    /https?:\/\/[^\s]+/g,
    "[URL]"
  );

  // Remove potential Korean resident registration numbers
  anonymized = anonymized.replace(
    /\d{6}-?[1-4]\d{6}/g,
    "[ID_NUMBER]"
  );

  // Remove credit card numbers (basic pattern)
  anonymized = anonymized.replace(
    /\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}/g,
    "[CARD_NUMBER]"
  );

  return anonymized;
}

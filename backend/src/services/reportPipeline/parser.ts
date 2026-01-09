import ThreadManager from "../../world/threadManager";
import { Message } from "../../types";
import { ParsedMessage, ParserResult, ReportRequestParams } from "../../types/report";

/**
 * Parse threads and extract user messages with anonymization
 */
export async function parseThreads(params: ReportRequestParams): Promise<ParserResult> {
  const threadManager = ThreadManager.getInstance();

  // Get threads to analyze
  let threads = threadManager.getAllThreads();

  // Filter by specific thread IDs if provided
  if (params.threadIds && params.threadIds.length > 0) {
    threads = threads.filter(t => params.threadIds!.includes(t.id));
  }

  const parsedMessages: ParsedMessage[] = [];

  for (const thread of threads) {
    const world = threadManager.getWorld(thread.id);
    if (!world) continue;

    const messages = world.getHistory();

    // Filter user messages only
    const userMessages = messages.filter(m => m.speaker === "User");

    for (const msg of userMessages) {
      // Apply date filter if provided
      if (params.startDate && msg.timestamp < params.startDate) continue;
      if (params.endDate && msg.timestamp > params.endDate) continue;

      // Anonymize: remove any potential PII from content
      const anonymizedContent = anonymizeContent(msg.content);

      parsedMessages.push({
        id: msg.id,
        content: anonymizedContent,
        timestamp: msg.timestamp,
        // userId is intentionally not included for anonymization
      });
    }
  }

  // Sort by timestamp
  parsedMessages.sort((a, b) => a.timestamp - b.timestamp);

  return {
    messages: parsedMessages,
    threadCount: threads.length,
  };
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

import RequestManager from "../../world/requestManager";
import { ParsedMessage, CategorizedMessage, CategorizerResult, ReportLanguage, CATEGORIZER_BATCH_SIZE, FilteringBreakdown, MIN_MESSAGE_LENGTH } from "../../types/report";
import { parseJsonResponse } from "../../utils/llm";

/**
 * Categorize messages using LLM
 */
export async function categorizeMessages(
  messages: ParsedMessage[],
  apiUrl: string,
  model: string,
  language: ReportLanguage = "en"
): Promise<CategorizerResult> {
  console.log(`[Categorizer] Starting categorization: ${messages.length} messages, language=${language}`);

  // Create all batch promises in parallel
  const batchPromises: Promise<CategorizedMessage[]>[] = [];

  for (let i = 0; i < messages.length; i += CATEGORIZER_BATCH_SIZE) {
    const batch = messages.slice(i, i + CATEGORIZER_BATCH_SIZE);
    batchPromises.push(categorizeBatch(batch, apiUrl, model, language));
  }
  console.log(`[Categorizer] Created ${batchPromises.length} batch promises (batch size: ${CATEGORIZER_BATCH_SIZE})`);

  // Wait for all batches to complete
  const batchResults = await Promise.all(batchPromises);
  const categorizedMessages = batchResults.flat();

  // Detailed filtering analysis
  const substantiveCount = categorizedMessages.filter(m => m.isSubstantive).length;
  const nonSubstantiveCount = categorizedMessages.length - substantiveCount;

  // Calculate filtering breakdown by reason
  const filteringBreakdown = calculateFilteringBreakdown(categorizedMessages);

  console.log(`[Categorizer] Completed: ${categorizedMessages.length} messages categorized`);
  console.log(`[Categorizer] Substantive: ${substantiveCount}, Non-substantive: ${nonSubstantiveCount}`);
  console.log(`[Categorizer] Filtering breakdown: greetings=${filteringBreakdown.greetings}, chitchat=${filteringBreakdown.chitchat}, shortMessages=${filteringBreakdown.shortMessages}, other=${filteringBreakdown.other}`);

  // Log examples of filtered messages (for debugging)
  const nonSubstantiveExamples = categorizedMessages
    .filter(m => !m.isSubstantive)
    .slice(0, 5)
    .map(m => `"${m.content.substring(0, 30)}..." (${m.category})`);

  if (nonSubstantiveExamples.length > 0) {
    console.log(`[Categorizer] Non-substantive examples:`, nonSubstantiveExamples);
  }

  // Log detailed category breakdown by substantive status
  const categoryBreakdown: Record<string, { substantive: number; nonSubstantive: number }> = {};
  for (const msg of categorizedMessages) {
    if (!categoryBreakdown[msg.category]) {
      categoryBreakdown[msg.category] = { substantive: 0, nonSubstantive: 0 };
    }
    if (msg.isSubstantive) {
      categoryBreakdown[msg.category].substantive++;
    } else {
      categoryBreakdown[msg.category].nonSubstantive++;
    }
  }

  console.log(`[Categorizer] Category breakdown by substantive status:`);
  for (const [category, counts] of Object.entries(categoryBreakdown)) {
    const total = counts.substantive + counts.nonSubstantive;
    const filterRate = total > 0 ? ((counts.nonSubstantive / total) * 100).toFixed(1) : "0.0";
    console.log(`  ${category}: ${counts.substantive} substantive, ${counts.nonSubstantive} non-substantive (${filterRate}% filtered)`);
  }

  // Log overall filtering rate
  const filteringRate = categorizedMessages.length > 0
    ? ((nonSubstantiveCount / categorizedMessages.length) * 100).toFixed(1)
    : "0.0";
  console.log(`[Categorizer] Overall filtering rate: ${filteringRate}%`);

  // Warning for high filtering rates
  if (parseFloat(filteringRate) > 80) {
    console.warn(`[Categorizer] WARNING: High filtering rate (${filteringRate}%). Consider reviewing categorizer prompts.`);
  }

  return { messages: categorizedMessages, filteringBreakdown };
}

/**
 * Calculate filtering breakdown by reason
 * Categories: greetings, chitchat, shortMessages, other
 */
function calculateFilteringBreakdown(messages: CategorizedMessage[]): FilteringBreakdown {
  const breakdown: FilteringBreakdown = {
    greetings: 0,
    chitchat: 0,
    shortMessages: 0,
    other: 0,
  };

  // Greeting patterns (case-insensitive)
  const greetingPatterns = /^(hi|hello|hey|안녕|하이|헬로|good\s*(morning|afternoon|evening)|greetings)[\s!.?]*$/i;

  // Chitchat patterns (acknowledgments, simple responses)
  const chitchatPatterns = /^(ok|okay|yes|no|yeah|yep|nope|thanks|thank you|thx|ty|ㅇㅇ|ㄴㄴ|ㅋ+|ㅎ+|lol|haha|good|nice|cool|great|sure|alright|got it|i see|understood)[\s!.?]*$/i;

  for (const msg of messages) {
    if (msg.isSubstantive) continue;

    const content = msg.content.trim();

    // Check for short messages first
    if (content.length < MIN_MESSAGE_LENGTH) {
      breakdown.shortMessages++;
    }
    // Check for greetings
    else if (greetingPatterns.test(content) || msg.category === "greeting") {
      breakdown.greetings++;
    }
    // Check for chitchat
    else if (chitchatPatterns.test(content) || msg.category === "other" && content.length < 20) {
      breakdown.chitchat++;
    }
    // Other non-substantive
    else {
      breakdown.other++;
    }
  }

  return breakdown;
}

async function categorizeBatch(
  messages: ParsedMessage[],
  apiUrl: string,
  model: string,
  language: ReportLanguage
): Promise<CategorizedMessage[]> {
  const messagesForPrompt = messages.map((m, idx) => ({
    index: idx,
    content: m.content,
  }));

  const langInstruction = language === "ko"
    ? "IMPORTANT: Write all text fields (subCategory, intent) in Korean."
    : "Write all text fields in English.";

  const prompt = `Analyze the following user messages and categorize each one.

${langInstruction}

Messages:
${JSON.stringify(messagesForPrompt, null, 2)}

For each message, determine:
1. category: Main category (one of: "question", "request", "feedback", "complaint", "information", "greeting", "other")
2. subCategory: More specific sub-category (e.g., "technical_question", "feature_request", "bug_report", etc.)
3. intent: What the user is trying to accomplish
4. sentiment: Overall sentiment ("positive", "negative", or "neutral")
5. isSubstantive: Boolean - Does this message have analytical value?
   - true: Meaningful questions, requests, feedback, complaints, or information that provides insight
   - false: Greetings, small talk, simple acknowledgments ("ok", "thanks"), identity questions ("who are you?"), or chitchat with no actionable content

Respond in JSON format only:
{
  "results": [
    {
      "index": 0,
      "category": "question",
      "subCategory": "technical_question",
      "intent": "Understanding how to use a feature",
      "sentiment": "neutral",
      "isSubstantive": true
    }
  ]
}`;

  try {
    const requestManager = RequestManager.getInstance();
    const response = await requestManager.request(
      apiUrl,
      model,
      [{ role: "user", content: prompt }],
      2000,
      0.3
    );

    // Parse JSON response
    const parsed = parseJsonResponse<{ results?: any[] }>(response);
    const results = parsed.results || [];

    // Map results back to messages
    return messages.map((msg, idx) => {
      const result = results.find((r: any) => r.index === idx) || {};
      return {
        ...msg,
        category: result.category || "other",
        subCategory: result.subCategory,
        intent: result.intent,
        sentiment: result.sentiment || "neutral",
        isSubstantive: result.isSubstantive !== false, // Default to true if not specified
      };
    });
  } catch (error) {
    console.error("[Categorizer] Error categorizing batch:", error);
    // On error, return messages with default category
    return messages.map(msg => ({
      ...msg,
      category: "other",
      sentiment: "neutral" as const,
      isSubstantive: true, // Default to true on error
    }));
  }
}

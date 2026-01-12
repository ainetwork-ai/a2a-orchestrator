import RequestManager from "../../world/requestManager";
import { ParsedMessage, CategorizedMessage, CategorizerResult } from "../../types/report";

const BATCH_SIZE = 10; // Process messages in batches to reduce API calls

/**
 * Categorize messages using LLM
 */
export async function categorizeMessages(
  messages: ParsedMessage[],
  apiUrl: string,
  model: string
): Promise<CategorizerResult> {
  const categorizedMessages: CategorizedMessage[] = [];

  // Process in batches
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    const batchResults = await categorizeBatch(batch, apiUrl, model);
    categorizedMessages.push(...batchResults);
  }

  return { messages: categorizedMessages };
}

async function categorizeBatch(
  messages: ParsedMessage[],
  apiUrl: string,
  model: string
): Promise<CategorizedMessage[]> {
  const messagesForPrompt = messages.map((m, idx) => ({
    index: idx,
    content: m.content,
  }));

  const prompt = `Analyze the following user messages and categorize each one.

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
    let jsonStr = response.trim();
    if (jsonStr.startsWith("```json")) {
      jsonStr = jsonStr.replace(/```json\s*/g, "").replace(/```\s*/g, "");
    } else if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/```\s*/g, "");
    }

    const parsed = JSON.parse(jsonStr);
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

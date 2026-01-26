import RequestManager from "../../world/requestManager";
import { CategorizedMessage, MessageCluster, ClustererResult, ReportLanguage, ClusterSummary, ActionItem, CLUSTERER_BATCH_SIZE, SAMPLE_SIZE_FOR_TOPICS, MAX_SAMPLE_MESSAGES_PER_CLUSTER } from "../../types/report";
import { v4 as uuidv4 } from "uuid";
import { parseJsonResponse } from "../../utils/llm";

/**
 * Cluster messages by topic and gather opinions using LLM
 */
export async function clusterMessages(
  messages: CategorizedMessage[],
  apiUrl: string,
  model: string,
  language: ReportLanguage = "en"
): Promise<ClustererResult> {
  console.log(`[Clusterer] Starting clustering: ${messages.length} messages, language=${language}`);

  if (messages.length === 0) {
    console.warn("[Clusterer] No substantive messages to cluster");
    return { clusters: [] };
  }

  // First, identify main topics
  console.log("[Clusterer] Step 1: Identifying topics...");
  const topics = await identifyTopics(messages, apiUrl, model, language);
  console.log(`[Clusterer] Identified ${topics.length} topics:`, topics);

  // Then, assign messages to topics and gather opinions
  console.log("[Clusterer] Step 2: Assigning messages to topics...");
  const clusters = await assignMessagesToTopics(messages, topics, apiUrl, model, language);
  console.log(`[Clusterer] Created ${clusters.length} clusters`);

  return { clusters };
}

async function identifyTopics(
  messages: CategorizedMessage[],
  apiUrl: string,
  model: string,
  language: ReportLanguage
): Promise<string[]> {
  // Sample messages if too many (to reduce token usage)
  const sampleSize = Math.min(messages.length, SAMPLE_SIZE_FOR_TOPICS);
  const sampledMessages = messages
    .sort(() => Math.random() - 0.5)
    .slice(0, sampleSize);

  const messageContents = sampledMessages.map(m => m.content).join("\n---\n");

  const langInstruction = language === "ko"
    ? "IMPORTANT: Write all topic names and descriptions in Korean."
    : "Write all topic names and descriptions in English.";

  const prompt = `Analyze the following user messages and identify the main topics/themes being discussed.

${langInstruction}

Messages:
${messageContents}

Instructions:
1. Identify 3-10 main topics that emerge from these messages
2. Topics should be specific enough to be meaningful but broad enough to group multiple messages
3. Focus on what users are asking about or discussing

Respond in JSON format only:
{
  "topics": [
    {
      "name": "Topic name",
      "description": "Brief description of what this topic covers"
    }
  ]
}`;

  try {
    const requestManager = RequestManager.getInstance();
    const response = await requestManager.request(
      apiUrl,
      model,
      [{ role: "user", content: prompt }],
      1500,
      0.3
    );

    const parsed = parseJsonResponse<{ topics?: { name: string }[] }>(response);
    return parsed.topics?.map((t) => t.name) || [];
  } catch (error) {
    console.error("[Clusterer] Error identifying topics:", error);
    // Fallback: use categories as topics
    const categories = [...new Set(messages.map(m => m.category))];
    return categories;
  }
}

async function assignMessagesToTopics(
  messages: CategorizedMessage[],
  topics: string[],
  apiUrl: string,
  model: string,
  language: ReportLanguage
): Promise<MessageCluster[]> {
  if (topics.length === 0) {
    console.warn("[Clusterer] No topics to assign messages to - returning empty clusters");
    return [];
  }
  console.log(`[Clusterer] Assigning ${messages.length} messages to ${topics.length} topics: [${topics.join(", ")}]`);

  // Process in batches (parallel)
  const assignments: Map<string, CategorizedMessage[]> = new Map();
  topics.forEach(topic => assignments.set(topic, []));

  // Create all batch promises in parallel
  const batchPromises: Promise<Record<string, CategorizedMessage[]>>[] = [];
  for (let i = 0; i < messages.length; i += CLUSTERER_BATCH_SIZE) {
    const batch = messages.slice(i, i + CLUSTERER_BATCH_SIZE);
    batchPromises.push(assignBatchToTopics(batch, topics, apiUrl, model));
  }
  console.log(`[Clusterer] Created ${batchPromises.length} assignment batch promises`);

  // Wait for all batches to complete
  const batchResults = await Promise.all(batchPromises);
  console.log("[Clusterer] All assignment batches completed");

  // Merge results
  for (const batchAssignments of batchResults) {
    for (const [topic, msgs] of Object.entries(batchAssignments)) {
      const existing = assignments.get(topic) || [];
      assignments.set(topic, [...existing, ...msgs]);
    }
  }

  // Create clusters and summarize opinions for each (parallel)
  const topicsWithMessages = Array.from(assignments.entries()).filter(
    ([, msgs]) => msgs.length > 0
  );

  // Log assignment results
  const assignmentSummary = Array.from(assignments.entries())
    .map(([topic, msgs]) => `${topic}:${msgs.length}`)
    .join(", ");
  console.log(`[Clusterer] Assignment results: ${assignmentSummary}`);
  console.log(`[Clusterer] Topics with messages: ${topicsWithMessages.length} / ${topics.length}`);

  if (topicsWithMessages.length === 0) {
    console.warn("[Clusterer] No topics have any assigned messages");
    console.log("[Clusterer] Debug info:", {
      totalMessages: messages.length,
      totalTopics: topics.length,
      batchResults: batchResults.map(br => Object.keys(br).length)
    });
    return [];
  }

  // Analyze clusters in parallel (opinions + summary + next steps)
  console.log(`[Clusterer] Analyzing ${topicsWithMessages.length} clusters...`);
  const analysisPromises = topicsWithMessages.map(([topic, topicMessages]) =>
    analyzeCluster(topicMessages, topic, apiUrl, model, language)
  );
  const analysisResults = await Promise.all(analysisPromises);
  console.log("[Clusterer] Cluster analysis completed");

  // Build clusters with defensive filtering
  // Input messages should already be filtered, but we apply isSubstantive check defensively
  const clusters: MessageCluster[] = topicsWithMessages.map(
    ([topic, topicMessages], idx) => {
      // Defensive filter: ensure only substantive messages are included
      const substantiveMessages = topicMessages.filter(m => m.isSubstantive);
      if (substantiveMessages.length < topicMessages.length) {
        console.warn(
          `[Clusterer] Defensive filter removed ${topicMessages.length - substantiveMessages.length} non-substantive messages from topic "${topic}"`
        );
      }
      return {
        id: uuidv4(),
        topic,
        description: `Messages related to "${topic}"`,
        messages: substantiveMessages,
        opinions: analysisResults[idx].opinions,
        summary: analysisResults[idx].summary,
        nextSteps: analysisResults[idx].nextSteps,
      };
    }
  );

  // Sort by message count (most discussed first)
  clusters.sort((a, b) => b.messages.length - a.messages.length);

  return clusters;
}

async function assignBatchToTopics(
  messages: CategorizedMessage[],
  topics: string[],
  apiUrl: string,
  model: string
): Promise<Record<string, CategorizedMessage[]>> {
  const messagesForPrompt = messages.map((m, idx) => ({
    index: idx,
    content: m.content,
  }));

  const prompt = `Assign each message to the most relevant topic by topic number.

Topics:
${topics.map((t, i) => `${i + 1}. ${t}`).join("\n")}

Messages:
${JSON.stringify(messagesForPrompt, null, 2)}

Instructions:
- Assign each message to exactly one topic using the topic NUMBER (1, 2, 3, etc.)
- If a message doesn't fit any topic well, assign it to the closest match

Respond in JSON format only:
{
  "assignments": [
    { "index": 0, "topic_number": 1 }
  ]
}`;

  try {
    const requestManager = RequestManager.getInstance();
    const response = await requestManager.request(
      apiUrl,
      model,
      [{ role: "user", content: prompt }],
      1500,
      0.3
    );

    const parsed = parseJsonResponse<{ assignments?: { index: number; topic_number: number; topic?: string }[] }>(response);
    const result: Record<string, CategorizedMessage[]> = {};
    topics.forEach(t => (result[t] = []));

    let matchedCount = 0;
    for (const assignment of parsed.assignments || []) {
      const msg = messages[assignment.index];
      // Use topic_number (1-indexed) to get the actual topic name
      const topicIndex = (assignment.topic_number ?? 0) - 1;
      const topic = topics[topicIndex] || assignment.topic; // Fallback to topic name if provided

      if (msg && topic && result[topic] !== undefined) {
        result[topic].push(msg);
        matchedCount++;
      }
    }
    console.log(`[Clusterer] Batch assignment: ${matchedCount}/${messages.length} messages matched`);

    return result;
  } catch (error) {
    console.error("[Clusterer] Error assigning batch to topics:", error);
    // Fallback: assign all to first topic
    const result: Record<string, CategorizedMessage[]> = {};
    topics.forEach(t => (result[t] = []));
    if (topics.length > 0) {
      result[topics[0]] = messages;
    }
    return result;
  }
}

interface ClusterAnalysisResult {
  opinions: string[];
  summary: ClusterSummary;
  nextSteps: ActionItem[];
}

async function analyzeCluster(
  messages: CategorizedMessage[],
  topic: string,
  apiUrl: string,
  model: string,
  language: ReportLanguage
): Promise<ClusterAnalysisResult> {
  const defaultResult: ClusterAnalysisResult = {
    opinions: [`${messages.length} messages about this topic`],
    summary: { consensus: [], conflicting: [], sentiment: "neutral" },
    nextSteps: [],
  };

  if (messages.length === 0) return defaultResult;

  // Sample if too many messages
  const sampleSize = Math.min(messages.length, MAX_SAMPLE_MESSAGES_PER_CLUSTER);
  const sampledMessages = messages
    .sort(() => Math.random() - 0.5)
    .slice(0, sampleSize);

  const messageContents = sampledMessages.map(m => m.content).join("\n---\n");

  // Calculate sentiment distribution for context
  const sentimentCounts = { positive: 0, negative: 0, neutral: 0 };
  for (const msg of messages) {
    if (msg.sentiment) sentimentCounts[msg.sentiment]++;
  }

  const langInstruction = language === "ko"
    ? "IMPORTANT: Write ALL text content in Korean."
    : "Write all text content in English.";

  const prompt = `Analyze the user feedback about "${topic}" and provide actionable insights.

${langInstruction}

Messages (${messages.length} total, showing sample of ${sampledMessages.length}):
${messageContents}

Sentiment distribution: ${sentimentCounts.positive} positive, ${sentimentCounts.negative} negative, ${sentimentCounts.neutral} neutral

Instructions:
1. Identify 3-7 distinct opinions expressed by users
2. Summarize common opinions (consensus) and conflicting opinions (if any)
3. Determine overall sentiment: "positive", "negative", "mixed", or "neutral"
4. Suggest 1-3 actionable next steps based on the feedback, with priority (high/medium/low) and rationale

Respond in JSON format only:
{
  "opinions": [
    "Opinion 1: ...",
    "Opinion 2: ..."
  ],
  "summary": {
    "consensus": ["Common opinion 1", "Common opinion 2"],
    "conflicting": ["Some users want X while others prefer Y"],
    "sentiment": "mixed"
  },
  "nextSteps": [
    {
      "action": "Specific action to take",
      "priority": "high",
      "rationale": "Why this is important based on user feedback"
    }
  ]
}`;

  try {
    const requestManager = RequestManager.getInstance();
    const response = await requestManager.request(
      apiUrl,
      model,
      [{ role: "user", content: prompt }],
      1500,
      0.5
    );

    const parsed = parseJsonResponse<{
      opinions?: any[];
      summary?: { consensus?: string[]; conflicting?: string[]; sentiment?: "positive" | "negative" | "mixed" | "neutral" };
      nextSteps?: { action?: string; priority?: string; rationale?: string }[];
    }>(response);

    // Extract opinions
    const opinions = (parsed.opinions || []).map((op: any) => {
      if (typeof op === "string") return op;
      if (typeof op === "object" && op !== null) {
        return op.summary || op.opinion || op.text || op.content || JSON.stringify(op);
      }
      return String(op);
    });

    // Extract summary
    const summary: ClusterSummary = {
      consensus: parsed.summary?.consensus || [],
      conflicting: parsed.summary?.conflicting || [],
      sentiment: parsed.summary?.sentiment || "neutral",
    };

    // Extract next steps
    const nextSteps: ActionItem[] = (parsed.nextSteps || []).map((step: any) => ({
      action: step.action || "",
      priority: step.priority || "medium",
      rationale: step.rationale || "",
    })).filter((step: ActionItem) => step.action);

    return { opinions, summary, nextSteps };
  } catch (error) {
    console.error("[Clusterer] Error analyzing cluster:", error);
    return defaultResult;
  }
}

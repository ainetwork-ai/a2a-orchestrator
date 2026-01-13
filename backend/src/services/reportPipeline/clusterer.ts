import RequestManager from "../../world/requestManager";
import { CategorizedMessage, MessageCluster, ClustererResult, ReportLanguage } from "../../types/report";
import { v4 as uuidv4 } from "uuid";

/**
 * Cluster messages by topic and gather opinions using LLM
 */
export async function clusterMessages(
  messages: CategorizedMessage[],
  apiUrl: string,
  model: string,
  language: ReportLanguage = "en"
): Promise<ClustererResult> {
  if (messages.length === 0) {
    return { clusters: [] };
  }

  // First, identify main topics
  const topics = await identifyTopics(messages, apiUrl, model, language);

  // Then, assign messages to topics and gather opinions
  const clusters = await assignMessagesToTopics(messages, topics, apiUrl, model, language);

  return { clusters };
}

async function identifyTopics(
  messages: CategorizedMessage[],
  apiUrl: string,
  model: string,
  language: ReportLanguage
): Promise<string[]> {
  // Sample messages if too many (to reduce token usage)
  const sampleSize = Math.min(messages.length, 50);
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

    let jsonStr = response.trim();
    if (jsonStr.startsWith("```json")) {
      jsonStr = jsonStr.replace(/```json\s*/g, "").replace(/```\s*/g, "");
    } else if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/```\s*/g, "");
    }

    const parsed = JSON.parse(jsonStr);
    return parsed.topics?.map((t: any) => t.name) || [];
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
    return [];
  }

  // Process in batches (parallel)
  const BATCH_SIZE = 20;
  const assignments: Map<string, CategorizedMessage[]> = new Map();
  topics.forEach(topic => assignments.set(topic, []));

  // Create all batch promises in parallel
  const batchPromises: Promise<Record<string, CategorizedMessage[]>>[] = [];
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    batchPromises.push(assignBatchToTopics(batch, topics, apiUrl, model));
  }

  // Wait for all batches to complete
  const batchResults = await Promise.all(batchPromises);

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

  // Summarize opinions in parallel
  const opinionPromises = topicsWithMessages.map(([topic, topicMessages]) =>
    summarizeOpinions(topicMessages, topic, apiUrl, model, language)
  );
  const opinionResults = await Promise.all(opinionPromises);

  // Build clusters
  const clusters: MessageCluster[] = topicsWithMessages.map(
    ([topic, topicMessages], idx) => ({
      id: uuidv4(),
      topic,
      description: `Messages related to "${topic}"`,
      messages: topicMessages,
      opinions: opinionResults[idx],
    })
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

  const prompt = `Assign each message to the most relevant topic.

Topics:
${topics.map((t, i) => `${i + 1}. ${t}`).join("\n")}

Messages:
${JSON.stringify(messagesForPrompt, null, 2)}

Instructions:
- Assign each message to exactly one topic
- If a message doesn't fit any topic well, assign it to the closest match

Respond in JSON format only:
{
  "assignments": [
    { "index": 0, "topic": "Topic name" }
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

    let jsonStr = response.trim();
    if (jsonStr.startsWith("```json")) {
      jsonStr = jsonStr.replace(/```json\s*/g, "").replace(/```\s*/g, "");
    } else if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/```\s*/g, "");
    }

    const parsed = JSON.parse(jsonStr);
    const result: Record<string, CategorizedMessage[]> = {};
    topics.forEach(t => (result[t] = []));

    for (const assignment of parsed.assignments || []) {
      const msg = messages[assignment.index];
      const topic = assignment.topic;
      if (msg && result[topic]) {
        result[topic].push(msg);
      }
    }

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

async function summarizeOpinions(
  messages: CategorizedMessage[],
  topic: string,
  apiUrl: string,
  model: string,
  language: ReportLanguage
): Promise<string[]> {
  if (messages.length === 0) return [];

  // Sample if too many messages
  const sampleSize = Math.min(messages.length, 30);
  const sampledMessages = messages
    .sort(() => Math.random() - 0.5)
    .slice(0, sampleSize);

  const messageContents = sampledMessages.map(m => m.content).join("\n---\n");

  const langInstruction = language === "ko"
    ? "IMPORTANT: Write all opinion summaries in Korean."
    : "Write all opinion summaries in English.";

  const prompt = `Summarize the different opinions and perspectives expressed about "${topic}" in these messages.

${langInstruction}

Messages:
${messageContents}

Instructions:
1. Identify distinct opinions or viewpoints (not just restatements of the same opinion)
2. Summarize each unique opinion in 1-2 sentences
3. Include the general sentiment (positive/negative/neutral) for each opinion
4. Return 3-7 main opinions

Respond in JSON format only:
{
  "opinions": [
    "Opinion summary 1",
    "Opinion summary 2"
  ]
}`;

  try {
    const requestManager = RequestManager.getInstance();
    const response = await requestManager.request(
      apiUrl,
      model,
      [{ role: "user", content: prompt }],
      1000,
      0.5
    );

    let jsonStr = response.trim();
    if (jsonStr.startsWith("```json")) {
      jsonStr = jsonStr.replace(/```json\s*/g, "").replace(/```\s*/g, "");
    } else if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/```\s*/g, "");
    }

    const parsed = JSON.parse(jsonStr);
    const opinions = parsed.opinions || [];

    // Handle case where LLM returns objects instead of strings
    return opinions.map((op: any) => {
      if (typeof op === "string") return op;
      // If object, try to extract meaningful text
      if (typeof op === "object" && op !== null) {
        return op.summary || op.opinion || op.text || op.content || JSON.stringify(op);
      }
      return String(op);
    });
  } catch (error) {
    console.error("[Clusterer] Error summarizing opinions:", error);
    return [`${messages.length} messages about this topic`];
  }
}

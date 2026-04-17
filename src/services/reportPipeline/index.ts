/**
 * Report Generation Pipeline
 *
 * 1. Parse conversations into segments
 * 2. Extract opinions from segments (LLM)
 * 3. Generate embeddings (OpenAI)
 * 4. Cluster (UMAP + K-means)
 * 5. Analyze clusters (LLM - labels, summaries)
 * 6. Calculate statistics
 * 7. Synthesize insights (LLM)
 */

import { collectRawMessages } from "./conversationParser";
import { extractOpinionsByThread } from "./opinionExtractor";
import { embedMessages, createOpenAIEmbedder, createAzureOpenAIEmbedder, AzureOpenAIConfig } from "./embedder";
import { clusterByEmbedding, subClusterTopic } from "./clusterer";
import { analyzeClusters } from "./clusterAnalyzer";
import { analyzeData } from "./analyzer";
import { synthesizeReport } from "./synthesizer";
import { opinionsToParsedMessages, cosineSimilarity } from "./pipelineUtils";
import {
  Report,
  ReportRequestParams,
  ReportJobProgress,
  ReportLanguage,
  Source,
  Claim,
  Quote,
  SegmentMessage,
  type ExtractedOpinion,
} from "../../types/report";
import { EmbedFunction, EmbeddedMessage } from "../../types/embedding";
import { validateReportMessages, validateStatistics } from "../../utils/reportValidator";

export type ProgressCallback = (progress: ReportJobProgress) => void;

/**
 * Pipeline steps (EPIC5.1: thread-level extraction, no segmentation)
 */
const PIPELINE_STEPS = [
  "Collecting messages",
  "Extracting claims (thread-level)",
  "Embedding claims",
  "Clustering",
  "Analyzing clusters",
  "Calculating statistics",
  "Synthesizing insights",
];

// Singleton embedder function (reused across requests)
let embedFn: EmbedFunction | null = null;

/**
 * Initialize the embedder function
 * Supports both Azure OpenAI and standard OpenAI
 */
function getEmbedder(): EmbedFunction {
  if (!embedFn) {
    // Check for Azure OpenAI configuration first
    const azureBaseUrl = process.env.AZURE_OPENAI_EMBEDDING_BASE_URL;
    const azureApiKey = process.env.AZURE_OPENAI_EMBEDDING_API_KEY;
    const azureApiVersion = process.env.AZURE_OPENAI_EMBEDDING_API_VERSION;
    const azureDeploymentName = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT_NAME;

    if (azureBaseUrl && azureApiKey && azureDeploymentName) {
      console.log(`[ReportPipeline] Using Azure OpenAI embedder: ${azureDeploymentName}`);
      const config: AzureOpenAIConfig = {
        baseUrl: azureBaseUrl,
        apiKey: azureApiKey,
        apiVersion: azureApiVersion || "2023-05-15",
        deploymentName: azureDeploymentName,
      };
      embedFn = createAzureOpenAIEmbedder(config);
    } else {
      // Fallback to standard OpenAI
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error(
          "Embedding API configuration is required. Set either:\n" +
          "1. Azure OpenAI: AZURE_OPENAI_EMBEDDING_BASE_URL, AZURE_OPENAI_EMBEDDING_API_KEY, AZURE_OPENAI_EMBEDDING_DEPLOYMENT_NAME\n" +
          "2. OpenAI: OPENAI_API_KEY"
        );
      }
      console.log("[ReportPipeline] Using OpenAI embedder");
      embedFn = createOpenAIEmbedder(apiKey);
    }
  }
  return embedFn;
}

/**
 * Execute the report generation pipeline.
 * EPIC5.1: Thread-level extraction (no segmentation step)
 */
export async function generateReport(
  params: ReportRequestParams,
  apiUrl: string,
  model: string,
  onProgress?: ProgressCallback
): Promise<Report> {
  const title = params.title || "User Conversation Analysis Report";
  const language: ReportLanguage = params.language || "ko";

  const updateProgress = makeProgressUpdater(PIPELINE_STEPS, onProgress);

  const embedder = getEmbedder();

  // Step 1: Collect raw messages grouped by thread
  updateProgress(1);
  console.log(`[ReportPipeline] Step 1: ${PIPELINE_STEPS[0]}`);
  const rawResult = await collectRawMessages(params);
  console.log(
    `[ReportPipeline] Collected ${rawResult.totalMessageCount} messages from ${rawResult.threadCount} threads`
  );

  if (rawResult.totalMessageCount === 0) {
    return createEmptyReport(title, rawResult.threadCount);
  }

  // Step 2: Extract claims per thread (1 LLM call per thread, topics identified by LLM)
  updateProgress(2);
  console.log(`[ReportPipeline] Step 2: ${PIPELINE_STEPS[1]}`);
  const extractionResult = await extractOpinionsByThread(
    rawResult.threadMessages, apiUrl, model, language
  );
  console.log(
    `[ReportPipeline] Extracted ${extractionResult.opinions.length} claims from ${rawResult.threadCount} threads ` +
    `(${extractionResult.failedSegments} failed, ${extractionResult.evolvedOpinionCount} evolved)`
  );

  if (extractionResult.opinions.length === 0) {
    return createEmptyReport(title, rawResult.threadCount);
  }

  // Step 3: Embed claims for clustering
  updateProgress(3);
  console.log(`[ReportPipeline] Step 3: ${PIPELINE_STEPS[2]}`);
  const parsedMessages = opinionsToParsedMessages(extractionResult.opinions);
  const embeddingResult = await embedMessages(parsedMessages, embedder);
  console.log(
    `[ReportPipeline] Claim embeddings: ${embeddingResult.cacheHits} cached, ${embeddingResult.newEmbeddings} new`
  );

  // Steps 4-7: shared pipeline (clustering → analysis → statistics → synthesis)
  return runSharedPipeline({
    title, language, params, apiUrl, model,
    substantiveMessages: embeddingResult.messages,
    threadCount: rawResult.threadCount,
    onProgress, stepOffset: 3,
    extractedOpinions: extractionResult.opinions,
    threadMessages: rawResult.threadMessages,
  });
}

/**
 * Create a progress updater function for a given step list
 */
function makeProgressUpdater(steps: string[], onProgress?: ProgressCallback) {
  return (step: number) => {
    if (onProgress) {
      onProgress({
        step,
        totalSteps: steps.length,
        currentStep: steps[step - 1],
        percentage: Math.round((step / steps.length) * 100),
      });
    }
  };
}

/**
 * Shared pipeline: clustering through synthesis
 */
async function runSharedPipeline(opts: {
  title: string;
  language: ReportLanguage;
  params: ReportRequestParams;
  apiUrl: string;
  model: string;
  substantiveMessages: EmbeddedMessage[];
  threadCount: number;
  onProgress?: ProgressCallback;
  stepOffset: number;
  extractedOpinions: ExtractedOpinion[];
  threadMessages: Map<string, SegmentMessage[]>;
}): Promise<Report> {
  const {
    title, language, params, apiUrl, model,
    substantiveMessages, threadCount,
    stepOffset, extractedOpinions, threadMessages,
  } = opts;

  const updateProgress = makeProgressUpdater(PIPELINE_STEPS, opts.onProgress);
  let step = stepOffset;

  // Clustering
  step++;
  updateProgress(step);
  console.log(`[ReportPipeline] Step ${step}: ${PIPELINE_STEPS[step - 1]}`);
  const clustererResult = await clusterByEmbedding(substantiveMessages);
  console.log(`[ReportPipeline] Created ${clustererResult.clusters.length} clusters`);

  if (clustererResult.clusters.length > 0) {
    const clusterSummary = clustererResult.clusters
      .map((c) => `${c.title}(${c.messages.length})`)
      .join(", ");
    console.log(`[ReportPipeline] Cluster breakdown: ${clusterSummary}`);
  }

  // Map ExtractedOpinions → Claims before analysis (so analyzeClusters can use claims)
  const messageMap = new Map<string, { content: string; threadId: string }>();
  for (const [threadId, msgs] of threadMessages) {
    for (const m of msgs) {
      messageMap.set(m.id, { content: m.content, threadId });
    }
  }

  const opinionMap = new Map(extractedOpinions.map((op) => [op.id, op]));
  for (const cluster of clustererResult.clusters) {
    cluster.claims = cluster.messages
      .filter((m) => opinionMap.has(m.id))
      .map((m) => {
        const op = opinionMap.get(m.id)!;
        const validMsgIds = op.source.keyMessageIds.filter((msgId) => messageMap.has(msgId));
        const quotes: Quote[] = validMsgIds.map((msgId) => ({
          id: msgId,
          text: messageMap.get(msgId)!.content,
          reference: {
            id: `ref-${msgId}`,
            sourceId: op.threadId,
            segmentId: op.source.segmentId,
            messageId: msgId,
          },
        }));
        const context = buildContextWindow(threadMessages.get(op.threadId) || [], validMsgIds);
        return {
          id: op.id,
          speaker: op.speaker,
          title: op.statement,
          quotes,
          context,
          number: quotes.length,
          similarClaims: [],
          stance: op.stance,
          confidence: op.confidence,
          evolved: op.evolved,
        } satisfies Claim;
      });
  }

  // Sub-cluster claims within each topic into subtopics
  const embeddingMap = new Map(substantiveMessages.map((m) => [m.id, m.embedding]));
  for (const cluster of clustererResult.clusters) {
    cluster.subtopics = subClusterTopic(cluster.claims, embeddingMap, cluster.id);
    cluster.claims = []; // moved into subtopics
  }

  const totalSubtopics = clustererResult.clusters.reduce((sum, c) => sum + c.subtopics.length, 0);
  console.log(`[ReportPipeline] Sub-clustered into ${totalSubtopics} subtopics`);

  // Dedup similar claims within each subtopic (cosine similarity on embeddings)
  let totalBeforeDedup = 0;
  let totalAfterDedup = 0;
  for (const cluster of clustererResult.clusters) {
    for (const subtopic of cluster.subtopics) {
      totalBeforeDedup += subtopic.claims.length;
      subtopic.claims = deduplicateClaims(subtopic.claims, embeddingMap);
      totalAfterDedup += subtopic.claims.length;
    }
  }
  console.log(`[ReportPipeline] Dedup: ${totalBeforeDedup} → ${totalAfterDedup} primary claims`);

  // Analyze clusters (LLM: topic labels, descriptions, summaries — uses claims)
  step++;
  updateProgress(step);
  console.log(`[ReportPipeline] Step ${step}: ${PIPELINE_STEPS[step - 1]}`);
  const analyzedClusters = await analyzeClusters(
    clustererResult.clusters, apiUrl, model, language
  );
  console.log(`[ReportPipeline] Analyzed ${analyzedClusters.length} clusters`);

  // Calculate statistics
  step++;
  updateProgress(step);
  console.log(`[ReportPipeline] Step ${step}: ${PIPELINE_STEPS[step - 1]}`);
  const analyzerResult = analyzeData(
    extractedOpinions, analyzedClusters, threadCount,
    threadMessages.size
  );

  // Synthesize insights
  step++;
  updateProgress(step);
  console.log(`[ReportPipeline] Step ${step}: ${PIPELINE_STEPS[step - 1]}`);
  const synthesizerResult = await synthesizeReport(
    analyzedClusters, analyzerResult.statistics, apiUrl, model, language
  );
  console.log(`[ReportPipeline] Synthesis completed`);

  // Build sources from threads (1 source per thread, segmentCount = 1 in thread-level mode)
  const sources: Source[] = Array.from(threadMessages.keys()).map((id) => ({
    id,
    segmentCount: 1,
  }));

  // Build final report — strip pipeline-internal fields (messages, claims) from topics
  const topics = analyzedClusters.map(({ messages, claims, ...topic }) => topic);

  const report: Report = {
    title,
    description: params.description || "",
    date: new Date().toISOString(),
    topics,
    sources,
    statistics: analyzerResult.statistics,
    synthesis: synthesizerResult.synthesis,
  };

  // Validation
  const messageValidation = validateReportMessages(report);
  const statsValidation = validateStatistics(report.statistics);

  if (!messageValidation.isValid) {
    console.error("[ReportPipeline] CRITICAL: Non-substantive messages in output!");
    console.error(messageValidation.errors);
    throw new Error("Report validation failed: Non-substantive messages found in output");
  }

  if (messageValidation.warnings.length > 0) {
    console.warn("[ReportPipeline] Message validation warnings:", messageValidation.warnings);
  }
  if (statsValidation.warnings.length > 0) {
    console.warn("[ReportPipeline] Statistics validation warnings:", statsValidation.warnings);
  }

  console.log(
    `[ReportPipeline] Validation passed: ${report.topics.length} topics, ` +
    `${report.statistics.totalOpinions} opinions`
  );
  console.log(`[ReportPipeline] Report generation completed`);
  return report;
}

const CONTEXT_WINDOW_RADIUS = 3;

const DEDUP_SIMILARITY_THRESHOLD = 0.85;

/**
 * Deduplicate claims within a subtopic using cosine similarity on embeddings.
 * Uses seed-based greedy grouping: each ungrouped claim becomes a seed,
 * and remaining claims similar to the seed join its group.
 * The primary claim (highest confidence) represents each group.
 */
function deduplicateClaims(
  claims: Claim[],
  embeddingMap: Map<string, number[]>
): Claim[] {
  if (claims.length <= 1) return claims;

  // Build pairs with embeddings
  const claimsWithEmb = claims
    .map((c) => ({ claim: c, embedding: embeddingMap.get(c.id) }))
    .filter((c): c is { claim: Claim; embedding: number[] } => !!c.embedding);

  // Claims without embeddings pass through as-is
  const noEmbClaims = claims.filter((c) => !embeddingMap.has(c.id));

  const grouped = new Set<string>();
  const groups: Claim[][] = [];

  for (let i = 0; i < claimsWithEmb.length; i++) {
    if (grouped.has(claimsWithEmb[i].claim.id)) continue;

    const group: Claim[] = [claimsWithEmb[i].claim];
    grouped.add(claimsWithEmb[i].claim.id);

    for (let j = i + 1; j < claimsWithEmb.length; j++) {
      if (grouped.has(claimsWithEmb[j].claim.id)) continue;

      const sim = cosineSimilarity(claimsWithEmb[i].embedding, claimsWithEmb[j].embedding);
      if (sim >= DEDUP_SIMILARITY_THRESHOLD) {
        group.push(claimsWithEmb[j].claim);
        grouped.add(claimsWithEmb[j].claim.id);
      }
    }
    groups.push(group);
  }

  // For each group: pick highest confidence as primary, rest go to similarClaims
  const primaryClaims: Claim[] = groups.map((group) => {
    group.sort((a, b) => b.confidence - a.confidence);
    const [primary, ...duplicates] = group;
    return {
      ...primary,
      similarClaims: duplicates,
      number: 1 + duplicates.length,
    };
  });

  return [...primaryClaims, ...noEmbClaims];
}

/**
 * Build a context window of messages around the given key message IDs.
 * Returns a deduplicated, time-ordered slice of thread messages within
 * ±CONTEXT_WINDOW_RADIUS of each key message.
 */
function buildContextWindow(
  threadMsgs: SegmentMessage[],
  keyMessageIds: string[]
): SegmentMessage[] {
  if (keyMessageIds.length === 0 || threadMsgs.length === 0) return [];

  const idToIndex = new Map(threadMsgs.map((m, i) => [m.id, i]));
  const includeSet = new Set<number>();

  for (const msgId of keyMessageIds) {
    const idx = idToIndex.get(msgId);
    if (idx === undefined) continue;
    const start = Math.max(0, idx - CONTEXT_WINDOW_RADIUS);
    const end = Math.min(threadMsgs.length - 1, idx + CONTEXT_WINDOW_RADIUS);
    for (let i = start; i <= end; i++) {
      includeSet.add(i);
    }
  }

  return Array.from(includeSet).sort((a, b) => a - b).map((i) => threadMsgs[i]);
}

/**
 * Create an empty report when no messages are found
 */
function createEmptyReport(
  title: string,
  threadCount: number
): Report {
  return {
    title,
    description: "",
    date: new Date().toISOString(),
    topics: [],
    sources: [],
    statistics: {
      totalOpinions: 0,
      totalSegments: 0,
      totalThreads: threadCount,
      dateRange: { start: Date.now(), end: Date.now() },
      stanceDistribution: {},
      speakerDistribution: {},
      topTopics: [],
      deliberation: { totalOpinions: 0, evolvedCount: 0 },
    },
  };
}

// Export pipeline components
export { parseConversations } from "./conversationParser";
export { extractOpinions, extractOpinionsByThread } from "./opinionExtractor";
export { embedMessages, createOpenAIEmbedder, createAzureOpenAIEmbedder } from "./embedder";
export { clusterByEmbedding, kMeans } from "./clusterer";
export { analyzeClusters } from "./clusterAnalyzer";
export { synthesizeReport } from "./synthesizer";
export { analyzeData } from "./analyzer";

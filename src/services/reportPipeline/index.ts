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

import { parseConversations } from "./conversationParser";
import { extractOpinions } from "./opinionExtractor";
import { embedMessages, createOpenAIEmbedder, createAzureOpenAIEmbedder, AzureOpenAIConfig } from "./embedder";
import { clusterByEmbedding } from "./clusterer";
import { analyzeClusters } from "./clusterAnalyzer";
import { analyzeData } from "./analyzer";
import { synthesizeReport } from "./synthesizer";
import { opinionsToParsedMessages } from "./pipelineUtils";
import {
  Report,
  ReportRequestParams,
  ReportJobProgress,
  ReportLanguage,
  Source,
  Claim,
  Quote,
  type ConversationSegment,
  type ExtractedOpinion,
} from "../../types/report";
import { EmbedFunction, EmbeddedMessage } from "../../types/embedding";
import { validateReportMessages, validateStatistics } from "../../utils/reportValidator";

export type ProgressCallback = (progress: ReportJobProgress) => void;

/**
 * Pipeline steps
 */
const PIPELINE_STEPS = [
  "Parsing conversations",
  "Extracting opinions",
  "Generating embeddings",
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

  // Step 1: Parse conversations into segments
  updateProgress(1);
  console.log(`[ReportPipeline] Step 1: ${PIPELINE_STEPS[0]}`);
  const conversationResult = await parseConversations(params);
  console.log(
    `[ReportPipeline] Parsed ${conversationResult.segments.length} segments from ${conversationResult.threadCount} threads`
  );

  if (conversationResult.segments.length === 0) {
    return createEmptyReport(title, conversationResult.threadCount);
  }

  // Step 2: Extract opinions from segments using LLM
  updateProgress(2);
  console.log(`[ReportPipeline] Step 2: ${PIPELINE_STEPS[1]}`);
  const extractionResult = await extractOpinions(
    conversationResult.segments, apiUrl, model, language
  );
  console.log(
    `[ReportPipeline] Extracted ${extractionResult.opinions.length} opinions ` +
    `(${extractionResult.failedSegments} failed, ${extractionResult.evolvedOpinionCount} evolved)`
  );

  if (extractionResult.opinions.length === 0) {
    return createEmptyReport(title, conversationResult.threadCount);
  }

  // Step 3: Generate embeddings for opinion statements
  updateProgress(3);
  console.log(`[ReportPipeline] Step 3: ${PIPELINE_STEPS[2]}`);
  const embedder = getEmbedder();
  const parsedMessages = opinionsToParsedMessages(extractionResult.opinions);
  const embeddingResult = await embedMessages(parsedMessages, embedder);
  console.log(
    `[ReportPipeline] Embeddings: ${embeddingResult.cacheHits} cached, ${embeddingResult.newEmbeddings} new`
  );

  // Steps 4-7: shared pipeline
  return runSharedPipeline({
    title, language, params, apiUrl, model,
    substantiveMessages: embeddingResult.messages,
    threadCount: conversationResult.threadCount,
    onProgress, stepOffset: 3,
    extractedOpinions: extractionResult.opinions,
    conversationSegments: conversationResult.segments,
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
 * Shared pipeline: clustering through synthesis (Steps 4-9)
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
  extractedOpinions?: ExtractedOpinion[];
  conversationSegments?: ConversationSegment[];
}): Promise<Report> {
  const {
    title, language, params, apiUrl, model,
    substantiveMessages, threadCount,
    stepOffset, extractedOpinions, conversationSegments,
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

  // Analyze clusters (LLM: topic labels, descriptions, summaries)
  step++;
  updateProgress(step);
  console.log(`[ReportPipeline] Step ${step}: ${PIPELINE_STEPS[step - 1]}`);
  const analyzedClusters = await analyzeClusters(
    clustererResult.clusters, apiUrl, model, language
  );
  console.log(`[ReportPipeline] Analyzed ${analyzedClusters.length} clusters`);

  // Map ExtractedOpinions → Claims (no LLM — already grounded at extraction)
  if (extractedOpinions) {
    const segmentMap = new Map(
      (conversationSegments || []).flatMap((seg) =>
        seg.messages.map((m) => [m.id, { content: m.content }])
      )
    );
    const opinionMap = new Map(extractedOpinions.map((op) => [op.id, op]));
    for (const cluster of analyzedClusters) {
      cluster.claims = cluster.messages
        .filter((m) => opinionMap.has(m.id))
        .map((m) => {
          const op = opinionMap.get(m.id)!;
          const quotes: Quote[] = op.source.keyMessageIds
            .filter((msgId) => segmentMap.has(msgId))
            .map((msgId) => ({
              id: msgId,
              text: segmentMap.get(msgId)!.content,
              reference: {
                id: `ref-${msgId}`,
                sourceId: op.threadId,
                segmentId: op.source.segmentId,
                messageId: msgId,
              },
            }));
          return {
            id: op.id,
            title: op.statement,
            quotes,
            number: quotes.length,
            similarClaims: [],
            stance: op.stance,
            confidence: op.confidence,
            evolved: op.evolved,
          } satisfies Claim;
        });
    }
  }

  // Calculate statistics
  step++;
  updateProgress(step);
  console.log(`[ReportPipeline] Step ${step}: ${PIPELINE_STEPS[step - 1]}`);
  const analyzerResult = analyzeData(
    extractedOpinions || [], analyzedClusters, threadCount
  );

  // Synthesize insights
  step++;
  updateProgress(step);
  console.log(`[ReportPipeline] Step ${step}: ${PIPELINE_STEPS[step - 1]}`);
  const synthesizerResult = await synthesizeReport(
    analyzedClusters, analyzerResult.statistics, apiUrl, model, language
  );
  console.log(
    `[ReportPipeline] Synthesized ${synthesizerResult.synthesis.keyFindings.length} key findings`
  );

  // Build sources from conversation segments
  const sourceMap = new Map<string, number>();
  for (const seg of conversationSegments || []) {
    sourceMap.set(seg.threadId, (sourceMap.get(seg.threadId) || 0) + 1);
  }
  const sources: Source[] = Array.from(sourceMap.entries()).map(([id, segmentCount]) => ({
    id,
    segmentCount,
  }));

  // Build final report — strip internal messages from topics
  const topics = analyzedClusters.map(({ messages, ...topic }) => topic);

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
      totalThreads: threadCount,
      dateRange: { start: Date.now(), end: Date.now() },
      stanceDistribution: {},
      topTopics: [],
      deliberation: { totalOpinions: 0, evolvedCount: 0 },
    },
  };
}

// Export pipeline components
export { parseConversations } from "./conversationParser";
export { extractOpinions } from "./opinionExtractor";
export { embedMessages, createOpenAIEmbedder, createAzureOpenAIEmbedder } from "./embedder";
export { clusterByEmbedding, kMeans } from "./clusterer";
export { analyzeClusters } from "./clusterAnalyzer";
export { synthesizeReport } from "./synthesizer";
export { analyzeData } from "./analyzer";

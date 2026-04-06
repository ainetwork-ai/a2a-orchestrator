/**
 * Report Generation Pipeline
 *
 * Conversation-aware pipeline:
 * 1. Parse conversations into segments
 * 2. Extract opinions from segments (LLM)
 * 3. Generate embeddings (OpenAI)
 * 4. Cluster (UMAP + K-means)
 * 5. Subtopic clustering
 * 6. Analyze clusters (LLM - labels, summaries)
 * 7. Ground opinions (LLM)
 * 8. Calculate statistics
 * 9. Synthesize insights (LLM)
 */

import { v4 as uuidv4 } from "uuid";
import { parseConversations } from "./conversationParser";
import { extractOpinions } from "./opinionExtractor";
import { embedMessages, createOpenAIEmbedder, createAzureOpenAIEmbedder, AzureOpenAIConfig } from "./embedder";
import { clusterByEmbedding } from "./clusterer";
import { addSubtopicsToAllClusters } from "./subtopicClusterer";
import { analyzeClusters } from "./clusterAnalyzer";
import { analyzeData } from "./analyzer";
import { groundOpinions } from "./grounding";
import { synthesizeReport } from "./synthesizer";
import { opinionsToParsedMessages, toCategorizedEmbedded, attachSourceSegmentIds } from "./pipelineUtils";
import {
  Report,
  ReportRequestParams,
  ReportJobProgress,
  ReportLanguage,
  type ConversationSegment,
  type ExtractedOpinion,
} from "../../types/report";
import { EmbedFunction, CategorizedEmbeddedMessage } from "../../types/embedding";
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
  "Subtopic clustering",
  "Analyzing clusters",
  "Grounding opinions",
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
  const reportId = uuidv4();
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
    return createEmptyReport(reportId, title, conversationResult.threadCount);
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
    return createEmptyReport(reportId, title, conversationResult.threadCount);
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

  // Adapt to CategorizedEmbeddedMessage (stance → category/sentiment mapping)
  const categorizedMessages = toCategorizedEmbedded(
    embeddingResult.messages, extractionResult.opinions
  );

  // Steps 4-9: shared pipeline
  return runSharedPipeline({
    reportId, title, language, params, apiUrl, model,
    substantiveMessages: categorizedMessages,
    threadCount: conversationResult.threadCount,
    totalMessagesBeforeSampling: conversationResult.totalMessages,
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
  reportId: string;
  title: string;
  language: ReportLanguage;
  params: ReportRequestParams;
  apiUrl: string;
  model: string;
  substantiveMessages: CategorizedEmbeddedMessage[];
  threadCount: number;
  totalMessagesBeforeSampling: number;
  onProgress?: ProgressCallback;
  stepOffset: number;
  extractedOpinions?: ExtractedOpinion[];
  conversationSegments?: ConversationSegment[];
}): Promise<Report> {
  const {
    reportId, title, language, params, apiUrl, model,
    substantiveMessages, threadCount, totalMessagesBeforeSampling,
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
      .map((c) => `${c.topic}(${c.messages.length})`)
      .join(", ");
    console.log(`[ReportPipeline] Cluster breakdown: ${clusterSummary}`);
  }

  // Subtopic clustering
  step++;
  updateProgress(step);
  console.log(`[ReportPipeline] Step ${step}: ${PIPELINE_STEPS[step - 1]}`);
  const clustersWithSubtopics = await addSubtopicsToAllClusters(
    clustererResult.clusters, substantiveMessages
  );
  console.log(`[ReportPipeline] Added subtopics to ${clustersWithSubtopics.length} clusters`);

  // Analyze clusters
  step++;
  updateProgress(step);
  console.log(`[ReportPipeline] Step ${step}: ${PIPELINE_STEPS[step - 1]}`);
  const analyzedClusters = await analyzeClusters(
    clustersWithSubtopics, apiUrl, model, language
  );
  console.log(`[ReportPipeline] Analyzed ${analyzedClusters.length} clusters`);

  // Ground opinions
  step++;
  updateProgress(step);
  console.log(`[ReportPipeline] Step ${step}: ${PIPELINE_STEPS[step - 1]}`);
  let groundingResult = await groundOpinions(analyzedClusters, apiUrl, model);
  console.log(`[ReportPipeline] Grounded opinions in ${groundingResult.clusters.length} clusters`);

  // Attach source segment IDs from extracted opinions
  if (extractedOpinions) {
    groundingResult = {
      ...groundingResult,
      clusters: attachSourceSegmentIds(groundingResult.clusters, extractedOpinions),
    };
  }

  // Calculate statistics
  step++;
  updateProgress(step);
  console.log(`[ReportPipeline] Step ${step}: ${PIPELINE_STEPS[step - 1]}`);
  const deliberation = extractedOpinions
    ? { totalOpinions: extractedOpinions.length, evolvedCount: extractedOpinions.filter((op) => op.evolved).length }
    : undefined;
  const analyzerResult = analyzeData(
    substantiveMessages, groundingResult.clusters, threadCount,
    totalMessagesBeforeSampling, false, 0, undefined,
    deliberation
  );

  // Synthesize insights
  step++;
  updateProgress(step);
  console.log(`[ReportPipeline] Step ${step}: ${PIPELINE_STEPS[step - 1]}`);
  const synthesizerResult = await synthesizeReport(
    groundingResult.clusters, analyzerResult.statistics, apiUrl, model, language
  );
  console.log(
    `[ReportPipeline] Synthesized ${synthesizerResult.synthesis.keyFindings.length} key findings`
  );

  // Build report
  const report: Report = {
    id: reportId,
    title,
    createdAt: Date.now(),
    statistics: analyzerResult.statistics,
    clusters: groundingResult.clusters,
    synthesis: synthesizerResult.synthesis,
    ...(extractedOpinions && { extractedOpinions }),
    ...(conversationSegments && { conversationSegments }),
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
    `[ReportPipeline] Validation passed: ${report.clusters.length} clusters, ` +
    `${report.statistics.totalMessages} messages`
  );
  console.log(`[ReportPipeline] Report generation completed`);
  return report;
}

/**
 * Create an empty report when no messages are found
 */
function createEmptyReport(
  reportId: string,
  title: string,
  threadCount: number
): Report {
  return {
    id: reportId,
    title,
    createdAt: Date.now(),
    statistics: {
      totalMessages: 0,
      totalThreads: threadCount,
      dateRange: { start: Date.now(), end: Date.now() },
      categoryDistribution: {},
      sentimentDistribution: { positive: 0, negative: 0, neutral: 0 },
      topTopics: [],
      averageMessagesPerThread: 0,
      totalMessagesBeforeSampling: 0,
      wasSampled: false,
      nonSubstantiveCount: 0,
    },
    clusters: [],
  };
}

// Export pipeline components
export { parseConversations } from "./conversationParser";
export { extractOpinions } from "./opinionExtractor";
export { embedMessages, createOpenAIEmbedder, createAzureOpenAIEmbedder } from "./embedder";
export { clusterByEmbedding, kMeans } from "./clusterer";
export { addSubtopicsToAllClusters, clusterSubtopics, countUniqueUsers } from "./subtopicClusterer";
export { analyzeClusters } from "./clusterAnalyzer";
export { groundOpinions } from "./grounding";
export { synthesizeReport } from "./synthesizer";
export { analyzeData } from "./analyzer";

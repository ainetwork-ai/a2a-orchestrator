/**
 * Report Generation Pipeline - TRD 12: Embedding-based Clustering
 *
 * New pipeline using embeddings for deterministic, cost-effective processing:
 * 1. Parse threads
 * 2. Generate embeddings (OpenAI)
 * 3. Categorize (embedding similarity, no LLM)
 * 4. Cluster (UMAP + K-means, no LLM)
 * 5. Analyze clusters (LLM - labels, opinions, summaries)
 * 6. Ground opinions (LLM)
 * 7. Calculate statistics
 * 8. Synthesize insights (LLM)
 * 9. Generate visualization
 * 10. Render report
 */

import { v4 as uuidv4 } from "uuid";
import { parseThreads } from "./parser";
import { parseConversations } from "./conversationParser";
import { extractOpinions } from "./opinionExtractor";
import { embedMessages, createOpenAIEmbedder, createAzureOpenAIEmbedder, AzureOpenAIConfig } from "./embedder";
import {
  categorizeEmbeddedMessages,
  categorizeByEmbedding,
  initializeCategoryEmbeddings,
  calculateFilteringBreakdown,
} from "./categorizer";
import { clusterByEmbedding } from "./clusterer";
import { addSubtopicsToAllClusters } from "./subtopicClusterer";
import { analyzeClusters } from "./clusterAnalyzer";
import { analyzeData } from "./analyzer";
import { groundOpinions } from "./grounding";
import { synthesizeReport } from "./synthesizer";
import { generateVisualizationData } from "./visualizer";
import { generateDotGridData } from "./dotGridGenerator";
import { renderMarkdown } from "./renderer";
import { opinionsToParsedMessages, toCategorizedEmbedded, attachSourceSegmentIds } from "./pipelineUtils";
import {
  Report,
  ReportRequestParams,
  ReportJobProgress,
  ReportLanguage,
  FilteringBreakdown,
  type ConversationSegment,
  type ExtractedOpinion,
} from "../../types/report";
import { EmbedFunction, CategorizedEmbeddedMessage } from "../../types/embedding";
import { validateReportMessages, validateStatistics } from "../../utils/reportValidator";

export type ProgressCallback = (progress: ReportJobProgress) => void;

/**
 * Pipeline steps (TRD 12 + TRD 13) - Legacy
 */
const LEGACY_STEPS = [
  "Parsing messages",
  "Generating embeddings",
  "Categorizing",
  "Clustering",
  "Subtopic clustering",      // TRD 13
  "Analyzing clusters",
  "Grounding opinions",
  "Calculating statistics",
  "Synthesizing insights",
  "Generating visualization",
  "Generating dot grid",      // TRD 13
  "Rendering report",
];

/**
 * Pipeline steps (EPIC1: Conversation-aware)
 */
const CONVERSATION_STEPS = [
  "Parsing conversations",
  "Extracting opinions",
  "Generating embeddings",
  "Clustering",
  "Subtopic clustering",
  "Analyzing clusters",
  "Grounding opinions",
  "Calculating statistics",
  "Synthesizing insights",
  "Generating visualization",
  "Generating dot grid",
  "Rendering report",
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
 * Dispatches to legacy or conversation-aware pipeline based on params.pipelineMode.
 */
export async function generateReport(
  params: ReportRequestParams,
  apiUrl: string,
  model: string,
  onProgress?: ProgressCallback
): Promise<Report> {
  console.log("[ReportPipeline] Starting generateReport with params:", JSON.stringify(params));
  if (params.pipelineMode === "conversation") {
    return generateConversationReport(params, apiUrl, model, onProgress);
  }
  return generateLegacyReport(params, apiUrl, model, onProgress);
}

/**
 * Legacy pipeline (TRD 12: Embedding-based)
 */
async function generateLegacyReport(
  params: ReportRequestParams,
  apiUrl: string,
  model: string,
  onProgress?: ProgressCallback
): Promise<Report> {
  const steps = LEGACY_STEPS;
  const reportId = uuidv4();
  const title = params.title || "User Conversation Analysis Report";
  const language: ReportLanguage = params.language || "ko";

  const updateProgress = makeProgressUpdater(steps, onProgress);

  // Step 1: Parse threads (no sampling - process all messages)
  updateProgress(1);
  console.log(`[ReportPipeline] Step 1: ${steps[0]}`);
  const parserResult = await parseThreads({
    ...params,
    maxMessages: undefined, // Remove sampling - TRD 12
  });
  console.log(
    `[ReportPipeline] Parsed ${parserResult.messages.length} messages from ${parserResult.threadCount} threads`
  );

  if (parserResult.messages.length === 0) {
    return createEmptyReport(reportId, title, parserResult.threadCount);
  }

  // Get embedder
  const embedder = getEmbedder();

  // Step 2: Generate embeddings
  updateProgress(2);
  console.log(`[ReportPipeline] Step 2: ${steps[1]}`);
  const embeddingResult = await embedMessages(parserResult.messages, embedder);
  console.log(
    `[ReportPipeline] Embeddings: ${embeddingResult.cacheHits} cached, ${embeddingResult.newEmbeddings} new`
  );

  // Step 3: Categorize using embeddings (no LLM)
  updateProgress(3);
  console.log(`[ReportPipeline] Step 3: ${steps[2]}`);
  await initializeCategoryEmbeddings(embedder);
  const categorizedMessages = categorizeByEmbedding(embeddingResult.messages);

  // Filter substantive messages
  const substantiveMessages = categorizedMessages.filter((m) => m.isSubstantive);
  const nonSubstantiveCount = categorizedMessages.length - substantiveMessages.length;
  const filteringBreakdown = calculateFilteringBreakdown(categorizedMessages);

  console.log(
    `[ReportPipeline] Categorized: ${substantiveMessages.length} substantive, ${nonSubstantiveCount} filtered`
  );

  if (substantiveMessages.length === 0) {
    console.warn("[ReportPipeline] No substantive messages found");
    return createEmptyReport(reportId, title, parserResult.threadCount);
  }

  // Steps 4-12: shared pipeline
  return runSharedPipeline({
    steps, reportId, title, language, params, apiUrl, model,
    substantiveMessages, threadCount: parserResult.threadCount,
    totalMessagesBeforeSampling: parserResult.messages.length,
    nonSubstantiveCount, filteringBreakdown,
    onProgress, stepOffset: 3,
  });
}

/**
 * Conversation-aware pipeline (EPIC1)
 */
async function generateConversationReport(
  params: ReportRequestParams,
  apiUrl: string,
  model: string,
  onProgress?: ProgressCallback
): Promise<Report> {
  const steps = CONVERSATION_STEPS;
  const reportId = uuidv4();
  const title = params.title || "User Conversation Analysis Report";
  const language: ReportLanguage = params.language || "ko";

  const updateProgress = makeProgressUpdater(steps, onProgress);

  // Step 1: Parse conversations into segments
  updateProgress(1);
  console.log(`[ReportPipeline:Conv] Step 1: ${steps[0]}`);
  const conversationResult = await parseConversations(params);
  console.log(
    `[ReportPipeline:Conv] Parsed ${conversationResult.segments.length} segments from ${conversationResult.threadCount} threads`
  );

  if (conversationResult.segments.length === 0) {
    return createEmptyReport(reportId, title, conversationResult.threadCount);
  }

  // Step 2: Extract opinions from segments using LLM
  updateProgress(2);
  console.log(`[ReportPipeline:Conv] Step 2: ${steps[1]}`);
  const extractionResult = await extractOpinions(
    conversationResult.segments, apiUrl, model, language
  );
  console.log(
    `[ReportPipeline:Conv] Extracted ${extractionResult.opinions.length} opinions ` +
    `(${extractionResult.failedSegments} failed, ${extractionResult.evolvedOpinionCount} evolved)`
  );

  if (extractionResult.opinions.length === 0) {
    return createEmptyReport(reportId, title, conversationResult.threadCount);
  }

  // Step 3: Generate embeddings for opinion statements
  updateProgress(3);
  console.log(`[ReportPipeline:Conv] Step 3: ${steps[2]}`);
  const embedder = getEmbedder();
  const parsedMessages = opinionsToParsedMessages(extractionResult.opinions);
  const embeddingResult = await embedMessages(parsedMessages, embedder);
  console.log(
    `[ReportPipeline:Conv] Embeddings: ${embeddingResult.cacheHits} cached, ${embeddingResult.newEmbeddings} new`
  );

  // Adapt to CategorizedEmbeddedMessage (stance → category/sentiment mapping)
  const categorizedMessages = toCategorizedEmbedded(
    embeddingResult.messages, extractionResult.opinions
  );

  // Steps 4-12: shared pipeline
  return runSharedPipeline({
    steps, reportId, title, language, params, apiUrl, model,
    substantiveMessages: categorizedMessages,
    threadCount: conversationResult.threadCount,
    totalMessagesBeforeSampling: conversationResult.totalMessages,
    nonSubstantiveCount: 0,
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
 * Shared pipeline from clustering through rendering (Steps 4-12)
 */
async function runSharedPipeline(opts: {
  steps: string[];
  reportId: string;
  title: string;
  language: ReportLanguage;
  params: ReportRequestParams;
  apiUrl: string;
  model: string;
  substantiveMessages: CategorizedEmbeddedMessage[];
  threadCount: number;
  totalMessagesBeforeSampling: number;
  nonSubstantiveCount: number;
  filteringBreakdown?: FilteringBreakdown;
  onProgress?: ProgressCallback;
  stepOffset: number;
  extractedOpinions?: ExtractedOpinion[];
  conversationSegments?: ConversationSegment[];
}): Promise<Report> {
  const {
    steps, reportId, title, language, params, apiUrl, model,
    substantiveMessages, threadCount, totalMessagesBeforeSampling,
    nonSubstantiveCount, filteringBreakdown, stepOffset,
    extractedOpinions, conversationSegments,
  } = opts;

  const updateProgress = makeProgressUpdater(steps, opts.onProgress);
  let step = stepOffset;

  // Clustering
  step++;
  updateProgress(step);
  console.log(`[ReportPipeline] Step ${step}: ${steps[step - 1]}`);
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
  console.log(`[ReportPipeline] Step ${step}: ${steps[step - 1]}`);
  const clustersWithSubtopics = await addSubtopicsToAllClusters(
    clustererResult.clusters, substantiveMessages
  );
  console.log(`[ReportPipeline] Added subtopics to ${clustersWithSubtopics.length} clusters`);

  // Analyze clusters
  step++;
  updateProgress(step);
  console.log(`[ReportPipeline] Step ${step}: ${steps[step - 1]}`);
  const analyzedClusters = await analyzeClusters(
    clustersWithSubtopics, apiUrl, model, language
  );
  console.log(`[ReportPipeline] Analyzed ${analyzedClusters.length} clusters`);

  // Ground opinions
  step++;
  updateProgress(step);
  console.log(`[ReportPipeline] Step ${step}: ${steps[step - 1]}`);
  let groundingResult = await groundOpinions(analyzedClusters, apiUrl, model);
  console.log(`[ReportPipeline] Grounded opinions in ${groundingResult.clusters.length} clusters`);

  // Attach source segment IDs if conversation pipeline (EPIC1)
  if (extractedOpinions) {
    groundingResult = {
      ...groundingResult,
      clusters: attachSourceSegmentIds(groundingResult.clusters, extractedOpinions),
    };
  }

  // Calculate statistics
  step++;
  updateProgress(step);
  console.log(`[ReportPipeline] Step ${step}: ${steps[step - 1]}`);
  const deliberation = extractedOpinions
    ? { totalOpinions: extractedOpinions.length, evolvedCount: extractedOpinions.filter((op) => op.evolved).length }
    : undefined;
  const analyzerResult = analyzeData(
    substantiveMessages, groundingResult.clusters, threadCount,
    totalMessagesBeforeSampling, false, nonSubstantiveCount, filteringBreakdown,
    deliberation
  );

  // Synthesize insights
  step++;
  updateProgress(step);
  console.log(`[ReportPipeline] Step ${step}: ${steps[step - 1]}`);
  const synthesizerResult = await synthesizeReport(
    groundingResult.clusters, analyzerResult.statistics, apiUrl, model, language
  );
  console.log(
    `[ReportPipeline] Synthesized ${synthesizerResult.synthesis.keyFindings.length} key findings`
  );

  // Generate visualization
  step++;
  updateProgress(step);
  console.log(`[ReportPipeline] Step ${step}: ${steps[step - 1]}`);
  const visualizerResult = await generateVisualizationData(
    groundingResult.clusters, analyzerResult.statistics, clustererResult.visualization
  );
  console.log(`[ReportPipeline] Generated visualization data`);

  // Generate dot grid
  step++;
  updateProgress(step);
  console.log(`[ReportPipeline] Step ${step}: ${steps[step - 1]}`);
  const dotGridData = generateDotGridData(
    groundingResult.clusters, clustererResult.visualization
  );
  console.log(`[ReportPipeline] Generated dot grid: ${dotGridData.totalMessages} points, ${dotGridData.totalUniqueUsers} users`);

  // Render markdown
  step++;
  updateProgress(step);
  console.log(`[ReportPipeline] Step ${step}: ${steps[step - 1]}`);
  const rendererResult = renderMarkdown(
    analyzerResult.statistics, groundingResult.clusters, synthesizerResult.synthesis,
    { timezone: params.timezone, language: params.language }
  );

  // Build report
  const report: Report = {
    id: reportId,
    title,
    createdAt: Date.now(),
    statistics: analyzerResult.statistics,
    clusters: groundingResult.clusters,
    synthesis: synthesizerResult.synthesis,
    visualization: visualizerResult.visualization,
    dotGrid: dotGridData,
    markdown: rendererResult.markdown,
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
    markdown: "# Report\n\nNo user messages found to analyze.",
  };
}

// Export pipeline components
export { parseThreads } from "./parser";
export { parseConversations } from "./conversationParser";
export { extractOpinions } from "./opinionExtractor";
export { embedMessages, createOpenAIEmbedder, createAzureOpenAIEmbedder } from "./embedder";
export {
  categorizeByEmbedding,
  categorizeEmbeddedMessages,
  initializeCategoryEmbeddings,
} from "./categorizer";
export { clusterByEmbedding, kMeans } from "./clusterer";
export { addSubtopicsToAllClusters, clusterSubtopics, countUniqueUsers } from "./subtopicClusterer";
export { analyzeClusters } from "./clusterAnalyzer";
export { groundOpinions } from "./grounding";
export { synthesizeReport } from "./synthesizer";
export { analyzeData } from "./analyzer";
export { generateVisualizationData } from "./visualizer";
export { generateDotGridData } from "./dotGridGenerator";
export { renderMarkdown } from "./renderer";

// Legacy exports for backward compatibility
export { categorizeMessages } from "./categorizer.legacy";
export { clusterMessages } from "./clusterer.legacy";

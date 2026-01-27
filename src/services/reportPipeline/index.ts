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
import { embedMessages, createOpenAIEmbedder } from "./embedder";
import {
  categorizeEmbeddedMessages,
  categorizeByEmbedding,
  initializeCategoryEmbeddings,
  calculateFilteringBreakdown,
} from "./categorizer";
import { clusterByEmbedding } from "./clusterer";
import { analyzeClusters } from "./clusterAnalyzer";
import { analyzeData } from "./analyzer";
import { groundOpinions } from "./grounding";
import { synthesizeReport } from "./synthesizer";
import { generateVisualizationData } from "./visualizer";
import { renderMarkdown } from "./renderer";
import {
  Report,
  ReportRequestParams,
  ReportJobProgress,
} from "../../types/report";
import { EmbedFunction, CategorizedEmbeddedMessage } from "../../types/embedding";
import { validateReportMessages, validateStatistics } from "../../utils/reportValidator";

export type ProgressCallback = (progress: ReportJobProgress) => void;

/**
 * New pipeline steps (TRD 12)
 */
const STEPS = [
  "Parsing messages",
  "Generating embeddings",
  "Categorizing",
  "Clustering",
  "Analyzing clusters",
  "Grounding opinions",
  "Calculating statistics",
  "Synthesizing insights",
  "Generating visualization",
  "Rendering report",
];

// Singleton embedder function (reused across requests)
let embedFn: EmbedFunction | null = null;

/**
 * Initialize the embedder function
 */
function getEmbedder(): EmbedFunction {
  if (!embedFn) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENAI_API_KEY environment variable is required for embedding-based pipeline. " +
        "Please set it in your .env file."
      );
    }
    embedFn = createOpenAIEmbedder(apiKey);
  }
  return embedFn;
}

/**
 * Execute the full report generation pipeline (TRD 12: Embedding-based)
 */
export async function generateReport(
  params: ReportRequestParams,
  apiUrl: string,
  model: string,
  onProgress?: ProgressCallback
): Promise<Report> {
  const reportId = uuidv4();
  const title = params.title || "User Conversation Analysis Report";
  const language = params.language || "ko";

  const updateProgress = (step: number) => {
    if (onProgress) {
      onProgress({
        step,
        totalSteps: STEPS.length,
        currentStep: STEPS[step - 1],
        percentage: Math.round((step / STEPS.length) * 100),
      });
    }
  };

  // Step 1: Parse threads (no sampling - process all messages)
  updateProgress(1);
  console.log(`[ReportPipeline] Step 1: ${STEPS[0]}`);
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
  console.log(`[ReportPipeline] Step 2: ${STEPS[1]}`);
  const embeddingResult = await embedMessages(parserResult.messages, embedder);
  console.log(
    `[ReportPipeline] Embeddings: ${embeddingResult.cacheHits} cached, ${embeddingResult.newEmbeddings} new`
  );

  // Step 3: Categorize using embeddings (no LLM)
  updateProgress(3);
  console.log(`[ReportPipeline] Step 3: ${STEPS[2]}`);
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

  // Step 4: Cluster using UMAP + K-means (no LLM)
  updateProgress(4);
  console.log(`[ReportPipeline] Step 4: ${STEPS[3]}`);
  const clustererResult = await clusterByEmbedding(substantiveMessages);
  console.log(`[ReportPipeline] Created ${clustererResult.clusters.length} clusters`);

  if (clustererResult.clusters.length > 0) {
    const clusterSummary = clustererResult.clusters
      .map((c) => `${c.topic}(${c.messages.length})`)
      .join(", ");
    console.log(`[ReportPipeline] Cluster breakdown: ${clusterSummary}`);
  }

  // Step 5: Analyze clusters (LLM - labels, opinions, summaries)
  updateProgress(5);
  console.log(`[ReportPipeline] Step 5: ${STEPS[4]}`);
  const analyzedClusters = await analyzeClusters(
    clustererResult.clusters,
    apiUrl,
    model,
    language
  );
  console.log(`[ReportPipeline] Analyzed ${analyzedClusters.length} clusters`);

  // Step 6: Ground opinions (LLM)
  updateProgress(6);
  console.log(`[ReportPipeline] Step 6: ${STEPS[5]}`);
  const groundingResult = await groundOpinions(analyzedClusters, apiUrl, model);
  console.log(`[ReportPipeline] Grounded opinions in ${groundingResult.clusters.length} clusters`);

  // Step 7: Calculate statistics
  updateProgress(7);
  console.log(`[ReportPipeline] Step 7: ${STEPS[6]}`);
  const analyzerResult = analyzeData(
    substantiveMessages,
    groundingResult.clusters,
    parserResult.threadCount,
    parserResult.messages.length, // Total messages (no sampling)
    false, // wasSampled = false (TRD 12)
    nonSubstantiveCount,
    filteringBreakdown
  );

  // Step 8: Synthesize insights (LLM)
  updateProgress(8);
  console.log(`[ReportPipeline] Step 8: ${STEPS[7]}`);
  const synthesizerResult = await synthesizeReport(
    groundingResult.clusters,
    analyzerResult.statistics,
    apiUrl,
    model,
    language
  );
  console.log(
    `[ReportPipeline] Synthesized ${synthesizerResult.synthesis.keyFindings.length} key findings`
  );

  // Step 9: Generate visualization
  updateProgress(9);
  console.log(`[ReportPipeline] Step 9: ${STEPS[8]}`);
  const visualizerResult = await generateVisualizationData(
    groundingResult.clusters,
    analyzerResult.statistics,
    clustererResult.visualization // Pass UMAP coordinates
  );
  console.log(`[ReportPipeline] Generated visualization data`);

  // Step 10: Render markdown
  updateProgress(10);
  console.log(`[ReportPipeline] Step 10: ${STEPS[9]}`);
  const rendererResult = renderMarkdown(
    analyzerResult.statistics,
    groundingResult.clusters,
    synthesizerResult.synthesis,
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
    markdown: rendererResult.markdown,
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
    `${report.statistics.totalMessages} substantive messages`
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
export { embedMessages, createOpenAIEmbedder } from "./embedder";
export {
  categorizeByEmbedding,
  categorizeEmbeddedMessages,
  initializeCategoryEmbeddings,
} from "./categorizer";
export { clusterByEmbedding } from "./clusterer";
export { analyzeClusters } from "./clusterAnalyzer";
export { groundOpinions } from "./grounding";
export { synthesizeReport } from "./synthesizer";
export { analyzeData } from "./analyzer";
export { generateVisualizationData } from "./visualizer";
export { renderMarkdown } from "./renderer";

// Legacy exports for backward compatibility
export { categorizeMessages } from "./categorizer.legacy";
export { clusterMessages } from "./clusterer.legacy";

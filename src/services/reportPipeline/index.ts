import { v4 as uuidv4 } from "uuid";
import { parseThreads } from "./parser";
import { categorizeMessages } from "./categorizer";
import { clusterMessages } from "./clusterer";
import { analyzeData } from "./analyzer";
import { groundOpinions } from "./grounding";
import { synthesizeReport } from "./synthesizer";
import { generateVisualizationData } from "./visualizer";
import { renderMarkdown } from "./renderer";
import {
  Report,
  ReportRequestParams,
  ReportJobProgress,
  VisualizationData,
} from "../../types/report";
import { validateReportMessages, validateStatistics } from "../../utils/reportValidator";

export type ProgressCallback = (progress: ReportJobProgress) => void;

const STEPS = [
  "Parsing threads & anonymizing",
  "Categorizing messages",
  "Clustering by topic",
  "Analyzing statistics",
  "Grounding opinions",           // TRD 05: Link opinions to supporting messages
  "Synthesizing insights",
  "Generating visualization data",
  "Generating report",
];

/**
 * Execute the full report generation pipeline
 */
export async function generateReport(
  params: ReportRequestParams,
  apiUrl: string,
  model: string,
  onProgress?: ProgressCallback
): Promise<Report> {
  const reportId = uuidv4();
  const title = "User Conversation Analysis Report";

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

  // Step 1: Parse threads and extract user messages
  updateProgress(1);
  console.log(`[ReportPipeline] Step 1: ${STEPS[0]}`);
  const parserResult = await parseThreads(params);
  console.log(`[ReportPipeline] Parsed ${parserResult.messages.length} messages from ${parserResult.threadCount} threads`);

  if (parserResult.messages.length === 0) {
    // Return empty report if no messages
    return {
      id: reportId,
      title,
      createdAt: Date.now(),
      statistics: {
        totalMessages: 0,
        totalThreads: parserResult.threadCount,
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

  // Determine language (default to "en")
  const language = params.language || "en";

  // Step 2: Categorize messages using LLM
  updateProgress(2);
  console.log(`[ReportPipeline] Step 2: ${STEPS[1]}`);
  console.log(`[ReportPipeline] Input to categorizer: ${parserResult.messages.length} messages`);
  const categorizerResult = await categorizeMessages(
    parserResult.messages,
    apiUrl,
    model,
    language
  );
  console.log(`[ReportPipeline] Categorized ${categorizerResult.messages.length} messages`);

  // Filter out non-substantive messages for clustering
  const substantiveMessages = categorizerResult.messages.filter(m => m.isSubstantive);
  const filteredCount = categorizerResult.messages.length - substantiveMessages.length;
  console.log(`[ReportPipeline] Substantive: ${substantiveMessages.length}, Non-substantive: ${filteredCount}`);
  if (substantiveMessages.length > 0) {
    console.log(`[ReportPipeline] Sample substantive message: "${substantiveMessages[0].content.substring(0, 50)}..."`);
  }

  // Step 3: Cluster messages by topic (only substantive messages)
  updateProgress(3);
  console.log(`[ReportPipeline] Step 3: ${STEPS[2]}`);
  console.log(`[ReportPipeline] Input to clusterer: ${substantiveMessages.length} substantive messages`);
  const clustererResult = await clusterMessages(
    substantiveMessages,
    apiUrl,
    model,
    language
  );
  console.log(`[ReportPipeline] Created ${clustererResult.clusters.length} clusters`);
  if (clustererResult.clusters.length > 0) {
    const clusterSummary = clustererResult.clusters.map(c => `${c.topic}(${c.messages.length})`).join(", ");
    console.log(`[ReportPipeline] Cluster breakdown: ${clusterSummary}`);
  } else {
    console.warn(`[ReportPipeline] WARNING: No clusters created from ${substantiveMessages.length} messages`);
  }

  // Step 4: Analyze data and generate statistics
  updateProgress(4);
  console.log(`[ReportPipeline] Step 4: ${STEPS[3]}`);
  const analyzerResult = analyzeData(
    substantiveMessages, // Use only substantive messages for stats
    clustererResult.clusters,
    parserResult.threadCount,
    parserResult.totalMessagesBeforeSampling,
    parserResult.wasSampled,
    filteredCount,
    categorizerResult.filteringBreakdown
  );

  // Step 5: Ground opinions to supporting messages (TRD 05)
  updateProgress(5);
  console.log(`[ReportPipeline] Step 5: ${STEPS[4]}`);
  const groundingResult = await groundOpinions(
    clustererResult.clusters,
    apiUrl,
    model
  );
  console.log(`[ReportPipeline] Grounded opinions in ${groundingResult.clusters.length} clusters`);
  if (groundingResult.performanceMs) {
    console.log(`[ReportPipeline] Grounding performance: ${groundingResult.performanceMs}ms`);
  }

  // Step 6: Synthesize insights across all clusters
  updateProgress(6);
  console.log(`[ReportPipeline] Step 6: ${STEPS[5]}`);
  const synthesizerResult = await synthesizeReport(
    groundingResult.clusters, // Use grounded clusters
    analyzerResult.statistics,
    apiUrl,
    model,
    language
  );
  console.log(`[ReportPipeline] Synthesized ${synthesizerResult.synthesis.keyFindings.length} key findings`);

  // Step 7: Generate visualization data
  updateProgress(7);
  console.log(`[ReportPipeline] Step 7: ${STEPS[6]}`);
  const visualizerResult = await generateVisualizationData(
    groundingResult.clusters, // Use grounded clusters
    analyzerResult.statistics
  );
  console.log(`[ReportPipeline] Generated visualization data`);

  // Step 8: Render markdown report
  updateProgress(8);
  console.log(`[ReportPipeline] Step 8: ${STEPS[7]}`);
  const rendererResult = renderMarkdown(
    analyzerResult.statistics,
    groundingResult.clusters, // Use grounded clusters
    synthesizerResult.synthesis,
    { timezone: params.timezone, language: params.language }
  );

  // Build report
  const report: Report = {
    id: reportId,
    title,
    createdAt: Date.now(),
    statistics: analyzerResult.statistics,
    clusters: groundingResult.clusters, // Use grounded clusters
    synthesis: synthesizerResult.synthesis,
    visualization: visualizerResult.visualization,
    markdown: rendererResult.markdown,
  };

  // Validation: Ensure data quality
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
    `[ReportPipeline] Validation passed: ${report.clusters.length} clusters, ${report.statistics.totalMessages} substantive messages`
  );
  console.log(`[ReportPipeline] Report generation completed`);

  return report;
}

export { parseThreads } from "./parser";
export { categorizeMessages } from "./categorizer";
export { clusterMessages } from "./clusterer";
export { groundOpinions } from "./grounding";
export { synthesizeReport } from "./synthesizer";
export { analyzeData } from "./analyzer";
export { generateVisualizationData } from "./visualizer";
export { renderMarkdown } from "./renderer";

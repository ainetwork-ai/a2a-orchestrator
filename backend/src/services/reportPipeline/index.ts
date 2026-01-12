import { v4 as uuidv4 } from "uuid";
import { parseThreads } from "./parser";
import { categorizeMessages } from "./categorizer";
import { clusterMessages } from "./clusterer";
import { analyzeData } from "./analyzer";
import { renderMarkdown } from "./renderer";
import {
  Report,
  ReportRequestParams,
  ReportJobProgress,
} from "../../types/report";

export type ProgressCallback = (progress: ReportJobProgress) => void;

const STEPS = [
  "Parsing threads & anonymizing",
  "Categorizing messages",
  "Clustering by topic",
  "Analyzing statistics",
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

  // Step 2: Categorize messages using LLM
  updateProgress(2);
  console.log(`[ReportPipeline] Step 2: ${STEPS[1]}`);
  const categorizerResult = await categorizeMessages(
    parserResult.messages,
    apiUrl,
    model
  );
  console.log(`[ReportPipeline] Categorized ${categorizerResult.messages.length} messages`);

  // Filter out non-substantive messages for clustering
  const substantiveMessages = categorizerResult.messages.filter(m => m.isSubstantive);
  const filteredCount = categorizerResult.messages.length - substantiveMessages.length;
  console.log(`[ReportPipeline] Filtered ${filteredCount} non-substantive messages (greetings/chitchat)`);

  // Step 3: Cluster messages by topic (only substantive messages)
  updateProgress(3);
  console.log(`[ReportPipeline] Step 3: ${STEPS[2]}`);
  const clustererResult = await clusterMessages(
    substantiveMessages,
    apiUrl,
    model
  );
  console.log(`[ReportPipeline] Created ${clustererResult.clusters.length} clusters`);

  // Step 4: Analyze data and generate statistics
  updateProgress(4);
  console.log(`[ReportPipeline] Step 4: ${STEPS[3]}`);
  const analyzerResult = analyzeData(
    substantiveMessages, // Use only substantive messages for stats
    clustererResult.clusters,
    parserResult.threadCount,
    parserResult.totalMessagesBeforeSampling,
    parserResult.wasSampled,
    filteredCount
  );

  // Step 5: Render markdown report
  updateProgress(5);
  console.log(`[ReportPipeline] Step 5: ${STEPS[4]}`);
  const rendererResult = renderMarkdown(
    analyzerResult.statistics,
    clustererResult.clusters,
    title
  );

  console.log(`[ReportPipeline] Report generation completed`);

  return {
    id: reportId,
    title,
    createdAt: Date.now(),
    statistics: analyzerResult.statistics,
    clusters: clustererResult.clusters,
    markdown: rendererResult.markdown,
  };
}

export { parseThreads } from "./parser";
export { categorizeMessages } from "./categorizer";
export { clusterMessages } from "./clusterer";
export { analyzeData } from "./analyzer";
export { renderMarkdown } from "./renderer";

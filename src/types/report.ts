// Report related types

export interface ParsedMessage {
  id: string;
  content: string;
  timestamp: number;
  // userId is removed for anonymization
}

export interface CategorizedMessage extends ParsedMessage {
  category: string;
  subCategory?: string;
  intent?: string;
  sentiment?: "positive" | "negative" | "neutral";
  // Whether the message has analytical value (not just greeting/chitchat)
  isSubstantive: boolean;
}

export interface ClusterSummary {
  consensus: string[];      // Common opinions
  conflicting: string[];    // Conflicting opinions (if any)
  sentiment: "positive" | "negative" | "mixed" | "neutral";
}

export interface ActionItem {
  action: string;           // e.g., "Improve loading speed"
  priority: "high" | "medium" | "low";
  rationale: string;        // e.g., "Many complaints, churn risk"
}

export interface MessageCluster {
  id: string;
  topic: string;
  description: string;
  messages: CategorizedMessage[];
  opinions: Opinion[]; // Grounded opinions with supporting messages (TRD 05)
  summary: ClusterSummary;
  nextSteps: ActionItem[];
}

export interface ReportStatistics {
  totalMessages: number;
  totalThreads: number;
  dateRange: {
    start: number;
    end: number;
  };
  categoryDistribution: Record<string, number>;
  sentimentDistribution: Record<string, number>;
  topTopics: Array<{
    topic: string;
    count: number;
    percentage: number;
  }>;
  averageMessagesPerThread: number;
  // Sampling info
  totalMessagesBeforeSampling: number;
  wasSampled: boolean;
  // Filtering info
  nonSubstantiveCount: number; // Messages filtered out (greetings, chitchat)
  filteringBreakdown?: FilteringBreakdown; // Detailed filtering reasons
}

export interface ReportSynthesis {
  overallSentiment: "positive" | "negative" | "mixed" | "neutral";
  keyFindings: string[];           // 3-5 key takeaways
  topPriorities: ActionItem[];     // Top 3-5 actions across all clusters
  executiveSummary: string;        // 2-3 sentence summary for decision makers
}

export interface Report {
  id: string;
  title: string;
  createdAt: number;
  statistics: ReportStatistics;
  clusters: MessageCluster[];
  synthesis?: ReportSynthesis;     // Total summary across all clusters
  visualization?: VisualizationData; // T3C-style visualization data
  markdown: string;
}

// Job related types
export type ReportJobStatus = "pending" | "processing" | "completed" | "failed";

export interface ReportJobProgress {
  step: number;
  totalSteps: number;
  currentStep: string;
  percentage: number;
}

export interface ReportJob {
  id: string;
  status: ReportJobStatus;
  progress?: ReportJobProgress;
  report?: Report;
  error?: string;
  createdAt: number;
  updatedAt: number;
  cachedAt?: number;
  // Request parameters for cache key
  params: ReportRequestParams;
}

export type ReportLanguage = "ko" | "en";

export interface ReportRequestParams {
  threadIds?: string[]; // Specific threads to analyze, or all if empty
  agentUrls?: string[]; // Filter by agent URLs (threads that include any of these agents)
  agentNames?: string[]; // Filter by agent names (threads that include any of these agents)
  startDate?: string; // ISO date string
  endDate?: string; // ISO date string
  maxMessages?: number; // Max messages to analyze (default: 1000, will sample if exceeded)
  timezone?: string; // IANA timezone (e.g., "Asia/Seoul", "America/New_York")
  language?: ReportLanguage; // Report language (defaults based on timezone if not specified)
}

// Report pipeline constants
export const DEFAULT_MAX_MESSAGES = 1000;
export const DEFAULT_DATE_RANGE_DAYS = 30; // Default to last 30 days if no date specified
export const MIN_MESSAGE_LENGTH = 3; // Minimum message length to include (filters out "Hi", "ㅇㅇ", etc.)

// Batch sizes for LLM processing
export const CATEGORIZER_BATCH_SIZE = 10; // Messages per batch in categorizer
export const CLUSTERER_BATCH_SIZE = 20; // Messages per batch in clusterer

// Sampling limits
export const SAMPLE_SIZE_FOR_TOPICS = 50; // Max messages to sample when identifying topics
export const MAX_SAMPLE_MESSAGES_PER_CLUSTER = 30; // Max messages to sample when analyzing each cluster

// Cache
export const REPORT_CACHE_TTL_SECONDS = 3600; // 1 hour cache

// Pipeline step results
export interface ParserResult {
  messages: ParsedMessage[];
  threadCount: number;
  totalMessagesBeforeSampling: number; // Original count before sampling
  wasSampled: boolean;
}

/**
 * Breakdown of filtering reasons for non-substantive messages
 */
export interface FilteringBreakdown {
  greetings: number;      // "Hi", "Hello", "안녕" etc.
  chitchat: number;       // Small talk, acknowledgments ("ok", "thanks")
  shortMessages: number;  // Messages too short to analyze
  other: number;          // Other non-substantive messages
}

export interface CategorizerResult {
  messages: CategorizedMessage[];
  filteringBreakdown?: FilteringBreakdown;
}

export interface ClustererResult {
  clusters: MessageCluster[];
}

export interface AnalyzerResult {
  statistics: ReportStatistics;
}

export interface RendererResult {
  markdown: string;
}

export interface SynthesizerResult {
  synthesis: ReportSynthesis;
}

/**
 * Grounding pipeline step result (TRD 05)
 */
export interface GroundingResult {
  clusters: MessageCluster[];  // Clusters with grounded opinions
  performanceMs?: number;      // Time taken for grounding step
}

// ============================================
// T3C-Style Report Types (TRD 01-04, 05)
// ============================================

/**
 * Opinion extracted from a topic cluster with grounding information (TRD 05)
 */
export interface Opinion {
  id: string;
  text: string;
  type: "consensus" | "conflicting" | "general";

  // Grounding fields (TRD 05 - Phase 1A)
  supportingMessages: string[];    // Message IDs (1-3 representative examples)
  mentionCount: number;            // Total messages that support this opinion
  representativeQuote?: string;    // Best single example quote
  confidence?: number;             // 0-1, how well supported
}

/**
 * Message reference in T3C format
 */
export interface MessageRef {
  id: string;
  content: string;
  timestamp: number;
  category: string;
  subCategory?: string;
  intent?: string;
  sentiment: "positive" | "negative" | "neutral";
  isSubstantive: boolean;
  context?: {
    threadId?: string;
  };
}

/**
 * Topic in T3C report format
 */
export interface Topic {
  id: string;
  name: string;
  description: string;
  parentId?: string | null;
  level: number;
  messageCount: number;
  percentage: number;
  sentiment: {
    overall: "positive" | "negative" | "mixed" | "neutral";
    distribution: {
      positive: number;
      negative: number;
      neutral: number;
    };
  };
  opinions: Opinion[];
  messages: MessageRef[];
  summary: ClusterSummary;
  nextSteps: ActionItem[];
  position?: {
    x: number;
    y: number;
  };
  color?: string;
}

/**
 * Scatter plot point for visualization
 */
export interface ScatterPoint {
  id: string;
  type: "message" | "topic" | "cluster";
  x: number;
  y: number;
  label: string;
  size?: number;
  color?: string;
  metadata: {
    sentiment?: string;
    category?: string;
    messageCount?: number;
    topicId?: string;
  };
}

/**
 * Scatter plot data structure
 */
export interface ScatterPlotData {
  points: ScatterPoint[];
  axes: {
    x: { label: string; min: number; max: number };
    y: { label: string; min: number; max: number };
  };
}

/**
 * Tree node for topic hierarchy
 */
export interface TreeNode {
  id: string;
  label: string;
  type: "topic" | "subtopic" | "message";
  parentId?: string;
  value: number;
  metadata: Record<string, unknown>;
}

/**
 * Tree link connecting nodes
 */
export interface TreeLink {
  source: string;
  target: string;
  weight?: number;
}

/**
 * Topic tree data structure
 */
export interface TopicTreeData {
  nodes: TreeNode[];
  links: TreeLink[];
}

/**
 * Chart data for various visualizations
 */
export interface ChartData {
  type: "bar" | "pie" | "line" | "area";
  data: Array<{
    label: string;
    value: number;
    color?: string;
    metadata?: Record<string, unknown>;
  }>;
}

/**
 * Complete visualization data for T3C report
 */
export interface VisualizationData {
  scatterPlot: ScatterPlotData;
  topicTree: TopicTreeData;
  charts: {
    sentiment?: ChartData;
    categories?: ChartData;
    topics?: ChartData;
    timeline?: ChartData;
  };
}

/**
 * Report metadata including processing info and scope
 */
export interface ReportMetadata {
  params: ReportRequestParams;
  processingTime: number;
  pipelineVersion: string;
  wasCached: boolean;
  cachedAt?: number;
  scope: {
    totalThreads: number;
    totalMessages: number;
    substantiveMessages: number;
    filteredMessages: number;
    dateRange: {
      start: number;
      end: number;
    };
  };
  filtering?: {
    totalBeforeFiltering: number;
    substantiveCount: number;
    nonSubstantiveCount: number;
    filteringRate: number;
    filterReasons?: FilteringBreakdown;
  };
}

/**
 * T3C-style report structure
 */
export interface T3CReport {
  id: string;
  title: string;
  createdAt: number;
  version: string;
  metadata: ReportMetadata;
  statistics: ReportStatistics;
  synthesis?: ReportSynthesis;
  topics: Topic[];
  visualization: VisualizationData;
  markdown?: string;
}

/**
 * Visualizer pipeline result
 */
export interface VisualizerResult {
  visualization: VisualizationData;
  performanceMs?: number; // Time taken to generate visualization data (TRD 02)
}

/**
 * Validation result for report data quality
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

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
  opinions: string[]; // Summary of different opinions in this cluster
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
  startDate?: string; // ISO date string
  endDate?: string; // ISO date string
  maxMessages?: number; // Max messages to analyze (default: 1000, will sample if exceeded)
  timezone?: string; // IANA timezone (e.g., "Asia/Seoul", "America/New_York")
  language?: ReportLanguage; // Report language (defaults based on timezone if not specified)
}

export const DEFAULT_MAX_MESSAGES = 1000;
export const DEFAULT_DATE_RANGE_DAYS = 30; // Default to last 30 days if no date specified
export const MIN_MESSAGE_LENGTH = 7; // Minimum message length to include (filters out "Hi", "ㅇㅇ", etc.)

// Pipeline step results
export interface ParserResult {
  messages: ParsedMessage[];
  threadCount: number;
  totalMessagesBeforeSampling: number; // Original count before sampling
  wasSampled: boolean;
}

export interface CategorizerResult {
  messages: CategorizedMessage[];
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

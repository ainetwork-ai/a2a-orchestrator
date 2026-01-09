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
}

export interface MessageCluster {
  id: string;
  topic: string;
  description: string;
  messages: CategorizedMessage[];
  opinions: string[]; // Summary of different opinions in this cluster
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
}

export interface Report {
  id: string;
  title: string;
  createdAt: number;
  statistics: ReportStatistics;
  clusters: MessageCluster[];
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

export interface ReportRequestParams {
  threadIds?: string[]; // Specific threads to analyze, or all if empty
  startDate?: number;
  endDate?: number;
}

// Pipeline step results
export interface ParserResult {
  messages: ParsedMessage[];
  threadCount: number;
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

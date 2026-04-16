// Report related types

// ============================================
// Core Pipeline Types
// ============================================

export interface ParsedMessage {
  id: string;
  threadId: string;
  content: string;
  timestamp: number;
}

// ============================================
// T3C-aligned Output Types
// ============================================

/**
 * Reference to a specific message in a conversation segment
 */
export interface Reference {
  id: string;
  sourceId: string;          // threadId
  segmentId: string;         // conversation segment ID
  messageId: string;         // specific message ID
}

/**
 * Quote from a conversation — an individual message backing a claim
 */
export interface Quote {
  id: string;
  text: string;              // the key message content
  reference: Reference;
}

/**
 * A claim extracted from conversations (T3C: Claim)
 * Includes AINSPACE extensions: stance, confidence, evolved
 */
export interface Claim {
  id: string;
  speaker: string;           // "User" or agent name
  title: string;             // self-contained opinion statement
  quotes: Quote[];           // original messages backing this claim
  context: SegmentMessage[]; // full conversation segment (once per claim, not per quote)
  number: number;            // mention count (= quotes.length)
  similarClaims: Claim[];    // empty for now, T3C compatibility
  // AINSPACE extensions
  stance: "support" | "oppose" | "neutral" | "request" | "question";
  confidence: number;        // 0.0~1.0
  evolved: boolean;          // whether opinion changed during conversation
}

export interface ClusterSummary {
  consensus: string[];
  conflicting: string[];
  sentiment: "positive" | "negative" | "mixed" | "neutral";
}

/**
 * Topic cluster (T3C: Topic)
 */
export interface Topic {
  id: string;
  title: string;             // topic label
  description: string;
  claims: Claim[];
  summary: ClusterSummary;
}

/**
 * Source — represents a conversation thread (T3C: Source)
 */
export interface Source {
  id: string;                // threadId
  segmentCount: number;
}

export interface ReportStatistics {
  totalOpinions: number;
  totalSegments: number;
  totalThreads: number;
  dateRange: {
    start: number;
    end: number;
  };
  stanceDistribution: Record<string, number>;
  speakerDistribution: Record<string, number>;
  topTopics: Array<{
    topic: string;
    count: number;
    percentage: number;
  }>;
  deliberation: {
    totalOpinions: number;
    evolvedCount: number;
  };
}

export interface ReportSynthesis {
  overallSentiment: "positive" | "negative" | "mixed" | "neutral";
  keyFindings: string[];
  executiveSummary: string;
}

/**
 * Report (T3C-aligned: ReportDataObj)
 */
export interface Report {
  title: string;
  description: string;
  date: string;              // ISO date string
  topics: Topic[];
  sources: Source[];
  // AINSPACE extensions
  statistics: ReportStatistics;
  synthesis?: ReportSynthesis;
}

// ============================================
// Job Types
// ============================================

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
  params: ReportRequestParams;
  title?: string;
  description?: string;
  tags?: string[];
}

export type ReportLanguage = "ko" | "en";

export interface ReportRequestParams {
  threadIds?: string[];
  agentUrls?: string[];
  agentNames?: string[];
  startDate?: string;
  endDate?: string;
  maxMessages?: number;
  timezone?: string;
  language?: ReportLanguage;
  title?: string;
  description?: string;
  tags?: string[];
}

// ============================================
// Query & Pagination Types
// ============================================

export interface ReportJobQuery {
  page?: number;
  limit?: number;
  tags?: string[];
  startDate?: string;
  endDate?: string;
  status?: ReportJobStatus;
  search?: string;
  sortBy?: "createdAt" | "updatedAt" | "title";
  sortOrder?: "asc" | "desc";
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export interface ReportJobSummary {
  jobId: string;
  status: ReportJobStatus;
  progress?: ReportJobProgress;
  createdAt: number;
  updatedAt: number;
  cachedAt?: number;
  error?: string;
  title?: string;
  description?: string;
  tags?: string[];
  reportSummary?: {
    totalOpinions: number;
    topicCount: number;
    dateRange?: {
      start: number;
      end: number;
    };
  };
}

// ============================================
// Pipeline Constants
// ============================================

export const DEFAULT_MAX_MESSAGES = 1000;
export const DEFAULT_DATE_RANGE_DAYS = 30;
export const MIN_MESSAGE_LENGTH = 3;
export const REPORT_CACHE_TTL_SECONDS = 3600;

// ============================================
// Pipeline Step Result Types
// ============================================

export interface AnalyzerResult {
  statistics: ReportStatistics;
}

export interface SynthesizerResult {
  synthesis: ReportSynthesis;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

// ============================================
// Conversation-Aware Opinion Extraction
// ============================================

export interface SegmentMessage {
  id: string;
  speaker: string;
  content: string;
  timestamp: number;
  isUser: boolean;
}

export interface ConversationSegment {
  id: string;
  threadId: string;
  messages: SegmentMessage[];
  startTimestamp: number;
  endTimestamp: number;
}

export interface ConversationParserResult {
  segments: ConversationSegment[];
  threadCount: number;
  totalMessages: number;
}

export interface OpinionSource {
  segmentId: string;
  keyMessageIds: string[];
}

export interface ExtractedOpinion {
  id: string;
  speaker: string;           // "User" or agent name
  statement: string;
  stance: "support" | "oppose" | "neutral" | "request" | "question";
  confidence: number;
  evolved: boolean;
  quote?: string;            // LLM-extracted concise quote from conversation
  source: OpinionSource;
  timestamp: number;
  threadId: string;
}

export interface OpinionExtractionResult {
  opinions: ExtractedOpinion[];
  totalSegmentsProcessed: number;
  emptySegments: number;
  failedSegments: number;
  evolvedOpinionCount: number;
}

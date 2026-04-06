// Report related types

export interface ParsedMessage {
  id: string;
  threadId: string;  // Thread ID for unique user count (TRD 13)
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
  messages: ParsedMessage[];
  opinions: Opinion[];
  summary: ClusterSummary;
  nextSteps: ActionItem[];
}


export interface ReportStatistics {
  totalOpinions: number;
  totalThreads: number;
  dateRange: {
    start: number;
    end: number;
  };
  stanceDistribution: Record<string, number>;
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
  synthesis?: ReportSynthesis;
  // EPIC1: Conversation-aware opinion extraction
  extractedOpinions?: ExtractedOpinion[];
  conversationSegments?: ConversationSegment[];
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

  // Metadata fields for report management (TRD 06)
  title?: string;
  description?: string;
  tags?: string[];
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

  // Metadata options for report management (TRD 06)
  title?: string; // Report title
  description?: string; // Report description
  tags?: string[]; // Tags for filtering/searching

}

// ============================================
// Report Query & Pagination Types (TRD 06)
// ============================================

/**
 * Query parameters for report job list
 */
export interface ReportJobQuery {
  // Pagination
  page?: number;
  limit?: number;

  // Filtering
  tags?: string[];
  startDate?: string; // ISO date string (createdAt filter)
  endDate?: string; // ISO date string (createdAt filter)
  status?: ReportJobStatus;

  // Search
  search?: string; // Search in title and description

  // Sorting
  sortBy?: "createdAt" | "updatedAt" | "title";
  sortOrder?: "asc" | "desc";
}

/**
 * Paginated result wrapper
 */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

/**
 * Summary of a report job for list view
 */
export interface ReportJobSummary {
  jobId: string;
  status: ReportJobStatus;
  progress?: ReportJobProgress;
  createdAt: number;
  updatedAt: number;
  cachedAt?: number;
  error?: string;

  // Metadata
  title?: string;
  description?: string;
  tags?: string[];

  // Report summary (if completed)
  reportSummary?: {
    totalMessages: number;
    topicCount: number;
    dateRange?: {
      start: number;
      end: number;
    };
  };
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

export interface SynthesizerResult {
  synthesis: ReportSynthesis;
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
  supportingMessages: string[];    // All message IDs that support this opinion
  mentionCount: number;            // Count of supporting messages (= supportingMessages.length)
  representativeQuote?: string;    // Best single example quote
  confidence?: number;             // 0-1, how well supported

  // EPIC1: Conversation segment traceability
  sourceSegmentIds?: string[];     // Conversation segment IDs backing this opinion
}


/**
 * Validation result for report data quality
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
}

// ============================================
// EPIC1: Conversation-Aware Opinion Extraction
// ============================================

/**
 * A single message within a conversation segment
 */
export interface SegmentMessage {
  id: string;
  speaker: string;               // "User" | agent name
  content: string;
  timestamp: number;
  isUser: boolean;
}

/**
 * A segment of conversation (topic-coherent block of messages)
 */
export interface ConversationSegment {
  id: string;                    // segment unique ID
  threadId: string;              // source thread ID
  messages: SegmentMessage[];    // user + agent messages in sequence
  startTimestamp: number;
  endTimestamp: number;
}

/**
 * Result of conversation parsing
 */
export interface ConversationParserResult {
  segments: ConversationSegment[];
  threadCount: number;
  totalMessages: number;         // total user + agent messages
}

/**
 * Source reference linking an extracted opinion to its conversation segment
 */
export interface OpinionSource {
  segmentId: string;              // source segment ID (segment stored separately)
  keyMessageIds: string[];        // message IDs that are the basis for this opinion
}

/**
 * A structured opinion extracted from a conversation segment by LLM
 */
export interface ExtractedOpinion {
  id: string;
  statement: string;              // self-contained opinion sentence
  stance: "support" | "oppose" | "neutral" | "request" | "question";
  confidence: number;             // 0.0~1.0 how firm the opinion is
  evolved: boolean;               // whether opinion changed during conversation
  source: OpinionSource;          // traceability to original conversation
  timestamp: number;              // when the opinion was expressed
  threadId: string;
}

/**
 * Result of opinion extraction from conversation segments
 */
export interface OpinionExtractionResult {
  opinions: ExtractedOpinion[];
  totalSegmentsProcessed: number;
  emptySegments: number;          // segments with no extractable opinions
  failedSegments: number;         // segments where LLM extraction failed
  evolvedOpinionCount: number;
}

import { v4 as uuidv4 } from "uuid";
import { getStateClient, rethrowAuthoritativeStateError } from "../utils/state";
import { mapConcurrent } from "../utils/concurrent-map";
import { ReportJobIndex, REPORT_JOB_PREFIX } from "./report-job-index";
import { generateReport } from "./reportPipeline";
import { AinmemReportPublisher, loadAinmemReportConfig } from "./ainmemReports";
import {
  Report,
  ReportJob,
  ReportJobStatus,
  ReportRequestParams,
  ReportJobProgress,
  ReportJobQuery,
  ReportJobSummary,
  PaginatedResult,
  REPORT_CACHE_TTL_SECONDS,
} from "../types/report";

const JOB_PREFIX = REPORT_JOB_PREFIX;
const CACHE_PREFIX = "report:cache:";
// Listing reads these small records instead of whole jobs with full reports.
const SUMMARY_PREFIX = "report:summary:";
const LIST_READ_CONCURRENCY = 8;

function isInFlight(job: ReportJob): boolean {
  return job.status === "pending" || job.status === "processing";
}

function toJobSummary(job: ReportJob): ReportJobSummary {
  return {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    cachedAt: job.cachedAt,
    error: job.error,
    title: job.title,
    description: job.description,
    tags: job.tags,
    reportSummary: job.report ? buildReportSummary(job.report) : undefined,
  };
}

/**
 * Check if a report uses the legacy format (pre-EPIC3).
 * Legacy reports have `clusters` instead of `topics`.
 */
function isLegacyReport(report: unknown): boolean {
  const raw = report as Record<string, unknown>;
  return !Array.isArray(raw.topics) && Array.isArray(raw.clusters);
}

/**
 * Build reportSummary for job listing, handling both legacy and current formats.
 */
function buildReportSummary(report: unknown): ReportJobSummary["reportSummary"] {
  const raw = report as Record<string, unknown>;

  if (isLegacyReport(report)) {
    const stats = raw.statistics as Record<string, unknown> | undefined;
    const clusters = raw.clusters as unknown[] | undefined;
    return {
      totalOpinions: (stats?.totalMessages as number) || 0,
      topicCount: clusters?.length || 0,
      dateRange: stats?.dateRange as { start: number; end: number } | undefined,
    };
  }

  const typed = report as Report;
  return {
    totalOpinions: typed.statistics.totalOpinions,
    topicCount: typed.topics.length,
    dateRange: typed.statistics.dateRange,
  };
}

class ReportService {
  private static instance: ReportService;
  // In-flight jobs only. Finished jobs live in the state store; keeping every
  // job (with its full report) here grew the heap until the process died.
  private jobs: Map<string, ReportJob> = new Map();
  private summaryBackfills = new Set<string>();
  private jobIndex?: ReportJobIndex;
  private index(): ReportJobIndex { return this.jobIndex ??= new ReportJobIndex(getStateClient()); }
  private apiUrl: string;
  private model: string;
  private publisher?: AinmemReportPublisher;
  private publicationTimer?: NodeJS.Timeout;

  private constructor(apiUrl: string, model: string) {
    this.apiUrl = apiUrl;
    this.model = model;
  }

  static initialize(apiUrl: string, model: string): ReportService {
    if (!ReportService.instance) {
      ReportService.instance = new ReportService(apiUrl, model);
    }
    return ReportService.instance;
  }

  static getInstance(): ReportService {
    if (!ReportService.instance) {
      throw new Error("ReportService not initialized. Call initialize() first.");
    }
    return ReportService.instance;
  }

  startPublication(): void {
    const path = process.env.AINMEM_REPORT_CONFIG;
    if (!path || this.publisher) return;
    this.publisher = new AinmemReportPublisher(getStateClient(), loadAinmemReportConfig(path));
    const flush = () => { void this.publisher!.flush().catch((error: Error) => console.error(`[ReportService] Ainmem publication will retry: ${error.message}`)); };
    this.publicationTimer = setInterval(flush, 60000);
    this.publicationTimer.unref(); flush();
  }

  /**
   * Create a new report generation job
   */
  async createJob(params: ReportRequestParams): Promise<ReportJob> {
    // Check cache first
    const cacheKey = this.generateCacheKey(params);
    const cached = await this.getFromCache(cacheKey);
    if (cached) {
      console.log(`[ReportService] Cache hit for ${cacheKey}`);
      return cached;
    }

    // Create new job
    const jobId = uuidv4();
    const now = Date.now();

    const job: ReportJob = {
      id: jobId,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      params,
      // Metadata from params (TRD 06)
      title: params.title,
      description: params.description,
      tags: params.tags,
    };

    await this.saveJobToRedis(job);
    // Queue publication before acknowledging the new job. The queue lives in
    // the selected authoritative store and survives a process restart.
    if (this.publisher) await this.publisher.enqueue(jobId);

    // Start processing in background
    void this.processJob(jobId).catch((error: Error) => {
      console.error(`[ReportService] Job ${jobId} could not persist its final status: ${error.message}`);
    });

    return job;
  }

  /**
   * Get job status and result
   */
  async getJob(jobId: string): Promise<ReportJob | null> {
    // In-flight jobs are in memory; finished jobs come from the state store.
    const memoryJob = this.jobs.get(jobId);
    if (memoryJob) return memoryJob;
    return this.getJobFromRedis(jobId);
  }

  /**
   * Get all jobs (from Redis) - legacy method for backward compatibility
   */
  async getAllJobs(): Promise<ReportJob[]> {
    const result = await this.queryJobs({});
    // Return full jobs by fetching each one
    const jobs: ReportJob[] = [];
    for (const summary of result.items) {
      const job = await this.getJob(summary.jobId);
      if (job) jobs.push(job);
    }
    return jobs;
  }

  /**
   * Query jobs with pagination, filtering, and search (TRD 06)
   */
  async queryJobs(query: ReportJobQuery): Promise<PaginatedResult<ReportJobSummary>> {
    try {
      const keys = await this.index().keys();

      if (keys.length === 0) {
        return {
          items: [],
          total: 0,
          page: query.page || 1,
          limit: query.limit || 20,
          hasMore: false,
        };
      }

      // Fetch summaries in bounded parallel; full jobs are read only as a fallback.
      const summaries = await mapConcurrent(keys, LIST_READ_CONCURRENCY, key => this.readSummary(key.slice(JOB_PREFIX.length)));
      const jobs = summaries.filter((summary): summary is ReportJobSummary => summary !== null);

      // Apply filters
      let filtered = jobs;

      // Filter by status
      if (query.status) {
        filtered = filtered.filter((job) => job.status === query.status);
      }

      // Filter by tags
      if (query.tags && query.tags.length > 0) {
        filtered = filtered.filter((job) =>
          query.tags!.some((tag) => job.tags?.includes(tag))
        );
      }

      // Filter by date range (createdAt)
      if (query.startDate) {
        const startTimestamp = new Date(query.startDate).getTime();
        filtered = filtered.filter((job) => job.createdAt >= startTimestamp);
      }
      if (query.endDate) {
        const endTimestamp = new Date(query.endDate).getTime();
        filtered = filtered.filter((job) => job.createdAt <= endTimestamp);
      }

      // Search in title and description
      if (query.search) {
        const searchLower = query.search.toLowerCase();
        filtered = filtered.filter(
          (job) =>
            job.title?.toLowerCase().includes(searchLower) ||
            job.description?.toLowerCase().includes(searchLower)
        );
      }

      // Sort
      const sortBy = query.sortBy || "createdAt";
      const sortOrder = query.sortOrder || "desc";
      filtered.sort((a, b) => {
        let comparison = 0;
        if (sortBy === "title") {
          comparison = (a.title || "").localeCompare(b.title || "");
        } else if (sortBy === "updatedAt") {
          comparison = a.updatedAt - b.updatedAt;
        } else {
          comparison = a.createdAt - b.createdAt;
        }
        return sortOrder === "desc" ? -comparison : comparison;
      });

      // Pagination
      const page = Math.max(1, query.page || 1);
      const limit = Math.min(100, Math.max(1, query.limit || 20));
      const total = filtered.length;
      const startIndex = (page - 1) * limit;
      const items = filtered.slice(startIndex, startIndex + limit);

      return {
        items,
        total,
        page,
        limit,
        hasMore: startIndex + limit < total,
      };
    } catch (error) {
      console.error("[ReportService] Error querying jobs:", error);
      rethrowAuthoritativeStateError(error);
      return {
        items: [],
        total: 0,
        page: query.page || 1,
        limit: query.limit || 20,
        hasMore: false,
      };
    }
  }

  /**
   * Summary for one listed job: memory for in-flight jobs, then the stored
   * summary, then the full job (older jobs without a summary are backfilled).
   */
  private async readSummary(jobId: string): Promise<ReportJobSummary | null> {
    const inFlight = this.jobs.get(jobId);
    if (inFlight) return toJobSummary(inFlight);
    const redis = getStateClient();
    const stored = await redis.get(`${SUMMARY_PREFIX}${jobId}`);
    if (stored) return JSON.parse(stored) as ReportJobSummary;
    const job = await this.getJobFromRedis(jobId);
    if (!job) return null;
    const summary = toJobSummary(job);
    if (!this.summaryBackfills.has(jobId)) {
      this.summaryBackfills.add(jobId);
      // Best effort: the list stays correct from the full job if this write fails.
      void redis.set(`${SUMMARY_PREFIX}${jobId}`, JSON.stringify(summary))
        .catch((error: Error) => console.error(`[ReportService] Summary backfill for ${jobId} will retry: ${error.message}`))
        .finally(() => this.summaryBackfills.delete(jobId));
    }
    return summary;
  }

  /**
   * Process job in background
   */
  private async processJob(jobId: string): Promise<void> {
    const savedJob = this.jobs.get(jobId);
    if (!savedJob) return;
    // Work on a separate snapshot so polling sees only confirmed state.
    const job: ReportJob = JSON.parse(JSON.stringify(savedJob));
    let progressWrites: Promise<void> = Promise.resolve();
    let progressFailure: unknown;

    try {
      // Update status to processing
      job.status = "processing";
      job.updatedAt = Date.now();
      await this.saveJobToRedis(job);

      // Generate report with progress updates
      const report = await generateReport(
        job.params,
        this.apiUrl,
        this.model,
        (progress: ReportJobProgress) => {
          job.progress = progress;
          job.updatedAt = Date.now();
          const snapshot: ReportJob = JSON.parse(JSON.stringify(job));
          progressWrites = progressWrites.then(async () => {
            if (progressFailure) return;
            await this.saveJobToRedis(snapshot);
          }).catch((error: unknown) => { progressFailure = error; });
        }
      );

      await progressWrites;
      if (progressFailure) throw progressFailure;

      // Update job with result
      job.status = "completed";
      job.report = report;
      job.updatedAt = Date.now();
      job.cachedAt = Date.now();

      await this.saveJobToRedis(job);

      // Save to cache
      const cacheKey = this.generateCacheKey(job.params);
      await this.saveToCache(cacheKey, job);

      if (this.publisher) void this.publisher.flush().catch((error: Error) => console.error(`[ReportService] Ainmem publication will retry: ${error.message}`));
      console.log(`[ReportService] Job ${jobId} completed`);
    } catch (error: any) {
      await progressWrites;
      console.error(`[ReportService] Job ${jobId} failed:`, error);

      job.status = "failed";
      job.error = error.message || "Unknown error";
      job.updatedAt = Date.now();
      await this.saveJobToRedis(job);
    }
  }

  /**
   * Generate cache key from params
   */
  private generateCacheKey(params: ReportRequestParams): string {
    const parts = [
      params.threadIds?.sort().join(",") || "all",
      params.agentUrls?.sort().join(",") || "all",
      params.agentNames?.sort().join(",") || "all",
      params.startDate || "0",
      params.endDate || "0",
    ];
    return parts.join(":");
  }

  /**
   * Get from cache
   */
  private async getFromCache(cacheKey: string): Promise<ReportJob | null> {
    try {
      const redis = getStateClient();
      const data = await redis.get(`${CACHE_PREFIX}${cacheKey}`);
      if (data) {
        const job = JSON.parse(data) as ReportJob;
        // Check if cache is still valid
        if (job.cachedAt && Date.now() - job.cachedAt < REPORT_CACHE_TTL_SECONDS * 1000) {
          return job;
        }
      }
      return null;
    } catch (error) {
      console.error("[ReportService] Error getting from cache:", error);
      return null;
    }
  }

  /**
   * Save to cache
   */
  private async saveToCache(cacheKey: string, job: ReportJob): Promise<void> {
    try {
      const redis = getStateClient();
      await redis.setEx(
        `${CACHE_PREFIX}${cacheKey}`,
        REPORT_CACHE_TTL_SECONDS,
        JSON.stringify(job)
      );
    } catch (error) {
      console.error("[ReportService] Error saving to cache:", error);
    }
  }

  /**
   * Save job to Redis
   */
  private async saveJobToRedis(job: ReportJob): Promise<void> {
    try {
      const redis = getStateClient();
      await this.index().add(job.id);
      await redis.set(`${JOB_PREFIX}${job.id}`, JSON.stringify(job));
      if (isInFlight(job)) {
        this.jobs.set(job.id, JSON.parse(JSON.stringify(job)));
      } else {
        // The stored job is now authoritative: drop the in-flight copy before
        // the summary write so a failure there cannot leave a stale status.
        this.jobs.delete(job.id);
        await redis.set(`${SUMMARY_PREFIX}${job.id}`, JSON.stringify(toJobSummary(job)));
      }
    } catch (error) {
      console.error("[ReportService] Error saving job to Redis:", error);
      rethrowAuthoritativeStateError(error);
    }
  }

  /**
   * Get job from Redis
   */
  private async getJobFromRedis(jobId: string): Promise<ReportJob | null> {
    try {
      const redis = getStateClient();
      const data = await redis.get(`${JOB_PREFIX}${jobId}`);
      if (data) {
        return JSON.parse(data) as ReportJob;
      }
      return null;
    } catch (error) {
      console.error("[ReportService] Error getting job from Redis:", error);
      rethrowAuthoritativeStateError(error);
      return null;
    }
  }

  /**
   * Update job metadata (title, description, tags) (TRD 06)
   */
  async updateJob(
    jobId: string,
    updates: { title?: string; description?: string; tags?: string[] }
  ): Promise<ReportJob | null> {
    try {
      const current = await this.getJob(jobId);
      if (!current) {
        return null;
      }
      const job: ReportJob = JSON.parse(JSON.stringify(current));

      // Update metadata fields
      if (updates.title !== undefined) {
        job.title = updates.title;
      }
      if (updates.description !== undefined) {
        job.description = updates.description;
      }
      if (updates.tags !== undefined) {
        job.tags = updates.tags;
      }

      job.updatedAt = Date.now();

      // Save to Redis and memory
      await this.saveJobToRedis(job);

      console.log(`[ReportService] Job ${jobId} metadata updated`);
      return job;
    } catch (error) {
      console.error("[ReportService] Error updating job:", error);
      rethrowAuthoritativeStateError(error);
      return null;
    }
  }

  /**
   * Delete a job (TRD 06)
   */
  async deleteJob(jobId: string): Promise<boolean> {
    try {
      const redis = getStateClient();

      // Check if job exists
      const job = await this.getJob(jobId);
      if (!job) {
        return false;
      }

      // Delete from Redis
      await redis.del(`${JOB_PREFIX}${jobId}`);
      await this.index().remove(jobId);
      await redis.del(`${SUMMARY_PREFIX}${jobId}`);

      // Delete from memory
      this.jobs.delete(jobId);

      // Also invalidate cache if this job was cached
      if (job.params) {
        const cacheKey = this.generateCacheKey(job.params);
        await redis.del(`${CACHE_PREFIX}${cacheKey}`);
      }

      console.log(`[ReportService] Job ${jobId} deleted`);
      return true;
    } catch (error) {
      console.error("[ReportService] Error deleting job:", error);
      rethrowAuthoritativeStateError(error);
      return false;
    }
  }

  /**
   * Invalidate cache for specific params
   */
  async invalidateCache(params?: ReportRequestParams): Promise<void> {
    try {
      const redis = getStateClient();
      if (params) {
        const cacheKey = this.generateCacheKey(params);
        await redis.del(`${CACHE_PREFIX}${cacheKey}`);
      } else {
        // Invalidate all report caches
        // Note: redis.keys() blocks Redis during execution (O(N)).
        // Acceptable here due to small number of report cache keys.
        // For larger scale, consider SCAN or Lua script for atomic operations.
        const keys = await redis.keys(`${CACHE_PREFIX}*`);
        if (keys.length > 0) {
          await redis.del(keys);
        }
      }
    } catch (error) {
      console.error("[ReportService] Error invalidating cache:", error);
    }
  }
}

export default ReportService;

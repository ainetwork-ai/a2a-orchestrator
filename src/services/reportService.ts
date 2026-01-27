import { v4 as uuidv4 } from "uuid";
import { getRedisClient } from "../utils/redis";
import { generateReport } from "./reportPipeline";
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

const JOB_PREFIX = "report:job:";
const CACHE_PREFIX = "report:cache:";

class ReportService {
  private static instance: ReportService;
  private jobs: Map<string, ReportJob> = new Map();
  private apiUrl: string;
  private model: string;

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

    this.jobs.set(jobId, job);
    await this.saveJobToRedis(job);

    // Start processing in background
    this.processJob(jobId);

    return job;
  }

  /**
   * Get job status and result
   */
  async getJob(jobId: string): Promise<ReportJob | null> {
    // Check in-memory first
    const memoryJob = this.jobs.get(jobId);
    if (memoryJob) return memoryJob;

    // Check Redis
    const redisJob = await this.getJobFromRedis(jobId);
    if (redisJob) {
      this.jobs.set(jobId, redisJob);
      return redisJob;
    }
    return null;
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
      const redis = getRedisClient();
      const keys = await redis.keys(`${JOB_PREFIX}*`);

      if (keys.length === 0) {
        return {
          items: [],
          total: 0,
          page: query.page || 1,
          limit: query.limit || 20,
          hasMore: false,
        };
      }

      // Fetch all jobs
      const jobs: ReportJob[] = [];
      for (const key of keys) {
        const data = await redis.get(key);
        if (data) {
          jobs.push(JSON.parse(data) as ReportJob);
        }
      }

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
      const paginatedJobs = filtered.slice(startIndex, startIndex + limit);

      // Transform to summary
      const items: ReportJobSummary[] = paginatedJobs.map((job) => ({
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
        reportSummary: job.report
          ? {
              totalMessages: job.report.statistics.totalMessages,
              topicCount: job.report.clusters.length,
              dateRange: job.report.statistics.dateRange,
            }
          : undefined,
      }));

      return {
        items,
        total,
        page,
        limit,
        hasMore: startIndex + limit < total,
      };
    } catch (error) {
      console.error("[ReportService] Error querying jobs:", error);
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
   * Process job in background
   */
  private async processJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

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
          this.saveJobToRedis(job);
        }
      );

      // Update job with result
      job.status = "completed";
      job.report = report;
      job.updatedAt = Date.now();
      job.cachedAt = Date.now();

      await this.saveJobToRedis(job);

      // Save to cache
      const cacheKey = this.generateCacheKey(job.params);
      await this.saveToCache(cacheKey, job);

      console.log(`[ReportService] Job ${jobId} completed`);
    } catch (error: any) {
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
      const redis = getRedisClient();
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
      const redis = getRedisClient();
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
      const redis = getRedisClient();
      await redis.set(`${JOB_PREFIX}${job.id}`, JSON.stringify(job));
    } catch (error) {
      console.error("[ReportService] Error saving job to Redis:", error);
    }
  }

  /**
   * Get job from Redis
   */
  private async getJobFromRedis(jobId: string): Promise<ReportJob | null> {
    try {
      const redis = getRedisClient();
      const data = await redis.get(`${JOB_PREFIX}${jobId}`);
      if (data) {
        return JSON.parse(data) as ReportJob;
      }
      return null;
    } catch (error) {
      console.error("[ReportService] Error getting job from Redis:", error);
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
      const job = await this.getJob(jobId);
      if (!job) {
        return null;
      }

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
      this.jobs.set(jobId, job);

      console.log(`[ReportService] Job ${jobId} metadata updated`);
      return job;
    } catch (error) {
      console.error("[ReportService] Error updating job:", error);
      return null;
    }
  }

  /**
   * Delete a job (TRD 06)
   */
  async deleteJob(jobId: string): Promise<boolean> {
    try {
      const redis = getRedisClient();

      // Check if job exists
      const job = await this.getJob(jobId);
      if (!job) {
        return false;
      }

      // Delete from Redis
      await redis.del(`${JOB_PREFIX}${jobId}`);

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
      return false;
    }
  }

  /**
   * Invalidate cache for specific params
   */
  async invalidateCache(params?: ReportRequestParams): Promise<void> {
    try {
      const redis = getRedisClient();
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

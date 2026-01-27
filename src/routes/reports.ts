import { Router, Request, Response } from "express";
import ReportService from "../services/reportService";
import {
  ReportRequestParams,
  ReportJobQuery,
  VisualizationData,
} from "../types/report";
import {
  transformToT3CFormat,
  extractTopicsSummary,
  extractStatistics,
} from "../utils/reportTransformer";

const router = Router();

/**
 * Create default visualization data for fallback
 */
function createDefaultVisualization(): VisualizationData {
  return {
    scatterPlot: {
      points: [],
      axes: {
        x: { label: "Sentiment", min: -1, max: 1 },
        y: { label: "Priority", min: 0, max: 1 },
      },
    },
    topicTree: {
      nodes: [],
      links: [],
    },
    charts: {},
  };
}

/**
 * GET /api/reports
 * Get all report jobs with pagination, filtering, and search (TRD 06)
 *
 * Query Parameters:
 * - page: number (default: 1)
 * - limit: number (default: 20, max: 100)
 * - tags: string (comma-separated)
 * - startDate: string (ISO date)
 * - endDate: string (ISO date)
 * - search: string (title, description search)
 * - status: string (pending, processing, completed, failed)
 * - sortBy: string (createdAt, updatedAt, title)
 * - sortOrder: string (asc, desc)
 *
 * Response:
 * - items: Array of ReportJobSummary
 * - total: number
 * - page: number
 * - limit: number
 * - hasMore: boolean
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const reportService = ReportService.getInstance();

    // Parse query parameters
    const query: ReportJobQuery = {
      page: req.query.page ? parseInt(req.query.page as string, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
      tags: req.query.tags ? (req.query.tags as string).split(",").map((t) => t.trim()) : undefined,
      startDate: req.query.startDate as string | undefined,
      endDate: req.query.endDate as string | undefined,
      search: req.query.search as string | undefined,
      status: req.query.status as ReportJobQuery["status"],
      sortBy: req.query.sortBy as ReportJobQuery["sortBy"],
      sortOrder: req.query.sortOrder as ReportJobQuery["sortOrder"],
    };

    // Validate query parameters
    if (query.page !== undefined && (isNaN(query.page) || query.page < 1)) {
      return res.status(400).json({ success: false, error: "page must be a positive integer" });
    }
    if (query.limit !== undefined && (isNaN(query.limit) || query.limit < 1 || query.limit > 100)) {
      return res.status(400).json({ success: false, error: "limit must be between 1 and 100" });
    }
    if (query.status && !["pending", "processing", "completed", "failed"].includes(query.status)) {
      return res.status(400).json({ success: false, error: "status must be: pending, processing, completed, or failed" });
    }
    if (query.sortBy && !["createdAt", "updatedAt", "title"].includes(query.sortBy)) {
      return res.status(400).json({ success: false, error: "sortBy must be: createdAt, updatedAt, or title" });
    }
    if (query.sortOrder && !["asc", "desc"].includes(query.sortOrder)) {
      return res.status(400).json({ success: false, error: "sortOrder must be: asc or desc" });
    }

    const result = await reportService.queryJobs(query);

    res.json({
      success: true,
      ...result,
    });
  } catch (error: unknown) {
    console.error("Error getting all report jobs:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

/**
 * POST /api/reports
 * Create a new report generation job
 *
 * Body:
 * - threadIds?: string[] - Specific thread IDs to analyze (optional, all if empty)
 * - startDate?: number - Start timestamp filter (optional)
 * - endDate?: number - End timestamp filter (optional)
 * - title?: string - Report title (TRD 06)
 * - description?: string - Report description (TRD 06)
 * - tags?: string[] - Tags for filtering/searching (TRD 06)
 *
 * Response:
 * - jobId: string - Job ID to poll for status
 * - status: "pending" | "processing" | "completed" | "failed"
 * - report?: Report - If cached, returns immediately
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const {
      threadIds,
      agentUrls,
      agentNames,
      startDate,
      endDate,
      timezone,
      language,
      title,
      description,
      tags,
    } = req.body;

    // Validation
    if (threadIds !== undefined && !Array.isArray(threadIds)) {
      return res.status(400).json({ success: false, error: "threadIds must be an array" });
    }
    if (agentUrls !== undefined && !Array.isArray(agentUrls)) {
      return res.status(400).json({ success: false, error: "agentUrls must be an array" });
    }
    if (agentNames !== undefined && !Array.isArray(agentNames)) {
      return res.status(400).json({ success: false, error: "agentNames must be an array" });
    }
    if (startDate !== undefined && (typeof startDate !== "string" || isNaN(Date.parse(startDate)))) {
      return res.status(400).json({ success: false, error: "startDate must be a valid ISO date string" });
    }
    if (endDate !== undefined && (typeof endDate !== "string" || isNaN(Date.parse(endDate)))) {
      return res.status(400).json({ success: false, error: "endDate must be a valid ISO date string" });
    }
    if (timezone !== undefined && typeof timezone !== "string") {
      return res.status(400).json({ success: false, error: "timezone must be a string" });
    }
    if (language !== undefined && !["ko", "en"].includes(language)) {
      return res.status(400).json({ success: false, error: "language must be 'ko' or 'en'" });
    }
    // Metadata validation (TRD 06)
    if (title !== undefined && typeof title !== "string") {
      return res.status(400).json({ success: false, error: "title must be a string" });
    }
    if (description !== undefined && typeof description !== "string") {
      return res.status(400).json({ success: false, error: "description must be a string" });
    }
    if (tags !== undefined && !Array.isArray(tags)) {
      return res.status(400).json({ success: false, error: "tags must be an array" });
    }
    if (tags !== undefined && !tags.every((t: unknown) => typeof t === "string")) {
      return res.status(400).json({ success: false, error: "all tags must be strings" });
    }

    const params: ReportRequestParams = {
      threadIds: threadIds || undefined,
      agentUrls: agentUrls || undefined,
      agentNames: agentNames || undefined,
      startDate,
      endDate,
      timezone,
      language,
      // Metadata (TRD 06)
      title,
      description,
      tags,
    };

    const reportService = ReportService.getInstance();
    const job = await reportService.createJob(params);

    res.json({
      success: true,
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      report: job.report,
      cachedAt: job.cachedAt,
      // Metadata in response (TRD 06)
      title: job.title,
      description: job.description,
      tags: job.tags,
    });
  } catch (error: unknown) {
    console.error("Error creating report job:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

/**
 * GET /api/reports/:jobId
 * Get report job status and result
 *
 * Query Parameters:
 * - format: "json" (default) | "markdown" | "full"
 * - includeMessages: "true" (default) | "false"
 *
 * Response:
 * - status: "pending" | "processing" | "completed" | "failed"
 * - progress?: { step, totalSteps, currentStep, percentage }
 * - report?: T3CReport | { markdown: string } - Available when status is "completed"
 * - error?: string - Available when status is "failed"
 */
router.get("/:jobId", async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const format = (req.query.format as string) || "json";
    const includeMessages = req.query.includeMessages !== "false";

    if (!jobId || typeof jobId !== "string") {
      return res.status(400).json({
        success: false,
        error: "Valid jobId is required",
      });
    }

    // Validate format parameter
    if (!["json", "markdown", "full"].includes(format)) {
      return res.status(400).json({
        success: false,
        error: "Invalid format. Must be: json, markdown, or full",
      });
    }

    const reportService = ReportService.getInstance();
    const job = await reportService.getJob(jobId);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job not found",
      });
    }

    // If not completed, return status only
    if (job.status !== "completed" || !job.report) {
      return res.json({
        success: true,
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        // Metadata (TRD 06)
        title: job.title,
        description: job.description,
        tags: job.tags,
      });
    }

    // Format response based on requested format
    switch (format) {
      case "markdown":
        return res.json({
          success: true,
          jobId: job.id,
          status: job.status,
          markdown: job.report.markdown,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          cachedAt: job.cachedAt,
          // Metadata (TRD 06)
          title: job.title,
          description: job.description,
          tags: job.tags,
        });

      case "full": {
        // Include both JSON and markdown
        const fullReport = transformToT3CFormat(job.report, job, includeMessages);
        fullReport.markdown = job.report.markdown;
        return res.json({
          success: true,
          jobId: job.id,
          status: job.status,
          report: fullReport,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          cachedAt: job.cachedAt,
          // Metadata (TRD 06)
          title: job.title,
          description: job.description,
          tags: job.tags,
        });
      }

      case "json":
      default: {
        // New T3C format (without markdown by default)
        const t3cReport = transformToT3CFormat(job.report, job, includeMessages);
        return res.json({
          success: true,
          jobId: job.id,
          status: job.status,
          report: t3cReport,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          cachedAt: job.cachedAt,
          // Metadata (TRD 06)
          title: job.title,
          description: job.description,
          tags: job.tags,
        });
      }
    }
  } catch (error: any) {
    console.error("Error getting report job:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Internal server error",
    });
  }
});

/**
 * GET /api/reports/:jobId/markdown
 * Get only the markdown content of a completed report
 *
 * Response: Plain text markdown
 */
router.get("/:jobId/markdown", async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;

    if (!jobId || typeof jobId !== "string") {
      return res.status(400).json({
        success: false,
        error: "Valid jobId is required",
      });
    }

    const reportService = ReportService.getInstance();
    const job = await reportService.getJob(jobId);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job not found",
      });
    }

    if (job.status !== "completed" || !job.report) {
      return res.status(400).json({
        success: false,
        error: "Report not yet completed",
        status: job.status,
      });
    }

    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.send(job.report.markdown);
  } catch (error: any) {
    console.error("Error getting report markdown:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Internal server error",
    });
  }
});

/**
 * GET /api/reports/:jobId/topics
 * Get only topics data (lightweight endpoint)
 *
 * Response: { topics: TopicSummary[] }
 */
router.get("/:jobId/topics", async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;

    if (!jobId || typeof jobId !== "string") {
      return res.status(400).json({
        success: false,
        error: "Valid jobId is required",
      });
    }

    const reportService = ReportService.getInstance();
    const job = await reportService.getJob(jobId);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job not found",
      });
    }

    if (job.status !== "completed" || !job.report) {
      return res.status(400).json({
        success: false,
        error: "Report not yet completed",
        status: job.status,
      });
    }

    const topics = extractTopicsSummary(job.report);

    res.json({
      success: true,
      jobId,
      topics,
    });
  } catch (error: any) {
    console.error("Error getting topics:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Internal server error",
    });
  }
});

/**
 * GET /api/reports/:jobId/visualization
 * Get only visualization data
 *
 * Response: { visualization: VisualizationData }
 */
router.get("/:jobId/visualization", async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;

    if (!jobId || typeof jobId !== "string") {
      return res.status(400).json({
        success: false,
        error: "Valid jobId is required",
      });
    }

    const reportService = ReportService.getInstance();
    const job = await reportService.getJob(jobId);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job not found",
      });
    }

    if (job.status !== "completed" || !job.report) {
      return res.status(400).json({
        success: false,
        error: "Report not yet completed",
        status: job.status,
      });
    }

    res.json({
      success: true,
      jobId,
      visualization: job.report.visualization || createDefaultVisualization(),
    });
  } catch (error: any) {
    console.error("Error getting visualization:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Internal server error",
    });
  }
});

/**
 * GET /api/reports/:jobId/statistics
 * Get only statistics and synthesis data
 *
 * Response: { statistics: ReportStatistics, synthesis: ReportSynthesis }
 */
router.get("/:jobId/statistics", async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;

    if (!jobId || typeof jobId !== "string") {
      return res.status(400).json({
        success: false,
        error: "Valid jobId is required",
      });
    }

    const reportService = ReportService.getInstance();
    const job = await reportService.getJob(jobId);

    if (!job) {
      return res.status(404).json({
        success: false,
        error: "Job not found",
      });
    }

    if (job.status !== "completed" || !job.report) {
      return res.status(400).json({
        success: false,
        error: "Report not yet completed",
        status: job.status,
      });
    }

    const { statistics, synthesis } = extractStatistics(job.report);

    res.json({
      success: true,
      jobId,
      statistics,
      synthesis,
    });
  } catch (error: any) {
    console.error("Error getting statistics:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Internal server error",
    });
  }
});

/**
 * PATCH /api/reports/:jobId
 * Update report job metadata (TRD 06)
 *
 * Body:
 * - title?: string
 * - description?: string
 * - tags?: string[]
 *
 * Response:
 * - success: boolean
 * - job: Updated job metadata
 */
router.patch("/:jobId", async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const { title, description, tags } = req.body;

    if (!jobId || typeof jobId !== "string") {
      return res.status(400).json({
        success: false,
        error: "Valid jobId is required",
      });
    }

    // Validate update fields
    if (title !== undefined && typeof title !== "string") {
      return res.status(400).json({ success: false, error: "title must be a string" });
    }
    if (description !== undefined && typeof description !== "string") {
      return res.status(400).json({ success: false, error: "description must be a string" });
    }
    if (tags !== undefined && !Array.isArray(tags)) {
      return res.status(400).json({ success: false, error: "tags must be an array" });
    }
    if (tags !== undefined && !tags.every((t: unknown) => typeof t === "string")) {
      return res.status(400).json({ success: false, error: "all tags must be strings" });
    }

    // Check if there's anything to update
    if (title === undefined && description === undefined && tags === undefined) {
      return res.status(400).json({
        success: false,
        error: "At least one field (title, description, or tags) must be provided",
      });
    }

    const reportService = ReportService.getInstance();
    const updatedJob = await reportService.updateJob(jobId, { title, description, tags });

    if (!updatedJob) {
      return res.status(404).json({
        success: false,
        error: "Job not found",
      });
    }

    res.json({
      success: true,
      job: {
        jobId: updatedJob.id,
        status: updatedJob.status,
        title: updatedJob.title,
        description: updatedJob.description,
        tags: updatedJob.tags,
        createdAt: updatedJob.createdAt,
        updatedAt: updatedJob.updatedAt,
      },
    });
  } catch (error: unknown) {
    console.error("Error updating report job:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

/**
 * DELETE /api/reports/:jobId
 * Delete a report job (TRD 06)
 *
 * Response:
 * - success: boolean
 * - message: string
 */
router.delete("/:jobId", async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;

    if (!jobId || typeof jobId !== "string") {
      return res.status(400).json({
        success: false,
        error: "Valid jobId is required",
      });
    }

    const reportService = ReportService.getInstance();
    const deleted = await reportService.deleteJob(jobId);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: "Job not found",
      });
    }

    res.json({
      success: true,
      message: "Job deleted",
    });
  } catch (error: unknown) {
    console.error("Error deleting report job:", error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
});

/**
 * DELETE /api/reports/cache
 * Invalidate report cache
 *
 * Body:
 * - threadIds?: string[] - Specific params to invalidate (optional, all if empty)
 */
router.delete("/cache", async (req: Request, res: Response) => {
  try {
    const { threadIds, startDate, endDate } = req.body;

    const params: ReportRequestParams | undefined =
      threadIds || startDate || endDate
        ? {
            threadIds: threadIds || undefined,
            startDate: startDate || undefined,
            endDate: endDate || undefined,
          }
        : undefined;

    const reportService = ReportService.getInstance();
    await reportService.invalidateCache(params);

    res.json({
      success: true,
      message: params ? "Specific cache invalidated" : "All cache invalidated",
    });
  } catch (error: any) {
    console.error("Error invalidating cache:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Internal server error",
    });
  }
});

export default router;

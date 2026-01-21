import { Router, Request, Response } from "express";
import ReportService from "../services/reportService";
import { ReportRequestParams } from "../types/report";

const router = Router();

/**
 * GET /api/reports
 * Get all report jobs
 *
 * Response:
 * - jobs: Array of { jobId, status, createdAt, updatedAt }
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const reportService = ReportService.getInstance();
    const jobs = await reportService.getAllJobs();

    // Return simplified job info (without full report data)
    const jobList = jobs.map((job) => ({
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      cachedAt: job.cachedAt,
      error: job.error,
    }));

    res.json({
      success: true,
      jobs: jobList,
      total: jobList.length,
    });
  } catch (error: any) {
    console.error("Error getting all report jobs:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Internal server error",
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
 *
 * Response:
 * - jobId: string - Job ID to poll for status
 * - status: "pending" | "processing" | "completed" | "failed"
 * - report?: Report - If cached, returns immediately
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const { threadIds, agentUrls, agentNames, startDate, endDate, timezone, language } = req.body;

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

    const params: ReportRequestParams = {
      threadIds: threadIds || undefined,
      agentUrls: agentUrls || undefined,
      agentNames: agentNames || undefined,
      startDate,
      endDate,
      timezone,
      language,
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
    });
  } catch (error: any) {
    console.error("Error creating report job:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Internal server error",
    });
  }
});

/**
 * GET /api/reports/:jobId
 * Get report job status and result
 *
 * Response:
 * - status: "pending" | "processing" | "completed" | "failed"
 * - progress?: { step, totalSteps, currentStep, percentage }
 * - report?: Report - Available when status is "completed"
 * - error?: string - Available when status is "failed"
 */
router.get("/:jobId", async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;

    if (!jobId || typeof jobId !== 'string') {
      return res.status(400).json({
        success: false,
        error: "Valid jobId is required"
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

    res.json({
      success: true,
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      report: job.report,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      cachedAt: job.cachedAt,
    });
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

    if (!jobId || typeof jobId !== 'string') {
      return res.status(400).json({
        success: false,
        error: "Valid jobId is required"
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

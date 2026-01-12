import { Router, Request, Response } from "express";
import ReportService from "../services/reportService";
import { ReportRequestParams } from "../types/report";

const router = Router();

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
    const { threadIds, startDate, endDate, timezone, language } = req.body;

    const params: ReportRequestParams = {
      threadIds: threadIds || undefined,
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

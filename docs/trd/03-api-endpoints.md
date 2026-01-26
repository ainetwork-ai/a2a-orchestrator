# Task 3: API Endpoint Updates

## Objective

Update API endpoints to support the new T3C-style JSON response format while maintaining backward compatibility with existing Markdown format.

## Current API Structure

### Existing Endpoints

```typescript
// src/routes/reports.ts

// 1. Get all report jobs
GET /api/reports
Response: { success: boolean, jobs: JobInfo[], total: number }

// 2. Create new report job
POST /api/reports
Body: { threadIds?, agentUrls?, agentNames?, startDate?, endDate?, timezone?, language? }
Response: { success: boolean, jobId: string, status: string, progress: object, report?: Report }

// 3. Get report status/result
GET /api/reports/:jobId
Response: { success: boolean, jobId: string, status: string, report?: Report, ... }

// 4. Get markdown only
GET /api/reports/:jobId/markdown
Response: Plain text (Markdown)

// 5. Delete cache
DELETE /api/reports/cache
Body: { threadIds?, startDate?, endDate? }
Response: { success: boolean, message: string }
```

## Proposed API Changes

### 1. Add Format Parameter

Add optional `format` query parameter to control response format:
- `format=json` (default) - New T3C-style JSON format
- `format=markdown` - Legacy Markdown string
- `format=full` - Both JSON and Markdown

### 2. New Endpoints

```typescript
// Get JSON report (new default)
GET /api/reports/:jobId?format=json
Response: T3CReport

// Get legacy markdown (backward compatible)
GET /api/reports/:jobId/markdown
Response: Plain text (Markdown)

// Get specific sections (optional, for performance)
GET /api/reports/:jobId/topics
Response: { topics: Topic[] }

GET /api/reports/:jobId/visualization
Response: { visualization: VisualizationData }

GET /api/reports/:jobId/statistics
Response: { statistics: ReportStatistics, synthesis: ReportSynthesis }
```

## Detailed API Specification

### Endpoint 1: Create Report Job

**No changes required** - existing endpoint works as-is.

```http
POST /api/reports
Content-Type: application/json

{
  "threadIds": ["thread-1", "thread-2"],
  "agentUrls": ["https://agent1.com"],
  "agentNames": ["Agent1"],
  "startDate": "2026-01-01T00:00:00Z",
  "endDate": "2026-01-26T23:59:59Z",
  "timezone": "Asia/Seoul",
  "language": "ko"
}
```

**Response** (202 Accepted if processing, 200 OK if cached):
```json
{
  "success": true,
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending|processing|completed",
  "progress": {
    "step": 2,
    "totalSteps": 7,
    "currentStep": "Categorizing messages",
    "percentage": 28
  },
  "report": null,
  "cachedAt": null
}
```

### Endpoint 2: Get Report (Updated)

Add format parameter support:

```http
GET /api/reports/:jobId?format=json
```

**Query Parameters:**
- `format` (optional): `json` (default) | `markdown` | `full`
- `includeMessages` (optional): `true` | `false` (default `true`)
  - If `false`, topics contain message count but not full message list (for performance)

**Response - JSON Format** (200 OK):
```json
{
  "success": true,
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "createdAt": 1706227200000,
  "updatedAt": 1706227205000,
  "cachedAt": 1706227205000,

  "report": {
    "id": "report-550e8400",
    "title": "User Conversation Analysis Report",
    "createdAt": 1706227205000,
    "version": "1.0.0",

    "metadata": {
      "params": { /* request params */ },
      "processingTime": 5432,
      "pipelineVersion": "1.0.0",
      "wasCached": true,
      "scope": {
        "totalThreads": 5,
        "totalMessages": 150,
        "substantiveMessages": 120,
        "filteredMessages": 30,
        "dateRange": {
          "start": 1704067200000,
          "end": 1706227200000
        }
      }
    },

    "statistics": { /* ReportStatistics */ },
    "synthesis": { /* ReportSynthesis */ },
    "topics": [ /* Topic[] */ ],
    "visualization": { /* VisualizationData */ }
  }
}
```

**Response - Markdown Format** (200 OK):
```json
{
  "success": true,
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "markdown": "# User Conversation Analysis Report\n\n..."
}
```

**Response - Full Format** (200 OK):
```json
{
  "success": true,
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "completed",
  "report": { /* T3CReport with markdown field included */ }
}
```

**Response - Processing** (200 OK):
```json
{
  "success": true,
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "processing",
  "progress": {
    "step": 3,
    "totalSteps": 7,
    "currentStep": "Clustering by topic",
    "percentage": 42
  },
  "report": null
}
```

**Response - Failed** (200 OK):
```json
{
  "success": true,
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "status": "failed",
  "error": "LLM API timeout after 3 retries",
  "createdAt": 1706227200000,
  "updatedAt": 1706227205000
}
```

**Error Responses:**
- `404 Not Found`: Job ID not found
- `400 Bad Request`: Invalid format parameter
- `500 Internal Server Error`: Server error

### Endpoint 3: Get Markdown Only (Existing)

**No changes** - maintain for backward compatibility:

```http
GET /api/reports/:jobId/markdown
```

**Response** (200 OK):
```
Content-Type: text/markdown; charset=utf-8

# User Conversation Analysis Report

> Generated at: 2026-01-26 10:00:00

## Executive Summary
...
```

### Endpoint 4: Get Topics Only (New, Optional)

For performance optimization when frontend only needs topic list:

```http
GET /api/reports/:jobId/topics
```

**Response** (200 OK):
```json
{
  "success": true,
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "topics": [
    {
      "id": "topic-1",
      "name": "Feature Requests",
      "description": "Messages requesting new features",
      "messageCount": 45,
      "percentage": 37.5,
      "sentiment": {
        "overall": "mixed",
        "distribution": { "positive": 20, "negative": 15, "neutral": 10 }
      }
    }
  ]
}
```

### Endpoint 5: Get Visualization Only (New, Optional)

```http
GET /api/reports/:jobId/visualization
```

**Response** (200 OK):
```json
{
  "success": true,
  "jobId": "550e8400-e29b-41d4-a716-446655440000",
  "visualization": {
    "scatterPlot": { /* ... */ },
    "topicTree": { /* ... */ },
    "charts": { /* ... */ }
  }
}
```

## Implementation Plan

### Phase 1: Update Route Handler

Update `src/routes/reports.ts`:

```typescript
import { Request, Response } from "express";
import ReportService from "../services/reportService";
import { transformToT3CFormat } from "../utils/reportTransformer";

/**
 * GET /api/reports/:jobId
 * Supports format parameter: json (default), markdown, full
 */
router.get("/:jobId", async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const { format = "json", includeMessages = "true" } = req.query;

    if (!jobId || typeof jobId !== "string") {
      return res.status(400).json({
        success: false,
        error: "Valid jobId is required",
      });
    }

    // Validate format parameter
    if (!["json", "markdown", "full"].includes(format as string)) {
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
        });

      case "full":
        // Include both JSON and markdown
        const fullReport = transformToT3CFormat(
          job.report,
          job,
          includeMessages === "true"
        );
        fullReport.markdown = job.report.markdown;
        return res.json({
          success: true,
          jobId: job.id,
          status: job.status,
          report: fullReport,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          cachedAt: job.cachedAt,
        });

      case "json":
      default:
        // New T3C format (without markdown)
        const t3cReport = transformToT3CFormat(
          job.report,
          job,
          includeMessages === "true"
        );
        return res.json({
          success: true,
          jobId: job.id,
          status: job.status,
          report: t3cReport,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          cachedAt: job.cachedAt,
        });
    }
  } catch (error: any) {
    console.error("Error getting report job:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Internal server error",
    });
  }
});
```

### Phase 2: Create Report Transformer

Create `src/utils/reportTransformer.ts`:

```typescript
import { Report, ReportJob, T3CReport, Topic } from "../types/report";

/**
 * Transform internal Report format to T3C format
 */
export function transformToT3CFormat(
  report: Report,
  job: ReportJob,
  includeMessages: boolean = true
): T3CReport {
  const topics: Topic[] = report.clusters.map((cluster, index) => ({
    id: cluster.id,
    name: cluster.topic,
    description: cluster.description,
    parentId: null,
    level: 0,
    messageCount: cluster.messages.length,
    percentage: calculatePercentage(
      cluster.messages.length,
      report.statistics.totalMessages
    ),
    sentiment: {
      overall: cluster.summary.sentiment,
      distribution: calculateSentimentDistribution(cluster.messages),
    },
    opinions: cluster.opinions.map((text, idx) => ({
      id: `${cluster.id}-op-${idx}`,
      text,
      type: "general",
    })),
    messages: includeMessages
      ? cluster.messages.map((msg) => ({
          id: msg.id,
          content: msg.content,
          timestamp: msg.timestamp,
          category: msg.category,
          subCategory: msg.subCategory,
          intent: msg.intent,
          sentiment: msg.sentiment || "neutral",
          isSubstantive: msg.isSubstantive,
        }))
      : [],
    summary: cluster.summary,
    nextSteps: cluster.nextSteps,
    position: report.visualization?.scatterPlot.points.find(
      (p) => p.id === cluster.id
    )?.position,
    color: report.visualization?.scatterPlot.points.find(
      (p) => p.id === cluster.id
    )?.color,
  }));

  return {
    id: report.id,
    title: report.title,
    createdAt: report.createdAt,
    version: "1.0.0",

    metadata: {
      params: job.params,
      processingTime: job.updatedAt - job.createdAt,
      pipelineVersion: "1.0.0",
      wasCached: !!job.cachedAt,
      scope: {
        totalThreads: report.statistics.totalThreads,
        totalMessages: report.statistics.totalMessages,
        substantiveMessages: report.statistics.totalMessages,
        filteredMessages: report.statistics.nonSubstantiveCount,
        dateRange: report.statistics.dateRange,
      },
    },

    statistics: report.statistics,
    synthesis: report.synthesis,
    topics,
    visualization: report.visualization || createDefaultVisualization(),
  };
}

function calculatePercentage(count: number, total: number): number {
  return total > 0 ? parseFloat(((count / total) * 100).toFixed(1)) : 0;
}

function calculateSentimentDistribution(messages: any[]) {
  const dist = { positive: 0, negative: 0, neutral: 0 };
  for (const msg of messages) {
    const sentiment = msg.sentiment || "neutral";
    if (sentiment in dist) {
      dist[sentiment as keyof typeof dist]++;
    }
  }
  return dist;
}

function createDefaultVisualization() {
  return {
    scatterPlot: { points: [], axes: { x: {}, y: {} } },
    topicTree: { nodes: [], links: [] },
    charts: {},
  };
}
```

### Phase 3: Add Optional Endpoints (Topics, Visualization)

```typescript
/**
 * GET /api/reports/:jobId/topics
 * Get only topics without full report data
 */
router.get("/:jobId/topics", async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;

    const reportService = ReportService.getInstance();
    const job = await reportService.getJob(jobId);

    if (!job || job.status !== "completed" || !job.report) {
      return res.status(404).json({
        success: false,
        error: "Report not found or not completed",
      });
    }

    const topics = job.report.clusters.map(cluster => ({
      id: cluster.id,
      name: cluster.topic,
      description: cluster.description,
      messageCount: cluster.messages.length,
      percentage: calculatePercentage(
        cluster.messages.length,
        job.report!.statistics.totalMessages
      ),
      sentiment: {
        overall: cluster.summary.sentiment,
        distribution: calculateSentimentDistribution(cluster.messages),
      },
    }));

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
 */
router.get("/:jobId/visualization", async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;

    const reportService = ReportService.getInstance();
    const job = await reportService.getJob(jobId);

    if (!job || job.status !== "completed" || !job.report) {
      return res.status(404).json({
        success: false,
        error: "Report not found or not completed",
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
```

## Migration Strategy

### Backward Compatibility

1. **Default Format**: New `format=json` is default, but response structure remains similar
2. **Markdown Endpoint**: Existing `/reports/:jobId/markdown` unchanged
3. **Version Field**: Include version in response to allow clients to detect format
4. **Gradual Migration**: Old clients continue working, new clients use new format

### Client Migration Path

1. **Phase 1**: Deploy backend with both formats
2. **Phase 2**: Update frontend to request `format=json`
3. **Phase 3**: Monitor usage of legacy format
4. **Phase 4**: Eventually deprecate (after 6+ months)

## Testing Requirements

### Unit Tests

```typescript
describe("Report API Endpoints", () => {
  describe("GET /api/reports/:jobId", () => {
    it("should return JSON format by default", async () => {
      const res = await request(app).get("/api/reports/job-123");
      expect(res.body.report.version).toBe("1.0.0");
      expect(res.body.report.topics).toBeDefined();
    });

    it("should return markdown format when requested", async () => {
      const res = await request(app).get("/api/reports/job-123?format=markdown");
      expect(res.body.markdown).toBeDefined();
      expect(res.body.report).toBeUndefined();
    });

    it("should return full format with both", async () => {
      const res = await request(app).get("/api/reports/job-123?format=full");
      expect(res.body.report.topics).toBeDefined();
      expect(res.body.report.markdown).toBeDefined();
    });

    it("should exclude messages when includeMessages=false", async () => {
      const res = await request(app).get("/api/reports/job-123?includeMessages=false");
      expect(res.body.report.topics[0].messageCount).toBeGreaterThan(0);
      expect(res.body.report.topics[0].messages).toHaveLength(0);
    });
  });
});
```

### Integration Tests

1. Create report → Get in JSON format → Validate structure
2. Create report → Get in Markdown format → Validate content
3. Create report → Get topics only → Validate data subset
4. Create report → Get visualization only → Validate viz data

### Performance Tests

- Response time with `includeMessages=true` vs `false`
- Response size comparison
- Cache hit/miss scenarios

## Documentation Updates

Update API documentation to include:
1. New format parameter
2. Response structure examples
3. Migration guide for existing clients
4. Performance considerations

## Acceptance Criteria

- ✅ `format` parameter supported on GET /api/reports/:jobId
- ✅ JSON format returns T3CReport structure
- ✅ Markdown format returns string (backward compatible)
- ✅ Full format returns both
- ✅ Optional endpoints (/topics, /visualization) implemented
- ✅ `includeMessages` parameter works correctly
- ✅ Backward compatibility maintained
- ✅ All tests pass
- ✅ API documentation updated
- ✅ Performance within acceptable limits

## References

- [Current API Routes](../../src/routes/reports.ts)
- [Express.js Query Parameters](https://expressjs.com/en/api.html#req.query)
- [REST API Best Practices](https://restfulapi.net/)

# Report API Specification

> AINSPACE Report API — T3C-aligned output types

## Endpoints

### POST /api/reports
Create a new report generation job.

**Request Body:**
```json
{
  "threadIds": ["thread-1", "thread-2"],  // optional, all if omitted
  "agentUrls": ["https://..."],           // optional
  "agentNames": ["AgentA"],               // optional
  "startDate": "2024-01-01T00:00:00Z",   // optional ISO date
  "endDate": "2024-12-31T23:59:59Z",     // optional ISO date
  "timezone": "Asia/Seoul",               // optional IANA timezone
  "language": "ko",                       // "ko" | "en"
  "title": "Report title",               // optional
  "description": "Report description",   // optional
  "tags": ["tag1", "tag2"]               // optional
}
```

**Response:**
```json
{
  "success": true,
  "jobId": "uuid",
  "status": "pending",
  "progress": null,
  "report": null,
  "title": "Report title",
  "description": "Report description",
  "tags": ["tag1"]
}
```

---

### GET /api/reports
List report jobs with pagination, filtering, and search.

**Query Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| page | number | 1 | Page number |
| limit | number | 20 | Items per page (max 100) |
| tags | string | — | Comma-separated tags |
| startDate | string | — | ISO date filter |
| endDate | string | — | ISO date filter |
| status | string | — | pending, processing, completed, failed |
| search | string | — | Search in title/description |
| sortBy | string | createdAt | createdAt, updatedAt, title |
| sortOrder | string | desc | asc, desc |

**Response:**
```json
{
  "success": true,
  "items": [ReportJobSummary],
  "total": 42,
  "page": 1,
  "limit": 20,
  "hasMore": true
}
```

---

### GET /api/reports/:jobId
Get report job status and result.

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| fields | string | Comma-separated field names for partial report (e.g., "statistics,synthesis") |

**Response (completed — current format):**

`report.topics`가 존재하면 현재(EPIC3+) 포맷입니다.

```json
{
  "success": true,
  "jobId": "uuid",
  "status": "completed",
  "report": { Report },
  "createdAt": 1700000000000,
  "updatedAt": 1700000060000,
  "cachedAt": 1700000060000,
  "title": "Report title",
  "description": "...",
  "tags": ["tag1"]
}
```

**Response (completed — legacy format):**

EPIC3 이전에 생성된 리포트는 `report.clusters`로 반환됩니다. 클라이언트는 `report.topics` 존재 여부로 포맷을 판별합니다.

```json
{
  "success": true,
  "jobId": "uuid",
  "status": "completed",
  "report": { LegacyReport },
  "createdAt": 1700000000000,
  "updatedAt": 1700000060000
}
```

레거시 포맷 구분: `report.topics` → 현재, `report.clusters` → 레거시

| 필드 | 현재 포맷 | 레거시 포맷 |
|------|-----------|-------------|
| 토픽 목록 | `report.topics[]` | `report.clusters[]` |
| 토픽 이름 | `topic.title` | `cluster.topic` |
| 의견 목록 | `topic.claims[]` | `cluster.opinions[]` |
| 의견 텍스트 | `claim.title` | `opinion.text` |
| 원문 참조 | `claim.quotes[]` | `opinion.supportingMessages[]` |
| 날짜 | `report.date` (ISO string) | `report.createdAt` (timestamp) |
| 통계 | `statistics.totalOpinions` | `statistics.totalMessages` |
| stance 분포 | `statistics.stanceDistribution` | `statistics.categoryDistribution` |

**Response (in progress):**
```json
{
  "success": true,
  "jobId": "uuid",
  "status": "processing",
  "progress": {
    "step": 3,
    "totalSteps": 7,
    "currentStep": "Generating embeddings",
    "percentage": 43
  }
}
```

---

### PATCH /api/reports/:jobId
Update report job metadata.

**Request Body:**
```json
{
  "title": "New title",
  "description": "New description",
  "tags": ["updated-tag"]
}
```

---

### DELETE /api/reports/:jobId
Delete a report job.

### DELETE /api/reports/cache
Invalidate report cache.

---

## Report Output Types (T3C-aligned)

### Report
```typescript
{
  title: string;
  description: string;
  date: string;                    // ISO date string
  topics: Topic[];
  sources: Source[];
  statistics: ReportStatistics;    // AINSPACE extension
  synthesis?: ReportSynthesis;     // AINSPACE extension
}
```

### Topic
```typescript
{
  id: string;
  title: string;                   // topic label (3-5 words)
  description: string;
  claims: Claim[];
  summary: {
    consensus: string[];
    conflicting: string[];
    sentiment: "positive" | "negative" | "mixed" | "neutral";
  };
}
```

### Claim
```typescript
{
  id: string;
  title: string;                   // self-contained opinion statement
  quotes: Quote[];                 // original messages backing this claim
  number: number;                  // = quotes.length
  similarClaims: Claim[];          // [] (T3C compatibility, reserved)
  // AINSPACE extensions:
  stance: "support" | "oppose" | "neutral" | "request" | "question";
  confidence: number;              // 0.0~1.0
  evolved: boolean;                // whether opinion changed during conversation
}
```

### Quote
```typescript
{
  id: string;
  text: string;                    // the key message content
  context: SegmentMessage[];       // full conversation segment (agent + user messages)
  reference: Reference;
}
```

### SegmentMessage
```typescript
{
  id: string;
  speaker: string;                 // "User" | agent name
  content: string;
  timestamp: number;
  isUser: boolean;
}
```

### Reference
```typescript
{
  id: string;
  sourceId: string;                // threadId
  segmentId: string;               // conversation segment ID
  messageId: string;               // specific message ID
}
```

### Source
```typescript
{
  id: string;                      // threadId
  segmentCount: number;
}
```

### ReportStatistics
```typescript
{
  totalOpinions: number;
  totalSegments: number;             // conversation segments analyzed
  totalThreads: number;
  dateRange: { start: number; end: number };
  stanceDistribution: Record<string, number>;
  speakerDistribution: Record<string, number>;
  topTopics: Array<{ topic: string; count: number; percentage: number }>;
  deliberation: { totalOpinions: number; evolvedCount: number };
}
```

### ReportSynthesis
```typescript
{
  overallSentiment: "positive" | "negative" | "mixed" | "neutral";
  keyFindings: string[];
  executiveSummary: string;
}
```

---

## T3C Mapping Table

| T3C Field | AINSPACE Field | Notes |
|-----------|---------------|-------|
| `ReportDataObj.title` | `Report.title` | Identical |
| `ReportDataObj.description` | `Report.description` | Identical |
| `ReportDataObj.date` | `Report.date` | Identical (ISO string) |
| `ReportDataObj.topics[]` | `Report.topics[]` | Identical structure |
| `Topic.title` | `Topic.title` | Identical |
| `Topic.description` | `Topic.description` | Identical |
| `Subtopic.claims[]` | `Topic.claims[]` | AINSPACE: flat (no subtopic layer) |
| `Claim.title` | `Claim.title` | Identical |
| `Claim.quotes[]` | `Claim.quotes[]` | Identical structure |
| `Claim.number` | `Claim.number` | Identical |
| `Claim.similarClaims[]` | `Claim.similarClaims[]` | Always [] in AINSPACE |
| `Quote.text` | `Quote.text` | Identical |
| `Quote.reference.interview` | `Quote.reference.sourceId` | T3C: participant name, AINSPACE: threadId (anonymous) |
| `Quote.reference.data` | `Quote.reference.segmentId/messageId` | T3C: text offset, AINSPACE: segment+message IDs |
| `ReportDataObj.sources[]` | `Report.sources[]` | T3C: participant list, AINSPACE: thread list |
| — | `Report.statistics` | AINSPACE extension |
| — | `Report.synthesis` | AINSPACE extension |
| — | `Claim.stance` | AINSPACE extension |
| — | `Claim.confidence` | AINSPACE extension |
| — | `Claim.evolved` | AINSPACE extension |

---

## Pipeline Steps (9 total, 3 LLM calls)

1. Collect messages from threads
2. Embed raw messages (for topic-based segmentation)
3. Segment by topic (cosine similarity + physical criteria)
4. Extract 1 claim per segment (LLM) — 0 if no debatable position
5. Embed claims (for clustering)
6. Cluster (UMAP + K-means) → Topic[]
7. Analyze clusters (LLM) → topic labels, summaries
8. Calculate statistics → ReportStatistics
9. Synthesize insights (LLM) → ReportSynthesis

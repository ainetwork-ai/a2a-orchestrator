# TRD 08: Real-time Report Updates (실시간 리포트 업데이트)

> **Origin:** [99-future-decisions.md](./99-future-decisions.md) - Decision #15

## 1. 개요 (Overview)

### 1.1 목적 (Purpose)

현재 리포트 생성 상태 확인은 폴링(polling) 방식으로만 가능합니다. 리포트 생성이 30초 이상 걸리는 대규모 데이터셋의 경우, 사용자 경험이 저하됩니다.

본 TRD는 Server-Sent Events (SSE) 기반의 실시간 진행 상황 스트리밍을 구현하여:

- **즉각적인 피드백**: 파이프라인 단계별 진행 상황 실시간 확인
- **리소스 효율성**: 불필요한 폴링 요청 감소
- **향상된 UX**: 진행률, 현재 단계, 예상 완료 시간 표시

### 1.2 범위 (Scope)

**포함 (In Scope):**
- SSE 기반 리포트 진행 상황 스트리밍
- 파이프라인 단계별 진행률 이벤트
- 에러 발생 시 실시간 알림
- 완료 시 결과 데이터 스트리밍
- 연결 복구 메커니즘

**제외 (Out of Scope):**
- WebSocket 기반 양방향 통신 (향후 고려)
- 리포트 취소 기능 (별도 TRD로 분리)
- 다중 클라이언트 브로드캐스트

### 1.3 용어 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **SSE (Server-Sent Events)** | 서버에서 클라이언트로 단방향 실시간 이벤트 스트리밍 |
| **Event Stream** | SSE 연결을 통해 전송되는 이벤트들의 흐름 |
| **Heartbeat** | 연결 유지를 위한 주기적 ping 메시지 |
| **Last-Event-ID** | 연결 복구 시 마지막으로 받은 이벤트 식별자 |

---

## 2. 현재 상태 분석 (Current State Analysis)

### 2.1 기존 시스템 구조

```
┌─────────────────────────────────────────────────────────────┐
│                    Current Polling Architecture              │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  [Client]                                                     │
│      │                                                        │
│      ├──► POST /api/reports (create job)                     │
│      │        │                                               │
│      │        └──► { jobId: "xxx", status: "pending" }       │
│      │                                                        │
│      ├──► GET /api/reports/:jobId (poll)  ─── 1초마다 반복   │
│      │        │                                               │
│      │        └──► { status: "processing", progress: 25% }   │
│      │                                                        │
│      └──► GET /api/reports/:jobId (poll)                     │
│               │                                               │
│               └──► { status: "completed", report: {...} }    │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

**현재 문제점:**
- 클라이언트가 1초마다 폴링 필요
- 서버 부하 증가
- 실시간 피드백 부재
- 네트워크 리소스 낭비

### 2.2 기존 SSE 구현 참조

```typescript
// src/routes/threads.ts (기존 SSE 구현)
router.get("/:id/stream", async (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  // SSE 연결 유지 및 이벤트 전송
  const sendEvent = (event: string, data: any) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // ...
});
```

### 2.3 문제점 및 한계

| 문제 | 영향 | 심각도 |
|------|------|--------|
| **불필요한 폴링** | 서버 부하, 네트워크 낭비 | 중간 |
| **진행 상황 지연** | 최대 1초 지연 (폴링 간격) | 낮음 |
| **대규모 리포트** | 30초+ 대기 시 UX 저하 | 높음 |
| **네트워크 불안정** | 상태 누락 가능 | 중간 |

---

## 3. 요구사항 (Requirements)

### 3.1 기능적 요구사항 (Functional Requirements)

**[FR-001] SSE 스트림 엔드포인트**
- 리포트 생성 진행 상황을 SSE로 스트리밍
- 연결 시 현재 상태 즉시 전송
- 단계별 진행률 이벤트 전송

**[FR-002] 이벤트 타입**
- `status`: 상태 변경 (pending, processing, completed, failed)
- `progress`: 진행률 업데이트 (step, percentage, currentStep)
- `error`: 에러 발생 알림
- `complete`: 완료 및 결과 데이터

**[FR-003] 연결 관리**
- Heartbeat (30초 간격) 전송으로 연결 유지
- 클라이언트 연결 해제 감지
- Last-Event-ID 기반 재연결 지원

**[FR-004] 완료 시 동작**
- 리포트 데이터 스트리밍 (선택적)
- 스트림 자동 종료
- 클라이언트에 종료 알림

**[FR-005] 에러 처리**
- 파이프라인 에러 실시간 전송
- 재시도 가능 여부 알림
- 상세 에러 메시지 포함

### 3.2 비기능적 요구사항 (Non-Functional Requirements)

**[NFR-001] 성능**
- 이벤트 전송 지연: < 100ms
- 동시 SSE 연결 지원: 100+ 개
- 메모리 사용: 연결당 < 1KB

**[NFR-002] 안정성**
- 연결 타임아웃: 5분 (설정 가능)
- 자동 재연결 지원
- 예외 상황 graceful 처리

**[NFR-003] 호환성**
- 기존 폴링 방식 병행 지원
- CORS 지원
- 프록시/로드밸런서 호환

### 3.3 제약사항 (Constraints)

- Node.js 단일 프로세스 환경 가정 (멀티 프로세스 시 Redis pub/sub 필요)
- HTTP/1.1 이상 필요
- 클라이언트 EventSource API 지원 필요

---

## 4. 기술 설계 (Technical Design)

### 4.1 아키텍처 개요

```
┌────────────────────────────────────────────────────────────────────┐
│                     SSE Streaming Architecture                      │
├────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  [Client]                                                            │
│      │                                                               │
│      ├──► POST /api/reports (create job)                            │
│      │        │                                                      │
│      │        └──► { jobId: "xxx" }                                 │
│      │                                                               │
│      └──► GET /api/reports/:jobId/stream (SSE connection)           │
│               │                                                      │
│               ▼                                                      │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    SSE Connection                            │   │
│  │                                                              │   │
│  │  event: status                                               │   │
│  │  data: {"status":"processing","step":1,"totalSteps":8}      │   │
│  │                                                              │   │
│  │  event: progress                                             │   │
│  │  data: {"step":2,"percentage":25,"currentStep":"Categorizing"}│  │
│  │                                                              │   │
│  │  event: progress                                             │   │
│  │  data: {"step":3,"percentage":38,"currentStep":"Clustering"} │   │
│  │                                                              │   │
│  │  ...                                                         │   │
│  │                                                              │   │
│  │  event: complete                                             │   │
│  │  data: {"status":"completed","report":{...}}                 │   │
│  │                                                              │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
└────────────────────────────────────────────────────────────────────┘
```

### 4.2 데이터 모델

#### 4.2.1 SSE 이벤트 타입

```typescript
// src/types/streaming.ts

/**
 * SSE 이벤트 타입
 */
export type SSEEventType = "status" | "progress" | "error" | "complete" | "heartbeat";

/**
 * 상태 변경 이벤트
 */
export interface StatusEvent {
  type: "status";
  jobId: string;
  status: "pending" | "processing" | "completed" | "failed";
  timestamp: number;
}

/**
 * 진행률 이벤트
 */
export interface ProgressEvent {
  type: "progress";
  jobId: string;
  step: number;
  totalSteps: number;
  currentStep: string;
  percentage: number;
  estimatedRemainingMs?: number;  // 예상 남은 시간
  timestamp: number;
}

/**
 * 에러 이벤트
 */
export interface ErrorEvent {
  type: "error";
  jobId: string;
  error: string;
  code?: string;
  retryable: boolean;
  timestamp: number;
}

/**
 * 완료 이벤트
 */
export interface CompleteEvent {
  type: "complete";
  jobId: string;
  status: "completed";
  reportId: string;
  includeReport?: boolean;  // 리포트 데이터 포함 여부
  report?: any;             // includeReport=true일 때만
  timestamp: number;
}

/**
 * Heartbeat 이벤트
 */
export interface HeartbeatEvent {
  type: "heartbeat";
  timestamp: number;
}

/**
 * 모든 SSE 이벤트 타입
 */
export type SSEEvent =
  | StatusEvent
  | ProgressEvent
  | ErrorEvent
  | CompleteEvent
  | HeartbeatEvent;

/**
 * SSE 연결 옵션
 */
export interface SSEConnectionOptions {
  includeReportOnComplete?: boolean;  // 완료 시 리포트 데이터 포함 (기본: false)
  heartbeatIntervalMs?: number;       // Heartbeat 간격 (기본: 30000)
  timeoutMs?: number;                 // 연결 타임아웃 (기본: 300000 = 5분)
}
```

### 4.3 API 설계

#### 4.3.1 SSE 스트림 엔드포인트

**GET /api/reports/:jobId/stream**

```http
GET /api/reports/:jobId/stream
Accept: text/event-stream

Query Parameters:
- includeReport: "true" | "false" (기본: false)
- timeout: number (ms, 최대: 600000)
```

**Response Headers:**
```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

**Event Stream 예시:**
```
id: 1
event: status
data: {"type":"status","jobId":"abc123","status":"processing","timestamp":1706400000000}

id: 2
event: progress
data: {"type":"progress","jobId":"abc123","step":1,"totalSteps":8,"currentStep":"Parsing threads","percentage":12,"timestamp":1706400001000}

id: 3
event: progress
data: {"type":"progress","jobId":"abc123","step":2,"totalSteps":8,"currentStep":"Categorizing messages","percentage":25,"timestamp":1706400005000}

id: 4
event: heartbeat
data: {"type":"heartbeat","timestamp":1706400030000}

id: 5
event: progress
data: {"type":"progress","jobId":"abc123","step":3,"totalSteps":8,"currentStep":"Clustering by topic","percentage":38,"timestamp":1706400010000}

...

id: 12
event: complete
data: {"type":"complete","jobId":"abc123","status":"completed","reportId":"report-xyz","timestamp":1706400060000}

```

### 4.4 컴포넌트 설계

#### 4.4.1 SSEManager 클래스

```typescript
// src/services/sseManager.ts

import { EventEmitter } from "events";
import { Response } from "express";
import {
  SSEEvent,
  SSEEventType,
  SSEConnectionOptions,
  ProgressEvent,
  StatusEvent,
  ErrorEvent,
  CompleteEvent,
  HeartbeatEvent,
} from "../types/streaming";

interface SSEConnection {
  res: Response;
  jobId: string;
  options: SSEConnectionOptions;
  lastEventId: number;
  heartbeatTimer?: NodeJS.Timeout;
  timeoutTimer?: NodeJS.Timeout;
}

export class SSEManager extends EventEmitter {
  private static instance: SSEManager;
  private connections: Map<string, Set<SSEConnection>> = new Map();

  private constructor() {
    super();
  }

  static getInstance(): SSEManager {
    if (!SSEManager.instance) {
      SSEManager.instance = new SSEManager();
    }
    return SSEManager.instance;
  }

  /**
   * SSE 연결 등록
   */
  registerConnection(
    jobId: string,
    res: Response,
    options: SSEConnectionOptions = {}
  ): void {
    const connection: SSEConnection = {
      res,
      jobId,
      options: {
        includeReportOnComplete: false,
        heartbeatIntervalMs: 30000,
        timeoutMs: 300000,
        ...options,
      },
      lastEventId: 0,
    };

    // 연결 그룹에 추가
    if (!this.connections.has(jobId)) {
      this.connections.set(jobId, new Set());
    }
    this.connections.get(jobId)!.add(connection);

    // SSE 헤더 설정
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // Heartbeat 시작
    this.startHeartbeat(connection);

    // 타임아웃 설정
    this.startTimeout(connection);

    // 연결 종료 핸들링
    res.on("close", () => {
      this.removeConnection(jobId, connection);
    });

    console.log(`[SSEManager] Connection registered for job ${jobId}`);
  }

  /**
   * 이벤트 전송
   */
  sendEvent(jobId: string, event: SSEEvent): void {
    const connections = this.connections.get(jobId);
    if (!connections || connections.size === 0) {
      return;
    }

    for (const conn of connections) {
      try {
        conn.lastEventId++;
        const eventStr = this.formatEvent(conn.lastEventId, event);
        conn.res.write(eventStr);

        // 완료 이벤트면 연결 종료
        if (event.type === "complete" || event.type === "error") {
          this.closeConnection(conn);
        }
      } catch (error) {
        console.error(`[SSEManager] Error sending event to ${jobId}:`, error);
        this.removeConnection(jobId, conn);
      }
    }
  }

  /**
   * 진행률 이벤트 전송
   */
  sendProgress(
    jobId: string,
    step: number,
    totalSteps: number,
    currentStep: string,
    estimatedRemainingMs?: number
  ): void {
    const event: ProgressEvent = {
      type: "progress",
      jobId,
      step,
      totalSteps,
      currentStep,
      percentage: Math.round((step / totalSteps) * 100),
      estimatedRemainingMs,
      timestamp: Date.now(),
    };
    this.sendEvent(jobId, event);
  }

  /**
   * 상태 변경 이벤트 전송
   */
  sendStatus(
    jobId: string,
    status: "pending" | "processing" | "completed" | "failed"
  ): void {
    const event: StatusEvent = {
      type: "status",
      jobId,
      status,
      timestamp: Date.now(),
    };
    this.sendEvent(jobId, event);
  }

  /**
   * 에러 이벤트 전송
   */
  sendError(
    jobId: string,
    error: string,
    retryable: boolean = false,
    code?: string
  ): void {
    const event: ErrorEvent = {
      type: "error",
      jobId,
      error,
      code,
      retryable,
      timestamp: Date.now(),
    };
    this.sendEvent(jobId, event);
  }

  /**
   * 완료 이벤트 전송
   */
  sendComplete(
    jobId: string,
    reportId: string,
    report?: any
  ): void {
    const connections = this.connections.get(jobId);
    if (!connections) return;

    for (const conn of connections) {
      const event: CompleteEvent = {
        type: "complete",
        jobId,
        status: "completed",
        reportId,
        includeReport: conn.options.includeReportOnComplete,
        report: conn.options.includeReportOnComplete ? report : undefined,
        timestamp: Date.now(),
      };
      this.sendEvent(jobId, event);
    }
  }

  /**
   * 특정 Job의 연결 수 확인
   */
  getConnectionCount(jobId: string): number {
    return this.connections.get(jobId)?.size || 0;
  }

  /**
   * 이벤트 포맷팅
   */
  private formatEvent(id: number, event: SSEEvent): string {
    let str = `id: ${id}\n`;
    str += `event: ${event.type}\n`;
    str += `data: ${JSON.stringify(event)}\n\n`;
    return str;
  }

  /**
   * Heartbeat 시작
   */
  private startHeartbeat(connection: SSEConnection): void {
    connection.heartbeatTimer = setInterval(() => {
      try {
        const event: HeartbeatEvent = {
          type: "heartbeat",
          timestamp: Date.now(),
        };
        connection.lastEventId++;
        connection.res.write(this.formatEvent(connection.lastEventId, event));
      } catch (error) {
        this.removeConnection(connection.jobId, connection);
      }
    }, connection.options.heartbeatIntervalMs);
  }

  /**
   * 타임아웃 설정
   */
  private startTimeout(connection: SSEConnection): void {
    connection.timeoutTimer = setTimeout(() => {
      console.log(`[SSEManager] Connection timeout for job ${connection.jobId}`);
      this.closeConnection(connection);
    }, connection.options.timeoutMs);
  }

  /**
   * 연결 제거
   */
  private removeConnection(jobId: string, connection: SSEConnection): void {
    if (connection.heartbeatTimer) {
      clearInterval(connection.heartbeatTimer);
    }
    if (connection.timeoutTimer) {
      clearTimeout(connection.timeoutTimer);
    }

    const connections = this.connections.get(jobId);
    if (connections) {
      connections.delete(connection);
      if (connections.size === 0) {
        this.connections.delete(jobId);
      }
    }

    console.log(`[SSEManager] Connection removed for job ${jobId}`);
  }

  /**
   * 연결 종료
   */
  private closeConnection(connection: SSEConnection): void {
    this.removeConnection(connection.jobId, connection);
    try {
      connection.res.end();
    } catch (error) {
      // Already closed
    }
  }
}
```

#### 4.4.2 API 라우트 추가

```typescript
// src/routes/reports.ts (추가)

import { SSEManager } from "../services/sseManager";

/**
 * GET /api/reports/:jobId/stream
 * SSE 스트림으로 리포트 진행 상황 수신
 */
router.get("/:jobId/stream", async (req: Request, res: Response) => {
  const { jobId } = req.params;
  const includeReport = req.query.includeReport === "true";
  const timeout = Math.min(
    parseInt(req.query.timeout as string) || 300000,
    600000 // 최대 10분
  );

  if (!jobId || typeof jobId !== "string") {
    return res.status(400).json({
      success: false,
      error: "Valid jobId is required",
    });
  }

  // Job 존재 확인
  const reportService = ReportService.getInstance();
  const job = await reportService.getJob(jobId);

  if (!job) {
    return res.status(404).json({
      success: false,
      error: "Job not found",
    });
  }

  // 이미 완료/실패된 경우 즉시 응답
  if (job.status === "completed") {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.write(`event: complete\n`);
    res.write(`data: ${JSON.stringify({
      type: "complete",
      jobId,
      status: "completed",
      reportId: job.report?.id,
      report: includeReport ? job.report : undefined,
      timestamp: Date.now(),
    })}\n\n`);
    return res.end();
  }

  if (job.status === "failed") {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.write(`event: error\n`);
    res.write(`data: ${JSON.stringify({
      type: "error",
      jobId,
      error: job.error || "Unknown error",
      retryable: false,
      timestamp: Date.now(),
    })}\n\n`);
    return res.end();
  }

  // SSE 연결 등록
  const sseManager = SSEManager.getInstance();
  sseManager.registerConnection(jobId, res, {
    includeReportOnComplete: includeReport,
    timeoutMs: timeout,
  });

  // 현재 상태 즉시 전송
  sseManager.sendStatus(jobId, job.status);

  // 현재 진행 상황이 있으면 전송
  if (job.progress) {
    sseManager.sendProgress(
      jobId,
      job.progress.step,
      job.progress.totalSteps,
      job.progress.currentStep
    );
  }
});
```

#### 4.4.3 ReportService 통합

```typescript
// src/services/reportService.ts (수정)

import { SSEManager } from "./sseManager";

class ReportService {
  // ... 기존 코드 ...

  /**
   * Process job in background (수정)
   */
  private async processJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    const sseManager = SSEManager.getInstance();

    try {
      // Update status to processing
      job.status = "processing";
      job.updatedAt = Date.now();
      await this.saveJobToRedis(job);
      sseManager.sendStatus(jobId, "processing");

      // Generate report with progress updates
      const report = await generateReport(
        job.params,
        this.apiUrl,
        this.model,
        (progress: ReportJobProgress) => {
          job.progress = progress;
          job.updatedAt = Date.now();
          this.saveJobToRedis(job);

          // SSE로 진행 상황 전송
          sseManager.sendProgress(
            jobId,
            progress.step,
            progress.totalSteps,
            progress.currentStep
          );
        }
      );

      // Update job with result
      job.status = "completed";
      job.report = report;
      job.updatedAt = Date.now();
      job.cachedAt = Date.now();
      await this.saveJobToRedis(job);

      // SSE로 완료 알림
      sseManager.sendComplete(jobId, report.id, report);

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

      // SSE로 에러 알림
      sseManager.sendError(jobId, job.error, false);
    }
  }
}
```

---

## 5. 구현 계획 (Implementation Plan)

### 5.1 작업 분해 (Task Breakdown)

| # | 작업 | 설명 | 예상 시간 |
|---|------|------|-----------|
| 1 | 타입 정의 | streaming.ts 이벤트 타입 정의 | 1시간 |
| 2 | SSEManager 구현 | 기본 SSE 관리자 구현 | 3시간 |
| 3 | Heartbeat/Timeout | 연결 유지 및 타임아웃 처리 | 1시간 |
| 4 | API 라우트 추가 | /stream 엔드포인트 구현 | 2시간 |
| 5 | ReportService 통합 | 파이프라인에 SSE 알림 추가 | 2시간 |
| 6 | 에러 처리 | 연결 복구 및 에러 핸들링 | 2시간 |
| 7 | 테스트 작성 | Unit, Integration 테스트 | 3시간 |
| 8 | 클라이언트 예제 | 프론트엔드 연동 예제 | 1시간 |
| 9 | 문서화 | API 문서 업데이트 | 1시간 |

### 5.2 의존성 (Dependencies)

```
Task 1 (타입 정의)
    │
    ▼
Task 2 (SSEManager 기본)
    │
    ├──► Task 3 (Heartbeat/Timeout)
    │
    └──► Task 4 (API 라우트)

Task 3, 4 완료 후
    │
    ▼
Task 5 (ReportService 통합)
    │
    ▼
Task 6 (에러 처리)
    │
    ├──► Task 7 (테스트)
    │
    └──► Task 8 (클라이언트 예제)

Task 7, 8 완료 후
    │
    ▼
Task 9 (문서화)
```

### 5.3 예상 일정 (Estimated Timeline)

**총 예상 시간:** 16시간

**일정 (3일 기준):**
- **Day 1:** Task 1, 2, 3 (타입 정의, SSEManager) - 5시간
- **Day 2:** Task 4, 5, 6 (API, 통합, 에러 처리) - 6시간
- **Day 3:** Task 7, 8, 9 (테스트, 예제, 문서화) - 5시간

---

## 6. 테스트 전략 (Testing Strategy)

### 6.1 단위 테스트

```typescript
describe("SSEManager", () => {
  let sseManager: SSEManager;
  let mockResponse: any;

  beforeEach(() => {
    sseManager = SSEManager.getInstance();
    mockResponse = createMockResponse();
  });

  describe("registerConnection", () => {
    it("should set correct SSE headers", () => {
      sseManager.registerConnection("job-1", mockResponse, {});

      expect(mockResponse.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "text/event-stream"
      );
    });

    it("should start heartbeat timer", () => {
      jest.useFakeTimers();
      sseManager.registerConnection("job-1", mockResponse, {
        heartbeatIntervalMs: 1000,
      });

      jest.advanceTimersByTime(1000);

      expect(mockResponse.write).toHaveBeenCalledWith(
        expect.stringContaining("event: heartbeat")
      );
    });
  });

  describe("sendProgress", () => {
    it("should format progress event correctly", () => {
      sseManager.registerConnection("job-1", mockResponse, {});
      sseManager.sendProgress("job-1", 2, 8, "Categorizing");

      expect(mockResponse.write).toHaveBeenCalledWith(
        expect.stringContaining('"percentage":25')
      );
    });
  });
});
```

### 6.2 통합 테스트

```typescript
describe("SSE Streaming Integration", () => {
  it("should stream progress events during report generation", (done) => {
    const events: any[] = [];

    // Create job
    request(app)
      .post("/api/reports")
      .send({ threadIds: ["test-thread"] })
      .then((res) => {
        const jobId = res.body.jobId;

        // Connect to SSE stream
        const eventSource = new EventSource(
          `http://localhost:${port}/api/reports/${jobId}/stream`
        );

        eventSource.addEventListener("progress", (e) => {
          events.push(JSON.parse(e.data));
        });

        eventSource.addEventListener("complete", (e) => {
          eventSource.close();

          expect(events.length).toBeGreaterThan(0);
          expect(events[0].type).toBe("progress");
          done();
        });
      });
  });
});
```

### 6.3 테스트 시나리오

| 시나리오 | 검증 항목 |
|----------|-----------|
| **정상 스트리밍** | 모든 단계의 progress 이벤트 수신 |
| **완료 이벤트** | complete 이벤트 및 데이터 수신 |
| **에러 이벤트** | error 이벤트 및 메시지 수신 |
| **Heartbeat** | 30초 간격으로 heartbeat 수신 |
| **타임아웃** | 설정된 시간 후 연결 종료 |
| **재연결** | Last-Event-ID로 재연결 처리 |
| **다중 클라이언트** | 여러 클라이언트 동시 연결 |

---

## 7. 위험 요소 및 완화 방안 (Risks & Mitigations)

| 위험 요소 | 영향도 | 발생 가능성 | 완화 방안 |
|----------|--------|------------|----------|
| **연결 누수** | 높음 | 중간 | 타임아웃, 주기적 정리, 메모리 모니터링 |
| **프록시 버퍼링** | 중간 | 높음 | X-Accel-Buffering: no 헤더 |
| **동시 연결 과다** | 중간 | 낮음 | 연결 수 제한, 풀링 폴백 |
| **네트워크 불안정** | 낮음 | 중간 | 재연결 로직, Last-Event-ID |

---

## 8. 참고 자료 (References)

### 내부 문서
- [00-overview.md](./00-overview.md) - 프로젝트 개요
- [99-future-decisions.md](./99-future-decisions.md) - Decision 15 원본

### 코드 참조
- [src/routes/threads.ts](../../src/routes/threads.ts) - 기존 SSE 구현
- [src/services/reportService.ts](../../src/services/reportService.ts)

### 외부 참조
- [MDN: Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
- [EventSource API](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)

---

## 9. 클라이언트 사용 예제

### 9.1 JavaScript/TypeScript

```typescript
// 프론트엔드 연동 예제
function subscribeToReportProgress(jobId: string, callbacks: {
  onProgress: (data: ProgressEvent) => void;
  onComplete: (data: CompleteEvent) => void;
  onError: (data: ErrorEvent) => void;
}): () => void {
  const eventSource = new EventSource(
    `/api/reports/${jobId}/stream?includeReport=true`
  );

  eventSource.addEventListener("progress", (e) => {
    callbacks.onProgress(JSON.parse(e.data));
  });

  eventSource.addEventListener("complete", (e) => {
    callbacks.onComplete(JSON.parse(e.data));
    eventSource.close();
  });

  eventSource.addEventListener("error", (e) => {
    if (e.data) {
      callbacks.onError(JSON.parse(e.data));
    }
    eventSource.close();
  });

  // 연결 해제 함수 반환
  return () => eventSource.close();
}

// 사용 예
const unsubscribe = subscribeToReportProgress("job-123", {
  onProgress: (data) => {
    console.log(`Progress: ${data.percentage}% - ${data.currentStep}`);
    updateProgressBar(data.percentage);
  },
  onComplete: (data) => {
    console.log("Report completed!");
    displayReport(data.report);
  },
  onError: (data) => {
    console.error("Report failed:", data.error);
    showErrorMessage(data.error);
  },
});
```

---

## 변경 이력 (Change Log)

| 날짜 | 버전 | 변경 내용 | 작성자 |
|------|------|----------|--------|
| 2026-01-27 | 1.0 | 초안 작성 | Claude |

# TRD 10: Error Handling & Recovery (에러 처리 및 복구)

> **Origin:** 추가 기능 (future-decisions에 없음)

## 1. 개요 (Overview)

### 1.1 목적 (Purpose)

현재 리포트 파이프라인은 에러 발생 시 전체 작업이 실패하며, 부분 복구나 재시도 메커니즘이 없습니다. 본 TRD는 견고한 에러 처리 및 복구 시스템을 설계하여:

- **안정성 향상**: 일시적 오류 자동 재시도
- **부분 성공 지원**: 일부 단계 실패 시 부분 결과 반환
- **디버깅 용이**: 상세 에러 정보 및 추적
- **사용자 경험 개선**: 명확한 에러 메시지 및 복구 가이드

### 1.2 범위 (Scope)

**포함 (In Scope):**
- 파이프라인 단계별 에러 처리
- 재시도 메커니즘 (exponential backoff)
- 부분 결과 저장 및 재개
- 에러 분류 및 코드화
- 사용자 친화적 에러 메시지
- 에러 로깅 및 모니터링

**제외 (Out of Scope):**
- 외부 모니터링 시스템 연동 (Sentry, DataDog 등)
- 자동 알림 (Slack, Email 등)
- 분산 시스템 에러 처리

### 1.3 용어 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **Retryable Error** | 재시도 시 성공 가능한 일시적 오류 (네트워크, 타임아웃) |
| **Fatal Error** | 재시도해도 해결 불가능한 치명적 오류 |
| **Partial Result** | 일부 단계까지 성공한 중간 결과 |
| **Checkpoint** | 재개 가능한 파이프라인 상태 저장점 |
| **Error Code** | 표준화된 에러 식별 코드 |

---

## 2. 현재 상태 분석 (Current State Analysis)

### 2.1 기존 시스템 구조

```typescript
// src/services/reportService.ts (현재)
private async processJob(jobId: string): Promise<void> {
  try {
    // ... 파이프라인 실행 ...
    const report = await generateReport(/* ... */);
    job.status = "completed";
  } catch (error: any) {
    // 단순 실패 처리
    job.status = "failed";
    job.error = error.message || "Unknown error";
  }
}
```

### 2.2 문제점 및 한계

| 문제 | 영향 | 심각도 |
|------|------|--------|
| **재시도 없음** | 일시적 오류에도 전체 실패 | 높음 |
| **부분 결과 손실** | 80% 완료 후 실패 시 처음부터 재시작 | 높음 |
| **에러 정보 부족** | 디버깅 어려움 | 중간 |
| **사용자 메시지 불명확** | UX 저하 | 중간 |
| **복구 불가** | 실패한 작업 재개 불가 | 높음 |

### 2.3 현재 에러 발생 지점

```
Pipeline Steps:
1. Parser     → Network error (Redis), Data format error
2. Categorizer → LLM API timeout, Rate limit, Invalid response
3. Clusterer  → LLM API timeout, Rate limit, Invalid response
4. Analyzer   → Calculation error, Division by zero
5. Grounding  → LLM API timeout, Rate limit
6. Synthesizer → LLM API timeout, Invalid JSON
7. Visualizer → Calculation error
8. Renderer   → Template error
```

---

## 3. 요구사항 (Requirements)

### 3.1 기능적 요구사항 (Functional Requirements)

**[FR-001] 재시도 메커니즘**
- LLM API 호출: 최대 3회, exponential backoff (1s, 2s, 4s)
- Redis 연결: 최대 5회, 500ms 간격
- 재시도 가능 에러와 치명적 에러 구분

**[FR-002] 체크포인트 저장**
- 각 파이프라인 단계 완료 시 중간 결과 저장
- 실패 시 마지막 체크포인트부터 재개 가능
- 체크포인트 만료 시간: 1시간

**[FR-003] 부분 결과 반환**
- 일부 단계 실패 시 성공한 부분까지 결과 제공
- 실패 단계 및 원인 명시
- 부분 결과로 리포트 생성 가능 여부 판단

**[FR-004] 에러 코드 체계**
- 표준화된 에러 코드 (예: `LLM_TIMEOUT`, `REDIS_CONNECTION`)
- 에러 심각도 분류 (ERROR, WARNING, INFO)
- 사용자 메시지와 기술 메시지 분리

**[FR-005] 에러 로깅**
- 구조화된 에러 로그 (JSON 형식)
- 스택 트레이스 포함
- 컨텍스트 정보 (jobId, step, params)

**[FR-006] 복구 API**
- 실패한 작업 재시도 엔드포인트
- 체크포인트 기반 재개 옵션
- 강제 처음부터 재시작 옵션

### 3.2 비기능적 요구사항 (Non-Functional Requirements)

**[NFR-001] 성능**
- 재시도로 인한 전체 지연: 최대 15초 추가
- 체크포인트 저장: < 100ms
- 에러 로깅: 비동기, 메인 플로우 블로킹 없음

**[NFR-002] 안정성**
- 에러 처리 자체의 실패는 원본 에러로 폴백
- 체크포인트 손상 시 처음부터 재시작

**[NFR-003] 가용성**
- 재시도 중에도 다른 작업 영향 없음
- 에러 로깅 실패 시 콘솔 폴백

### 3.3 제약사항 (Constraints)

- 기존 파이프라인 구조 유지
- 성능 오버헤드 최소화
- 메모리 사용량 제한

---

## 4. 기술 설계 (Technical Design)

### 4.1 아키텍처 개요

```
┌────────────────────────────────────────────────────────────────────┐
│                    Error Handling Architecture                      │
├────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  [Pipeline Step]                                                     │
│       │                                                              │
│       ▼                                                              │
│  ┌─────────────────┐                                                │
│  │  Try Execute    │                                                │
│  └────────┬────────┘                                                │
│           │                                                          │
│     ┌─────┴─────┐                                                   │
│     │           │                                                    │
│     ▼           ▼                                                    │
│ [Success]   [Error]                                                  │
│     │           │                                                    │
│     │     ┌─────┴─────┐                                             │
│     │     │           │                                              │
│     │     ▼           ▼                                              │
│     │ [Retryable] [Fatal]                                           │
│     │     │           │                                              │
│     │     ▼           │                                              │
│     │ ┌────────┐      │                                              │
│     │ │ Retry  │      │                                              │
│     │ │ Logic  │      │                                              │
│     │ └───┬────┘      │                                              │
│     │     │           │                                              │
│     │     ▼           │                                              │
│     │ [Max Retries?]  │                                              │
│     │   │       │     │                                              │
│     │   │       ▼     │                                              │
│     │   │    [Fail]───┘                                              │
│     │   ▼                                                            │
│     │ [Retry]                                                        │
│     │                                                                │
│     └────────────┬───────────────────────────────────────────       │
│                  │                                                   │
│                  ▼                                                   │
│           ┌─────────────┐                                           │
│           │ Checkpoint  │                                           │
│           │   Save      │                                           │
│           └─────────────┘                                           │
│                                                                      │
└────────────────────────────────────────────────────────────────────┘
```

### 4.2 데이터 모델

#### 4.2.1 에러 코드 체계

```typescript
// src/types/errors.ts

/**
 * 에러 심각도
 */
export type ErrorSeverity = "fatal" | "error" | "warning" | "info";

/**
 * 에러 카테고리
 */
export type ErrorCategory =
  | "llm"        // LLM API 관련
  | "network"    // 네트워크 관련
  | "data"       // 데이터 처리 관련
  | "validation" // 검증 관련
  | "system"     // 시스템 관련
  | "unknown";   // 알 수 없음

/**
 * 표준 에러 코드
 */
export enum ErrorCode {
  // LLM 관련 (1xxx)
  LLM_TIMEOUT = "LLM_1001",
  LLM_RATE_LIMIT = "LLM_1002",
  LLM_INVALID_RESPONSE = "LLM_1003",
  LLM_CONNECTION_ERROR = "LLM_1004",
  LLM_CONTEXT_TOO_LONG = "LLM_1005",

  // 네트워크 관련 (2xxx)
  NETWORK_TIMEOUT = "NET_2001",
  NETWORK_CONNECTION_REFUSED = "NET_2002",
  REDIS_CONNECTION_ERROR = "NET_2003",
  REDIS_TIMEOUT = "NET_2004",

  // 데이터 관련 (3xxx)
  DATA_PARSE_ERROR = "DATA_3001",
  DATA_INVALID_FORMAT = "DATA_3002",
  DATA_EMPTY_INPUT = "DATA_3003",
  DATA_TOO_LARGE = "DATA_3004",

  // 검증 관련 (4xxx)
  VALIDATION_FAILED = "VAL_4001",
  VALIDATION_MISSING_FIELD = "VAL_4002",
  VALIDATION_INVALID_TYPE = "VAL_4003",

  // 시스템 관련 (5xxx)
  SYSTEM_OUT_OF_MEMORY = "SYS_5001",
  SYSTEM_INTERNAL_ERROR = "SYS_5002",
  SYSTEM_NOT_INITIALIZED = "SYS_5003",

  // 알 수 없음 (9xxx)
  UNKNOWN_ERROR = "UNK_9001",
}

/**
 * 에러 코드별 설정
 */
export const ERROR_CONFIG: Record<ErrorCode, {
  severity: ErrorSeverity;
  category: ErrorCategory;
  retryable: boolean;
  maxRetries: number;
  userMessage: string;
  userMessageKo: string;
}> = {
  [ErrorCode.LLM_TIMEOUT]: {
    severity: "error",
    category: "llm",
    retryable: true,
    maxRetries: 3,
    userMessage: "AI processing is taking longer than expected. Please try again.",
    userMessageKo: "AI 처리가 예상보다 오래 걸리고 있습니다. 다시 시도해 주세요.",
  },
  [ErrorCode.LLM_RATE_LIMIT]: {
    severity: "error",
    category: "llm",
    retryable: true,
    maxRetries: 5,
    userMessage: "Service is busy. Please wait a moment and try again.",
    userMessageKo: "서비스가 혼잡합니다. 잠시 후 다시 시도해 주세요.",
  },
  [ErrorCode.LLM_INVALID_RESPONSE]: {
    severity: "error",
    category: "llm",
    retryable: true,
    maxRetries: 2,
    userMessage: "AI returned an unexpected response. Retrying...",
    userMessageKo: "AI가 예상치 못한 응답을 반환했습니다. 재시도 중...",
  },
  [ErrorCode.DATA_EMPTY_INPUT]: {
    severity: "warning",
    category: "data",
    retryable: false,
    maxRetries: 0,
    userMessage: "No data found to analyze.",
    userMessageKo: "분석할 데이터가 없습니다.",
  },
  // ... 나머지 에러 코드 설정
};

/**
 * 파이프라인 에러
 */
export class PipelineError extends Error {
  code: ErrorCode;
  severity: ErrorSeverity;
  category: ErrorCategory;
  retryable: boolean;
  step?: string;
  context?: Record<string, any>;
  originalError?: Error;
  timestamp: number;

  constructor(
    code: ErrorCode,
    message: string,
    options?: {
      step?: string;
      context?: Record<string, any>;
      originalError?: Error;
    }
  ) {
    super(message);
    this.name = "PipelineError";
    this.code = code;
    this.timestamp = Date.now();

    const config = ERROR_CONFIG[code];
    this.severity = config?.severity || "error";
    this.category = config?.category || "unknown";
    this.retryable = config?.retryable || false;

    this.step = options?.step;
    this.context = options?.context;
    this.originalError = options?.originalError;
  }

  /**
   * 사용자 친화적 메시지 반환
   */
  getUserMessage(language: "en" | "ko" = "en"): string {
    const config = ERROR_CONFIG[this.code];
    return language === "ko" ? config?.userMessageKo : config?.userMessage;
  }

  /**
   * JSON 직렬화
   */
  toJSON(): Record<string, any> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      severity: this.severity,
      category: this.category,
      retryable: this.retryable,
      step: this.step,
      context: this.context,
      timestamp: this.timestamp,
      stack: this.stack,
    };
  }
}
```

#### 4.2.2 체크포인트 구조

```typescript
// src/types/checkpoint.ts

/**
 * 파이프라인 단계
 */
export type PipelineStep =
  | "parser"
  | "categorizer"
  | "clusterer"
  | "analyzer"
  | "grounding"
  | "synthesizer"
  | "visualizer"
  | "renderer";

/**
 * 체크포인트 데이터
 */
export interface Checkpoint {
  jobId: string;
  completedSteps: PipelineStep[];
  currentStep: PipelineStep;
  stepResults: {
    parser?: ParserResult;
    categorizer?: CategorizerResult;
    clusterer?: ClustererResult;
    analyzer?: AnalyzerResult;
    grounding?: GroundingResult;
    synthesizer?: SynthesizerResult;
    visualizer?: VisualizerResult;
  };
  errors: PipelineError[];
  startedAt: number;
  updatedAt: number;
  expiresAt: number;
}

/**
 * 체크포인트 저장 옵션
 */
export interface CheckpointOptions {
  ttlSeconds?: number;  // 기본: 3600 (1시간)
}
```

### 4.3 컴포넌트 설계

#### 4.3.1 RetryExecutor

```typescript
// src/utils/retryExecutor.ts

import { PipelineError, ErrorCode, ERROR_CONFIG } from "../types/errors";

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  onRetry?: (attempt: number, error: Error, delay: number) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, "onRetry">> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

/**
 * Exponential backoff 재시도 실행
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  errorCode: ErrorCode,
  options: RetryOptions = {}
): Promise<T> {
  const config = ERROR_CONFIG[errorCode];
  const opts = {
    ...DEFAULT_OPTIONS,
    maxRetries: config?.maxRetries ?? DEFAULT_OPTIONS.maxRetries,
    ...options,
  };

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      // 재시도 불가능한 에러면 즉시 throw
      if (error instanceof PipelineError && !error.retryable) {
        throw error;
      }

      // 마지막 시도였으면 throw
      if (attempt === opts.maxRetries) {
        break;
      }

      // 지연 시간 계산 (exponential backoff with jitter)
      const delay = Math.min(
        opts.baseDelayMs * Math.pow(opts.backoffMultiplier, attempt),
        opts.maxDelayMs
      );
      const jitter = delay * 0.2 * Math.random();
      const actualDelay = Math.round(delay + jitter);

      // 재시도 콜백
      if (opts.onRetry) {
        opts.onRetry(attempt + 1, error, actualDelay);
      }

      console.log(
        `[RetryExecutor] Attempt ${attempt + 1} failed, retrying in ${actualDelay}ms...`
      );

      await sleep(actualDelay);
    }
  }

  // 모든 재시도 실패
  throw lastError || new Error("All retries failed");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

#### 4.3.2 CheckpointManager

```typescript
// src/services/checkpointManager.ts

import { getRedisClient } from "../utils/redis";
import { Checkpoint, PipelineStep, CheckpointOptions } from "../types/checkpoint";

const CHECKPOINT_PREFIX = "checkpoint:";
const DEFAULT_TTL = 3600; // 1시간

export class CheckpointManager {
  private static instance: CheckpointManager;

  static getInstance(): CheckpointManager {
    if (!CheckpointManager.instance) {
      CheckpointManager.instance = new CheckpointManager();
    }
    return CheckpointManager.instance;
  }

  /**
   * 체크포인트 생성
   */
  async create(jobId: string, options: CheckpointOptions = {}): Promise<Checkpoint> {
    const now = Date.now();
    const ttl = options.ttlSeconds || DEFAULT_TTL;

    const checkpoint: Checkpoint = {
      jobId,
      completedSteps: [],
      currentStep: "parser",
      stepResults: {},
      errors: [],
      startedAt: now,
      updatedAt: now,
      expiresAt: now + ttl * 1000,
    };

    await this.save(checkpoint, ttl);
    return checkpoint;
  }

  /**
   * 체크포인트 업데이트
   */
  async update(
    jobId: string,
    updates: Partial<Omit<Checkpoint, "jobId" | "startedAt">>
  ): Promise<Checkpoint | null> {
    const checkpoint = await this.get(jobId);
    if (!checkpoint) return null;

    const updated: Checkpoint = {
      ...checkpoint,
      ...updates,
      updatedAt: Date.now(),
    };

    const remainingTtl = Math.max(
      Math.floor((checkpoint.expiresAt - Date.now()) / 1000),
      60
    );
    await this.save(updated, remainingTtl);

    return updated;
  }

  /**
   * 단계 완료 기록
   */
  async completeStep(
    jobId: string,
    step: PipelineStep,
    result: any
  ): Promise<Checkpoint | null> {
    const checkpoint = await this.get(jobId);
    if (!checkpoint) return null;

    if (!checkpoint.completedSteps.includes(step)) {
      checkpoint.completedSteps.push(step);
    }
    checkpoint.stepResults[step] = result;
    checkpoint.updatedAt = Date.now();

    const remainingTtl = Math.max(
      Math.floor((checkpoint.expiresAt - Date.now()) / 1000),
      60
    );
    await this.save(checkpoint, remainingTtl);

    return checkpoint;
  }

  /**
   * 에러 기록
   */
  async recordError(jobId: string, error: PipelineError): Promise<void> {
    const checkpoint = await this.get(jobId);
    if (!checkpoint) return;

    checkpoint.errors.push(error);
    checkpoint.updatedAt = Date.now();

    const remainingTtl = Math.max(
      Math.floor((checkpoint.expiresAt - Date.now()) / 1000),
      60
    );
    await this.save(checkpoint, remainingTtl);
  }

  /**
   * 체크포인트 조회
   */
  async get(jobId: string): Promise<Checkpoint | null> {
    try {
      const redis = getRedisClient();
      const data = await redis.get(`${CHECKPOINT_PREFIX}${jobId}`);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error("[CheckpointManager] Error getting checkpoint:", error);
      return null;
    }
  }

  /**
   * 체크포인트 삭제
   */
  async delete(jobId: string): Promise<void> {
    try {
      const redis = getRedisClient();
      await redis.del(`${CHECKPOINT_PREFIX}${jobId}`);
    } catch (error) {
      console.error("[CheckpointManager] Error deleting checkpoint:", error);
    }
  }

  /**
   * 재개 가능한지 확인
   */
  async canResume(jobId: string): Promise<{
    canResume: boolean;
    checkpoint?: Checkpoint;
    nextStep?: PipelineStep;
  }> {
    const checkpoint = await this.get(jobId);

    if (!checkpoint) {
      return { canResume: false };
    }

    if (checkpoint.expiresAt < Date.now()) {
      await this.delete(jobId);
      return { canResume: false };
    }

    const steps: PipelineStep[] = [
      "parser",
      "categorizer",
      "clusterer",
      "analyzer",
      "grounding",
      "synthesizer",
      "visualizer",
      "renderer",
    ];

    const lastCompleted = checkpoint.completedSteps[checkpoint.completedSteps.length - 1];
    const lastIndex = steps.indexOf(lastCompleted);
    const nextStep = lastIndex < steps.length - 1 ? steps[lastIndex + 1] : undefined;

    return {
      canResume: !!nextStep,
      checkpoint,
      nextStep,
    };
  }

  /**
   * 체크포인트 저장
   */
  private async save(checkpoint: Checkpoint, ttlSeconds: number): Promise<void> {
    try {
      const redis = getRedisClient();
      await redis.setEx(
        `${CHECKPOINT_PREFIX}${checkpoint.jobId}`,
        ttlSeconds,
        JSON.stringify(checkpoint)
      );
    } catch (error) {
      console.error("[CheckpointManager] Error saving checkpoint:", error);
    }
  }
}
```

#### 4.3.3 ErrorAggregator

```typescript
// src/utils/errorAggregator.ts

import { PipelineError, ErrorCode, ErrorSeverity } from "../types/errors";

/**
 * 에러 집계 결과
 */
export interface ErrorSummary {
  totalErrors: number;
  fatalErrors: number;
  retryableErrors: number;
  errorsByCode: Record<string, number>;
  errorsByStep: Record<string, number>;
  firstError?: PipelineError;
  lastError?: PipelineError;
  canProceed: boolean;  // 부분 결과로 진행 가능한지
}

/**
 * 에러 집계기
 */
export class ErrorAggregator {
  private errors: PipelineError[] = [];

  /**
   * 에러 추가
   */
  add(error: PipelineError): void {
    this.errors.push(error);
  }

  /**
   * 에러 목록 조회
   */
  getErrors(): PipelineError[] {
    return [...this.errors];
  }

  /**
   * 요약 생성
   */
  summarize(): ErrorSummary {
    const fatalErrors = this.errors.filter((e) => e.severity === "fatal");
    const retryableErrors = this.errors.filter((e) => e.retryable);

    const errorsByCode: Record<string, number> = {};
    const errorsByStep: Record<string, number> = {};

    for (const error of this.errors) {
      errorsByCode[error.code] = (errorsByCode[error.code] || 0) + 1;
      if (error.step) {
        errorsByStep[error.step] = (errorsByStep[error.step] || 0) + 1;
      }
    }

    return {
      totalErrors: this.errors.length,
      fatalErrors: fatalErrors.length,
      retryableErrors: retryableErrors.length,
      errorsByCode,
      errorsByStep,
      firstError: this.errors[0],
      lastError: this.errors[this.errors.length - 1],
      canProceed: fatalErrors.length === 0,
    };
  }

  /**
   * 치명적 에러 여부
   */
  hasFatalError(): boolean {
    return this.errors.some((e) => e.severity === "fatal");
  }

  /**
   * 초기화
   */
  clear(): void {
    this.errors = [];
  }
}
```

#### 4.3.4 개선된 파이프라인

```typescript
// src/services/reportPipeline/index.ts (개선)

import { CheckpointManager } from "../checkpointManager";
import { ErrorAggregator } from "../../utils/errorAggregator";
import { retryWithBackoff } from "../../utils/retryExecutor";
import { PipelineError, ErrorCode } from "../../types/errors";

export async function generateReport(
  params: ReportRequestParams,
  apiUrl: string,
  model: string,
  onProgress?: ProgressCallback,
  options?: {
    resumeFromCheckpoint?: boolean;
    jobId?: string;
  }
): Promise<Report> {
  const jobId = options?.jobId || uuidv4();
  const checkpointManager = CheckpointManager.getInstance();
  const errorAggregator = new ErrorAggregator();

  let checkpoint = await checkpointManager.get(jobId);
  let startStep = 0;

  // 체크포인트에서 재개
  if (options?.resumeFromCheckpoint && checkpoint) {
    const resumeInfo = await checkpointManager.canResume(jobId);
    if (resumeInfo.canResume && resumeInfo.nextStep) {
      startStep = STEPS.findIndex((s) => s.step === resumeInfo.nextStep);
      console.log(`[ReportPipeline] Resuming from step ${startStep}: ${resumeInfo.nextStep}`);
    }
  } else {
    checkpoint = await checkpointManager.create(jobId);
  }

  const stepFunctions = [
    { step: "parser", fn: () => parseThreads(params) },
    { step: "categorizer", fn: () => categorizeWithRetry(/* ... */) },
    { step: "clusterer", fn: () => clusterWithRetry(/* ... */) },
    { step: "analyzer", fn: () => analyzeData(/* ... */) },
    { step: "grounding", fn: () => groundWithRetry(/* ... */) },
    { step: "synthesizer", fn: () => synthesizeWithRetry(/* ... */) },
    { step: "visualizer", fn: () => generateVisualizationData(/* ... */) },
    { step: "renderer", fn: () => renderMarkdown(/* ... */) },
  ];

  let results: Record<string, any> = checkpoint?.stepResults || {};

  for (let i = startStep; i < stepFunctions.length; i++) {
    const { step, fn } = stepFunctions[i];

    try {
      updateProgress(i + 1);
      console.log(`[ReportPipeline] Step ${i + 1}: ${step}`);

      const result = await fn();
      results[step] = result;

      // 체크포인트 저장
      await checkpointManager.completeStep(jobId, step as PipelineStep, result);

    } catch (error: any) {
      const pipelineError = error instanceof PipelineError
        ? error
        : new PipelineError(
            ErrorCode.UNKNOWN_ERROR,
            error.message,
            { step, originalError: error }
          );

      pipelineError.step = step;
      errorAggregator.add(pipelineError);
      await checkpointManager.recordError(jobId, pipelineError);

      // 치명적 에러면 중단
      if (pipelineError.severity === "fatal") {
        throw pipelineError;
      }

      // 부분 결과로 계속 진행 가능한지 확인
      if (!canContinueWithoutStep(step)) {
        throw pipelineError;
      }

      console.warn(`[ReportPipeline] Step ${step} failed, continuing with partial results`);
    }
  }

  // 체크포인트 정리
  await checkpointManager.delete(jobId);

  return buildReport(results, errorAggregator.summarize());
}

/**
 * LLM 호출 재시도 래퍼
 */
async function categorizeWithRetry(/* ... */): Promise<CategorizerResult> {
  return retryWithBackoff(
    () => categorizeMessages(/* ... */),
    ErrorCode.LLM_TIMEOUT,
    {
      onRetry: (attempt, error, delay) => {
        console.log(`[Categorizer] Retry ${attempt}: ${error.message}, waiting ${delay}ms`);
      },
    }
  );
}

/**
 * 특정 단계 없이 계속 진행 가능한지 확인
 */
function canContinueWithoutStep(step: string): boolean {
  // 필수 단계들
  const requiredSteps = ["parser", "categorizer", "clusterer"];
  return !requiredSteps.includes(step);
}
```

---

## 5. 구현 계획 (Implementation Plan)

### 5.1 작업 분해 (Task Breakdown)

| # | 작업 | 설명 | 예상 시간 |
|---|------|------|-----------|
| 1 | 에러 타입 정의 | ErrorCode, PipelineError 정의 | 2시간 |
| 2 | RetryExecutor | 재시도 로직 구현 | 2시간 |
| 3 | CheckpointManager | 체크포인트 저장/복구 | 3시간 |
| 4 | ErrorAggregator | 에러 집계 및 분석 | 1시간 |
| 5 | 파이프라인 개선 | 기존 파이프라인 통합 | 4시간 |
| 6 | 복구 API | 재시도/재개 엔드포인트 | 2시간 |
| 7 | 에러 응답 포맷 | 사용자 친화적 응답 | 1시간 |
| 8 | 테스트 작성 | Unit, Integration 테스트 | 4시간 |
| 9 | 문서화 | 에러 코드 문서 | 1시간 |

### 5.2 의존성 (Dependencies)

```
Task 1 (에러 타입)
    │
    ├──► Task 2 (RetryExecutor)
    │
    ├──► Task 3 (CheckpointManager)
    │
    └──► Task 4 (ErrorAggregator)

Task 2, 3, 4 완료 후
    │
    ▼
Task 5 (파이프라인 개선)
    │
    ├──► Task 6 (복구 API)
    │
    └──► Task 7 (에러 응답 포맷)

Task 5, 6, 7 완료 후
    │
    ▼
Task 8 (테스트) → Task 9 (문서화)
```

### 5.3 예상 일정 (Estimated Timeline)

**총 예상 시간:** 20시간

**일정 (4일 기준):**
- **Day 1:** Task 1, 2, 3 (에러 타입, Retry, Checkpoint) - 7시간
- **Day 2:** Task 4, 5 (Aggregator, 파이프라인) - 5시간
- **Day 3:** Task 6, 7, 8 (API, 포맷, 테스트) - 7시간
- **Day 4:** Task 9 및 버그 수정 - 1시간 +

---

## 6. 테스트 전략 (Testing Strategy)

### 6.1 단위 테스트

```typescript
describe("RetryExecutor", () => {
  it("should retry on retryable error", async () => {
    let attempts = 0;
    const fn = jest.fn().mockImplementation(() => {
      attempts++;
      if (attempts < 3) throw new Error("Temporary error");
      return "success";
    });

    const result = await retryWithBackoff(fn, ErrorCode.LLM_TIMEOUT);

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("should not retry on fatal error", async () => {
    const fn = jest.fn().mockRejectedValue(
      new PipelineError(ErrorCode.DATA_EMPTY_INPUT, "No data")
    );

    await expect(retryWithBackoff(fn, ErrorCode.DATA_EMPTY_INPUT))
      .rejects.toThrow("No data");

    expect(fn).toHaveBeenCalledTimes(1);
  });
});
```

### 6.2 통합 테스트

```typescript
describe("Pipeline Error Recovery", () => {
  it("should resume from checkpoint", async () => {
    // 첫 번째 실행 - 중간에 실패
    const job1 = await reportService.createJob(params);
    // ... simulate failure at step 3

    // 두 번째 실행 - 체크포인트에서 재개
    const job2 = await reportService.resumeJob(job1.id);

    expect(job2.status).toBe("completed");
  });

  it("should return partial result on non-fatal error", async () => {
    // synthesizer 실패 시에도 기본 리포트는 생성
    const result = await generateReport(params, apiUrl, model);

    expect(result.clusters).toBeDefined();
    expect(result.synthesis).toBeUndefined(); // 실패한 부분
    expect(result.errors).toContain(expect.objectContaining({
      step: "synthesizer",
    }));
  });
});
```

### 6.3 테스트 시나리오

| 시나리오 | 검증 항목 |
|----------|-----------|
| **LLM 타임아웃** | 3회 재시도 후 성공 |
| **Rate Limit** | Exponential backoff 적용 |
| **치명적 에러** | 즉시 실패, 에러 코드 정확 |
| **체크포인트 재개** | 마지막 성공 단계부터 진행 |
| **부분 결과** | 선택적 단계 실패 시 계속 진행 |
| **에러 집계** | 다중 에러 요약 정확 |

---

## 7. 위험 요소 및 완화 방안 (Risks & Mitigations)

| 위험 요소 | 영향도 | 발생 가능성 | 완화 방안 |
|----------|--------|------------|----------|
| **무한 재시도** | 높음 | 낮음 | 최대 재시도 횟수 제한 |
| **체크포인트 손상** | 중간 | 낮음 | 유효성 검증, 처음부터 재시작 |
| **메모리 누수** | 중간 | 중간 | 체크포인트 TTL, 정기 정리 |
| **복잡도 증가** | 중간 | 높음 | 단계적 도입, 충분한 테스트 |

---

## 8. 참고 자료 (References)

### 내부 문서
- [00-overview.md](./00-overview.md) - 프로젝트 개요
- [05-grounded-analysis.md](./05-grounded-analysis.md) - 파이프라인 구조

### 외부 참조
- [Exponential Backoff](https://cloud.google.com/iot/docs/how-tos/exponential-backoff)
- [Circuit Breaker Pattern](https://martinfowler.com/bliki/CircuitBreaker.html)

---

## 변경 이력 (Change Log)

| 날짜 | 버전 | 변경 내용 | 작성자 |
|------|------|----------|--------|
| 2026-01-27 | 1.0 | 초안 작성 | Claude |

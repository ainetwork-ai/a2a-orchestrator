# TRD 11: Testing Strategy (테스팅 전략)

> **Origin:** 추가 기능 (future-decisions에 없음)

## 1. 개요 (Overview)

### 1.1 목적 (Purpose)

리포트 생성 시스템의 품질 보증을 위한 포괄적인 테스팅 전략을 수립합니다. 본 TRD는:

- **테스트 커버리지**: 핵심 기능의 80% 이상 커버리지 목표
- **자동화**: CI/CD 파이프라인 통합 테스트
- **품질 게이트**: 배포 전 필수 테스트 통과 조건
- **문서화**: 테스트 케이스 및 결과 기록

### 1.2 범위 (Scope)

**포함 (In Scope):**
- 단위 테스트 (Unit Tests)
- 통합 테스트 (Integration Tests)
- E2E 테스트 (End-to-End Tests)
- 성능 테스트 (Performance Tests)
- 데이터 품질 테스트
- Mock/Stub 전략
- 테스트 인프라 설정

**제외 (Out of Scope):**
- UI 테스트 (프론트엔드 별도)
- 보안 침투 테스트 (별도 수행)
- 부하 테스트 (별도 TRD)

### 1.3 용어 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **Unit Test** | 개별 함수/클래스의 독립적 테스트 |
| **Integration Test** | 여러 컴포넌트 간 상호작용 테스트 |
| **E2E Test** | 전체 시스템 워크플로우 테스트 |
| **Mock** | 외부 의존성을 모방하는 가짜 객체 |
| **Fixture** | 테스트에 사용되는 샘플 데이터 |
| **Coverage** | 테스트가 실행하는 코드의 비율 |

---

## 2. 현재 상태 분석 (Current State Analysis)

### 2.1 기존 테스트 현황

```
src/
├── services/
│   └── reportPipeline/
│       ├── parser.ts        ← 테스트 없음
│       ├── categorizer.ts   ← 테스트 없음
│       ├── clusterer.ts     ← 테스트 없음
│       └── ...
├── utils/
│   ├── reportTransformer.ts ← 테스트 없음
│   └── reportValidator.ts   ← 테스트 없음
└── routes/
    └── reports.ts           ← 테스트 없음
```

### 2.2 문제점 및 한계

| 문제 | 영향 | 심각도 |
|------|------|--------|
| **테스트 부재** | 회귀 버그 발생 가능 | 높음 |
| **수동 테스트 의존** | 배포 지연, 품질 불안정 | 높음 |
| **LLM 의존성** | 테스트 비결정성 | 중간 |
| **데이터 품질 검증 없음** | 잘못된 출력 감지 어려움 | 중간 |

---

## 3. 요구사항 (Requirements)

### 3.1 기능적 요구사항 (Functional Requirements)

**[FR-001] 단위 테스트**
- 모든 유틸리티 함수 테스트 (reportTransformer, reportValidator)
- 파이프라인 각 단계 단위 테스트
- 에러 처리 로직 테스트

**[FR-002] 통합 테스트**
- 파이프라인 전체 흐름 테스트
- API 엔드포인트 테스트
- Redis 연동 테스트

**[FR-003] E2E 테스트**
- 리포트 생성 전체 워크플로우
- 에러 시나리오 테스트
- 성능 벤치마크

**[FR-004] 데이터 품질 테스트**
- 출력 데이터 구조 검증
- 필터링 정확도 테스트
- Grounding 정확도 테스트

**[FR-005] 테스트 인프라**
- Jest 설정 및 구성
- Mock/Fixture 라이브러리
- CI 통합

### 3.2 비기능적 요구사항 (Non-Functional Requirements)

**[NFR-001] 커버리지**
- 전체 코드 커버리지: 70% 이상
- 핵심 모듈 커버리지: 80% 이상
- 유틸리티 함수: 90% 이상

**[NFR-002] 실행 시간**
- 단위 테스트: < 30초
- 통합 테스트: < 2분
- E2E 테스트: < 5분

**[NFR-003] 안정성**
- 테스트 결과 재현 가능 (flaky test 최소화)
- LLM 의존 테스트 분리

### 3.3 제약사항 (Constraints)

- Jest 사용 (기존 프로젝트 호환)
- LLM 호출 테스트는 Mock 사용
- CI에서 Redis 컨테이너 사용 가능

---

## 4. 기술 설계 (Technical Design)

### 4.1 테스트 구조

```
tests/
├── unit/                           # 단위 테스트
│   ├── utils/
│   │   ├── reportTransformer.test.ts
│   │   ├── reportValidator.test.ts
│   │   └── retryExecutor.test.ts
│   ├── services/
│   │   ├── reportService.test.ts
│   │   └── reportPipeline/
│   │       ├── parser.test.ts
│   │       ├── categorizer.test.ts
│   │       ├── clusterer.test.ts
│   │       ├── analyzer.test.ts
│   │       ├── grounding.test.ts
│   │       ├── synthesizer.test.ts
│   │       ├── visualizer.test.ts
│   │       └── renderer.test.ts
│   └── types/
│       └── errors.test.ts
│
├── integration/                    # 통합 테스트
│   ├── api/
│   │   ├── reports.test.ts
│   │   ├── storedReports.test.ts
│   │   └── shares.test.ts
│   ├── pipeline/
│   │   └── fullPipeline.test.ts
│   └── storage/
│       ├── redis.test.ts
│       └── postgres.test.ts
│
├── e2e/                            # E2E 테스트
│   ├── reportWorkflow.test.ts
│   ├── errorRecovery.test.ts
│   └── performance.test.ts
│
├── fixtures/                       # 테스트 데이터
│   ├── messages/
│   │   ├── sample-messages.json
│   │   ├── edge-cases.json
│   │   └── large-dataset.json
│   ├── reports/
│   │   └── expected-output.json
│   └── threads/
│       └── sample-threads.json
│
├── mocks/                          # Mock 객체
│   ├── llmMock.ts
│   ├── redisMock.ts
│   └── postgresMock.ts
│
└── helpers/                        # 테스트 헬퍼
    ├── setup.ts
    ├── teardown.ts
    ├── factories.ts
    └── assertions.ts
```

### 4.2 Jest 설정

```typescript
// jest.config.ts

import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],

  // 커버리지 설정
  collectCoverage: true,
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov", "html"],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
    "./src/utils/**/*.ts": {
      branches: 90,
      functions: 90,
      lines: 90,
      statements: 90,
    },
  },
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.d.ts",
    "!src/server.ts",
  ],

  // 셋업 파일
  setupFilesAfterEnv: ["<rootDir>/tests/helpers/setup.ts"],
  globalSetup: "<rootDir>/tests/helpers/globalSetup.ts",
  globalTeardown: "<rootDir>/tests/helpers/globalTeardown.ts",

  // 테스트 분리
  projects: [
    {
      displayName: "unit",
      testMatch: ["<rootDir>/tests/unit/**/*.test.ts"],
      testTimeout: 10000,
    },
    {
      displayName: "integration",
      testMatch: ["<rootDir>/tests/integration/**/*.test.ts"],
      testTimeout: 30000,
    },
    {
      displayName: "e2e",
      testMatch: ["<rootDir>/tests/e2e/**/*.test.ts"],
      testTimeout: 120000,
    },
  ],

  // 모듈 별칭
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
    "^@tests/(.*)$": "<rootDir>/tests/$1",
  },

  // 병렬 실행
  maxWorkers: "50%",

  // 실패 시 즉시 중단 (CI용)
  bail: process.env.CI ? 1 : 0,
};

export default config;
```

### 4.3 Mock 전략

#### 4.3.1 LLM Mock

```typescript
// tests/mocks/llmMock.ts

import { jest } from "@jest/globals";

/**
 * LLM API Mock
 * 결정적인 테스트를 위해 고정된 응답 반환
 */
export const createLLMMock = () => {
  const mockResponses: Record<string, any> = {
    categorize: {
      messages: [
        {
          id: "msg-1",
          category: "feature_request",
          subCategory: "ui",
          sentiment: "positive",
          isSubstantive: true,
        },
      ],
    },
    cluster: {
      clusters: [
        {
          id: "cluster-1",
          topic: "UI Improvements",
          description: "Requests for UI enhancements",
          messageIds: ["msg-1"],
        },
      ],
    },
    synthesize: {
      keyFindings: ["Users want better UI"],
      topPriorities: [
        { action: "Improve UI", priority: "high", rationale: "High demand" },
      ],
      executiveSummary: "Users are requesting UI improvements.",
    },
    ground: {
      opinions: [
        {
          id: "op-1",
          text: "Users want better UI",
          type: "consensus",
          supportingMessages: ["msg-1"],
          mentionCount: 1,
        },
      ],
    },
  };

  return {
    chat: jest.fn().mockImplementation(async (prompt: string) => {
      // 프롬프트 분석하여 적절한 응답 반환
      if (prompt.includes("categorize")) {
        return JSON.stringify(mockResponses.categorize);
      }
      if (prompt.includes("cluster")) {
        return JSON.stringify(mockResponses.cluster);
      }
      if (prompt.includes("synthesize")) {
        return JSON.stringify(mockResponses.synthesize);
      }
      if (prompt.includes("ground")) {
        return JSON.stringify(mockResponses.ground);
      }
      return "{}";
    }),

    // 특정 응답 오버라이드
    setResponse: (type: string, response: any) => {
      mockResponses[type] = response;
    },

    // 에러 시뮬레이션
    simulateError: (type: string) => {
      return jest.fn().mockRejectedValue(new Error(`${type} failed`));
    },

    // 타임아웃 시뮬레이션
    simulateTimeout: (delayMs: number) => {
      return jest.fn().mockImplementation(
        () => new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), delayMs)
        )
      );
    },
  };
};
```

#### 4.3.2 Redis Mock

```typescript
// tests/mocks/redisMock.ts

import { jest } from "@jest/globals";

/**
 * Redis Mock
 * In-memory 구현으로 실제 Redis 없이 테스트
 */
export const createRedisMock = () => {
  const store: Map<string, { value: string; expiresAt?: number }> = new Map();

  return {
    get: jest.fn().mockImplementation(async (key: string) => {
      const item = store.get(key);
      if (!item) return null;
      if (item.expiresAt && item.expiresAt < Date.now()) {
        store.delete(key);
        return null;
      }
      return item.value;
    }),

    set: jest.fn().mockImplementation(async (key: string, value: string) => {
      store.set(key, { value });
      return "OK";
    }),

    setEx: jest.fn().mockImplementation(
      async (key: string, seconds: number, value: string) => {
        store.set(key, {
          value,
          expiresAt: Date.now() + seconds * 1000,
        });
        return "OK";
      }
    ),

    del: jest.fn().mockImplementation(async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      let deleted = 0;
      for (const k of keys) {
        if (store.delete(k)) deleted++;
      }
      return deleted;
    }),

    keys: jest.fn().mockImplementation(async (pattern: string) => {
      const regex = new RegExp(
        "^" + pattern.replace(/\*/g, ".*") + "$"
      );
      return Array.from(store.keys()).filter((k) => regex.test(k));
    }),

    // 테스트 헬퍼
    clear: () => store.clear(),
    size: () => store.size,
    getAll: () => Object.fromEntries(store),
  };
};
```

### 4.4 테스트 케이스

#### 4.4.1 단위 테스트 예시

```typescript
// tests/unit/utils/reportValidator.test.ts

import {
  validateReportMessages,
  validateStatistics,
  validateClusters,
  validateGroundedOpinions,
} from "@/utils/reportValidator";
import { createMockReport, createMockCluster } from "@tests/helpers/factories";

describe("reportValidator", () => {
  describe("validateReportMessages", () => {
    it("should pass for report with only substantive messages", () => {
      const report = createMockReport({
        clusters: [
          createMockCluster({
            messages: [
              { id: "1", content: "Good feedback", isSubstantive: true },
              { id: "2", content: "Another point", isSubstantive: true },
            ],
          }),
        ],
      });

      const result = validateReportMessages(report);

      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should fail if non-substantive messages exist", () => {
      const report = createMockReport({
        clusters: [
          createMockCluster({
            messages: [
              { id: "1", content: "Hi", isSubstantive: false }, // Should not be here!
            ],
          }),
        ],
      });

      const result = validateReportMessages(report);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain(
        expect.stringContaining("Non-substantive message found")
      );
    });

    it("should warn about suspiciously short substantive messages", () => {
      const report = createMockReport({
        clusters: [
          createMockCluster({
            messages: [
              { id: "1", content: "OK yes", isSubstantive: true }, // Very short
            ],
          }),
        ],
      });

      const result = validateReportMessages(report);

      expect(result.isValid).toBe(true); // Still valid
      expect(result.warnings).toContain(
        expect.stringContaining("Suspiciously short")
      );
    });
  });

  describe("validateStatistics", () => {
    it("should fail if totalMessages is negative", () => {
      const stats = { totalMessages: -1, /* ... */ };

      const result = validateStatistics(stats);

      expect(result.isValid).toBe(false);
      expect(result.errors).toContain("totalMessages cannot be negative");
    });

    it("should warn if date range is inverted", () => {
      const stats = {
        dateRange: { start: 2000, end: 1000 }, // Inverted
        /* ... */
      };

      const result = validateStatistics(stats);

      expect(result.warnings).toContain(
        expect.stringContaining("Date range is inverted")
      );
    });
  });

  describe("validateGroundedOpinions", () => {
    it("should warn if opinion references invalid message ID", () => {
      const cluster = createMockCluster({
        messages: [{ id: "msg-1" }],
        opinions: [
          {
            id: "op-1",
            supportingMessages: ["msg-1", "msg-invalid"], // msg-invalid doesn't exist
          },
        ],
      });

      const result = validateGroundedOpinions(cluster);

      expect(result.warnings).toContain(
        expect.stringContaining("invalid message ID")
      );
    });

    it("should warn if mentionCount exceeds message count", () => {
      const cluster = createMockCluster({
        messages: [{ id: "msg-1" }], // 1 message
        opinions: [
          {
            id: "op-1",
            mentionCount: 10, // Claims 10 mentions
            supportingMessages: ["msg-1"],
          },
        ],
      });

      const result = validateGroundedOpinions(cluster);

      expect(result.warnings).toContain(
        expect.stringContaining("exceeding cluster message count")
      );
    });
  });
});
```

#### 4.4.2 통합 테스트 예시

```typescript
// tests/integration/api/reports.test.ts

import request from "supertest";
import { createApp } from "@/server";
import { createRedisMock } from "@tests/mocks/redisMock";
import { createLLMMock } from "@tests/mocks/llmMock";

describe("Reports API Integration", () => {
  let app: Express;
  let redisMock: ReturnType<typeof createRedisMock>;
  let llmMock: ReturnType<typeof createLLMMock>;

  beforeAll(async () => {
    redisMock = createRedisMock();
    llmMock = createLLMMock();
    app = await createApp({
      redis: redisMock,
      llm: llmMock,
    });
  });

  afterEach(() => {
    redisMock.clear();
    jest.clearAllMocks();
  });

  describe("POST /api/reports", () => {
    it("should create a new report job", async () => {
      const res = await request(app)
        .post("/api/reports")
        .send({
          threadIds: ["thread-1"],
          language: "ko",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.jobId).toBeDefined();
      expect(res.body.status).toBe("pending");
    });

    it("should return cached report if available", async () => {
      // 첫 번째 요청
      const res1 = await request(app)
        .post("/api/reports")
        .send({ threadIds: ["thread-1"] });

      // 완료 대기
      await waitForJobCompletion(app, res1.body.jobId);

      // 두 번째 요청 (같은 파라미터)
      const res2 = await request(app)
        .post("/api/reports")
        .send({ threadIds: ["thread-1"] });

      expect(res2.body.cachedAt).toBeDefined();
      expect(res2.body.status).toBe("completed");
    });

    it("should validate threadIds parameter", async () => {
      const res = await request(app)
        .post("/api/reports")
        .send({
          threadIds: "not-an-array", // Invalid
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain("threadIds must be an array");
    });
  });

  describe("GET /api/reports/:jobId", () => {
    it("should return job status", async () => {
      const createRes = await request(app)
        .post("/api/reports")
        .send({ threadIds: ["thread-1"] });

      const jobId = createRes.body.jobId;

      const res = await request(app)
        .get(`/api/reports/${jobId}`);

      expect(res.status).toBe(200);
      expect(res.body.jobId).toBe(jobId);
    });

    it("should return 404 for non-existent job", async () => {
      const res = await request(app)
        .get("/api/reports/non-existent-id");

      expect(res.status).toBe(404);
    });

    it("should support format parameter", async () => {
      const jobId = await createCompletedReport(app);

      const jsonRes = await request(app)
        .get(`/api/reports/${jobId}?format=json`);
      expect(jsonRes.body.report.topics).toBeDefined();

      const mdRes = await request(app)
        .get(`/api/reports/${jobId}?format=markdown`);
      expect(mdRes.body.markdown).toBeDefined();
    });
  });
});
```

#### 4.4.3 E2E 테스트 예시

```typescript
// tests/e2e/reportWorkflow.test.ts

describe("Report Generation E2E", () => {
  let app: Express;

  beforeAll(async () => {
    // 실제 LLM API 사용 (또는 테스트용 LLM)
    app = await createApp({
      useMockLLM: process.env.USE_MOCK_LLM === "true",
    });
  });

  it("should generate complete report from thread data", async () => {
    // 1. 스레드 생성 및 메시지 추가
    const threadRes = await request(app)
      .post("/api/threads")
      .send({ title: "E2E Test Thread" });
    const threadId = threadRes.body.id;

    await request(app)
      .post(`/api/threads/${threadId}/messages`)
      .send({ content: "I think the app needs better performance" });

    await request(app)
      .post(`/api/threads/${threadId}/messages`)
      .send({ content: "The loading time is too slow" });

    // 2. 리포트 생성
    const createRes = await request(app)
      .post("/api/reports")
      .send({
        threadIds: [threadId],
        language: "en",
      });

    const jobId = createRes.body.jobId;

    // 3. 완료 대기 (폴링)
    let status = "pending";
    let report;
    const startTime = Date.now();
    const timeout = 60000; // 60초

    while (status !== "completed" && status !== "failed") {
      if (Date.now() - startTime > timeout) {
        throw new Error("Report generation timeout");
      }

      const res = await request(app).get(`/api/reports/${jobId}`);
      status = res.body.status;
      report = res.body.report;

      if (status !== "completed") {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    // 4. 결과 검증
    expect(status).toBe("completed");
    expect(report).toBeDefined();

    // 4.1 기본 구조 검증
    expect(report.id).toBeDefined();
    expect(report.title).toBeDefined();
    expect(report.statistics).toBeDefined();
    expect(report.clusters).toBeInstanceOf(Array);
    expect(report.clusters.length).toBeGreaterThan(0);

    // 4.2 클러스터 검증
    const cluster = report.clusters[0];
    expect(cluster.topic).toBeDefined();
    expect(cluster.messages.length).toBeGreaterThan(0);
    expect(cluster.opinions).toBeInstanceOf(Array);

    // 4.3 Grounding 검증
    if (cluster.opinions.length > 0) {
      const opinion = cluster.opinions[0];
      expect(opinion.supportingMessages).toBeInstanceOf(Array);
      expect(opinion.mentionCount).toBeGreaterThanOrEqual(0);
    }

    // 4.4 모든 메시지가 substantive인지 검증
    for (const c of report.clusters) {
      for (const msg of c.messages) {
        expect(msg.isSubstantive).toBe(true);
      }
    }
  }, 120000); // 2분 타임아웃

  it("should handle empty thread gracefully", async () => {
    const emptyThreadRes = await request(app)
      .post("/api/threads")
      .send({ title: "Empty Thread" });

    const createRes = await request(app)
      .post("/api/reports")
      .send({ threadIds: [emptyThreadRes.body.id] });

    const jobId = createRes.body.jobId;
    await waitForJobCompletion(app, jobId, 30000);

    const res = await request(app).get(`/api/reports/${jobId}`);

    expect(res.body.status).toBe("completed");
    expect(res.body.report.statistics.totalMessages).toBe(0);
    expect(res.body.report.clusters).toHaveLength(0);
  });
});
```

### 4.5 성능 테스트

```typescript
// tests/e2e/performance.test.ts

describe("Performance Tests", () => {
  it("should generate report within time limit", async () => {
    const startTime = Date.now();

    const createRes = await request(app)
      .post("/api/reports")
      .send({ threadIds: ["thread-with-100-messages"] });

    const jobId = createRes.body.jobId;
    await waitForJobCompletion(app, jobId, 120000);

    const endTime = Date.now();
    const duration = endTime - startTime;

    // 100개 메시지 처리 30초 이내
    expect(duration).toBeLessThan(30000);
  });

  it("should handle concurrent requests", async () => {
    const concurrentRequests = 5;
    const requests = Array(concurrentRequests)
      .fill(null)
      .map((_, i) =>
        request(app)
          .post("/api/reports")
          .send({ threadIds: [`thread-${i}`] })
      );

    const responses = await Promise.all(requests);

    // 모든 요청 성공
    responses.forEach((res) => {
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  it("should not exceed memory threshold", async () => {
    const initialMemory = process.memoryUsage().heapUsed;

    // 대용량 리포트 생성
    const createRes = await request(app)
      .post("/api/reports")
      .send({ threadIds: ["thread-with-1000-messages"] });

    await waitForJobCompletion(app, createRes.body.jobId, 300000);

    const finalMemory = process.memoryUsage().heapUsed;
    const memoryIncrease = finalMemory - initialMemory;

    // 메모리 증가 500MB 이하
    expect(memoryIncrease).toBeLessThan(500 * 1024 * 1024);
  });
});
```

### 4.6 테스트 헬퍼

```typescript
// tests/helpers/factories.ts

import { v4 as uuidv4 } from "uuid";
import {
  Report,
  MessageCluster,
  CategorizedMessage,
  Opinion,
  ReportStatistics,
} from "@/types/report";

export function createMockMessage(
  overrides: Partial<CategorizedMessage> = {}
): CategorizedMessage {
  return {
    id: uuidv4(),
    content: "This is a test message with substantive content.",
    timestamp: Date.now(),
    category: "feedback",
    sentiment: "neutral",
    isSubstantive: true,
    ...overrides,
  };
}

export function createMockOpinion(
  overrides: Partial<Opinion> = {}
): Opinion {
  return {
    id: uuidv4(),
    text: "Test opinion",
    type: "general",
    supportingMessages: [],
    mentionCount: 0,
    ...overrides,
  };
}

export function createMockCluster(
  overrides: Partial<MessageCluster> = {}
): MessageCluster {
  return {
    id: uuidv4(),
    topic: "Test Topic",
    description: "Test cluster description",
    messages: [createMockMessage()],
    opinions: [createMockOpinion()],
    summary: {
      consensus: ["Test consensus"],
      conflicting: [],
      sentiment: "neutral",
    },
    nextSteps: [],
    ...overrides,
  };
}

export function createMockStatistics(
  overrides: Partial<ReportStatistics> = {}
): ReportStatistics {
  return {
    totalMessages: 10,
    totalThreads: 1,
    dateRange: { start: Date.now() - 86400000, end: Date.now() },
    categoryDistribution: { feedback: 10 },
    sentimentDistribution: { positive: 3, negative: 3, neutral: 4 },
    topTopics: [{ topic: "Test", count: 10, percentage: 100 }],
    averageMessagesPerThread: 10,
    totalMessagesBeforeSampling: 10,
    wasSampled: false,
    nonSubstantiveCount: 0,
    ...overrides,
  };
}

export function createMockReport(
  overrides: Partial<Report> = {}
): Report {
  return {
    id: uuidv4(),
    title: "Test Report",
    createdAt: Date.now(),
    statistics: createMockStatistics(),
    clusters: [createMockCluster()],
    markdown: "# Test Report",
    ...overrides,
  };
}
```

```typescript
// tests/helpers/assertions.ts

import { Report, MessageCluster } from "@/types/report";

/**
 * 리포트 구조 검증
 */
export function assertValidReport(report: Report): void {
  expect(report.id).toBeDefined();
  expect(report.title).toBeDefined();
  expect(report.createdAt).toBeGreaterThan(0);
  expect(report.statistics).toBeDefined();
  expect(Array.isArray(report.clusters)).toBe(true);
  expect(report.markdown).toBeDefined();
}

/**
 * 클러스터 구조 검증
 */
export function assertValidCluster(cluster: MessageCluster): void {
  expect(cluster.id).toBeDefined();
  expect(cluster.topic).toBeTruthy();
  expect(cluster.description).toBeDefined();
  expect(Array.isArray(cluster.messages)).toBe(true);
  expect(Array.isArray(cluster.opinions)).toBe(true);
  expect(cluster.summary).toBeDefined();
}

/**
 * 모든 메시지가 substantive인지 검증
 */
export function assertAllSubstantive(report: Report): void {
  for (const cluster of report.clusters) {
    for (const message of cluster.messages) {
      expect(message.isSubstantive).toBe(true);
    }
  }
}

/**
 * Grounding 검증
 */
export function assertValidGrounding(cluster: MessageCluster): void {
  const validMessageIds = new Set(cluster.messages.map((m) => m.id));

  for (const opinion of cluster.opinions) {
    // supportingMessages가 유효한 ID를 참조하는지
    for (const msgId of opinion.supportingMessages) {
      expect(validMessageIds.has(msgId)).toBe(true);
    }

    // mentionCount가 합리적인지
    expect(opinion.mentionCount).toBeLessThanOrEqual(cluster.messages.length);
  }
}
```

---

## 5. 구현 계획 (Implementation Plan)

### 5.1 작업 분해 (Task Breakdown)

| # | 작업 | 설명 | 예상 시간 |
|---|------|------|-----------|
| 1 | 테스트 인프라 설정 | Jest 구성, 디렉토리 구조 | 2시간 |
| 2 | Mock 라이브러리 | LLM, Redis, Postgres mock | 3시간 |
| 3 | 테스트 헬퍼/팩토리 | 공통 헬퍼 함수 | 2시간 |
| 4 | 유틸리티 단위 테스트 | Validator, Transformer 등 | 4시간 |
| 5 | 파이프라인 단위 테스트 | 각 단계별 테스트 | 6시간 |
| 6 | API 통합 테스트 | 엔드포인트 테스트 | 4시간 |
| 7 | E2E 테스트 | 전체 워크플로우 | 4시간 |
| 8 | 성능 테스트 | 벤치마크 테스트 | 2시간 |
| 9 | CI 통합 | GitHub Actions 설정 | 2시간 |
| 10 | 문서화 | 테스트 가이드 | 1시간 |

### 5.2 예상 일정 (Estimated Timeline)

**총 예상 시간:** 30시간

**일정 (6일 기준):**
- **Day 1:** Task 1, 2 (인프라, Mock) - 5시간
- **Day 2:** Task 3, 4 (헬퍼, 유틸리티 테스트) - 6시간
- **Day 3:** Task 5 (파이프라인 테스트) - 6시간
- **Day 4:** Task 6 (API 테스트) - 4시간
- **Day 5:** Task 7, 8 (E2E, 성능) - 6시간
- **Day 6:** Task 9, 10 (CI, 문서화) - 3시간

---

## 6. CI/CD 통합

### 6.1 GitHub Actions 워크플로우

```yaml
# .github/workflows/test.yml

name: Test Suite

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
      - run: npm ci
      - run: npm run test:unit
      - uses: codecov/codecov-action@v4
        with:
          file: ./coverage/lcov.info

  integration-tests:
    runs-on: ubuntu-latest
    services:
      redis:
        image: redis:7
        ports:
          - 6379:6379
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: test
          POSTGRES_DB: test
        ports:
          - 5432:5432
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
      - run: npm ci
      - run: npm run test:integration
        env:
          REDIS_URL: redis://localhost:6379
          DATABASE_URL: postgresql://postgres:test@localhost:5432/test

  e2e-tests:
    runs-on: ubuntu-latest
    needs: [unit-tests, integration-tests]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
      - run: npm ci
      - run: npm run test:e2e
        env:
          USE_MOCK_LLM: "true"
```

### 6.2 품질 게이트

```json
// package.json scripts

{
  "scripts": {
    "test": "jest",
    "test:unit": "jest --selectProjects unit",
    "test:integration": "jest --selectProjects integration",
    "test:e2e": "jest --selectProjects e2e",
    "test:coverage": "jest --coverage",
    "test:watch": "jest --watch",
    "precommit": "npm run test:unit && npm run lint"
  }
}
```

---

## 7. 위험 요소 및 완화 방안 (Risks & Mitigations)

| 위험 요소 | 영향도 | 발생 가능성 | 완화 방안 |
|----------|--------|------------|----------|
| **LLM 비결정성** | 높음 | 높음 | Mock 사용, 고정 응답 |
| **Flaky Tests** | 중간 | 중간 | 재시도, 타임아웃 조정 |
| **테스트 속도 저하** | 중간 | 중간 | 병렬 실행, 캐싱 |
| **커버리지 미달** | 중간 | 중간 | 품질 게이트, 리뷰 |

---

## 8. 참고 자료 (References)

### 외부 참조
- [Jest Documentation](https://jestjs.io/docs/getting-started)
- [Testing Best Practices](https://github.com/goldbergyoni/javascript-testing-best-practices)
- [Supertest](https://github.com/ladjs/supertest)

---

## 변경 이력 (Change Log)

| 날짜 | 버전 | 변경 내용 | 작성자 |
|------|------|----------|--------|
| 2026-01-27 | 1.0 | 초안 작성 | Claude |

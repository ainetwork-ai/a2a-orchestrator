# TRD 07: Enhanced Report Metadata (리포트 메타데이터 확장)

> **Origin:** [99-future-decisions.md](./99-future-decisions.md) - Decision #10

## 1. 개요 (Overview)

### 1.1 목적 (Purpose)

현재 리포트 메타데이터는 기본적인 처리 정보만 포함합니다. 본 TRD는 리포트의 활용성과 분석 깊이를 높이기 위해 다음과 같은 확장된 메타데이터를 추가하는 것을 목표로 합니다:

- **Thread-level 분석**: 스레드별 메시지 분포, 활성도
- **Agent-level 분석**: 에이전트별 참여도, 응답 품질
- **Time-period 분석**: 시간대별 활동 패턴, 트렌드
- **Category-specific 심층 분석**: 카테고리별 상세 인사이트

### 1.2 범위 (Scope)

**포함 (In Scope):**
- Thread-level 메타데이터 구조 설계 및 구현
- Agent-level 메타데이터 구조 설계 및 구현
- Time-period 메타데이터 구조 설계 및 구현
- Category-specific 심층 분석 데이터
- 기존 `ReportMetadata` 인터페이스 확장
- API 응답 포맷 업데이트

**제외 (Out of Scope):**
- 사용자 개인 식별 정보 노출 (익명화 원칙 유지)
- 실시간 메타데이터 스트리밍
- 메타데이터 기반 알림 시스템

### 1.3 용어 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **Thread Breakdown** | 스레드별 메시지 수, 참여 에이전트, 활성 기간 등의 상세 정보 |
| **Agent Breakdown** | 에이전트별 메시지 수, 평균 응답 길이, 활동 패턴 등의 상세 정보 |
| **Time Breakdown** | 시간대별 메시지 분포, 피크 시간, 트렌드 분석 |
| **Deep Analysis** | 특정 카테고리에 대한 심층적인 패턴 분석 |

---

## 2. 현재 상태 분석 (Current State Analysis)

### 2.1 기존 시스템 구조

```typescript
// src/types/report.ts (현재)
interface ReportMetadata {
  params: ReportRequestParams;
  processingTime: number;
  pipelineVersion: string;
  wasCached: boolean;
  cachedAt?: number;
  scope: {
    totalThreads: number;
    totalMessages: number;
    substantiveMessages: number;
    filteredMessages: number;
    dateRange: {
      start: number;
      end: number;
    };
  };
  filtering?: {
    totalBeforeFiltering: number;
    substantiveCount: number;
    nonSubstantiveCount: number;
    filteringRate: number;
    filterReasons?: FilteringBreakdown;
  };
}
```

### 2.2 문제점 및 한계

| 문제 | 영향 | 심각도 |
|------|------|--------|
| **스레드별 분석 없음** | 어떤 스레드가 가장 활발한지 파악 불가 | 중간 |
| **에이전트별 분석 없음** | 에이전트 성능 비교 불가 | 중간 |
| **시간 패턴 없음** | 사용 트렌드 파악 불가 | 낮음 |
| **심층 분석 없음** | 카테고리별 인사이트 제한적 | 중간 |

---

## 3. 요구사항 (Requirements)

### 3.1 기능적 요구사항 (Functional Requirements)

**[FR-001] Thread Breakdown**
- 스레드별 메시지 수 제공
- 스레드별 활성 기간 (첫 메시지 ~ 마지막 메시지)
- 스레드별 주요 카테고리 분포
- 스레드별 감정 분포

**[FR-002] Agent Breakdown**
- 에이전트별 메시지 수 (익명화된 형태로)
- 에이전트별 평균 응답 길이
- 에이전트별 활동 시간대
- 에이전트 참여 스레드 수

**[FR-003] Time Period Breakdown**
- 시간별 (hourly) 메시지 분포
- 일별 (daily) 메시지 분포
- 주간 패턴 (요일별)
- 피크 시간대 식별

**[FR-004] Category Deep Analysis**
- 카테고리별 감정 분포 상세
- 카테고리별 시간 패턴
- 카테고리 간 상관관계 힌트
- 카테고리별 대표 키워드

**[FR-005] 선택적 포함**
- API 요청 시 메타데이터 포함 여부 선택 가능
- 세부 레벨 선택 (basic, detailed, full)
- 성능을 위한 lazy loading 지원

### 3.2 비기능적 요구사항 (Non-Functional Requirements)

**[NFR-001] 성능**
- 기본 메타데이터 생성: < 100ms
- 상세 메타데이터 생성: < 500ms
- 전체 메타데이터 생성: < 1000ms
- 메타데이터 포함 시 응답 크기 증가: < 20%

**[NFR-002] 익명화**
- 에이전트 이름은 포함 가능 (공개 정보)
- 사용자 ID는 포함 불가
- 스레드 ID는 요청 옵션에 따라 포함 가능

**[NFR-003] 확장성**
- 새로운 메타데이터 필드 추가 용이
- 버전 관리를 통한 하위 호환성 유지

### 3.3 제약사항 (Constraints)

- 익명화 원칙 준수 (Decision 11이 결정되기 전까지)
- 기존 API 하위 호환성 유지
- 메모리 사용량 제한 (대규모 리포트에서도 안정적)

---

## 4. 기술 설계 (Technical Design)

### 4.1 아키텍처 개요

```
┌─────────────────────────────────────────────────────────────────┐
│                    Enhanced Metadata Pipeline                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  [Parser]                                                         │
│      │                                                            │
│      └──► Thread Data Extraction ──►┐                            │
│                                      │                            │
│  [Categorizer]                       │                            │
│      │                               │                            │
│      └──► Category Analysis ────────►│                            │
│                                      │                            │
│  [Analyzer]                          ▼                            │
│      │                        ┌─────────────────┐                │
│      └──────────────────────►│ MetadataBuilder │                 │
│                              └────────┬────────┘                 │
│                                       │                           │
│                          ┌────────────┼────────────┐             │
│                          ▼            ▼            ▼             │
│                    ┌─────────┐ ┌───────────┐ ┌──────────┐       │
│                    │ Thread  │ │   Agent   │ │   Time   │       │
│                    │Breakdown│ │ Breakdown │ │ Breakdown│       │
│                    └─────────┘ └───────────┘ └──────────┘       │
│                          │            │            │             │
│                          └────────────┼────────────┘             │
│                                       ▼                          │
│                              ┌─────────────────┐                 │
│                              │ ReportMetadata  │                 │
│                              │   (Enhanced)    │                 │
│                              └─────────────────┘                 │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 데이터 모델

#### 4.2.1 확장된 TypeScript 인터페이스

```typescript
// src/types/metadata.ts

/**
 * 메타데이터 상세 수준
 */
export type MetadataLevel = "basic" | "detailed" | "full";

/**
 * Thread Breakdown 데이터
 */
export interface ThreadBreakdown {
  threadId: string;  // 옵션에 따라 포함 (includeThreadIds)
  messageCount: number;
  substantiveCount: number;
  dateRange: {
    start: number;
    end: number;
  };
  primaryCategory: string;
  sentimentDistribution: {
    positive: number;
    negative: number;
    neutral: number;
  };
  agentCount: number;  // 참여 에이전트 수
}

/**
 * Agent Breakdown 데이터 (익명화된 형태)
 */
export interface AgentBreakdown {
  agentName: string;  // 에이전트 이름 (공개 정보)
  agentUrl?: string;  // 에이전트 URL (옵션)
  messageCount: number;
  averageMessageLength: number;
  threadCount: number;  // 참여 스레드 수
  primaryCategories: string[];  // 주로 다루는 카테고리
  activityPattern: {
    peakHour: number;  // 0-23
    activeDays: number;  // 활동한 일수
  };
}

/**
 * Time Period Breakdown 데이터
 */
export interface TimeBreakdown {
  hourly: Array<{
    hour: number;  // 0-23
    messageCount: number;
  }>;
  daily: Array<{
    date: string;  // YYYY-MM-DD
    messageCount: number;
    sentiment: "positive" | "negative" | "mixed" | "neutral";
  }>;
  weekly: {
    [key: string]: number;  // "sunday" - "saturday"
  };
  peakPeriods: {
    peakHour: number;
    peakDay: string;
    busiestDate: string;
  };
}

/**
 * Category Deep Analysis 데이터
 */
export interface CategoryDeepAnalysis {
  category: string;
  messageCount: number;
  percentage: number;
  sentiment: {
    overall: "positive" | "negative" | "mixed" | "neutral";
    distribution: {
      positive: number;
      negative: number;
      neutral: number;
    };
    trend?: "improving" | "declining" | "stable";
  };
  timePattern: {
    peakHour: number;
    peakDay: string;
  };
  topKeywords: string[];  // 최대 5개
  subCategories: Array<{
    name: string;
    count: number;
  }>;
  relatedCategories: string[];  // 함께 나타나는 카테고리들
}

/**
 * 확장된 ReportMetadata
 */
export interface EnhancedReportMetadata {
  // 기존 필드
  params: ReportRequestParams;
  processingTime: number;
  pipelineVersion: string;
  wasCached: boolean;
  cachedAt?: number;
  scope: {
    totalThreads: number;
    totalMessages: number;
    substantiveMessages: number;
    filteredMessages: number;
    dateRange: {
      start: number;
      end: number;
    };
  };
  filtering?: {
    totalBeforeFiltering: number;
    substantiveCount: number;
    nonSubstantiveCount: number;
    filteringRate: number;
    filterReasons?: FilteringBreakdown;
  };

  // 확장 필드 (메타데이터 레벨에 따라 포함)
  threadBreakdown?: ThreadBreakdown[];    // detailed, full
  agentBreakdown?: AgentBreakdown[];      // detailed, full
  timeBreakdown?: TimeBreakdown;          // detailed, full
  categoryAnalysis?: CategoryDeepAnalysis[]; // full only
}

/**
 * 메타데이터 생성 옵션
 */
export interface MetadataOptions {
  level?: MetadataLevel;          // 기본: "basic"
  includeThreadIds?: boolean;     // Thread ID 포함 여부 (기본: false)
  includeAgentUrls?: boolean;     // Agent URL 포함 여부 (기본: false)
  timezone?: string;              // 시간대 (기본: UTC)
}
```

### 4.3 API 설계

#### 4.3.1 리포트 생성 시 메타데이터 옵션

**POST /api/reports (업데이트)**

```http
POST /api/reports
Content-Type: application/json

{
  "threadIds": ["thread-1", "thread-2"],
  "startDate": "2026-01-01",
  "endDate": "2026-01-26",
  "language": "ko",

  // NEW: 메타데이터 옵션
  "metadata": {
    "level": "detailed",
    "includeThreadIds": true,
    "includeAgentUrls": false,
    "timezone": "Asia/Seoul"
  }
}
```

#### 4.3.2 리포트 조회 시 메타데이터 레벨 지정

**GET /api/reports/:jobId**

```http
GET /api/reports/:jobId?format=json&metadataLevel=full
```

**Query Parameters:**
- `metadataLevel`: "basic" | "detailed" | "full" (기본: "basic")

### 4.4 컴포넌트 설계

#### 4.4.1 MetadataBuilder 클래스

```typescript
// src/services/reportPipeline/metadataBuilder.ts

import {
  CategorizedMessage,
  MessageCluster,
  ReportStatistics,
  ReportRequestParams,
} from "../../types/report";
import {
  EnhancedReportMetadata,
  MetadataOptions,
  MetadataLevel,
  ThreadBreakdown,
  AgentBreakdown,
  TimeBreakdown,
  CategoryDeepAnalysis,
} from "../../types/metadata";

interface ThreadMessageData {
  threadId: string;
  messages: CategorizedMessage[];
  agents: Set<string>;
}

interface AgentMessageData {
  agentName: string;
  agentUrl?: string;
  messages: CategorizedMessage[];
  threads: Set<string>;
}

export class MetadataBuilder {
  private messages: CategorizedMessage[];
  private clusters: MessageCluster[];
  private statistics: ReportStatistics;
  private options: MetadataOptions;

  constructor(
    messages: CategorizedMessage[],
    clusters: MessageCluster[],
    statistics: ReportStatistics,
    options: MetadataOptions = {}
  ) {
    this.messages = messages;
    this.clusters = clusters;
    this.statistics = statistics;
    this.options = {
      level: "basic",
      includeThreadIds: false,
      includeAgentUrls: false,
      timezone: "UTC",
      ...options,
    };
  }

  /**
   * 메타데이터 빌드
   */
  build(
    params: ReportRequestParams,
    processingTime: number,
    wasCached: boolean,
    cachedAt?: number
  ): EnhancedReportMetadata {
    const baseMetadata = this.buildBaseMetadata(
      params,
      processingTime,
      wasCached,
      cachedAt
    );

    if (this.options.level === "basic") {
      return baseMetadata;
    }

    // detailed 또는 full 레벨
    const enhancedMetadata: EnhancedReportMetadata = {
      ...baseMetadata,
      threadBreakdown: this.buildThreadBreakdown(),
      agentBreakdown: this.buildAgentBreakdown(),
      timeBreakdown: this.buildTimeBreakdown(),
    };

    // full 레벨에서만 카테고리 심층 분석 포함
    if (this.options.level === "full") {
      enhancedMetadata.categoryAnalysis = this.buildCategoryAnalysis();
    }

    return enhancedMetadata;
  }

  /**
   * 기본 메타데이터 빌드
   */
  private buildBaseMetadata(
    params: ReportRequestParams,
    processingTime: number,
    wasCached: boolean,
    cachedAt?: number
  ): EnhancedReportMetadata {
    const totalBeforeFiltering =
      this.statistics.totalMessages + this.statistics.nonSubstantiveCount;

    return {
      params,
      processingTime,
      pipelineVersion: "1.0.0",
      wasCached,
      cachedAt,
      scope: {
        totalThreads: this.statistics.totalThreads,
        totalMessages: this.statistics.totalMessages,
        substantiveMessages: this.statistics.totalMessages,
        filteredMessages: this.statistics.nonSubstantiveCount,
        dateRange: this.statistics.dateRange,
      },
      filtering: {
        totalBeforeFiltering,
        substantiveCount: this.statistics.totalMessages,
        nonSubstantiveCount: this.statistics.nonSubstantiveCount,
        filteringRate:
          totalBeforeFiltering > 0
            ? parseFloat(
                (
                  (this.statistics.nonSubstantiveCount / totalBeforeFiltering) *
                  100
                ).toFixed(1)
              )
            : 0,
        filterReasons: this.statistics.filteringBreakdown,
      },
    };
  }

  /**
   * Thread Breakdown 빌드
   */
  private buildThreadBreakdown(): ThreadBreakdown[] {
    // 스레드별 메시지 그룹화 (실제 구현 시 threadId 필요)
    // 현재 익명화로 인해 threadId가 없으므로 placeholder 구현
    const threadMap = new Map<string, CategorizedMessage[]>();

    // 메시지에서 context.threadId를 통해 그룹화 (있는 경우)
    for (const msg of this.messages) {
      // @ts-ignore - 현재 타입에 context 없을 수 있음
      const threadId = msg.context?.threadId || "unknown";
      if (!threadMap.has(threadId)) {
        threadMap.set(threadId, []);
      }
      threadMap.get(threadId)!.push(msg);
    }

    return Array.from(threadMap.entries()).map(([threadId, msgs]) => {
      const timestamps = msgs.map((m) => m.timestamp);
      const sentiments = this.calculateSentimentDistribution(msgs);
      const categories = this.calculateCategoryDistribution(msgs);
      const primaryCategory =
        Object.entries(categories).sort(([, a], [, b]) => b - a)[0]?.[0] ||
        "unknown";

      return {
        threadId: this.options.includeThreadIds ? threadId : `thread-${threadMap.size}`,
        messageCount: msgs.length,
        substantiveCount: msgs.filter((m) => m.isSubstantive).length,
        dateRange: {
          start: Math.min(...timestamps),
          end: Math.max(...timestamps),
        },
        primaryCategory,
        sentimentDistribution: sentiments,
        agentCount: 0, // 에이전트 정보 필요
      };
    });
  }

  /**
   * Agent Breakdown 빌드
   */
  private buildAgentBreakdown(): AgentBreakdown[] {
    // 에이전트 정보는 현재 메시지에 포함되어 있지 않음
    // 실제 구현 시 파서에서 에이전트 정보를 추출해야 함
    return [];
  }

  /**
   * Time Breakdown 빌드
   */
  private buildTimeBreakdown(): TimeBreakdown {
    const hourly: Map<number, number> = new Map();
    const daily: Map<string, { count: number; sentiments: string[] }> = new Map();
    const weekly: Map<string, number> = new Map();

    const dayNames = [
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
    ];

    for (const msg of this.messages) {
      const date = new Date(msg.timestamp);

      // Hourly
      const hour = date.getHours();
      hourly.set(hour, (hourly.get(hour) || 0) + 1);

      // Daily
      const dateStr = date.toISOString().split("T")[0];
      if (!daily.has(dateStr)) {
        daily.set(dateStr, { count: 0, sentiments: [] });
      }
      const dayData = daily.get(dateStr)!;
      dayData.count++;
      if (msg.sentiment) {
        dayData.sentiments.push(msg.sentiment);
      }

      // Weekly
      const dayName = dayNames[date.getDay()];
      weekly.set(dayName, (weekly.get(dayName) || 0) + 1);
    }

    // Find peaks
    let peakHour = 0;
    let maxHourly = 0;
    for (const [hour, count] of hourly.entries()) {
      if (count > maxHourly) {
        maxHourly = count;
        peakHour = hour;
      }
    }

    let peakDay = "monday";
    let maxWeekly = 0;
    for (const [day, count] of weekly.entries()) {
      if (count > maxWeekly) {
        maxWeekly = count;
        peakDay = day;
      }
    }

    let busiestDate = "";
    let maxDaily = 0;
    for (const [date, data] of daily.entries()) {
      if (data.count > maxDaily) {
        maxDaily = data.count;
        busiestDate = date;
      }
    }

    return {
      hourly: Array.from({ length: 24 }, (_, i) => ({
        hour: i,
        messageCount: hourly.get(i) || 0,
      })),
      daily: Array.from(daily.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, data]) => ({
          date,
          messageCount: data.count,
          sentiment: this.calculateOverallSentiment(data.sentiments),
        })),
      weekly: Object.fromEntries(
        dayNames.map((day) => [day, weekly.get(day) || 0])
      ),
      peakPeriods: {
        peakHour,
        peakDay,
        busiestDate,
      },
    };
  }

  /**
   * Category Deep Analysis 빌드
   */
  private buildCategoryAnalysis(): CategoryDeepAnalysis[] {
    const categoryMap = new Map<string, CategorizedMessage[]>();

    for (const msg of this.messages) {
      const category = msg.category || "uncategorized";
      if (!categoryMap.has(category)) {
        categoryMap.set(category, []);
      }
      categoryMap.get(category)!.push(msg);
    }

    return Array.from(categoryMap.entries()).map(([category, msgs]) => {
      const sentiments = this.calculateSentimentDistribution(msgs);
      const total = sentiments.positive + sentiments.negative + sentiments.neutral;
      const overall = this.calculateOverallSentiment(
        msgs.map((m) => m.sentiment || "neutral")
      );

      // Time pattern
      const hourCounts = new Map<number, number>();
      const dayCounts = new Map<string, number>();
      const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

      for (const msg of msgs) {
        const date = new Date(msg.timestamp);
        const hour = date.getHours();
        const day = dayNames[date.getDay()];
        hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
        dayCounts.set(day, (dayCounts.get(day) || 0) + 1);
      }

      let peakHour = 0;
      let maxHour = 0;
      for (const [hour, count] of hourCounts.entries()) {
        if (count > maxHour) {
          maxHour = count;
          peakHour = hour;
        }
      }

      let peakDay = "monday";
      let maxDay = 0;
      for (const [day, count] of dayCounts.entries()) {
        if (count > maxDay) {
          maxDay = count;
          peakDay = day;
        }
      }

      // Sub-categories
      const subCategoryMap = new Map<string, number>();
      for (const msg of msgs) {
        if (msg.subCategory) {
          subCategoryMap.set(
            msg.subCategory,
            (subCategoryMap.get(msg.subCategory) || 0) + 1
          );
        }
      }

      return {
        category,
        messageCount: msgs.length,
        percentage: parseFloat(
          ((msgs.length / this.messages.length) * 100).toFixed(1)
        ),
        sentiment: {
          overall,
          distribution: sentiments,
        },
        timePattern: {
          peakHour,
          peakDay,
        },
        topKeywords: [], // 키워드 추출은 별도 구현 필요
        subCategories: Array.from(subCategoryMap.entries())
          .sort(([, a], [, b]) => b - a)
          .slice(0, 5)
          .map(([name, count]) => ({ name, count })),
        relatedCategories: [], // 상관관계 분석은 별도 구현 필요
      };
    });
  }

  /**
   * 감정 분포 계산
   */
  private calculateSentimentDistribution(messages: CategorizedMessage[]): {
    positive: number;
    negative: number;
    neutral: number;
  } {
    const dist = { positive: 0, negative: 0, neutral: 0 };
    for (const msg of messages) {
      const sentiment = msg.sentiment || "neutral";
      if (sentiment in dist) {
        dist[sentiment as keyof typeof dist]++;
      }
    }
    return dist;
  }

  /**
   * 카테고리 분포 계산
   */
  private calculateCategoryDistribution(
    messages: CategorizedMessage[]
  ): Record<string, number> {
    const dist: Record<string, number> = {};
    for (const msg of messages) {
      const category = msg.category || "uncategorized";
      dist[category] = (dist[category] || 0) + 1;
    }
    return dist;
  }

  /**
   * 전체 감정 계산
   */
  private calculateOverallSentiment(
    sentiments: string[]
  ): "positive" | "negative" | "mixed" | "neutral" {
    const counts = { positive: 0, negative: 0, neutral: 0 };
    for (const s of sentiments) {
      if (s in counts) {
        counts[s as keyof typeof counts]++;
      }
    }

    const total = counts.positive + counts.negative + counts.neutral;
    if (total === 0) return "neutral";

    const positiveRatio = counts.positive / total;
    const negativeRatio = counts.negative / total;

    if (positiveRatio > 0.6) return "positive";
    if (negativeRatio > 0.6) return "negative";
    if (positiveRatio > 0.3 && negativeRatio > 0.3) return "mixed";
    return "neutral";
  }
}
```

---

## 5. 구현 계획 (Implementation Plan)

### 5.1 작업 분해 (Task Breakdown)

| # | 작업 | 설명 | 예상 시간 |
|---|------|------|-----------|
| 1 | 타입 정의 | metadata.ts 인터페이스 정의 | 1시간 |
| 2 | MetadataBuilder 구현 | 기본 메타데이터 빌더 | 3시간 |
| 3 | Thread Breakdown | 스레드별 분석 구현 | 2시간 |
| 4 | Time Breakdown | 시간대별 분석 구현 | 2시간 |
| 5 | Category Analysis | 카테고리 심층 분석 | 3시간 |
| 6 | API 업데이트 | 라우트 및 파라미터 추가 | 2시간 |
| 7 | 파이프라인 통합 | 기존 파이프라인에 통합 | 2시간 |
| 8 | 테스트 작성 | Unit, Integration 테스트 | 3시간 |
| 9 | 문서화 | API 문서 업데이트 | 1시간 |

### 5.2 의존성 (Dependencies)

```
Task 1 (타입 정의)
    │
    ▼
Task 2 (MetadataBuilder 기본)
    │
    ├──► Task 3 (Thread Breakdown)
    │
    ├──► Task 4 (Time Breakdown)
    │
    └──► Task 5 (Category Analysis)

Task 3, 4, 5 완료 후
    │
    ▼
Task 6 (API 업데이트)
    │
    ▼
Task 7 (파이프라인 통합)
    │
    ▼
Task 8 (테스트)
    │
    ▼
Task 9 (문서화)
```

### 5.3 예상 일정 (Estimated Timeline)

**총 예상 시간:** 19시간

**일정 (4일 기준):**
- **Day 1:** Task 1, 2 (타입 정의, MetadataBuilder 기본) - 4시간
- **Day 2:** Task 3, 4 (Thread/Time Breakdown) - 4시간
- **Day 3:** Task 5, 6 (Category Analysis, API) - 5시간
- **Day 4:** Task 7, 8, 9 (통합, 테스트, 문서화) - 6시간

---

## 6. 테스트 전략 (Testing Strategy)

### 6.1 단위 테스트

```typescript
describe("MetadataBuilder", () => {
  describe("buildTimeBreakdown", () => {
    it("should correctly calculate hourly distribution", () => {
      const messages = createMockMessages([
        { timestamp: new Date("2026-01-26T10:00:00").getTime() },
        { timestamp: new Date("2026-01-26T10:30:00").getTime() },
        { timestamp: new Date("2026-01-26T14:00:00").getTime() },
      ]);

      const builder = new MetadataBuilder(messages, [], mockStats);
      const timeBreakdown = builder["buildTimeBreakdown"]();

      expect(timeBreakdown.hourly[10].messageCount).toBe(2);
      expect(timeBreakdown.hourly[14].messageCount).toBe(1);
      expect(timeBreakdown.peakPeriods.peakHour).toBe(10);
    });
  });

  describe("buildCategoryAnalysis", () => {
    it("should calculate sentiment distribution per category", () => {
      // ...
    });
  });
});
```

### 6.2 통합 테스트

```typescript
describe("Report with Enhanced Metadata", () => {
  it("should include detailed metadata when level=detailed", async () => {
    const res = await request(app)
      .get(`/api/reports/${jobId}?metadataLevel=detailed`);

    expect(res.body.report.metadata.threadBreakdown).toBeDefined();
    expect(res.body.report.metadata.timeBreakdown).toBeDefined();
    expect(res.body.report.metadata.categoryAnalysis).toBeUndefined();
  });

  it("should include full metadata when level=full", async () => {
    const res = await request(app)
      .get(`/api/reports/${jobId}?metadataLevel=full`);

    expect(res.body.report.metadata.categoryAnalysis).toBeDefined();
  });
});
```

### 6.3 테스트 시나리오

| 시나리오 | 검증 항목 |
|----------|-----------|
| **기본 레벨** | 확장 필드 미포함 |
| **상세 레벨** | Thread/Time/Agent breakdown 포함 |
| **전체 레벨** | Category analysis 추가 포함 |
| **대용량 데이터** | 성능 목표 달성 |
| **빈 데이터** | 에러 없이 처리 |

---

## 7. 위험 요소 및 완화 방안 (Risks & Mitigations)

| 위험 요소 | 영향도 | 발생 가능성 | 완화 방안 |
|----------|--------|------------|----------|
| **성능 저하** | 중간 | 중간 | Lazy loading, 캐싱 적용 |
| **메모리 사용 증가** | 중간 | 높음 | 스트리밍 처리, 청크 단위 계산 |
| **익명화 위반** | 높음 | 낮음 | 코드 리뷰, 자동 검증 |
| **하위 호환성 깨짐** | 중간 | 낮음 | 버전 관리, 점진적 적용 |

---

## 8. 참고 자료 (References)

### 내부 문서
- [00-overview.md](./00-overview.md) - 프로젝트 개요
- [01-json-api-structure.md](./01-json-api-structure.md) - JSON API 구조
- [99-future-decisions.md](./99-future-decisions.md) - Decision 10 원본

### 코드 참조
- [src/types/report.ts](../../src/types/report.ts)
- [src/utils/reportTransformer.ts](../../src/utils/reportTransformer.ts)
- [src/services/reportPipeline/analyzer.ts](../../src/services/reportPipeline/analyzer.ts)

---

## 변경 이력 (Change Log)

| 날짜 | 버전 | 변경 내용 | 작성자 |
|------|------|----------|--------|
| 2026-01-27 | 1.0 | 초안 작성 | Claude |

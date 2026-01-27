# Refactoring Plan: Enhanced Report Metadata (TRD 07)

## Overview

리포트 메타데이터 확장 기능을 구현합니다.
Time 기반의 상세 분석과 카테고리별 심층 분석을 제공합니다.

**핵심 변경**: TRD 12 (Embedding 기반 파이프라인) 이후 구현해야 합니다.
- 샘플링 제거로 전체 메시지 대상 분석 가능
- 고정 카테고리 기반으로 일관된 분석 가능

## Source Documents

- `docs/trd/07-enhanced-metadata.md` - 리포트 메타데이터 확장
- `docs/trd/12-embedding-clustering.md` - 의존성 (먼저 구현 필요)

## Dependencies

- **TRD 12 필수**: Embedding 기반 파이프라인 구현 후 진행
- 기존 Report Pipeline과 통합 필요

---

## 제거된 기능 (TRD 12 점검 후)

| 기능 | 제거 이유 |
|------|----------|
| **ThreadBreakdown** | threadId 익명화로 제거됨, TRD 12에서도 미포함 |
| **AgentBreakdown** | 유저 메시지 분석이라 agent breakdown은 개념적 오류 |
| **Performance Optimization** | TRD 12에서 전체 메시지 처리, lazy loading 불필요 |
| **Testing** | 프로젝트에 테스트 인프라 없음 |

---

## Tasks

### Phase 1: Types & Interfaces

- [ ] task1 - Create `src/types/metadata.ts` with MetadataLevel type ("basic" | "detailed" | "full")
- [ ] task2 - Define TimeBreakdown interface (hourly, daily, weekly distributions, peakPeriods)
- [ ] task3 - Define CategoryDeepAnalysis interface (sentiment, timePattern, subCategories)
- [ ] task4 - Define EnhancedReportMetadata interface extending existing ReportMetadata
- [ ] task5 - Define MetadataOptions interface (level, timezone)

### Phase 2: MetadataBuilder Implementation

- [ ] task6 - Create `src/services/reportPipeline/metadataBuilder.ts`
- [ ] task7 - Implement buildBaseMetadata() for basic level (existing metadata)
- [ ] task8 - Implement buildTimeBreakdown() for time-period analysis
- [ ] task9 - Implement buildCategoryAnalysis() for deep category analysis (detailed/full level)
- [ ] task10 - Add helper methods: calculateSentimentDistribution, calculateCategoryDistribution
- [ ] task11 - Add helper method: calculateOverallSentiment for aggregating sentiment

### Phase 3: Pipeline Integration

- [ ] task12 - Extend ReportRequestParams to include MetadataOptions
- [ ] task13 - Integrate MetadataBuilder into TRD 12 pipeline (after analyzer)
- [ ] task14 - Update generateReport() to use MetadataBuilder

### Phase 4: API Updates

- [ ] task15 - Add `metadata` parameter to POST /api/reports request body
- [ ] task16 - Add `metadataLevel` query parameter to GET /api/reports/:jobId
- [ ] task17 - Update response format to include enhanced metadata based on level
- [ ] task18 - Add validation for metadata options (level enum, timezone format)

---

## Build Verification

- [ ] Run TypeScript build check (`source ~/.nvm/nvm.sh && nvm use 22 && npx tsc --noEmit`)

---

## Implementation Order

### Recommended Sequence:

1. **Tasks 1-5**: Type definitions (foundation)
2. **Tasks 6-11**: MetadataBuilder implementation (core logic)
3. **Tasks 12-14**: Pipeline integration
4. **Tasks 15-18**: API updates

### Parallel Work Opportunities:

- Tasks 8, 9 (TimeBreakdown, CategoryAnalysis) can be developed in parallel

---

## 상세 설계

### TimeBreakdown Interface

```typescript
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
```

### CategoryDeepAnalysis Interface

```typescript
export interface CategoryDeepAnalysis {
  category: string;  // TRD 12 고정 카테고리: question, request, feedback, complaint, etc.
  messageCount: number;
  percentage: number;
  sentiment: {
    overall: "positive" | "negative" | "mixed" | "neutral";
    distribution: {
      positive: number;
      negative: number;
      neutral: number;
    };
  };
  timePattern: {
    peakHour: number;
    peakDay: string;
  };
  subCategories: Array<{
    name: string;
    count: number;
  }>;
}
```

### MetadataLevel 설명

| Level | 포함 내용 |
|-------|----------|
| **basic** | 기존 ReportMetadata (scope, filtering 등) |
| **detailed** | basic + TimeBreakdown |
| **full** | detailed + CategoryDeepAnalysis |

---

## Notes

### TRD 12와의 연동

1. **전체 메시지 접근**: TRD 12에서 샘플링 제거됨 → 정확한 통계 가능
2. **고정 카테고리**: question, request, feedback, complaint, information, greeting, other
3. **통합 시점**: ClusterAnalyzer 이후, Grounding 이전 또는 이후

### Timezone Handling

- Default to UTC for time breakdowns
- Support timezone option for localized analysis
- Use built-in Date APIs (no external library needed for basic support)

### API Examples

**Request with metadata options:**
```json
POST /api/reports
{
  "threadIds": ["thread-1"],
  "metadata": {
    "level": "detailed",
    "timezone": "Asia/Seoul"
  }
}
```

**Query with metadata level:**
```
GET /api/reports/:jobId?metadataLevel=full
```

---

## Estimated Timeline

| Phase | Tasks | Estimated Hours |
|-------|-------|-----------------|
| Types | 1-5 | 1h |
| MetadataBuilder | 6-11 | 4h |
| Pipeline Integration | 12-14 | 2h |
| API Updates | 15-18 | 2h |
| **Total** | | **9h (~1.5 days)** |

---

## 변경 이력

| 날짜 | 변경 내용 |
|------|----------|
| 2026-01-27 | 초안 작성 |
| 2026-01-27 | TRD 12 점검 후 수정: ThreadBreakdown, AgentBreakdown, Performance, Testing 제거 |

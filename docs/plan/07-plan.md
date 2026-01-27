# Refactoring Plan: Enhanced Report Metadata

## Overview

이 계획은 리포트 메타데이터 확장 기능(TRD 07)을 구현합니다.
Thread, Agent, Time 기반의 상세 분석과 카테고리별 심층 분석을 제공합니다.

## Source Documents

- `07-enhanced-metadata.md` - 리포트 메타데이터 확장

## Dependencies

- **독립적 구현 가능**: 다른 TRD에 의존하지 않음
- 기존 Report Pipeline과 통합 필요

---

## Tasks

### 1. Types & Interfaces

[ ] task1 - Create `src/types/metadata.ts` with MetadataLevel type ("basic" | "detailed" | "full")
[ ] task2 - Define ThreadBreakdown interface (messageCount, dateRange, primaryCategory, sentimentDistribution)
[ ] task3 - Define AgentBreakdown interface (agentName, messageCount, avgLength, threadCount, activityPattern)
[ ] task4 - Define TimeBreakdown interface (hourly, daily, weekly distributions, peakPeriods)
[ ] task5 - Define CategoryDeepAnalysis interface (sentiment, timePattern, topKeywords, subCategories)
[ ] task6 - Define EnhancedReportMetadata interface extending existing ReportMetadata
[ ] task7 - Define MetadataOptions interface (level, includeThreadIds, includeAgentUrls, timezone)

### 2. MetadataBuilder Implementation

[ ] task8 - Create `src/services/reportPipeline/metadataBuilder.ts` base class
[ ] task9 - Implement buildBaseMetadata() for basic level (existing metadata)
[ ] task10 - Implement buildThreadBreakdown() for thread-level analysis
[ ] task11 - Implement buildAgentBreakdown() for agent-level analysis
[ ] task12 - Implement buildTimeBreakdown() for time-period analysis
[ ] task13 - Implement buildCategoryAnalysis() for deep category analysis (full level only)
[ ] task14 - Add helper methods: calculateSentimentDistribution, calculateCategoryDistribution
[ ] task15 - Add helper method: calculateOverallSentiment for aggregating sentiment

### 3. Pipeline Integration

[ ] task16 - Extend ReportRequestParams to include MetadataOptions
[ ] task17 - Modify report pipeline to pass MetadataOptions to MetadataBuilder
[ ] task18 - Update generateReport() to use MetadataBuilder
[ ] task19 - Ensure CategorizedMessage includes necessary context for breakdown analysis
[ ] task20 - Add threadId tracking in parser if not already present

### 4. API Updates

[ ] task21 - Add `metadata` parameter to POST /api/reports request body
[ ] task22 - Add `metadataLevel` query parameter to GET /api/reports/:jobId
[ ] task23 - Update response format to include enhanced metadata based on level
[ ] task24 - Add validation for metadata options (level enum, timezone format)

### 5. Performance Optimization

[ ] task25 - Implement lazy loading for detailed/full metadata levels
[ ] task26 - Add caching for computed breakdown data
[ ] task27 - Ensure streaming/chunked computation for large message sets

### 6. Testing

[ ] task28 - Write unit tests for MetadataBuilder.buildThreadBreakdown()
[ ] task29 - Write unit tests for MetadataBuilder.buildTimeBreakdown()
[ ] task30 - Write unit tests for MetadataBuilder.buildCategoryAnalysis()
[ ] task31 - Write integration tests for API with different metadata levels
[ ] task32 - Write performance tests for large datasets (1000+ messages)

---

## Build Verification

[ ] Run TypeScript build check (`source ~/.nvm/nvm.sh && nvm use 22 && npx tsc --noEmit`)

---

## Implementation Order

### Recommended Sequence:

1. **Tasks 1-7**: Type definitions (foundation)
2. **Tasks 8-15**: MetadataBuilder implementation (core logic)
3. **Tasks 16-20**: Pipeline integration
4. **Tasks 21-24**: API updates
5. **Tasks 25-27**: Performance optimization
6. **Tasks 28-32**: Testing

### Parallel Work Opportunities:

- Tasks 10, 11, 12 (breakdown builders) can be developed in parallel
- Testing (tasks 28-32) can start as soon as MetadataBuilder is complete

---

## Notes

### Technical Considerations:

1. **Thread ID Availability**:
   - Current anonymization may hide threadId
   - MetadataBuilder should handle missing threadId gracefully
   - Option `includeThreadIds` controls exposure in API response

2. **Agent Information**:
   - Agent names are public info (can be included)
   - User IDs must never be exposed
   - AgentBreakdown may be limited by available data in CategorizedMessage

3. **Timezone Handling**:
   - Default to UTC for time breakdowns
   - Support timezone option for localized analysis
   - Use date-fns or similar for timezone conversion

4. **Performance Targets**:
   - Basic metadata: < 100ms
   - Detailed metadata: < 500ms
   - Full metadata: < 1000ms

### Data Requirements:

For full metadata functionality, ensure CategorizedMessage includes:
- `timestamp` (already present)
- `category`, `subCategory` (already present from categorizer)
- `sentiment` (already present)
- `threadId` or `context.threadId` (may need enhancement)
- `agentName`, `agentUrl` (may need enhancement from parser)

### API Examples:

**Request with metadata options:**
```json
POST /api/reports
{
  "threadIds": ["thread-1"],
  "metadata": {
    "level": "detailed",
    "includeThreadIds": true,
    "timezone": "Asia/Seoul"
  }
}
```

**Query with metadata level:**
```
GET /api/reports/:jobId?metadataLevel=full
```

### Memory Considerations:

- Large reports (10k+ messages) may consume significant memory during breakdown computation
- Consider streaming/iterator patterns for buildTimeBreakdown
- Limit topKeywords, subCategories arrays to prevent response bloat

---

## Estimated Timeline

| Phase | Tasks | Estimated Hours |
|-------|-------|-----------------|
| Types | 1-7 | 2h |
| MetadataBuilder | 8-15 | 6h |
| Pipeline Integration | 16-20 | 3h |
| API Updates | 21-24 | 2h |
| Performance | 25-27 | 3h |
| Testing | 28-32 | 4h |
| **Total** | | **20h (~3 days)** |

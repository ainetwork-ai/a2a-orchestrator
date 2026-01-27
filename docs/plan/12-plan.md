# Refactoring Plan: Embedding-based Clustering Pipeline (TRD 12)

## Overview

Embedding 기반 클러스터링 파이프라인으로 전환합니다.
Talk to the City 방식을 참고하여, 결정적이고 캐싱 가능한 클러스터링을 구현합니다.

**핵심 변경**:
- LLM 기반 Categorizer/Clusterer → Embedding + 알고리즘 기반
- 샘플링 제거 → 전체 메시지 분석
- 비결정적 토픽 → 결정적 클러스터링

## Source Documents

- `docs/trd/12-embedding-clustering.md` - Embedding 기반 클러스터링 파이프라인

## Dependencies

- **독립 구현**: 다른 TRD에 선행하여 구현
- TRD 05 (Grounding)와 통합 필요
- TRD 07, 08은 이 TRD 구현 후 진행

**Note**: 이 TRD가 완료되면 TRD 07, 08의 파이프라인 단계명이 업데이트됩니다.

---

## Tasks

### Phase 1: Dependencies & Setup

- [x] task1 - Install `umap-js` package (`npm install umap-js`)
- [x] task2 - Verify `openai` package is installed (already in dependencies)
- [x] task3 - Add `OPENAI_API_KEY` to `.env.example` with description
- [x] task4 - Create `src/types/embedding.ts` with EmbeddedMessage, EmbedderResult, EmbedFunction types
- [x] task5 - Add ClustererVisualization interface (points with x, y, clusterId)
- [x] task6 - Verify FilteringBreakdown exists in types/report.ts (already defined at line 220)

### Phase 2: Embedder Implementation

- [x] task7 - Create `src/services/reportPipeline/embedder.ts`
- [x] task8 - Implement hashContent() using SHA256 (16 chars)
- [x] task9 - Implement createOpenAIEmbedder() factory function
- [x] task10 - Implement embedMessages() with batch processing (100 per batch)
- [x] task11 - Add Redis caching for embeddings (mGet/pipeline for batch)
- [x] task12 - Add cache TTL: 30 days for embeddings
- [x] task13 - Add logging for cache hits/misses

### Phase 3: Categorizer Refactoring

- [x] task14 - Backup existing `categorizer.ts` (if reverting needed)
- [x] task15 - Define FIXED_CATEGORIES constant with keywords and descriptions
- [x] task16 - Define NON_SUBSTANTIVE_PATTERNS (greetings, chitchat, botQuestions)
- [x] task17 - Implement initializeCategoryEmbeddings() with Redis caching
- [x] task18 - Implement cosineSimilarity() utility function
- [x] task19 - Implement checkIsSubstantive() rule-based function
- [x] task20 - Implement detectSentiment() with negative keyword priority
- [x] task21 - Implement categorizeByEmbedding() main function
- [x] task22 - Export all functions for pipeline use

### Phase 4: Clusterer Refactoring

- [x] task23 - Backup existing `clusterer.ts` (if reverting needed)
- [x] task24 - Implement kMeans() algorithm (deterministic seeding)
- [x] task25 - Implement euclideanDistance() utility
- [x] task26 - Implement clusterByEmbedding() using UMAP + K-means
- [x] task27 - Add UMAP configuration (nComponents: 2, nNeighbors: 15)
- [x] task28 - Implement calculateClusterSentiment() for cluster-level sentiment
- [x] task29 - Implement createSingleCluster() for small datasets
- [x] task30 - Return visualization data (x, y coordinates, clusterId)

### Phase 5: ClusterAnalyzer Implementation

- [x] task31 - Create `src/services/reportPipeline/clusterAnalyzer.ts`
- [x] task32 - Implement analyzeCluster() single cluster analysis
- [x] task33 - Build contrastive prompt (inside/outside examples)
- [x] task34 - Extract topic label and description
- [x] task35 - Extract opinions array from LLM response
- [x] task36 - Extract summary (consensus, conflicting, sentiment)
- [x] task37 - Extract nextSteps (action, priority, rationale)
- [x] task38 - Implement analyzeClusters() for all clusters (parallel)
- [x] task39 - Add error handling with fallback responses
- [x] task40 - Add language support (ko/en)

### Phase 6: Pipeline Integration

- [x] task41 - Update `src/services/reportPipeline/index.ts`
- [x] task42 - Import new modules (embedder, categorizer, clusterer, clusterAnalyzer)
- [x] task43 - Initialize embedFn with createOpenAIEmbedder (check OPENAI_API_KEY)
- [x] task44 - Update STEPS array (8 steps → 10 steps)
- [x] task45 - Update `parser.ts`: remove maxMessages parameter handling
- [x] task46 - Add embedMessages step after parsing
- [x] task47 - Add initializeCategoryEmbeddings call before categorization
- [x] task48 - Replace categorizeMessages() with categorizeByEmbedding()
- [x] task49 - Filter substantive messages (reuse existing logic)
- [x] task50 - Replace clusterMessages() with clusterByEmbedding()
- [x] task51 - Add analyzeClusters step after clustering
- [x] task52 - Adapt calculateFilteringBreakdown() for embedding-based categorizer
- [x] task53 - Update analyzeData call signature if needed
- [x] task54 - Merge clusterer visualization with generateVisualizationData()

### Phase 7: Grounding Integration

- [x] task55 - Verify groundOpinions() accepts new MessageCluster structure
- [x] task56 - Update grounding.ts: remove any sampling logic (use all messages)
- [x] task57 - Verify opinion.supportingMessages populated correctly
- [x] task58 - Verify opinion.mentionCount accuracy with full message set

### Phase 8: Cleanup & Constants

- [ ] task59 - Remove/update `SAMPLE_SIZE_FOR_TOPICS` constant (types/report.ts:203)
- [ ] task60 - Remove/update `MAX_SAMPLE_MESSAGES_PER_CLUSTER` constant (types/report.ts:204)
- [ ] task61 - Remove `DEFAULT_MAX_MESSAGES` if no longer used (types/report.ts:194)
- [x] task62 - Rename old categorizer.ts → categorizer.legacy.ts (keep as fallback)
- [x] task63 - Rename old clusterer.ts → clusterer.legacy.ts (keep as fallback)
- [ ] task64 - Update ReportRequestParams: deprecate maxMessages field
- [ ] task65 - Add migration note to README or CHANGELOG

---

## Build Verification

- [x] Run TypeScript build check (`source ~/.nvm/nvm.sh && nvm use 22 && npx tsc --noEmit`)

---

## Implementation Order

### Recommended Sequence:

1. **Tasks 1-6**: Dependencies and setup (foundation)
2. **Tasks 7-13**: Embedder (core infrastructure)
3. **Tasks 14-22**: Categorizer refactoring
4. **Tasks 23-30**: Clusterer refactoring
5. **Tasks 31-40**: ClusterAnalyzer (new)
6. **Tasks 41-54**: Pipeline integration
7. **Tasks 55-58**: Grounding integration
8. **Tasks 59-65**: Cleanup

### Critical Path:

```
Setup (1-6) -> Embedder (7-13) -> Categorizer (14-22) -> Clusterer (23-30) -> ClusterAnalyzer (31-40) -> Pipeline (41-54)
```

### Parallel Work Opportunities:

- Tasks 14-22 (Categorizer) and 23-30 (Clusterer) can be developed in parallel after Embedder
- Tasks 55-58 (Grounding) and 59-65 (Cleanup) can be done in parallel after pipeline integration

---

## New Pipeline Steps (10 steps)

```typescript
const PIPELINE_STEPS = [
  "Parsing messages",           // 1
  "Generating embeddings",      // 2 - NEW
  "Categorizing",               // 3 - Changed (embedding-based)
  "Clustering",                 // 4 - Changed (UMAP + K-means)
  "Analyzing clusters",         // 5 - NEW (label + opinions + summary)
  "Grounding opinions",         // 6
  "Calculating statistics",     // 7
  "Synthesizing insights",      // 8
  "Generating visualization",   // 9
  "Rendering report",           // 10
];
```

---

## Key Code Patterns

### Embedder Dependency Injection

```typescript
export type EmbedFunction = (texts: string[]) => Promise<number[][]>;

export function createOpenAIEmbedder(apiKey: string): EmbedFunction {
  return async (texts: string[]): Promise<number[][]> => {
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey });
    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: texts,
    });
    return response.data.map(d => d.embedding);
  };
}
```

### isSubstantive Pattern Matching

```typescript
const NON_SUBSTANTIVE_PATTERNS = {
  greetings: /^(hi|hello|hey|안녕|하이|헬로)[\s!.?]*$/i,
  chitchat: /^(ok|okay|yes|no|thanks|ㅇㅇ|ㅋ+|ㅎ+)[\s!.?]*$/i,
  botQuestions: /^(who are you|what are you|누구|뭐야)[\s?]*$/i,
};
```

### Negative Sentiment Priority

```typescript
// "좋아요 버튼이 안 눌려요" → negative (not positive)
if (hasNegativeContext) return "negative";
if (hasPositiveContext) return "positive";
return "neutral";
```

---

## Notes

### Cost Comparison (5000 messages)

| Component | Before | After |
|-----------|--------|-------|
| Categorizer | 100 LLM calls | 0 (embedding similarity) |
| Clusterer | 20 LLM calls | 0 (UMAP + K-means) |
| ClusterAnalyzer | - | ~10 LLM calls (1 per cluster) |
| Grounding | 10 LLM calls | 10 LLM calls |
| Synthesizer | 1 LLM call | 1 LLM call |
| **Total** | **~131 LLM calls** | **~21 LLM calls** |
| **Embedding Cost** | $0 | ~$0.10 |
| **Message Coverage** | 20% (1000/5000) | 100% |

### Caching Benefits

- First report: Full embedding generation
- Second report (same data + new): Only embed new messages
- Third report (same data, different params): 100% cache hit

### Backward Compatibility

- Category names unchanged (question, request, feedback, etc.)
- ReportJob structure unchanged
- MessageCluster structure unchanged
- API response format unchanged

---

## Estimated Timeline

| Phase | Tasks | Count | Estimated Hours |
|-------|-------|-------|-----------------|
| Dependencies & Setup | 1-6 | 6 | 1h |
| Embedder | 7-13 | 7 | 3h |
| Categorizer | 14-22 | 9 | 3h |
| Clusterer | 23-30 | 8 | 4h |
| ClusterAnalyzer | 31-40 | 10 | 3h |
| Pipeline Integration | 41-54 | 14 | 4h |
| Grounding Integration | 55-58 | 4 | 2h |
| Cleanup | 59-65 | 7 | 1h |
| **Total** | | **65** | **21h (~3 days)** |

---

## Risk Mitigations

| Risk | Mitigation |
|------|------------|
| K-means less accurate than HDBSCAN | Tune cluster count, consider HDBSCAN.js later |
| isSubstantive false positives | Keep LLM-based fallback, monitor and adjust patterns |
| OpenAI embedding API failure | Fallback to keyword-based categorization |
| Memory issues with large datasets | Batch processing, streaming |

---

## Existing Code Reference

### Files to Modify

| File | Changes |
|------|---------|
| `src/services/reportPipeline/index.ts` | Replace pipeline, update STEPS |
| `src/services/reportPipeline/parser.ts` | Remove maxMessages handling |
| `src/types/report.ts` | Deprecate sampling constants |

### Files to Create

| File | Purpose |
|------|---------|
| `src/types/embedding.ts` | Embedding types |
| `src/services/reportPipeline/embedder.ts` | Embedding generation |
| `src/services/reportPipeline/clusterAnalyzer.ts` | Cluster labeling + opinions |

### Files to Replace (Keep as Fallback)

| Current | Backup | Replacement |
|---------|--------|-------------|
| `categorizer.ts` | `categorizer.legacy.ts` | New embedding-based categorizer |
| `clusterer.ts` | `clusterer.legacy.ts` | New UMAP + K-means clusterer |

### Constants Currently Defined (types/report.ts)

```typescript
// 현재 정의됨 - 검토 필요
export const DEFAULT_MAX_MESSAGES = 1000;        // line 194
export const SAMPLE_SIZE_FOR_TOPICS = 50;        // line 203
export const MAX_SAMPLE_MESSAGES_PER_CLUSTER = 30; // line 204
```

---

## Change Log

| Date | Change |
|------|--------|
| 2026-01-27 | Initial plan created based on TRD 12 |
| 2026-01-27 | 점검 후 수정: 기존 코드 참조 추가, 태스크 구체화 (62 → 65 tasks) |
| 2026-01-27 | 구현 완료: Phase 1-7 전체 완료 (58/65 tasks), Phase 8 일부 완료 (62-63) |

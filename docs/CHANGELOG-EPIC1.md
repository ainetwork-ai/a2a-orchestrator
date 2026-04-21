# EPIC1 변경점 요약: Conversation-Aware Opinion Extraction

## Before → After

### 파이프라인 흐름

**Before (Legacy — 12단계)**
```
parseThreads → embedMessages → categorizeByEmbedding → clusterByEmbedding
→ subtopicCluster → analyzeClusters → groundOpinions → analyzeData
→ synthesizeReport → generateVisualization → generateDotGrid → renderMarkdown
```

**After (Conversation — 12단계)**
```
parseConversations → extractOpinions → embedMessages → clusterByEmbedding
→ subtopicCluster → analyzeClusters → groundOpinions → analyzeData
→ synthesizeReport → generateVisualization → generateDotGrid → renderMarkdown
```

- `parseThreads` → `parseConversations` (유저+에이전트 메시지 보존, 세그먼트 분리)
- `categorizeByEmbedding` → `extractOpinions` (LLM 기반 의견 추출이 카테고라이저 대체)
- Step 4 이후는 `runSharedPipeline()`으로 공유

### 입력 단위 변경

| | Legacy | Conversation |
|---|---|---|
| 입력 | 유저 메시지 (ParsedMessage) | 대화 세그먼트 (ConversationSegment) |
| 분석 대상 | 원본 메시지 텍스트 | LLM 추출 의견 (ExtractedOpinion.statement) |
| 카테고리 | 임베딩 유사도 기반 | stance 직접 매핑 |
| 감성 | 임베딩 유사도 기반 | stance → sentiment 매핑 |

### 파이프라인 전환

`POST /api/reports` body에 `pipelineMode: "conversation"` 추가 시 새 파이프라인 사용.
기본값은 `"legacy"` (기존 동작 유지).

---

## 신규 파일

| 파일 | 역할 |
|------|------|
| `src/services/reportPipeline/conversationParser.ts` | 대화 세그먼트 파서 |
| `src/services/reportPipeline/opinionExtractor.ts` | LLM 의견 추출기 |
| `src/services/reportPipeline/pipelineUtils.ts` | 공유 유틸 (anonymize, truncate, filterThreads, adapters) |

## 수정 파일

| 파일 | 변경 요약 |
|------|----------|
| `src/services/reportPipeline/index.ts` | 파이프라인 분기 (legacy/conversation), `runSharedPipeline` 추출 |
| `src/services/reportPipeline/analyzer.ts` | `deliberation` 파라미터 추가 |
| `src/routes/reports.ts` | `pipelineMode` body에서 수신 및 params에 전달 |
| `src/utils/reportTransformer.ts` | `extractedOpinions`, `conversationSegments` T3CReport에 패스스루 |
| `src/types/report.ts` | 신규 타입 + 기존 타입 확장 (Report, T3CReport, Opinion, ReportStatistics, ReportRequestParams) |

---

## 타입 변경

### 신규 타입

```typescript
interface SegmentMessage {
  id: string;
  speaker: string;        // "User" | agent name
  content: string;
  timestamp: number;
  isUser: boolean;
}

interface ConversationSegment {
  id: string;
  threadId: string;
  messages: SegmentMessage[];
  startTimestamp: number;
  endTimestamp: number;
}

interface OpinionSource {
  segmentId: string;
  keyMessageIds: string[];
}

interface ExtractedOpinion {
  id: string;
  statement: string;
  stance: "support" | "oppose" | "neutral" | "request" | "question";
  confidence: number;       // 0.0~1.0
  evolved: boolean;
  source: OpinionSource;
  timestamp: number;
  threadId: string;
}
```

### 확장된 타입

```typescript
// Report — 신규 optional 필드
interface Report {
  // ... 기존 필드 그대로 ...
  extractedOpinions?: ExtractedOpinion[];
  conversationSegments?: ConversationSegment[];
}

// ReportRequestParams — 신규 optional 필드
interface ReportRequestParams {
  // ... 기존 필드 그대로 ...
  pipelineMode?: "legacy" | "conversation";
}

// ReportStatistics — 신규 optional 필드
interface ReportStatistics {
  // ... 기존 필드 그대로 ...
  deliberation?: {
    totalOpinions: number;
    evolvedCount: number;
  };
}

// Opinion — 신규 optional 필드
interface Opinion {
  // ... 기존 필드 그대로 ...
  sourceSegmentIds?: string[];
}

// T3CReport — 신규 optional 필드 (API 응답용)
interface T3CReport {
  // ... 기존 필드 그대로 ...
  extractedOpinions?: ExtractedOpinion[];
  conversationSegments?: ConversationSegment[];
}
```

---

## API Response 변경

### `POST /api/reports`

요청 body에 `pipelineMode` 추가 가능:
```json
{
  "threadIds": ["..."],
  "pipelineMode": "conversation",
  "language": "ko"
}
```

### `GET /api/reports/:jobId`

conversation 파이프라인으로 생성된 리포트에 추가 필드:

```typescript
{
  // 기존 필드 전부 동일
  report: {
    // ... 기존 ...
    extractedOpinions: ExtractedOpinion[],      // 신규
    conversationSegments: ConversationSegment[], // 신규
    statistics: {
      // ... 기존 ...
      deliberation: {                            // 신규
        totalOpinions: number,
        evolvedCount: number
      }
    }
  }
}
```

legacy 파이프라인으로 생성된 리포트에는 이 필드들이 없음 (undefined).

### `GET /api/reports/:jobId/statistics`

`deliberation` 필드가 conversation 파이프라인 리포트에만 포함됨.

### `GET /api/reports/:jobId/topics`

각 topic의 `opinions`에 `sourceSegmentIds` 필드가 conversation 파이프라인 리포트에만 포함됨.

---

## 하위 호환

- 모든 신규 필드는 **optional** → 기존 프론트엔드 코드 변경 없이 동작
- `pipelineMode` 미지정 시 기본값 `"legacy"` → 기존 동작 완전 보존
- `categoryDistribution`에 stance 값이 채워짐 (conversation 파이프라인) → 기존 차트 렌더링 호환

## 프론트엔드 활용 예시

```typescript
// 의견 → 원본 대화 연결
const opinion = report.extractedOpinions?.find(op => op.id === targetId);
if (opinion) {
  const segment = report.conversationSegments?.find(
    s => s.id === opinion.source.segmentId
  );
  // segment.messages로 원본 대화 흐름 표시
}

// 클러스터 의견 → 원본 대화 세그먼트
const clusterOpinion = topic.opinions[0];
if (clusterOpinion.sourceSegmentIds) {
  const segments = clusterOpinion.sourceSegmentIds
    .map(id => report.conversationSegments?.find(s => s.id === id))
    .filter(Boolean);
  // segments로 관련 대화 목록 표시
}

// 숙의 통계
if (report.statistics.deliberation) {
  const { totalOpinions, evolvedCount } = report.statistics.deliberation;
  const evolvedRate = totalOpinions > 0 ? evolvedCount / totalOpinions : 0;
  // evolvedRate 표시
}
```

# AINSPACE Report Pipeline 분석 문서

> a2a-orchestrator 프로젝트의 리포트 생성 구조 분석 (2026-04-06)

---

## 1. 개요: T3C와의 관계

이 프로젝트는 T3C(Talk to the City)의 "시민 의견 구조화" 철학을 차용하되, **기준 데이터가 CSV 코멘트가 아닌 "AI Agent와 인간의 대화(thread)"** 라는 점에서 근본적으로 다르다.

### 1.1 핵심 차이점

| 구분 | T3C (tttc-light-js) | AINSPACE (a2a-orchestrator) |
|------|---------------------|---------------------------|
| **입력 데이터** | CSV 코멘트 (1인 1코멘트) | AI Agent-사용자 대화 스레드 |
| **최소 단위** | 코멘트 (comment) | 대화 세그먼트 (ConversationSegment) |
| **의견 추출** | LLM이 코멘트에서 직접 추출 | 대화 맥락(agent 응답 포함) 기반 LLM 추출 |
| **클러스터링** | UMAP + HDBSCAN + GPT-4 | UMAP + K-means (임베딩 기반, LLM 불필요) |
| **스토리지** | Firestore + GCS | 인메모리 + Redis 캐시 |
| **아키텍처** | 분산 (Pub/Sub 큐 + Worker) | 단일 프로세스 (동기 파이프라인) |
| **인증/권한** | Firebase Auth + 소유자/공개 | 없음 (내부 서비스) |
| **언어 지원** | 다국어 (outputLanguage) | 한국어/영어 (ko/en) |

### 1.2 대화 기반의 특수성

- **Agent 메시지는 맥락(context)** 으로만 사용: 사용자 의견 해석의 단서로 활용하되, 분석 대상이 아님
- **의견 진화(evolved)** 추적: 대화 과정에서 사용자의 의견이 변화했는지를 감지
- **stance 분류**: T3C의 단순 sentiment와 달리 `support | oppose | neutral | request | question` 5가지 입장
- **세그먼트 분할**: 시간 간격(5분), 에이전트 변경, 최대 메시지 수(20)로 대화를 의미 단위로 분할
- **익명화**: 사용자 메시지는 PII 제거, 에이전트 메시지는 원본 유지

---

## 2. 리포트 데이터 모델

### 2.1 Report 최상위 구조

**파일**: `src/types/report.ts` (line 107~120)

```typescript
Report = {
  id: string                              // UUID
  title: string
  createdAt: number                       // timestamp
  statistics: ReportStatistics
  clusters: MessageClusterWithSubtopics[] // 토픽 클러스터 (서브토픽 포함)
  synthesis?: ReportSynthesis             // 종합 인사이트
  visualization?: VisualizationData       // 스캐터 플롯, 토픽 트리, 차트
  dotGrid?: DotGridVisualization          // T3C 스타일 점 그리드
  markdown: string                        // 렌더링된 마크다운 리포트
  // EPIC1: 대화 파이프라인 전용
  extractedOpinions?: ExtractedOpinion[]
  conversationSegments?: ConversationSegment[]
}
```

### 2.2 T3CReport (API 응답용 변환 포맷)

**파일**: `src/types/report.ts` (line 487~502)

```typescript
T3CReport = {
  id: string
  title: string
  createdAt: number
  version: string
  metadata: ReportMetadata           // 처리 정보, 스코프, 필터링 통계
  statistics: ReportStatistics
  synthesis?: ReportSynthesis
  topics: Topic[]                    // T3C 스타일 토픽 배열
  visualization: VisualizationData
  extractedOpinions?: ExtractedOpinion[]
  conversationSegments?: ConversationSegment[]
  dotGrid?: DotGridVisualization
  markdown?: string
}
```

내부 `Report` → API 응답 시 `transformToT3CFormat()`으로 변환하여 `T3CReport` 형태로 제공.

### 2.3 계층 구조

```
Report
├── clusters: MessageClusterWithSubtopics[]
│   ├── id, topic, description
│   ├── messages: CategorizedMessage[]       ← 실질적 메시지
│   │   ├── id, threadId, content, timestamp
│   │   ├── category, subCategory, intent
│   │   ├── sentiment: "positive" | "negative" | "neutral"
│   │   └── isSubstantive: boolean
│   ├── opinions: Opinion[]                  ← 근거 기반 의견
│   │   ├── id, text
│   │   ├── type: "consensus" | "conflicting" | "general"
│   │   ├── supportingMessages: string[]     ← 뒷받침 메시지 ID
│   │   ├── mentionCount: number
│   │   ├── representativeQuote?: string     ← 대표 인용
│   │   ├── confidence?: number              ← 0~1
│   │   └── sourceSegmentIds?: string[]      ← EPIC1: 원본 세그먼트 추적
│   ├── summary: ClusterSummary
│   │   ├── consensus: string[]
│   │   ├── conflicting: string[]
│   │   └── sentiment
│   ├── nextSteps: ActionItem[]
│   │   ├── action, priority ("high"|"medium"|"low"), rationale
│   ├── subtopics: Subtopic[]                ← TRD 13
│   │   ├── id, index, label
│   │   ├── messageIds: string[]
│   │   ├── messageCount, uniqueUserCount
│   │   └── centroid?: { x, y }              ← UMAP 공간 좌표
│   └── uniqueUserCount: number
├── statistics: ReportStatistics
│   ├── totalMessages, totalThreads
│   ├── dateRange: { start, end }
│   ├── categoryDistribution, sentimentDistribution
│   ├── topTopics: { topic, count, percentage }[]
│   ├── nonSubstantiveCount                  ← 필터된 비실질 메시지 수
│   ├── filteringBreakdown?: { greetings, chitchat, shortMessages, other }
│   └── deliberation?: { totalOpinions, evolvedCount }  ← EPIC1
├── synthesis: ReportSynthesis
│   ├── overallSentiment
│   ├── keyFindings: string[]                ← 3~5개 핵심 발견
│   ├── topPriorities: ActionItem[]          ← 최우선 액션 아이템
│   └── executiveSummary: string             ← 경영진 요약 (2~3문장)
├── visualization: VisualizationData
│   ├── scatterPlot: { points, axes }
│   ├── topicTree: { nodes, links }
│   └── charts: { sentiment?, categories?, topics?, timeline? }
└── dotGrid: DotGridVisualization
```

---

## 3. 파이프라인 구조

### 3.1 듀얼 파이프라인

프로젝트는 **두 가지 파이프라인**을 지원하며, `pipelineMode` 파라미터로 선택한다:

**파일**: `src/services/reportPipeline/index.ts`

#### Legacy 파이프라인 (`pipelineMode: "legacy"`)

개별 메시지를 직접 임베딩 → 카테고리화 → 클러스터링하는 방식.

```
1. Parse threads         → ParsedMessage[]
2. Generate embeddings   → EmbeddedMessage[]         (OpenAI/Azure)
3. Categorize            → CategorizedEmbeddedMessage[] (임베딩 유사도, LLM 불필요)
4. Cluster               → MessageCluster[]          (UMAP + K-means, LLM 불필요)
5. Subtopic clustering   → MessageClusterWithSubtopics[]
6. Analyze clusters      → labels, opinions, summaries (LLM)
7. Ground opinions       → supportingMessages 연결    (LLM)
8. Calculate statistics  → ReportStatistics
9. Synthesize insights   → ReportSynthesis            (LLM)
10. Generate visualization → VisualizationData
11. Generate dot grid    → DotGridVisualization
12. Render report        → markdown
```

#### Conversation 파이프라인 (`pipelineMode: "conversation"`, EPIC1)

대화 맥락을 보존하며 의견을 추출하는 방식. **Agent 응답을 맥락으로 활용**.

```
1. Parse conversations   → ConversationSegment[]     ← 대화를 세그먼트로 분할
2. Extract opinions      → ExtractedOpinion[]        ← LLM으로 의견 추출 (agent 응답 = 맥락)
3. Generate embeddings   → EmbeddedMessage[]         ← 의견 문장을 임베딩
   ↓ (opinions → ParsedMessage 변환 후 공통 파이프라인)
4~12. (Legacy와 동일: Clustering → Rendering)
```

### 3.2 공통 파이프라인 상세 (Step 4~12)

두 파이프라인 모두 `runSharedPipeline()` 함수를 공유:

| 단계 | 파일 | LLM 사용 | 설명 |
|------|------|----------|------|
| **Clustering** | `clusterer.ts` | X | UMAP (1536D→2D) + K-means, 기본 8클러스터 |
| **Subtopic Clustering** | `subtopicClusterer.ts` | X | 토픽 내 서브토픽 K-means 분할, uniqueUser 집계 |
| **Analyze Clusters** | `clusterAnalyzer.ts` | O | contrastive prompting으로 토픽 라벨, 의견, 요약, 액션 생성 |
| **Ground Opinions** | `grounding.ts` | O | 의견 ↔ 뒷받침 메시지 매핑, representativeQuote 선정 |
| **Calculate Statistics** | `analyzer.ts` | X | 통계 집계 (감성, 카테고리, 토픽 분포 등) |
| **Synthesize** | `synthesizer.ts` | O | 전체 클러스터 종합 → 핵심 발견, 우선순위, 경영진 요약 |
| **Visualization** | `visualizer.ts` | X | 스캐터 플롯, 토픽 트리, 차트 데이터 생성 |
| **Dot Grid** | `dotGridGenerator.ts` | X | T3C 스타일 점 그리드 (UMAP 좌표 기반) |
| **Render** | `renderer.ts` | X | 마크다운 리포트 생성 (ko/en 다국어) |

### 3.3 Conversation 파이프라인 핵심: 세그먼트 분할

**파일**: `src/services/reportPipeline/conversationParser.ts`

대화 스레드를 의미 있는 단위로 분할하는 규칙:

| 분할 조건 | 값 | 설명 |
|-----------|-----|------|
| 시간 간격 | 5분 (`SEGMENT_TIME_GAP_MS`) | 5분 이상 침묵 시 새 세그먼트 |
| 에이전트 변경 | - | 다른 AI 에이전트가 응답하면 새 세그먼트 |
| 최대 메시지 수 | 20 (`MAX_SEGMENT_MESSAGES`) | 한 세그먼트당 최대 20개 메시지 |
| 최소 조건 | 사용자 메시지 1개 이상 | 사용자 발화가 없는 세그먼트는 버림 |

```typescript
ConversationSegment = {
  id: string               // UUID
  threadId: string          // 원본 스레드 ID
  messages: SegmentMessage[] // user + agent 메시지 순서 보존
  startTimestamp: number
  endTimestamp: number
}

SegmentMessage = {
  id: string
  speaker: string           // "User" | agent name
  content: string           // 사용자: 익명화됨, 에이전트: 원본
  timestamp: number
  isUser: boolean
}
```

### 3.4 Conversation 파이프라인 핵심: 의견 추출

**파일**: `src/services/reportPipeline/opinionExtractor.ts`

각 세그먼트에서 LLM이 구조화된 의견을 추출:

```typescript
ExtractedOpinion = {
  id: string
  statement: string          // 자기완결적 의견 문장
  stance: "support" | "oppose" | "neutral" | "request" | "question"
  confidence: number         // 0.0~1.0 (의견의 확신도)
  evolved: boolean           // 대화 중 의견이 변화했는지
  source: {
    segmentId: string        // 원본 세그먼트 추적
    keyMessageIds: string[]  // 근거 메시지 ID
  }
  timestamp: number
  threadId: string
}
```

**특징**:
- Agent 메시지는 **맥락으로만** 활용 (사용자 의견 해석의 단서)
- `evolved: true`인 의견은 대화 과정에서 사용자가 입장을 바꾼 경우
- 모든 세그먼트를 `Promise.all`로 병렬 처리

---

## 4. API 엔드포인트

### 4.1 리포트 생성

**파일**: `src/routes/reports.ts`

```
POST /api/reports
Body: {
  threadIds?: string[]       // 분석할 스레드 (미지정 시 전체)
  agentUrls?: string[]       // 에이전트 URL 필터
  agentNames?: string[]      // 에이전트 이름 필터
  startDate?: string         // ISO 날짜
  endDate?: string
  timezone?: string          // IANA (e.g., "Asia/Seoul")
  language?: "ko" | "en"
  title?: string
  description?: string
  tags?: string[]
  pipelineMode?: "legacy" | "conversation"  // EPIC1
}
Response: {
  success: true
  jobId: string              // 폴링용 Job ID
  status: "pending" | "processing" | "completed" | "failed"
  progress?: ReportJobProgress
  report?: Report            // 캐시 히트 시 즉시 반환
}
```

### 4.2 리포트 조회

```
GET /api/reports/:jobId
Query: format = "json" | "markdown" | "full"
       includeMessages = "true" | "false"

Response (completed):
  format=json     → T3CReport (메시지 포함/제외 선택)
  format=markdown → markdown 텍스트만
  format=full     → T3CReport + markdown
```

### 4.3 부분 데이터 엔드포인트

| 엔드포인트 | 반환 데이터 |
|-----------|------------|
| `GET /api/reports/:jobId/topics` | 토픽 요약 목록만 |
| `GET /api/reports/:jobId/visualization` | 시각화 데이터만 |
| `GET /api/reports/:jobId/statistics` | 통계 + 종합 인사이트만 |
| `GET /api/reports/:jobId/markdown` | 마크다운 원문 (text/markdown) |

### 4.4 리포트 관리

```
GET    /api/reports              # 목록 (페이지네이션, 필터, 검색)
PATCH  /api/reports/:jobId       # 메타데이터 수정 (title, description, tags)
DELETE /api/reports/:jobId       # 삭제
DELETE /api/reports/cache        # 캐시 무효화
```

---

## 5. 인프라 & 스토리지

### 5.1 아키텍처

T3C와 달리 **외부 저장소(Firestore, GCS)를 사용하지 않는** 단일 프로세스 구조:

```
[Client] → POST /api/reports → [Express Server]
                                    │
                                    ├─ ReportService (인메모리 Job 관리)
                                    │   └─ Redis 캐시 (TTL 1시간)
                                    │
                                    └─ Pipeline (동기 실행)
                                        ├─ ThreadManager (인메모리 대화 데이터)
                                        ├─ OpenAI / Azure OpenAI (임베딩)
                                        ├─ RequestManager (LLM 호출)
                                        └─ Redis (임베딩 캐시)
```

### 5.2 임베딩

**파일**: `src/services/reportPipeline/embedder.ts`

- **Azure OpenAI** 우선, fallback으로 **OpenAI** 사용
- Redis에 임베딩 캐시 (content hash 기반)
- Singleton 패턴 (요청 간 재사용)

### 5.3 Job 관리

**파일**: `src/types/report.ts` (line 132~148)

```typescript
ReportJob = {
  id: string
  status: "pending" | "processing" | "completed" | "failed"
  progress?: { step, totalSteps, currentStep, percentage }
  report?: Report
  error?: string
  createdAt: number
  updatedAt: number
  cachedAt?: number
  params: ReportRequestParams   // 캐시 키로 사용
  title?: string
  description?: string
  tags?: string[]
}
```

- 폴링 방식 (`GET /api/reports/:jobId`)으로 진행 상태 확인
- `progress.percentage`로 UI 프로그레스 바 표현 가능

---

## 6. T3C 대비 설계 차별점 요약

### 6.1 대화 맥락 보존

T3C는 독립적인 코멘트를 분석하지만, 이 프로젝트는 **대화의 흐름(Agent 질문 → 사용자 응답 → Agent 반응)을 보존**한다. 이는 의견 추출의 정확도를 높인다:

- Agent가 "그 기능에 대해 어떻게 생각하세요?"라고 물었을 때의 맥락
- 사용자가 대화 중 의견을 바꾼 경우(`evolved: true`)
- 여러 에이전트와의 대화를 에이전트별로 필터링 가능

### 6.2 임베딩 기반 클러스터링 (LLM 비용 절감)

T3C는 클러스터링에 GPT-4를 사용하지만, 이 프로젝트는:

- **임베딩 생성**(OpenAI text-embedding) → **UMAP 차원 축소** → **K-means 클러스터링**
- 카테고리화도 임베딩 유사도 기반 (LLM 호출 없음)
- LLM은 분석(라벨링, 의견 추출, 요약, 근거 연결)에만 사용

### 6.3 Grounding (근거 기반 분석)

T3C의 `Claim > Quote > Reference` 구조를 모방하되, 이 프로젝트만의 방식:

```
Opinion
├── supportingMessages: string[]   ← 뒷받침하는 메시지 ID 목록
├── mentionCount                   ← 지지하는 메시지 수
├── representativeQuote            ← 가장 대표적인 인용
├── confidence                     ← LLM이 판단한 신뢰도
└── sourceSegmentIds               ← EPIC1: 원본 대화 세그먼트까지 추적
```

### 6.4 필터링 투명성

비실질적 메시지(인사, 잡담, 짧은 메시지)를 필터링하되, **왜 필터했는지** 상세 breakdown 제공:

```typescript
FilteringBreakdown = {
  greetings: number      // "안녕하세요", "Hi" 등
  chitchat: number       // "네", "감사합니다" 등
  shortMessages: number  // 3자 미만
  other: number
}
```

---

## 7. 핵심 파일 맵

| 영역 | 파일 경로 |
|------|-----------|
| **Report 타입 정의** | `src/types/report.ts` |
| **시각화 타입** | `src/types/visualization.ts` |
| **임베딩 타입** | `src/types/embedding.ts` |
| **파이프라인 오케스트레이터** | `src/services/reportPipeline/index.ts` |
| **대화 파서** | `src/services/reportPipeline/conversationParser.ts` |
| **의견 추출기** | `src/services/reportPipeline/opinionExtractor.ts` |
| **임베더** | `src/services/reportPipeline/embedder.ts` |
| **카테고라이저** | `src/services/reportPipeline/categorizer.ts` |
| **클러스터러** | `src/services/reportPipeline/clusterer.ts` |
| **서브토픽 클러스터러** | `src/services/reportPipeline/subtopicClusterer.ts` |
| **클러스터 분석기** | `src/services/reportPipeline/clusterAnalyzer.ts` |
| **근거 연결** | `src/services/reportPipeline/grounding.ts` |
| **통계 분석기** | `src/services/reportPipeline/analyzer.ts` |
| **종합 분석기** | `src/services/reportPipeline/synthesizer.ts` |
| **시각화 생성기** | `src/services/reportPipeline/visualizer.ts` |
| **점 그리드 생성기** | `src/services/reportPipeline/dotGridGenerator.ts` |
| **마크다운 렌더러** | `src/services/reportPipeline/renderer.ts` |
| **유틸리티** | `src/services/reportPipeline/pipelineUtils.ts` |
| **레거시 카테고라이저** | `src/services/reportPipeline/categorizer.legacy.ts` |
| **레거시 클러스터러** | `src/services/reportPipeline/clusterer.legacy.ts` |
| **API 라우트** | `src/routes/reports.ts` |
| **T3C 변환기** | `src/utils/reportTransformer.ts` |
| **리포트 검증기** | `src/utils/reportValidator.ts` |

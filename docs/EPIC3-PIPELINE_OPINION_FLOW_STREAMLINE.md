# EPIC3 - Pipeline Opinion Flow Streamline (파이프라인 의견 흐름 정리)

> 의견 추출 → 클러스터링 → 요약 과정에서 ExtractedOpinion이 버려지고 새 Opinion이 재생성되는 이중 작업을 제거하여, T3C와 동일하게 "추출 = grounding" 패턴으로 정리한다.

## 의존성
- EPIC2 (Report Pipeline Simplification) — 시각화/마크다운/레거시 제거 완료 전제

## 목표
- analyzeClusters의 Opinion 재생성을 제거하고 ExtractedOpinion을 직접 활용한다
- groundOpinions 단계를 완전히 제거한다 (ExtractedOpinion.source가 이미 grounding)
- subtopicClusterer를 제거한다 (EPIC2에서 dotGrid/시각화 소비처 제거 완료)
- toCategorizedEmbedded 어댑터를 제거하고 클러스터러 입력을 단순화한다
- 파이프라인을 9단계에서 6단계로 줄이고 LLM 호출을 4회에서 3회로 줄인다
- 출력 타입을 T3C와 최대한 맞춘다 (clusters→topics, opinions→claims, Quote/Reference/Source 도입)
- 변경된 API 응답 명세를 문서로 작성한다

---

## Story 3.1: 클러스터러 입력 타입 단순화

**수정 파일:** `src/services/reportPipeline/clusterer.ts`, `src/services/reportPipeline/index.ts`, `src/services/reportPipeline/pipelineUtils.ts`, `src/types/embedding.ts`

### 배경
현재 클러스터러는 `CategorizedEmbeddedMessage`를 입력으로 받는다 (`clusterer.ts:36`). 이 타입은 `CategorizedMessage`를 상속하여 `category`, `sentiment`, `isSubstantive` 필드를 요구하지만:

- conversation 파이프라인에서는 `toCategorizedEmbedded()` (pipelineUtils.ts:138~154)가 `stance`를 `category`로, `STANCE_TO_SENTIMENT[stance]`를 `sentiment`로 억지 매핑하여 이 타입을 충족시킨다
- 클러스터러 내부에서 `category`와 `isSubstantive`는 사용하지 않는다 — `embedding` 벡터만 사용
- `sentiment`는 `calculateClusterSentiment()` (clusterer.ts)에서만 사용하지만, 이 값도 analyzeClusters가 LLM으로 다시 판단하므로 의미 없다

클러스터러 입력을 `EmbeddedMessage`로 단순화하면 `toCategorizedEmbedded` 어댑터가 불필요해진다.

### 참고 파일
- `src/services/reportPipeline/clusterer.ts:36~109` — `clusterByEmbedding()` 함수와 클러스터 생성부
- `src/services/reportPipeline/clusterer.ts:95~109` — `MessageCluster` 생성 시 `messages: msgs` 할당
- `src/types/embedding.ts:31~33` — `CategorizedEmbeddedMessage` 타입
- `src/services/reportPipeline/pipelineUtils.ts:116~154` — `opinionsToParsedMessages()`, `toCategorizedEmbedded()`

### 태스크

#### 클러스터러 입력 타입 변경
- [x] `src/services/reportPipeline/clusterer.ts`의 `clusterByEmbedding()` 파라미터를 `CategorizedEmbeddedMessage[]` → `EmbeddedMessage[]`로 변경
- [x] 클러스터 내 `messages` 필드 타입도 `CategorizedMessage[]` → `ParsedMessage[]`로 정합성 유지 (또는 `EmbeddedMessage[]` 유지)
- [x] `calculateClusterSentiment()` 함수 제거 — sentiment는 analyzeClusters에서 ExtractedOpinion의 stance 집계로 대체
- [x] `MessageCluster` 생성부에서 `summary.sentiment` 초기값을 `"neutral"`로 고정 (LLM이 재설정)

#### MessageCluster 타입 변경
- [x] `src/types/report.ts`의 `MessageCluster.messages` 타입을 `CategorizedMessage[]` → `ParsedMessage[]`로 변경
- [x] `CategorizedMessage` 타입이 더 이상 MessageCluster에서 요구되지 않음 확인

#### 어댑터 제거
- [x] `src/services/reportPipeline/pipelineUtils.ts`에서 `toCategorizedEmbedded()` 함수 삭제
- [x] `src/services/reportPipeline/pipelineUtils.ts`에서 `STANCE_TO_SENTIMENT` 매핑 삭제
- [x] `src/services/reportPipeline/index.ts`에서 `toCategorizedEmbedded` import 및 호출 제거
- [x] `index.ts`의 `generateReport()`에서 `embeddingResult.messages`를 `runSharedPipeline`에 직접 전달 (CategorizedEmbeddedMessage 변환 없이)

#### runSharedPipeline 입력 타입 변경
- [x] `runSharedPipeline` opts의 `substantiveMessages` 타입을 `CategorizedEmbeddedMessage[]` → `EmbeddedMessage[]`로 변경
- [x] `index.ts`에서 `CategorizedEmbeddedMessage` import 제거

#### clusterAnalyzer.ts 타입 정합성
- [x] `src/services/reportPipeline/clusterAnalyzer.ts`의 `allMessages` 변수 타입을 `CategorizedMessage[]` → `ParsedMessage[]`로 변경 (line 61)
- [x] `analyzeCluster()` 내 `sentimentCounts` 계산 로직 제거 (lines 135~140) — `msg.sentiment`가 `ParsedMessage`에 없음
- [x] LLM 프롬프트에서 sentiment distribution 컨텍스트 제거 (line 154) — 대신 프롬프트가 messages의 content만으로 sentiment 판단하도록 유지
- [x] `CategorizedMessage` import를 `ParsedMessage`로 변경

### 주의사항
- `analyzer.ts`의 `analyzeData()`가 `CategorizedMessage[]`를 입력으로 받아 `categoryDistribution`과 `sentimentDistribution`을 계산한다 — Story 3.3에서 ExtractedOpinion 기반으로 변경

---

## Story 3.2: Grounding 제거 및 ExtractedOpinion 직접 활용

**수정 파일:** `src/services/reportPipeline/grounding.ts`, `src/services/reportPipeline/clusterAnalyzer.ts`, `src/services/reportPipeline/index.ts`, `src/services/reportPipeline/pipelineUtils.ts`, `src/types/report.ts`

### 배경
현재 파이프라인에서 의견(opinion)은 두 번 생성되고 한 번 재연결된다:

1. **Step 2** `extractOpinions()` → `ExtractedOpinion[]` (statement, stance, confidence, evolved, source.segmentId, source.keyMessageIds)
2. **Step 6** `analyzeClusters()` → 새 `Opinion[]` 생성 (text만 있고 supportingMessages는 빈 배열)
3. **Step 7** `groundOpinions()` → LLM으로 Step 6의 Opinion과 messages를 다시 매핑
4. `attachSourceSegmentIds()` → grounding 결과를 다시 ExtractedOpinion으로 역매핑

T3C에서는 claim 추출 시 quote/reference가 내장되어 별도 grounding 단계가 없다. ExtractedOpinion도 추출 시 `source`가 내장되어 있으므로 같은 패턴으로 정리할 수 있다.

**analyzeClusters를 축소**: Opinion 재생성을 제거하고, 토픽 라벨/설명 + ExtractedOpinion 기반 consensus/conflicting 요약만 LLM으로 생성한다.

### 참고 파일
- `src/services/reportPipeline/clusterAnalyzer.ts:148~194` — LLM 프롬프트 (opinions 재생성 부분)
- `src/services/reportPipeline/clusterAnalyzer.ts:214~224` — 빈 Opinion 객체 생성부
- `src/services/reportPipeline/grounding.ts` — 전체 파일 (268줄)
- `src/services/reportPipeline/pipelineUtils.ts:160~182` — `attachSourceSegmentIds()`
- `src/services/reportPipeline/index.ts:248~261` — groundOpinions 호출 및 attachSourceSegmentIds 호출

### 태스크

#### analyzeClusters 축소
- [x] `src/services/reportPipeline/clusterAnalyzer.ts`의 `analyzeCluster()` LLM 프롬프트를 변경:
  - **유지**: topic label, description, summary (consensus/conflicting/sentiment), nextSteps
  - **제거**: opinions 생성 요청 (프롬프트의 "3. Opinions" 항목과 JSON 응답의 "opinions" 필드)
- [x] `analyzeCluster()` 반환 시 `opinions` 필드를 빈 배열(`[]`)로 설정 (ExtractedOpinion이 대체)
- [ ] ~~프롬프트에 클러스터 내 ExtractedOpinion 목록을 컨텍스트로 추가하여 summary 품질 향상~~ → EPIC4 Story A로 이관 (프롬프트 보강 시 함께 처리)

#### Grounding 단계 제거
- [x] `src/services/reportPipeline/index.ts`에서 `groundOpinions` import 및 호출 제거
- [x] `src/services/reportPipeline/index.ts`에서 `attachSourceSegmentIds` import 및 호출 제거
- [x] `PIPELINE_STEPS`에서 `"Grounding opinions"` 제거
- [x] `runSharedPipeline()`에서 `groundingResult` 변수를 `analyzedClusters`로 직접 사용하도록 변경
- [x] `export { groundOpinions }` 제거

#### ExtractedOpinion을 클러스터에 매핑
- [x] `src/services/reportPipeline/index.ts`의 `runSharedPipeline()`에서 analyzeClusters 이후 ExtractedOpinion→Opinion 매핑 구현

#### pipelineUtils 정리
- [x] `src/services/reportPipeline/pipelineUtils.ts`에서 `attachSourceSegmentIds()` 함수 삭제

#### 타입 정리
- [x] `src/types/report.ts`에서 `GroundingResult` 인터페이스 삭제 (grounding.ts 삭제와 함께 미사용)

#### 파일 삭제
- [x] `src/services/reportPipeline/grounding.ts` 삭제

### 주의사항
- `synthesizer.ts`가 `cluster.summary.consensus/conflicting`과 `cluster.nextSteps`를 입력으로 사용 — analyzeClusters가 여전히 이 값을 생성하므로 영향 없음
- `Opinion` 타입은 유지 — `MessageCluster.opinions`의 타입으로 사용됨
- analyzeClusters의 `labelSubtopics()` 호출은 Story 3.4에서 제거

---

## Story 3.3: Statistics 집계를 ExtractedOpinion 기반으로 변경

**수정 파일:** `src/services/reportPipeline/analyzer.ts`, `src/services/reportPipeline/index.ts`, `src/types/report.ts`

### 배경
현재 `analyzeData()` (analyzer.ts)는 `CategorizedMessage[]`를 입력으로 받아 통계를 계산한다:

- `categoryDistribution`: `msg.category`를 집계 — 현재 stance를 억지 매핑한 값 (`support`, `oppose`, `neutral` 등)
- `sentimentDistribution`: `msg.sentiment`를 집계 — stance→sentiment 매핑 결과

Story 3.1에서 `CategorizedMessage` 어댑터를 제거하면 이 집계가 불가능해진다. ExtractedOpinion에서 직접 stance/confidence/evolved를 집계하는 것이 더 정확하고 의미 있다.

### 참고 파일
- `src/services/reportPipeline/analyzer.ts` — 전체 파일 (91줄)
- `src/types/report.ts:72~98` — `ReportStatistics` 타입 (categoryDistribution, sentimentDistribution)

### 태스크

#### analyzeData 함수 시그니처 변경
- [x] `analyzeData()`의 첫 번째 파라미터를 `CategorizedMessage[]` → `ExtractedOpinion[]`로 변경
- [x] `clusters` 파라미터는 유지 (topTopics 계산에 필요)
- [x] dead 파라미터 제거: `wasSampled`, `nonSubstantiveCount`, `filteringBreakdown` — 레거시 메시지 필터링용이었으며 현재 항상 `false`, `0`, `undefined`로 호출됨
- [x] `deliberation` 파라미터 제거 — ExtractedOpinion에서 직접 집계

#### 집계 로직 변경
- [x] `calculateCategoryDistribution()` → `calculateStanceDistribution()`: `opinion.stance`별 카운트
- [x] `calculateSentimentDistribution()` 제거
- [x] `ReportStatistics.categoryDistribution`을 `stanceDistribution`으로 rename
- [x] `ReportStatistics`에서 dead 필드 제거: `wasSampled`, `nonSubstantiveCount`, `filteringBreakdown`, `totalMessagesBeforeSampling`, `averageMessagesPerThread`, `sentimentDistribution`, `categoryDistribution`
- [x] `totalMessages` → `totalOpinions` (의견 수 기반)
- [x] `dateRange` 계산을 `ExtractedOpinion.timestamp` 기반으로 변경
- [x] `deliberation`을 analyzer 내부에서 직접 집계

#### index.ts 호출부 변경
- [x] `runSharedPipeline()`에서 `analyzeData()` 호출을 ExtractedOpinion 기반으로 변경 — dead 파라미터 제거
- [x] `deliberation` 수동 계산 제거 (analyzer 내부로 이동)
- [x] `totalMessagesBeforeSampling` 전달 제거

### 주의사항
- `ReportStatistics` 타입의 필드명 변경은 API 응답 구조에 영향 — 프론트엔드가 없으므로 자유롭게 변경 가능
- `sentimentDistribution`을 완전히 제거할지, stance 기반으로 유지할지 판단 필요 — T3C에는 sentiment 개념이 없으므로 제거 가능

---

## Story 3.4: Subtopic 클러스터링 및 미사용 파일 제거

**수정 파일:** `src/services/reportPipeline/subtopicClusterer.ts`, `src/services/reportPipeline/clusterAnalyzer.ts`, `src/services/reportPipeline/index.ts`, `src/services/reportPipeline/parser.ts`, `src/services/reportPipeline/categorizer.ts`, `src/types/report.ts`

### 배경
EPIC2에서 dotGrid와 시각화를 제거한 후, subtopic의 소비처가 없어졌다:

- `subtopicClusterer.ts`: 클러스터 내 메시지를 K-means로 서브토픽 분할 → dotGrid에서 사용했으나 제거됨
- `clusterAnalyzer.ts`의 `labelSubtopics()`: 서브토픽에 LLM 라벨을 부여 → 소비처 없음
- `parser.ts`: Legacy 파이프라인 전용 파서 — EPIC2에서 Legacy 제거 후 import 없음
- `categorizer.ts`: 임베딩 기반 카테고리화 — EPIC2에서 Legacy 제거 후 import 없음

### 참고 파일
- `src/services/reportPipeline/index.ts:230~237` — `addSubtopicsToAllClusters()` 호출
- `src/services/reportPipeline/clusterAnalyzer.ts:70~104` — `labelSubtopics()` 호출
- `src/types/report.ts:51~69` — `Subtopic`, `MessageClusterWithSubtopics` 타입

### 태스크

#### 파이프라인에서 서브토픽 단계 제거
- [x] `src/services/reportPipeline/index.ts`의 `PIPELINE_STEPS`에서 `"Subtopic clustering"` 제거
- [x] `runSharedPipeline()`에서 `addSubtopicsToAllClusters()` 호출 제거
- [x] `addSubtopicsToAllClusters` import 제거
- [x] `export { addSubtopicsToAllClusters, clusterSubtopics, countUniqueUsers }` 제거
- [x] `clustererResult.clusters`를 `analyzeClusters()`에 직접 전달 (subtopics 단계 건너뛰기)

#### clusterAnalyzer에서 서브토픽 라벨링 제거
- [x] `src/services/reportPipeline/clusterAnalyzer.ts`에서 `labelSubtopics()` 함수 삭제
- [x] `analyzeClusters()`의 반환 타입을 `MessageClusterWithSubtopics[]` → `MessageCluster[]`로 변경
- [x] `analyzeClusters()`에서 서브토픽 관련 분기 (line 70~104) 제거

#### 타입 정리
- [x] `src/types/report.ts`에서 `Subtopic` 인터페이스 삭제
- [x] `MessageClusterWithSubtopics` 인터페이스 삭제 — `MessageCluster`만 사용
- [x] `Report.clusters` 타입을 `MessageClusterWithSubtopics[]` → `MessageCluster[]`로 변경
- [x] 코드베이스 전체에서 `MessageClusterWithSubtopics` 참조를 `MessageCluster`로 변경

#### 미사용 파일 삭제
- [x] `src/services/reportPipeline/subtopicClusterer.ts` 삭제
- [x] `src/services/reportPipeline/parser.ts` 삭제 (Legacy 전용, EPIC2 이후 import 없음)
- [x] `src/services/reportPipeline/categorizer.ts` 삭제 (Legacy 전용, EPIC2 이후 import 없음)

### 주의사항
- `clusterer.ts`의 `kMeans` 함수는 유지 — 메인 클러스터링에서 사용. subtopicClusterer만 삭제
- `countUniqueUsers()`를 다른 곳에서 사용하는지 확인 필요 — 미사용이면 함께 삭제
- `Subtopic` 타입이 `Report` 외부에서 참조되는지 확인 필요

---

## Story 3.5: 출력 타입을 T3C에 맞추고 API 명세 문서화

**수정 파일:** `src/types/report.ts`, `src/types/embedding.ts`, `src/services/reportPipeline/index.ts`, `src/services/reportPipeline/clusterAnalyzer.ts`, `src/services/reportPipeline/synthesizer.ts`, `src/services/reportPipeline/analyzer.ts`, `src/services/reportService.ts`, `src/routes/reports.ts`, `src/utils/reportValidator.ts`

### 배경
EPIC3의 Story 3.1~3.4에서 파이프라인 내부를 정리했으나, 최종 출력 타입은 여전히 AINSPACE 고유 네이밍(`MessageCluster`, `Opinion`, `supportingMessages` 등)을 사용한다. T3C의 출력 구조와 최대한 맞추면 향후 T3C 프론트엔드 연동이나 다른 T3C 호환 클라이언트와의 통합이 용이해진다.

**T3C 출력 계층:**
```
ReportDataObj
├── topics: Topic[]
│   └── (subtopics →) claims: Claim[]
│       ├── title, number
│       ├── quotes: Quote[]
│       │   └── reference: Reference { interview, sourceId }
│       └── similarClaims: Claim[]
└── sources: Source[] { id, interview }
```

**입력 차이로 어쩔 수 없는 부분** (변경하지 않음):
- T3C `source.interview` (참여자 이름) → AINSPACE `source.id` (threadId, 익명)
- T3C `reference.data: ["text", {startIdx, endIdx}]` → AINSPACE `reference.segmentId` + `reference.messageId` (대화 참조)
- T3C에는 없는 AINSPACE 고유 필드: `claim.stance`, `claim.confidence`, `claim.evolved`, `topic.nextSteps`, `statistics`, `synthesis`

### 참고 파일
- `src/types/report.ts` — 현재 `Report`, `MessageCluster`, `Opinion` 타입
- `/Users/comcom/tttc-light-js/common/schema/index.ts:865~1009` — T3C의 Quote, Claim, Subtopic, Topic, ReportDataObj 타입
- `src/services/reportPipeline/index.ts` — Report 객체 생성부
- `src/services/reportPipeline/clusterAnalyzer.ts` — analyzeCluster 반환 구조
- `src/services/reportPipeline/synthesizer.ts` — synthesizeReport 입력 (cluster.summary 참조)

### 태스크

#### 타입 rename 및 재구조화

- [x] `src/types/report.ts`에서 타입 변경:
  - `MessageCluster` → `Topic` (rename)
    - `topic: string` → `title: string`
    - `messages: ParsedMessage[]` → 제거 (claims가 대체)
    - `opinions: Opinion[]` → `claims: Claim[]`
  - `Opinion` → `Claim` (rename + 구조 변경)
    - `text: string` → `title: string`
    - `supportingMessages: string[]` → 제거 (quotes가 대체)
    - `mentionCount: number` → `number: number`
    - `representativeQuote?: string` → 제거 (quotes에 흡수)
    - `sourceSegmentIds?: string[]` → 제거 (quotes[].reference에 흡수)
    - 추가: `quotes: Quote[]`
    - 추가: `similarClaims: Claim[]` (빈 배열, T3C 호환)
    - 추가: `stance`, `confidence`, `evolved` (AINSPACE 고유, ExtractedOpinion에서 이관)
  - `Quote` 인터페이스 신규 생성:
    ```typescript
    interface Quote {
      id: string;
      text: string;              // 원본 사용자 메시지 내용
      reference: Reference;
    }
    ```
  - `Reference` 인터페이스 신규 생성:
    ```typescript
    interface Reference {
      id: string;
      sourceId: string;          // threadId
      segmentId: string;         // conversation segment ID
      messageId: string;         // specific message ID
    }
    ```
  - `Source` 인터페이스 신규 생성:
    ```typescript
    interface Source {
      id: string;                // threadId
      segmentCount: number;
    }
    ```
  - `Report` 변경:
    - `clusters: MessageCluster[]` → `topics: Topic[]`
    - `createdAt: number` → `date: string` (ISO date string, T3C와 동일)
    - `extractedOpinions?: ExtractedOpinion[]` → 제거 (claims에 흡수)
    - `conversationSegments?: ConversationSegment[]` → 제거 (sources + reference로 분산)
    - 추가: `sources: Source[]`
  - `ClusterSummary` 이름은 유지 (T3C에도 토픽별 summary가 있으므로 역할 동일)

#### ExtractedOpinion → Claim 변환 로직 업데이트

- [x] `src/services/reportPipeline/index.ts`의 ExtractedOpinion → Claim 변환 로직을 Quote/Reference 포함 형태로 변경:
  ```typescript
  // ExtractedOpinion → Claim 변환
  {
    id: op.id,
    title: op.statement,
    number: 1,
    quotes: op.source.keyMessageIds.map(msgId => ({
      id: msgId,
      text: getMessageContent(msgId, segments),  // 원본 메시지 내용 조회
      reference: {
        id: `ref-${msgId}`,
        sourceId: op.threadId,
        segmentId: op.source.segmentId,
        messageId: msgId,
      },
    })),
    similarClaims: [],
    stance: op.stance,
    confidence: op.confidence,
    evolved: op.evolved,
  }
  ```
- [x] `sources` 배열 생성: conversationSegments에서 threadId별 segmentCount 집계

#### Report 생성부 업데이트

- [x] `src/services/reportPipeline/index.ts`의 Report 빌드 로직:
  - `clusters` → `topics`
  - `createdAt: Date.now()` → `date: new Date().toISOString()`
  - `extractedOpinions`, `conversationSegments` 제거
  - `sources` 추가
- [x] `createEmptyReport()`에서 `clusters: []` → `topics: []`, `date` 필드 추가, `sources: []` 추가

#### 파이프라인 내부 참조 변경

- [x] `src/services/reportPipeline/clusterAnalyzer.ts`: 반환 타입 `MessageCluster[]` → `PipelineTopic[]` 변경, 내부 `topic` 필드 → `title` 변경
- [x] `src/services/reportPipeline/synthesizer.ts`: 입력의 `cluster.topic` → `cluster.title` 참조 변경
- [x] `src/services/reportPipeline/analyzer.ts`: `clusters` 파라미터의 타입을 `PipelineTopic[]`으로 변경, `cluster.topic` → `cluster.title` 참조 변경
- [x] `src/types/embedding.ts`: `EmbeddingClustererResult` 삭제 (ClustererResult로 대체)

#### 파이프라인 외부 참조 변경

- [x] `src/services/reportService.ts`: `job.report.clusters` → `job.report.topics` 참조 변경 + 레거시 호환 (buildReportSummary)
- [x] `src/routes/reports.ts`: `includeMessages` 로직 제거 — Topic에 messages 필드 없음

#### reportValidator.ts 재작업

- [x] `src/utils/reportValidator.ts`: Topic/Claim 기반 검증으로 전면 재작업
- [x] `validateReportMessages()` → Topic.claims 기반 검증 (quotes, reference, confidence 검증)
- [x] `validateGroundedOpinions()` → `validateTopics()`로 대체

#### 미사용 타입 정리

- [x] `src/types/report.ts`에서 불필요한 타입 삭제: `CategorizedMessage`, `CategorizerResult`, `ClustererResult`, `FilteringBreakdown`, `ParserResult`, `ActionItem`, `Opinion`, `MessageCluster` 등

#### API 명세 문서 작성

- [x] `docs/API_REPORT_SPEC.md` 파일 생성 (전체 엔드포인트 + 타입 + T3C 매핑 + 레거시 호환 문서화)

### 주의사항
- `ReportJob` 타입의 `report?: Report` 필드가 새 Report 구조를 반영해야 함
- `ReportJobSummary.reportSummary.topicCount`가 `report.topics.length`를 참조해야 함
- `routes/reports.ts`의 `includeMessages` 로직은 제거 — Topic에 messages 필드가 없으므로 (claims가 대체)
- T3C의 `Subtopic` 계층은 도입하지 않음 — Claim이 Topic 바로 아래에 위치 (T3C는 Topic > Subtopic > Claim이지만, AINSPACE는 Topic > Claim으로 단순화)

---

## 구현 규칙

### 순서
- Story 3.1 → 3.2 → 3.3 → 3.4 → 3.5 순서로 진행
- Story 3.1에서 클러스터러 입력을 단순화해야 3.2에서 grounding 제거 후 정합성 유지 가능
- Story 3.3은 3.1 이후 (CategorizedMessage 제거) 진행
- Story 3.4는 독립적이나 3.5 전에 타입 정리가 완료되어야 함
- Story 3.5는 마지막에 진행 — 3.1~3.4의 내부 정리가 완료된 후 최종 출력 타입을 T3C에 맞추고 API 명세를 문서화

### 데이터 흐름 (EPIC3 완료 후)
```
1. parseConversations()     → ConversationSegment[]
2. extractOpinions(LLM)     → ExtractedOpinion[] (grounding 내장)
3. embedMessages()          → EmbeddedMessage[]
4. clusterByEmbedding()     → Topic[] (UMAP + K-means)
5. analyzeClusters(LLM)     → 토픽 title/description/summary/nextSteps
   + ExtractedOpinion → Claim (Quote/Reference 포함) 매핑 (LLM 없이)
6. synthesizeReport(LLM)    → keyFindings/topPriorities/executiveSummary
   + statistics (ExtractedOpinion 직접 집계)
   + sources (threadId별 집계)
```

### 최종 출력 구조 (T3C 정렬)
```
Report
├── title, description, date
├── topics: Topic[]
│   ├── id, title, description
│   ├── claims: Claim[]
│   │   ├── id, title, number
│   │   ├── quotes: Quote[]
│   │   │   └── reference: Reference { sourceId, segmentId, messageId }
│   │   ├── similarClaims: []
│   │   └── stance, confidence, evolved  (AINSPACE 고유)
│   ├── summary: ClusterSummary
│   └── nextSteps: ActionItem[]          (AINSPACE 고유)
├── sources: Source[]
├── statistics: ReportStatistics         (AINSPACE 고유)
└── synthesis: ReportSynthesis           (AINSPACE 고유)
```

### 테스트
- 각 Story 완료 후 `tsc --noEmit`으로 타입 에러 없음 확인
- 파이프라인이 정상 동작하여 Report 객체를 생성하는지 확인

### 금지사항
- 파이프라인의 핵심 로직(대화 파싱, 의견 추출, 임베딩, UMAP+K-means 클러스터링, 종합)은 변경하지 않는다
- `ExtractedOpinion`의 필드 구조는 변경하지 않는다 — 추출기(opinionExtractor)는 건드리지 않는다
- 새로운 LLM 호출을 추가하지 않는다 — 이 EPIC의 목적은 제거와 단순화

---

## 완료 조건
- [x] `src/services/reportPipeline/grounding.ts` 파일이 삭제되었다
- [x] `src/services/reportPipeline/subtopicClusterer.ts` 파일이 삭제되었다
- [x] `src/services/reportPipeline/parser.ts` 파일이 삭제되었다
- [x] `src/services/reportPipeline/categorizer.ts` 파일이 삭제되었다
- [x] `PIPELINE_STEPS`가 7단계이다 (9단계에서 축소)
- [x] LLM 호출이 3회이다: extractOpinions, analyzeClusters, synthesizeReport
- [x] `toCategorizedEmbedded()`, `attachSourceSegmentIds()` 함수가 삭제되었다
- [x] 클러스터러가 `EmbeddedMessage[]`를 입력으로 받는다
- [x] Report.topics의 claims가 ExtractedOpinion에서 변환된 값이다 (LLM 재생성 아님)
- [x] statistics가 ExtractedOpinion의 stance/confidence/evolved 기반으로 집계된다
- [x] 출력 타입이 T3C와 정렬되었다: Report.topics (not clusters), Topic.claims (not opinions), Claim.quotes, Reference, Source
- [x] `reportService.ts`, `routes/reports.ts`의 외부 참조가 새 타입에 맞게 변경되었다
- [x] `reportValidator.ts`가 Topic/Claim 기반 검증으로 재작업되었다
- [x] `docs/API_REPORT_SPEC.md` 파일이 생성되었고, 전체 API 엔드포인트와 응답 타입이 문서화되었다
- [x] `tsc --noEmit`이 타입 에러 없이 통과한다
- [x] 삭제된 파일에 대한 import가 코드베이스 전체에 남아있지 않다

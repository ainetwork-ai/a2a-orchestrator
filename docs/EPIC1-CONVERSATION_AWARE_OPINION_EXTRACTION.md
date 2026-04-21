# EPIC1 - Conversation-Aware Opinion Extraction (대화 맥락 기반 의견 추출)

> 현재 유저 메시지만 단독 추출하는 리포트 파이프라인을 대화 맥락(에이전트 응답 포함)을 활용하여 구조화된 의견 단위로 추출하도록 개선한다.

## 의존성
- 없음

## 목표
- 에이전트-유저 간 대화 흐름을 보존하여 의견 추출 정확도를 높인다
- 추출된 의견과 원본 대화 세그먼트 간 양방향 연계(traceability)를 보장한다
- 대화 중 의견 변화(숙의) 추적을 통해 T3C에 없는 deliberation 차원을 추가한다
- 기존 파이프라인(임베딩 이후)은 최소 변경으로 재활용한다

---

## Story 1.1: 대화 세그먼트 파서 구현

**수정 파일:** `src/services/reportPipeline/conversationParser.ts` (신규)

### 배경
현재 `parser.ts`의 `parseThreads()`는 `m.speaker === "User"` 필터로 유저 메시지만 추출한다 (parser.ts:71).
에이전트 응답이 제외되면 `"네"`, `"그건 좀..."` 같은 대화 의존적 발화가 맥락 없이 파이프라인에 투입되어 임베딩/클러스터링 정확도가 떨어진다.

새로운 파서는 유저+에이전트 메시지를 대화 흐름째 보존하면서, 토픽 전환 지점을 기준으로 세그먼트를 분리한다.

### 참고 파일
- `src/services/reportPipeline/parser.ts` — 현재 유저 메시지 파싱 로직, 익명화, 샘플링 참고
- `src/types/index.ts` — `Message` 인터페이스 (speaker, content, timestamp, replyTo)
- `src/types/report.ts` — `ReportRequestParams`, `ParserResult` 등 기존 타입

### 태스크

#### 타입 정의
- [x] `src/types/report.ts`에 `ConversationSegment` 인터페이스 추가:
  ```typescript
  interface ConversationSegment {
    id: string;                    // segment 고유 ID
    threadId: string;              // 원본 스레드 ID
    messages: SegmentMessage[];    // 유저+에이전트 메시지 시퀀스
    startTimestamp: number;
    endTimestamp: number;
  }

  interface SegmentMessage {
    id: string;
    speaker: string;               // "User" | agent name
    content: string;
    timestamp: number;
    isUser: boolean;
  }
  ```
- [x] `ConversationParserResult` 인터페이스 추가:
  ```typescript
  interface ConversationParserResult {
    segments: ConversationSegment[];
    threadCount: number;
    totalMessages: number;         // 유저+에이전트 전체 메시지 수
  }
  ```
  - `totalSegments`는 `segments.length`와 중복이므로 제거 (simplify 리뷰)

#### 세그먼트 분리 로직
- [x] `conversationParser.ts` 파일 생성
- [x] `parseConversations(params: ReportRequestParams): Promise<ConversationParserResult>` 함수 구현
- [x] 기존 `parser.ts`의 스레드 필터링 로직 재사용 (threadIds, agentUrls, agentNames, 날짜 필터)
- [x] 스레드의 전체 메시지(유저+에이전트)를 시간순으로 가져오기
- [x] 토픽 전환 감지 로직 구현: 시간 간격 기반 (예: 5분 이상 공백 시 새 세그먼트) + 에이전트 변경 시 새 세그먼트 + 최대 메시지 수 초과 시 분리 (예: `MAX_SEGMENT_MESSAGES = 20`)
- [x] 각 세그먼트에 최소 1개의 유저 메시지가 포함되어야 하며, 유저 메시지 없는 세그먼트는 제외
- [x] `pipelineUtils.ts`의 공유 `anonymizeContent()`를 유저 메시지에만 적용 (에이전트 메시지는 익명화 불필요)

### 주의사항
- 기존 `parser.ts`는 삭제하지 않는다 (하위 호환 유지, 추후 deprecation)
- 세그먼트 분리 기준(시간 간격, 최대 메시지 수)은 설정 가능하도록 상수로 분리한다
- 에이전트 메시지는 의견 추출의 **맥락**으로만 사용되며, 에이전트의 발화 자체가 의견으로 추출되면 안 된다

---

## Story 1.2: LLM 기반 의견 추출기 구현

**수정 파일:** `src/services/reportPipeline/opinionExtractor.ts` (신규)

### 배경
현재 파이프라인은 유저 메시지 원문을 그대로 임베딩 → 클러스터링하고, 의견은 클러스터 분석 단계(`clusterAnalyzer.ts:148`)에서 LLM이 메시지 샘플을 보고 추론한다.

이 방식의 문제:
1. 맥락 없는 단편 메시지가 임베딩되어 클러스터링 품질이 저하됨
2. 의견이 클러스터 단위로만 추출되어, 개별 대화에서 나온 구체적 의견이 유실됨
3. 대화 중 의견 변화를 추적할 수 없음

새로운 의견 추출기는 각 대화 세그먼트를 LLM에 넣어 구조화된 의견 단위(ExtractedOpinion)를 생성하고, 원본 세그먼트 참조를 유지한다.

### 참고 파일
- `src/services/reportPipeline/clusterAnalyzer.ts` — 현재 LLM 프롬프트 패턴, `parseJsonResponse` 사용법
- `src/world/requestManager.ts` — LLM 요청 매니저
- `src/utils/llm.ts` — `parseJsonResponse` 유틸

### 태스크

#### 타입 정의
- [x] `src/types/report.ts`에 `ExtractedOpinion` 인터페이스 추가:
  ```typescript
  interface ExtractedOpinion {
    id: string;
    statement: string;              // 완결된 문장으로 정리된 의견
    stance: "support" | "oppose" | "neutral" | "request" | "question";
    confidence: number;             // 0.0~1.0 의견의 확고함
    evolved: boolean;               // 대화 중 변화 여부
    source: OpinionSource;          // 원문 대화 연계 정보
    timestamp: number;              // 의견이 표현된 시점
    threadId: string;
  }

  interface OpinionSource {
    segmentId: string;                // 출처 세그먼트 ID (세그먼트 본체는 별도 보관)
    keyMessageIds: string[];          // 의견 근거가 된 핵심 메시지 ID
  }

  interface OpinionExtractionResult {
    opinions: ExtractedOpinion[];
    totalSegmentsProcessed: number;
    emptySegments: number;           // 의견 없는 세그먼트 수
    failedSegments: number;          // LLM 추출 실패 세그먼트 수 (simplify 리뷰: 에러와 빈 결과 구분)
    evolvedOpinionCount: number;     // 변화된 의견 수
  }
  ```

#### LLM 의견 추출 로직
- [x] `opinionExtractor.ts` 파일 생성
- [x] `extractOpinions(segments: ConversationSegment[], apiUrl: string, model: string, language: ReportLanguage): Promise<OpinionExtractionResult>` 함수 구현
- [x] LLM 프롬프트 작성: 대화 세그먼트 → 구조화된 의견 추출
  - 에이전트 발화를 맥락으로 활용하여 유저의 암묵적 의견 해석
  - 인사, 감사 등 의견이 아닌 발화 자연 필터링
  - 대화 중 의견 변화 감지 시 `evolved: true` 기록
  - `keyMessageIds`로 의견 근거 메시지 지정
- [x] 세그먼트를 배치로 처리 (병렬 요청, RequestManager 활용)
- [x] 빈 세그먼트(의견 없음) 카운팅
- [x] 추출된 의견마다 고유 ID 부여 (`uuid`)

#### 프롬프트 설계
- [x] 프롬프트에 다음 지시사항 포함:
  - "사용자의 발화만 의견으로 추출하세요. 에이전트의 발화는 맥락으로만 활용하세요."
  - "사용자가 명시적으로 표현하지 않았더라도 대화 맥락에서 추론 가능한 의견을 추출하세요."
  - "각 의견은 대화 맥락 없이도 이해할 수 있는 완결된 문장이어야 합니다."
  - "대화 중 의견이 변했다면 최종 입장을 statement에 기록하고 evolved를 true로 설정하세요."

### 주의사항
- LLM 호출 비용을 고려하여 세그먼트당 토큰 제한 설정 (세그먼트 메시지가 너무 길면 truncation)
- temperature는 0.2~0.3으로 낮게 설정하여 일관된 추출 품질 유지
- 에이전트 메시지를 그대로 프롬프트에 넣을 때 토큰 효율을 위해 300자로 truncate (clusterAnalyzer.ts 패턴 참고)

---

## Story 1.3: 파이프라인 통합 및 타입 어댑터

**수정 파일:** `src/services/reportPipeline/index.ts`, `src/types/report.ts`

### 배경
현재 파이프라인의 `generateReport()` (index.ts:107)는 다음 흐름을 따른다:
```
parseThreads() → embedMessages() → categorizeByEmbedding() → clusterByEmbedding() → ...
```

새로운 흐름은:
```
parseConversations() → extractOpinions() → embedMessages() → clusterByEmbedding() → ...
```

핵심 변경:
1. `embedMessages()`의 입력이 `ParsedMessage[]`에서 `ExtractedOpinion[]`(어댑터 경유)으로 바뀐다
2. `categorizeByEmbedding()` 단계는 **스킵**한다 — LLM이 의견 추출 시 이미 non-substantive를 필터링했고, `ExtractedOpinion.stance`가 기존 category를 대체한다
3. `clusterByEmbedding()`의 입력 타입을 `EmbeddedMessage[]`도 받도록 완화한다 (클러스터링 알고리즘은 임베딩 벡터만 사용하므로 category/sentiment 필드 불필요)
4. 기존 통계의 category/sentiment 분포는 `ExtractedOpinion.stance` 기반 분포로 대체한다

### 참고 파일
- `src/services/reportPipeline/index.ts` — 전체 파이프라인 오케스트레이션
- `src/services/reportPipeline/embedder.ts` — 임베딩 입력 타입
- `src/types/embedding.ts` — `EmbeddedMessage` 타입

### 태스크

#### 어댑터 함수
- [x] `ExtractedOpinion`을 `ParsedMessage` 형태로 변환하는 어댑터 함수 작성:
  ```typescript
  function opinionsToParsedMessages(opinions: ExtractedOpinion[]): ParsedMessage[] {
    return opinions.map(op => ({
      id: op.id,
      threadId: op.threadId,
      content: op.statement,    // 완결된 의견 문장이 임베딩 대상
      timestamp: op.timestamp,
    }));
  }
  ```
- [x] 어댑터를 통해 기존 `embedMessages` 그대로 사용

#### 파이프라인 수정
- [x] `index.ts`의 `STEPS` 배열 업데이트: `LEGACY_STEPS` (기존)과 `CONVERSATION_STEPS` (신규) 분리
- [x] `generateReport()` 함수에 `params.pipelineMode` 기반 분기 추가 (legacy/conversation)
- [x] conversation 파이프라인: parseConversations → extractOpinions → embedMessages → `toCategorizedEmbedded()` 어댑터로 `CategorizedEmbeddedMessage[]` 생성 → 이후 기존 파이프라인 공유
  - 클러스터러 타입 변경 없이 stance→category(직접), stance→sentiment(매핑) 처리 (금지사항 준수)
  - `categoryDistribution`에 stance 값이 자연스럽게 채워짐
- [x] 공통 로직을 `runSharedPipeline()`으로 추출하여 레거시/신규 파이프라인 모두 사용
  - `makeProgressUpdater()` 헬퍼로 progress 콜백 중복 제거 (simplify)
  - `extractedOpinions`/`conversationSegments`는 opts로 전달 후 report 생성 시 포함 (사후 mutation 제거, simplify)
- [x] `report` 객체에 `extractedOpinions`, `conversationSegments` 추가
- [x] 빈 의견 결과(opinions.length === 0) 시 `createEmptyReport()` 반환

#### Report 타입 확장
- [x] `Report` 인터페이스에 필드 추가:
  ```typescript
  extractedOpinions?: ExtractedOpinion[];    // 원본 추출 의견 (segmentId로 참조)
  conversationSegments?: ConversationSegment[]; // 세그먼트 원본 (별도 보관)
  ```
  - 숙의 통계(`deliberation`)는 `ReportStatistics`에만 배치한다 (Story 1.5에서 정의)
- [x] `ReportRequestParams`에 `pipelineMode?: "legacy" | "conversation"` 추가

### 주의사항
- 기존 `parseThreads()` 기반 경로를 완전히 제거하지 않는다. 환경변수나 파라미터로 레거시/신규 파이프라인 전환 가능하도록 한다
- `extractedOpinions` 필드는 optional로 두어 기존 리포트 응답 형식과 하위 호환 유지
- progress callback의 퍼센티지 계산이 스텝 수(12)를 반영하도록 한다

---

## Story 1.4: 그라운딩 확장 (클러스터 의견 → 원본 대화 세그먼트 연계)

**수정 파일:** `src/services/reportPipeline/grounding.ts`, `src/types/report.ts`

### 배경
새 파이프라인에서 데이터 흐름을 정리하면:

1. `opinionExtractor`가 `ExtractedOpinion` 생성 (각각 `source.segmentId` 보유)
2. 어댑터가 `ExtractedOpinion.statement` → `ParsedMessage.content`로 변환
3. 임베딩 → 클러스터링 → 클러스터의 `messages`에는 opinion statement가 담김
4. `clusterAnalyzer`가 클러스터 내 opinion statement들을 분석하여 상위 `Opinion` 생성
5. `grounding`이 상위 `Opinion` → 클러스터 내 `messages`(=opinion statement) 연결

여기서 클러스터 내 `messages`의 ID는 `ExtractedOpinion.id`와 동일하므로, grounding의 `supportingMessages`(ID 배열)를 통해 원본 `ExtractedOpinion`을 조회하고, 거기서 `source.segmentId`로 대화 세그먼트까지 추적할 수 있다.

즉, **grounding 로직 자체는 크게 변경할 필요 없이**, `supportingMessages` ID → `ExtractedOpinion` → `segmentId` → `ConversationSegment` 체이닝으로 원본 대화 연계가 가능하다.

### 참고 파일
- `src/services/reportPipeline/grounding.ts` — 현재 그라운딩 로직
- `src/utils/reportTransformer.ts` — T3C 포맷 변환 시 Opinion 참조

### 태스크

#### Opinion 타입 확장
- [x] `Opinion` 인터페이스에 optional 필드 추가:
  ```typescript
  sourceSegmentIds?: string[];  // 이 의견을 뒷받침하는 대화 세그먼트 ID 목록
  ```

#### 그라운딩 후처리
- [x] `groundOpinions()` 완료 후, 각 `Opinion.supportingMessages`(ID 배열)를 `ExtractedOpinion` 목록과 대조하여 `sourceSegmentIds`를 채우는 후처리 함수 작성 (`pipelineUtils.attachSourceSegmentIds`)
- [x] 이 함수는 `index.ts`의 grounding 단계 직후에 호출 (conversation 파이프라인일 때만)
- [x] 기존 `supportingMessages`, `mentionCount`, `representativeQuote` 로직은 그대로 유지 (하위 호환)

### 주의사항
- grounding LLM 프롬프트나 `applyGroundingsToOpinions()` 내부 로직은 변경하지 않는다
- `sourceSegmentIds`는 optional 필드로 추가하여 레거시 호환 유지
- 프론트엔드에서 `sourceSegmentIds` → `Report.conversationSegments`에서 조회하여 원본 대화 표시

---

## Story 1.5: 통계에 숙의 데이터 최소 반영

**수정 파일:** `src/services/reportPipeline/analyzer.ts`

### 배경
새로운 파이프라인에서 추출된 `ExtractedOpinion`에는 `evolved`, `stance`, `confidence` 정보가 포함된다.
첫 버전에서는 데이터 수집 목적으로 통계에만 최소한으로 반영하고, 별도 렌더링 섹션은 실제 데이터가 쌓인 후 의미 있는 패턴이 확인되면 추가한다.

### 참고 파일
- `src/services/reportPipeline/analyzer.ts` — 통계 계산

### 태스크

#### analyzer.ts 수정
- [x] `analyzeData()` 함수에 `deliberation?: { totalOpinions, evolvedCount }` 파라미터 추가 (simplify: ExtractedOpinion[] 대신 pre-computed 값 전달)
- [x] `ReportStatistics`에 `deliberation` 필드 추가:
  ```typescript
  deliberation?: {
    totalOpinions: number;
    evolvedCount: number;
  };
  ```
- [x] extractedOpinions가 있을 때 `totalOpinions`와 `evolvedCount` 계산

### 주의사항
- synthesizer, renderer는 이 Story에서 수정하지 않는다 (숙의 섹션 렌더링은 추후 별도 EPIC으로)
- `ReportStatistics`의 기존 필드를 변경하지 않는다 (추가만)

---

## Story 1.6: 변경점 요약 및 API Response 타입 문서 작성

**수정 파일:** `docs/CHANGELOG-EPIC1.md` (신규)

### 배경
Story 1.1~1.5 구현 완료 후, 프론트엔드 개발자 및 팀원이 변경 사항을 빠르게 파악할 수 있도록 before/after 비교와 API 응답 타입을 정리한 문서가 필요하다.

### 참고 파일
- `src/types/report.ts` — 최종 타입 정의 (구현 완료 후 상태)
- `src/routes/reports.ts` — API 엔드포인트 정의
- `src/utils/reportTransformer.ts` — T3C 변환 로직

### 태스크

#### 변경점 요약
- [x] `docs/CHANGELOG-EPIC1.md` 파일 생성
- [x] Before/After 섹션 작성:
  - 파이프라인 흐름 비교 (기존 12단계 → 신규 12단계, 의견 추출 추가 + 카테고라이저 제거)
  - 입력 단위 변경 (유저 메시지 → 대화 세그먼트 → 추출 의견)
  - 새로 추가된 파일 목록
  - 수정된 파일 목록과 변경 요약
- [x] 주요 타입 변경 정리:
  - 신규 타입: `ConversationSegment`, `SegmentMessage`, `ExtractedOpinion`, `OpinionSource`
  - 확장된 타입: `Report`, `Opinion`, `ReportStatistics`

#### API Response 타입 문서
- [x] 각 엔드포인트별 응답 타입을 코드에서 추출하여 문서화:
  - `GET /api/reports/:jobId` — 신규 필드 (`extractedOpinions`, `deliberation`) 포함
  - `GET /api/reports/:jobId/topics` — `sourceSegmentIds` 포함 여부
  - `GET /api/reports/:jobId/statistics` — `deliberation` 필드
- [x] 하위 호환 여부 표시: 기존 필드는 그대로, 신규 필드는 optional로 추가됨을 명시
- [x] 프론트엔드에서 새 필드를 활용하는 예시 코드 스니펫 포함

### 주의사항
- 반드시 Story 1.1~1.5 구현이 **모두 완료된 후** 실제 코드 상태를 기반으로 작성한다 (추측 금지)
- 타입 정보는 코드에서 직접 추출하여 문서와 코드 간 불일치를 방지한다

---

## 구현 규칙

### 파이프라인 패턴
- 새로운 파이프라인 스텝은 기존 패턴을 따른다: 독립 파일, export 함수, `index.ts`에서 오케스트레이션
- LLM 호출은 반드시 `RequestManager.getInstance()` 를 통해 수행
- JSON 파싱은 `parseJsonResponse()` 유틸 사용

### 타입 확장 원칙
- 기존 인터페이스에 필드를 추가할 때는 반드시 optional(`?`)로 선언
- 새로운 인터페이스는 `src/types/report.ts`에 정의

### 하위 호환
- 기존 API 응답 형식이 깨지지 않아야 한다
- `reportTransformer.ts`의 T3C 변환이 새 필드 유무와 관계없이 동작해야 한다

### 금지사항
- 기존 `parser.ts`를 삭제하거나 시그니처를 변경하지 않는다
- 기존 `ParsedMessage`, `CategorizedMessage` 타입의 필수 필드를 변경하지 않는다
- 임베딩 이후 파이프라인(clusterer, subtopicClusterer, dotGridGenerator, visualizer)의 로직을 변경하지 않는다
- 카테고라이저(`categorizer.ts`)의 코드를 수정하지 않는다 (레거시 파이프라인에서 여전히 사용)
- 에이전트 발화를 유저 의견으로 추출하지 않는다

---

## 완료 조건
- [x] 에이전트+유저 대화가 포함된 스레드에서 리포트 생성 시, 대화 맥락을 반영한 의견이 추출된다
- [x] 추출된 각 의견에서 원본 대화 세그먼트(에이전트 응답 포함)를 확인할 수 있다
- [x] `"네"`, `"그렇구나"` 같은 맥락 의존 발화가 단독 메시지로 클러스터링되지 않는다
- [x] 대화 중 의견이 변화한 경우 `evolved: true`로 표시되고, `ReportStatistics.deliberation`에 집계된다
- [x] 기존 API 응답 형식(`GET /api/reports/:jobId`)이 하위 호환된다
- [x] 레거시 파이프라인(유저 메시지만 추출)으로 전환 가능하다
- [x] `docs/CHANGELOG-EPIC1.md`에 before/after 비교 및 API Response 타입이 문서화되어 있다

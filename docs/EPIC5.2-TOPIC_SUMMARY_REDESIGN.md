# EPIC5.2 - Topic Summary Redesign (토픽 요약 체계 변경)

> topic별 요약을 consensus/conflicting 배열에서 T3C 스타일 자연어 문단으로 변경하고, 전체 리포트 synthesis에서 keyFindings/overallSentiment를 제거한다.

## 의존성
- EPIC5.1 (Thread-Level Topic Extraction) — 완료됨

## 목표
- topic별 요약을 claims + quotes 기반 100-140 단어 자연어 문단으로 개선
- 전체 리포트 synthesis를 executiveSummary만 남기도록 단순화
- claims 매핑을 analyzeClusters 앞으로 이동하여 요약 시 claim 데이터 활용 가능하게 함

---

## Story 5.2.1: Claims 매핑 순서 변경

**수정 파일:** `src/services/reportPipeline/index.ts`

### 배경
현재 파이프라인에서 claims 매핑(ExtractedOpinion → Claim)은 `analyzeClusters` 이후에 수행된다. topic 요약을 claims 기반으로 생성하려면, `analyzeClusters` 호출 시점에 이미 claims가 존재해야 한다.

현재 순서 (`index.ts:210-259`):
```
analyzeClusters() → claims 매핑
```

변경 순서:
```
claims 매핑 → analyzeClusters(claims 포함)
```

### 태스크

#### 순서 변경
- [x] `messageMap` 구성 + `opinionMap` 구성 + `cluster.claims` 매핑 코드를 `analyzeClusters()` 호출 전으로 이동
- [x] `analyzeClusters()`에 claims 데이터를 전달할 수 있도록 호출부 수정

### 주의사항
- claims 매핑 로직 자체는 변경하지 않음 (이동만)
- `analyzeClusters`가 `extractedOpinions`를 직접 받던 방식에서, 이미 매핑된 `claims`를 받는 방식으로 전환

---

## Story 5.2.2: Topic 요약을 자연어 문단으로 변경

**수정 파일:** `src/types/report.ts`, `src/services/reportPipeline/clusterAnalyzer.ts`, `src/services/reportPipeline/clusterer.ts`

### 배경
현재 `ClusterSummary`는 `consensus: string[]`, `conflicting: string[]` 구조로, 키워드 나열에 가까운 요약을 생성한다. T3C는 topic 요약을 100-140 단어 자연어 문단으로 생성하며, claims + quotes를 입력으로 사용하여 풍부한 맥락을 담는다.

현재 프롬프트 입력 (`clusterAnalyzer.ts:87-95`):
```
- "Notion AI 한국어 품질이 부족하다" (oppose, confidence: 0.7)
- "뤼튼이 대안이 될 수 있다" (support, confidence: 0.6)
```

T3C 스타일 입력:
```
Claim: "Notion AI 한국어 품질이 부족하다"
  Quote: "써봤는데 한국어가 좀 어색해요"
Claim: "뤼튼이 대안이 될 수 있다"
  Quote: "오 그건 괜찮을 것 같아요"
```

### 참고 파일
- T3C 프롬프트: `/Users/comcom/tttc-light-js/common/prompts/index.ts` (defaultSummariesPrompt, 163-178행)

### 태스크

#### 타입 변경
- [x] `ClusterSummary` 인터페이스 변경: `consensus: string[]`, `conflicting: string[]` 제거, `text: string` 추가
  ```typescript
  export interface ClusterSummary {
    text: string;  // 100-140 단어 자연어 요약
    sentiment: "positive" | "negative" | "mixed" | "neutral";
  }
  ```
- [x] `clusterer.ts`의 기본 `ClusterSummary` 생성부 업데이트 (빈 consensus/conflicting → 빈 text)

#### 프롬프트 변경
- [x] `analyzeCluster()` 프롬프트에 claims + quotes 데이터를 입력으로 포함
- [x] 프롬프트 출력 형식을 자연어 요약으로 변경:
  ```
  Generate a detailed summary (100-140 words) that:
  - Synthesizes the key themes and patterns across all claims
  - Highlights the main perspectives and stances expressed
  - Captures the breadth of discussion on this topic
  - Is comprehensive yet concise
  ```
- [x] 응답 JSON 형식 변경: `summary: { text: "...", sentiment: "..." }`
- [x] 파싱 로직 업데이트: `parsed.summary?.text`, `parsed.summary?.sentiment`

### 주의사항
- `analyzeClusters`의 함수 시그니처 변경이 필요할 수 있음 (claims 데이터 전달)
- 기존 `extractedOpinions` 파라미터를 claims 기반으로 대체하거나 병행

---

## Story 5.2.3: Synthesizer 단순화

**수정 파일:** `src/types/report.ts`, `src/services/reportPipeline/synthesizer.ts`, `src/services/reportPipeline/index.ts`

### 배경
현재 `ReportSynthesis`는 `overallSentiment`, `keyFindings`, `executiveSummary` 3개 필드를 포함한다. keyFindings와 overallSentiment를 제거하고 executiveSummary만 남긴다. topic별 자연어 요약이 충분한 정보를 담으므로, 전체 리포트 레벨에서는 간결한 종합 요약만 필요하다.

### 태스크

#### 타입 변경
- [x] `ReportSynthesis` 인터페이스에서 `overallSentiment`, `keyFindings` 제거
  ```typescript
  export interface ReportSynthesis {
    executiveSummary: string;
  }
  ```

#### Synthesizer 프롬프트 변경
- [x] 프롬프트 입력: cluster별 `summary.text` (자연어 문단)을 사용
- [x] 프롬프트 출력: `executiveSummary`만 요청 (2-3문장)
- [x] 기본값/에러 핸들링 업데이트
- [x] 파싱 로직에서 `overallSentiment`, `keyFindings` 제거

#### 파이프라인 로그 업데이트
- [x] `index.ts`의 `keyFindings.length` 참조 로그 수정

### 주의사항
- `Report.synthesis`는 optional 필드(`synthesis?: ReportSynthesis`)이므로 하위 호환 가능
- `ReportStatistics`는 변경하지 않음

---

## 구현 규칙

### 순서
- Story 5.2.1 → 5.2.2 → 5.2.3 순서로 구현 (의존 관계)

### 금지사항
- `ExtractedOpinion`, `Claim` 타입 구조는 변경하지 않는다
- `ReportStatistics` 타입은 변경하지 않는다
- 클러스터링 로직(`clusterer.ts`)의 알고리즘은 변경하지 않는다
- claim 매핑 로직(quote, context 구성)은 변경하지 않는다

---

## Story 5.2.4: API 응답 스키마 변경 사항 정리

**수정 파일:** 없음 (문서화)

### 배경
`Report` JSON 응답의 타입이 변경되므로, 프론트엔드에서 참조하는 필드가 달라진다. 별도 OpenAPI/Swagger 명세는 없으므로, 타입 변경 내역을 이 Story에 기록한다.

### API 응답 변경 내역

#### `Report.topics[].summary` (ClusterSummary)
```diff
- { consensus: string[], conflicting: string[], sentiment: string }
+ { text: string, sentiment: string }
```
- `consensus`, `conflicting` 필드 제거
- `text` 필드 추가 (100-140 단어 자연어 요약)

#### `Report.synthesis` (ReportSynthesis)
```diff
- { overallSentiment: string, keyFindings: string[], executiveSummary: string }
+ { executiveSummary: string }
```
- `overallSentiment`, `keyFindings` 필드 제거

### 프론트엔드 영향
- topic 요약 렌더링: consensus/conflicting 목록 → text 문단으로 변경 필요
- 전체 리포트 요약: keyFindings 목록, overallSentiment 배지 제거 필요

---

## 완료 조건
- [x] topic별 요약이 100-140 단어 자연어 문단으로 생성된다
- [x] topic 요약 생성 시 claims + quotes가 입력으로 사용된다
- [x] ReportSynthesis에 executiveSummary만 존재한다
- [x] 기존 파이프라인 단계 수와 LLM 호출 수에 변화가 없다
- [x] TypeScript 컴파일 에러가 없다

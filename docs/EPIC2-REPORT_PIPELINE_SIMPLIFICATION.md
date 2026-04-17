# EPIC2 - Report Pipeline Simplification (리포트 파이프라인 과잉 구현 정리)

> T3C 모방으로 인해 실제 사용처 없이 과하게 구현된 시각화, 마크다운 렌더링, 변환 레이어, 레거시 파이프라인, 중복 엔드포인트를 제거하여 유지보수 비용을 줄인다.

## 의존성
- EPIC1 (Conversation-Aware Opinion Extraction) — conversation 파이프라인이 안정화된 상태 전제

## 목표
- T3CReport 변환 레이어를 제거하고 Report를 직접 API로 제공한다
- 소비하는 프론트엔드가 없는 서버 사이드 시각화 데이터 생성을 제거한다
- JSON API와 중복되는 마크다운 렌더링 파이프라인을 제거한다
- Legacy 파이프라인과 관련 코드를 제거한다
- 중복 부분 데이터 엔드포인트를 통합한다

---

## Story 2.1: T3CReport 변환 레이어 제거

**수정 파일:** `src/utils/reportTransformer.ts`, `src/routes/reports.ts`, `src/types/report.ts`

### 배경
현재 API 응답 시 내부 `Report` 객체를 `transformToT3CFormat()`으로 `T3CReport`로 변환하여 반환한다 (`reports.ts:297`, `reports.ts:317`). 그러나 이 변환은 실질적으로:

- 13개 필드 중 10개를 그대로 pass-through
- `cluster.topic` → `topic.name`으로 필드명만 변경 (1개)
- `parentId=null`, `level=0`, `version="1.0.0"` 하드코딩 (3개)
- `statistics`에 이미 있는 값을 `metadata.scope`, `metadata.filtering`으로 재배치 (새 정보 없음)
- `CategorizedMessage` → `MessageRef`로 threadId만 제거 (context.threadId는 타입에만 존재하고 안 채움)

실제 T3C 프론트엔드(next-client)와 연동하지 않으므로 `T3CReport`, `Topic`, `MessageRef`, `ReportMetadata` 등 별도 타입과 변환 함수가 모두 불필요한 추상화다.

### 참고 파일
- `src/utils/reportTransformer.ts` — 전체 변환 로직 (254줄), `transformToT3CFormat()`, `extractTopicsSummary()`, `extractStatistics()`
- `src/routes/reports.ts:279~332` — format별 응답 분기에서 `transformToT3CFormat()` 호출
- `src/types/report.ts:341~502` — `Topic`, `MessageRef`, `T3CReport`, `ReportMetadata` 등 T3C 전용 타입

### 태스크

#### API 응답 변경
- [x] `src/routes/reports.ts`에서 `transformToT3CFormat()` 호출을 제거하고 `job.report`를 직접 반환
- [x] `format=json` 응답: `report: job.report` (clusters 그대로 포함)
- [x] `format=full` 응답: `report: { ...job.report }` (markdown 포함)
- [x] `includeMessages` 옵션이 `false`일 때: clusters 내 messages 배열을 빈 배열로 치환하는 인라인 로직으로 대체 (transformToT3CFormat이 하던 유일한 실질 로직)
- [x] `import { transformToT3CFormat, extractTopicsSummary, extractStatistics }` 제거

#### 타입 정리
- [x] `src/types/report.ts`에서 T3C 전용 타입 삭제: `T3CReport`, `Topic`, `MessageRef`, `ReportMetadata`, `ScatterPoint`, `ScatterPlotData`, `TreeNode`, `TreeLink`, `TopicTreeData`, `ChartData`, `VisualizationData`, `VisualizerResult`
- [x] `Report` 인터페이스에서 `visualization?: VisualizationData` 필드 제거 (Story 2.2와 연동)

#### 변환 파일 삭제
- [x] `src/utils/reportTransformer.ts` 파일 삭제

### 주의사항
- API 응답 구조가 바뀌므로, 현재 이 API를 소비하는 클라이언트가 있다면 영향도 확인 필요
- `extractTopicsSummary()`와 `extractStatistics()`는 부분 데이터 엔드포인트에서 사용 중 — Story 2.4에서 함께 제거

---

## Story 2.2: 서버 사이드 시각화 및 마크다운 렌더링 제거

**수정 파일:** `src/services/reportPipeline/visualizer.ts`, `src/services/reportPipeline/dotGridGenerator.ts`, `src/services/reportPipeline/renderer.ts`, `src/services/reportPipeline/index.ts`, `src/types/report.ts`, `src/types/visualization.ts`, `src/routes/reports.ts`

### 배경
T3C는 시각화를 프론트엔드가 전담하고 서버는 원본 데이터만 제공한다. AINSPACE는 서버에서 scatter plot, topic tree, 4종 차트, dot grid 데이터를 모두 생성하지만:

- `visualizer.ts` (608줄): `ScatterPlotConfig`에 4가지 축 옵션이 있으나 항상 `DEFAULT_CONFIG`만 사용, `generateTopicTree()`의 `includeMessages`는 항상 `false`로 호출
- `dotGridGenerator.ts` (185줄): 점 그리드 데이터를 생성하지만 이를 렌더링하는 프론트엔드가 없음
- 두 파일 모두 `index.ts`에서 한 번만 호출되고, 결과는 `Report.visualization`과 `Report.dotGrid`에 담겨 API에 전달되나 소비처가 불명확

마크다운 렌더링(`renderer.ts`, 432줄)도 마찬가지로 과잉이다:
- 이미 JSON API(`GET /:jobId?format=json`)로 동일한 데이터를 구조화하여 제공
- ko/en 양쪽의 i18n 문자열 60개+를 수동 관리해야 하는 유지보수 비용
- T3C에는 마크다운 렌더링이 없음 (인터랙티브 웹 UI가 핵심)
- `format=markdown` 전용 엔드포인트, `format=full` 분기 등 마크다운을 위한 추가 코드가 곳곳에 산재

파이프라인에서 이 세 단계를 제거하면 12단계 → 9단계로 줄고, 불필요한 UMAP 좌표 재가공과 i18n 마크다운 생성이 사라진다.

### 참고 파일
- `src/services/reportPipeline/index.ts:407~432` — `generateVisualizationData()`, `generateDotGridData()`, `renderMarkdown()` 호출부
- `src/services/reportPipeline/index.ts:436~447` — Report 객체에 visualization, dotGrid, markdown 할당
- `src/types/visualization.ts` — DotGridVisualization, TopicDotGrid, DotGridPoint, Bounds 타입
- `src/services/reportPipeline/renderer.ts` — 전체 마크다운 렌더링 (432줄, i18n 포함)
- `src/routes/reports.ts:280~285` — `format=markdown` 분기
- `src/routes/reports.ts:348~386` — `GET /:jobId/markdown` 전용 엔드포인트

### 태스크

#### 파이프라인에서 제거
- [x] `src/services/reportPipeline/index.ts`의 `CONVERSATION_STEPS`에서 `"Generating visualization"`, `"Generating dot grid"`, `"Rendering report"` 제거
- [x] `runSharedPipeline()`에서 `generateVisualizationData()`, `generateDotGridData()`, `renderMarkdown()` 호출 제거
- [x] Report 객체 생성부에서 `visualization`, `dotGrid`, `markdown` 할당 제거
- [x] 파일 상단의 `import { generateVisualizationData }`, `import { generateDotGridData }`, `import { renderMarkdown }` 제거
- [x] `export { generateVisualizationData }`, `export { generateDotGridData }`, `export { renderMarkdown }` 제거
- [x] `createEmptyReport()`에서 `markdown` 필드 제거 (index.ts:499)

#### Report 타입에서 필드 제거
- [x] `src/types/report.ts`의 `Report` 인터페이스에서 `visualization?: VisualizationData`, `dotGrid?: DotGridVisualization`, `markdown: string` 제거
- [x] `VisualizerResult` 타입 삭제
- [x] `RendererResult` 타입 삭제
- [x] `RenderOptions` 관련 타입이 있다면 삭제

#### API에서 마크다운 관련 코드 제거
- [x] `src/routes/reports.ts`의 `GET /:jobId` 핸들러에서 `format=markdown` case 제거 (line 280~291)
- [x] `format=full`에서 `fullReport.markdown = job.report.markdown` 제거 (line 298)
- [x] format 검증에서 `"markdown"`, `"full"` 제거하여 `format=json`만 지원하거나, format 파라미터 자체 제거

#### 파일 삭제
- [x] `src/services/reportPipeline/visualizer.ts` 삭제
- [x] `src/services/reportPipeline/dotGridGenerator.ts` 삭제
- [x] `src/services/reportPipeline/renderer.ts` 삭제
- [x] `src/types/visualization.ts` 삭제

### 주의사항
- `clusterer.ts`의 `ClustererVisualization` (UMAP 좌표)은 유지 — 서브토픽 클러스터러가 centroid 계산에 사용
- `Report.dotGrid`와 `Report.markdown`이 사라지면 `routes/reports.ts`의 `/visualization`, `/markdown` 엔드포인트도 무의미해짐 — Story 2.4에서 제거
- `llm.ts`의 `parseJsonResponse()`에 있는 "markdown code fence 제거" 로직은 LLM 응답 파싱용이므로 유지 (renderer와 무관)

---

## Story 2.3: Legacy 파이프라인 제거

**수정 파일:** `src/services/reportPipeline/index.ts`, `src/services/reportPipeline/categorizer.legacy.ts`, `src/services/reportPipeline/clusterer.legacy.ts`, `src/services/reportPipeline/categorizer.ts`, `src/services/reportPipeline/clusterer.ts`, `src/types/report.ts`

### 배경
Conversation 파이프라인(EPIC1)이 구현된 후에도 Legacy 파이프라인이 유지되고 있다:

- `index.ts:55~68` — `LEGACY_STEPS` 12단계 정의
- `index.ts:149~216` — `generateLegacyReport()` 함수 전체
- `categorizer.legacy.ts`, `clusterer.legacy.ts` — LLM 기반 카테고리화/클러스터링 (임베딩 이전 방식)
- `categorizer.ts:338`, `clusterer.ts:265`, `index.ts:524~525` — legacy 모듈 re-export

Legacy는 메시지를 직접 임베딩하여 대화 맥락을 무시하므로, "AI Agent와 인간의 대화"를 분석하는 이 프로젝트의 취지와 맞지 않는다. 유지하면 파이프라인 변경 시 두 경로를 모두 고려해야 하는 부담이 있다.

### 참고 파일
- `src/services/reportPipeline/index.ts:133~144` — `generateReport()`의 pipelineMode 분기
- `src/services/reportPipeline/parser.ts` — Legacy 전용 파서 (유저 메시지만 추출)
- `src/types/report.ts:168` — `pipelineMode?: "legacy" | "conversation"`

### 태스크

#### 파이프라인 분기 제거
- [x] `src/services/reportPipeline/index.ts`의 `generateReport()`에서 pipelineMode 분기 제거, `generateConversationReport()`를 직접 호출하도록 변경
- [x] `generateLegacyReport()` 함수 전체 삭제
- [x] `LEGACY_STEPS` 상수 삭제
- [x] Legacy 전용 import 제거: `parseThreads`, `categorizeByEmbedding`, `initializeCategoryEmbeddings`, `calculateFilteringBreakdown`, `categorizeEmbeddedMessages`
- [x] Legacy re-export 제거: `export { categorizeMessages }`, `export { clusterMessages }` (index.ts:524~525)

#### Legacy 파일 삭제
- [x] `src/services/reportPipeline/categorizer.legacy.ts` 삭제
- [x] `src/services/reportPipeline/clusterer.legacy.ts` 삭제

#### Legacy re-export 정리
- [x] `src/services/reportPipeline/categorizer.ts:338`의 `export { categorizeMessages } from "./categorizer.legacy"` 제거
- [x] `src/services/reportPipeline/clusterer.ts:265`의 `export { clusterMessages } from "./clusterer.legacy"` 제거

#### 타입 정리
- [x] `src/types/report.ts`에서 `pipelineMode` 필드를 제거하거나 `"conversation"` 고정값으로 변경
- [x] `src/routes/reports.ts`에서 `pipelineMode` body 파라미터 처리 제거

### 주의사항
- `parser.ts` (Legacy 파서)는 당장 삭제하지 않음 — `parseThreads()`가 다른 곳에서 사용될 가능성 확인 후 별도 정리
- `categorizer.ts`의 임베딩 기반 카테고리화 로직은 유지 — conversation 파이프라인의 `toCategorizedEmbedded()`에서 호출하지 않더라도 향후 활용 가능

---

## Story 2.4: 부분 데이터 엔드포인트 통합

**수정 파일:** `src/routes/reports.ts`

### 배경
현재 같은 Report 데이터의 부분 뷰를 4개 별도 엔드포인트로 제공한다:

```
GET /:jobId/topics        → extractTopicsSummary(report)
GET /:jobId/visualization → report.visualization
GET /:jobId/statistics    → { statistics, synthesis }
GET /:jobId/markdown      → report.markdown
```

각 엔드포인트는 job 조회 → null 체크 → 완료 체크 → 데이터 추출이라는 동일한 보일러플레이트를 반복한다 (약 40줄 × 4 = 160줄). `GET /:jobId?format=json`으로 전체 데이터를 이미 받을 수 있으므로, `fields` 쿼리 파라미터로 통합 가능하다.

단, Story 2.2에서 visualization과 dotGrid가 제거되므로 `/visualization` 엔드포인트는 자동으로 무의미해진다.

### 참고 파일
- `src/routes/reports.ts:348~386` — `/markdown` 엔드포인트
- `src/routes/reports.ts:394~437` — `/topics` 엔드포인트
- `src/routes/reports.ts:445~486` — `/visualization` 엔드포인트
- `src/routes/reports.ts:494~538` — `/statistics` 엔드포인트

### 태스크

#### 엔드포인트 제거
- [x] `GET /:jobId/topics` 엔드포인트 삭제 (line 394~437)
- [x] `GET /:jobId/visualization` 엔드포인트 삭제 (line 445~486)
- [x] `GET /:jobId/statistics` 엔드포인트 삭제 (line 494~538)
- [x] `GET /:jobId/markdown` 엔드포인트 삭제 (line 348~386)
- [x] `createDefaultVisualization()` 헬퍼 함수 삭제 (line 19~34)

#### 기존 `GET /:jobId`에 fields 지원 추가
- [x] `GET /:jobId`에 `fields` 쿼리 파라미터 추가: `?fields=statistics,synthesis`
- [x] fields가 지정되면 Report에서 해당 필드만 추출하여 반환
- [x] fields가 미지정이면 기존처럼 전체 Report 반환
- [x] `format=markdown` 제거됨 (markdown 데이터 자체가 Story 2.2에서 삭제)

#### import 정리
- [x] `extractTopicsSummary`, `extractStatistics` import 제거 (Story 2.1에서 파일 삭제 후)
- [x] `VisualizationData` import 제거

### 주의사항
- `format=markdown`은 Content-Type이 `text/markdown`으로 다르므로 fields 방식이 아닌 format으로 유지하는 게 적절할 수 있음 — 판단 후 결정
- 외부 클라이언트가 부분 엔드포인트를 사용 중이라면 deprecation 기간 필요

---

## 구현 규칙

### 순서
- Story 2.1 → 2.2 → 2.3 → 2.4 순서로 진행 (타입 의존 관계)
- Story 2.1에서 T3C 타입을 제거해야 2.2에서 VisualizationData를 깔끔하게 제거 가능
- Story 2.3은 독립적이나, 파이프라인 단계 수가 2.2에서 먼저 줄어야 LEGACY_STEPS 정리가 깔끔

### 테스트
- 각 Story 완료 후 `pnpm build` (또는 `tsc --noEmit`)로 타입 에러 없음 확인
- 기존 테스트가 있다면 실행하여 regression 확인
- API 응답 구조 변경이므로 Postman/curl로 수동 검증 권장

### 금지사항
- 파이프라인의 핵심 로직(임베딩, 클러스터링, 의견 추출, 근거 연결, 종합)은 절대 변경하지 않는다
- `clusterer.ts`의 UMAP + K-means 로직과 `ClustererVisualization` 타입은 유지한다 (서브토픽 클러스터러 의존)
- 새로운 추상화나 래퍼를 도입하지 않는다 — 이 EPIC의 목적은 제거와 단순화

---

## 완료 조건
- [x] `src/utils/reportTransformer.ts` 파일이 삭제되었고 어디서도 import하지 않는다
- [x] `src/services/reportPipeline/visualizer.ts`, `dotGridGenerator.ts`, `renderer.ts` 파일이 삭제되었다
- [x] `src/services/reportPipeline/categorizer.legacy.ts`, `clusterer.legacy.ts` 파일이 삭제되었다
- [x] `src/types/visualization.ts` 파일이 삭제되었다
- [x] `src/types/report.ts`에서 `T3CReport`, `Topic`, `MessageRef`, `ReportMetadata`, `VisualizationData`, `RendererResult` 등 T3C 전용 타입이 제거되었다
- [x] `Report` 인터페이스에서 `markdown`, `visualization`, `dotGrid` 필드가 제거되었다
- [x] `GET /api/reports/:jobId` 응답이 `Report` 객체를 직접 반환한다
- [x] `format=markdown` 및 `format=full` 분기가 제거되었다
- [x] 부분 데이터 엔드포인트 4개가 제거되고 `fields` 쿼리로 통합되었다
- [x] Conversation 파이프라인이 정상 동작한다 (Legacy 분기 제거 후)
- [x] `pnpm build`가 타입 에러 없이 통과한다
- [x] 삭제된 파일에 대한 import가 코드베이스 전체에 남아있지 않다

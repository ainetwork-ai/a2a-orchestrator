# Talk to the City (T3C) 분석 문서

> tttc-light-js 레포지토리 기반 분석 (2026-04-06)

---

## 1. Talk to the City 철학

### 1.1 개요

Talk to the City(T3C)는 **AI Objectives Institute(AOI)** 가 개발한 오픈소스 숙의(deliberation) 도구다.
고 Peter Eckersley(Let's Encrypt 공동 설립자)가 세운 비영리 연구소에서 시작되었으며, 현재 Bruno Marnette, Colleen McKenzie 등이 핵심 개발을 이끌고 있다.

### 1.2 핵심 미션

대규모 공공 의견 수렴에서 **"깊이(depth) vs 규모(scale)"의 트레이드오프를 AI로 해결**하는 것이 핵심이다.

- 수천 명의 의견을 수집하면서도 **개인의 뉘앙스와 다양성을 보존**
- 모든 분석 결과가 **원문 인용에 직접 근거(grounding)** 하도록 설계하여 환각(hallucination) 위험 최소화
- 감사 가능성(auditability) 확보: 의사결정자가 넓은 주제에서 **개별 참여자의 정확한 발언까지 추적** 가능

### 1.3 실사용 사례

| 지역 | 활용 내용 |
|------|-----------|
| 대만 디지털부(moda) | AI 정책 분석, 2024년 선거 정당 공약 분석 |
| 일본 | 2024년 도쿄도지사 선거 앞두고 1000명 주민 정책 니즈 조사 |
| 호주, 미시간 | 정부/노조/시민단체 참여 |

### 1.4 기술 철학

- 기존 AI 요약 도구와 달리, **모든 주제와 의견이 참여자의 원문 인용에 직접 근거**
- 분석가가 클러스터 세분화 수준을 조절 가능
- LLM 기반이지만 **구조화된 파이프라인**으로 재현 가능성과 투명성 확보

---

## 2. Report 데이터 모델

### 2.1 핵심 계층 구조

```
ReportDataObj
├── title: string
├── description: string
├── date: string
├── topics: Topic[]                    ← 참여자 수 기준 내림차순 정렬
│   ├── id, title, description
│   ├── summary?, context?
│   ├── topicColor: TopicColors        ← "violet" | "blueSea" | "blueSky" | ...
│   └── subtopics: Subtopic[]
│       ├── id, title, description
│       └── claims: Claim[]            ← 재귀 구조
│           ├── id, title, number
│           ├── quotes: Quote[]
│           │   └── Quote
│           │       ├── id, text
│           │       └── reference: Reference
│           │           ├── interview (화자명)
│           │           ├── commentId (원문 ID)
│           │           └── data: TextMedia | VideoMedia | AudioMedia
│           └── similarClaims: Claim[] ← 중복 클레임 (재귀)
├── sources: Source[]                  ← 원본 데이터 (화자별)
│   ├── id, interview
│   └── data: MediaSource
├── questionAnswers?: QuestionAnswer[] ← 보고서 작성자 Q&A
├── addOns?: AddOns                    ← 선택적 고급 분석
│   ├── subtopicCruxes?: SubtopicCrux[]
│   ├── topicScores?: TopicScore[]
│   ├── speakerCruxMatrix?: SpeakerCruxMatrix
│   ├── claimBridgingScores?: ClaimBridgingScore[]
│   └── quoteBridgingScores?: QuoteBridgingScore[]
└── graphics?: PieChart
```

**핵심 파일**: `common/schema/index.ts` (line 974~1009)

### 2.2 ReportRef (Firestore 메타데이터)

Firestore `reportRef` 컬렉션에 저장되는 리포트 참조 문서:

```typescript
ReportRef = {
  id: string                    // Firebase document ID (stable report ID)
  userId: string                // 소유자
  reportDataUri: string         // GCS URL (실제 데이터 위치)
  title: string
  description: string
  numTopics: number
  numSubtopics: number
  numClaims: number
  numPeople: number
  createdDate: Date
  jobId?: string                // 파이프라인 작업 ID
  status?: ReportStatus         // "created" | "queued" | "processing" | "completed" | "failed" | "cancelled"
  processingSubState?: string   // "clustering" | "extraction" | "sorting" | "dedup" | "wrappingup" | "summarizing" | "scoring_bridging"
  lastStatusUpdate?: Date
  errorMessage?: string
  outputLanguage?: string       // 생성 언어 (기본값: "English")
  isPublic?: boolean            // 공개 여부 (신규 기본값: false)
  elicitationEventId?: string   // 연결된 설문 이벤트
  schemaVersion?: number
}
```

**핵심 파일**: `common/firebase/index.ts` (line 53~111)

### 2.3 ReportJob (파이프라인 작업 정보)

```typescript
ReportJob = {
  userId: string
  title: string
  description: string
  reportDataUri: string         // GCS URL
  createdAt: Date
  schemaVersion?: number
}
```

### 2.4 Report Metadata (비공개 메타데이터)

```typescript
ReportMetadataObj = {
  startTimestamp: number
  duration: number
  totalCost: string
  author: string
  organization?: string
}
```

---

## 3. 리포트 생성 파이프라인

### 3.1 전체 흐름

```
[Client]                  [Express Server]              [Queue]              [Pipeline Worker]           [Storage]
   │                           │                          │                        │                       │
   │  POST /create             │                          │                        │                       │
   │  (CSV + config) ────────► │                          │                        │                       │
   │                           │  1. CSV 보안 검증          │                        │                       │
   │                           │  2. GCS placeholder 저장 ─┼────────────────────────┼─────────────────────► │
   │                           │  3. ReportRef + Job 생성   │                        │                       │
   │                           │  4. PipelineJob enqueue ──► │                       │                       │
   │  ◄── { reportId, url }    │                          │                        │                       │
   │                           │                          │  dequeue ────────────►  │                       │
   │                           │                          │                        │  Step 1: Clustering    │
   │  GET /report/:id          │                          │                        │  Step 2: Extraction    │
   │  (polling) ─────────────► │  status 조회               │                        │  Step 3: Sort/Dedup    │
   │  ◄── { status: "..." }    │                          │                        │  Step 4: Summaries     │
   │                           │                          │                        │  Step 5: Cruxes (opt)  │
   │                           │                          │                        │                       │
   │                           │                          │                        │  결과 JSON 업로드 ────► │
   │                           │                          │                        │  ReportRef 상태 갱신    │
   │  GET /report/:id          │                          │                        │                       │
   │  ─────────────────────► │  status: "finished"        │                        │                       │
   │  ◄── { dataUrl, meta }    │  + GCS signed URL         │                        │                       │
```

### 3.2 파이프라인 단계 상세

| 순서 | 단계 | 디렉토리 | 설명 | 상태값 |
|------|------|----------|------|--------|
| 1 | **Clustering** | `pipeline-steps/clustering/` | 코멘트를 토픽/서브토픽으로 분류 (LLM) | `clustering` |
| 2 | **Claims Extraction** | `pipeline-steps/claims/` | 각 코멘트에서 핵심 주장 + 인용 추출 | `extraction` |
| 3 | **Sort & Dedup** | `pipeline-steps/sort-and-deduplicate/` | 유사 클레임 정렬/중복 제거, 화자 수 기준 정렬 | `sorting` → `dedup` |
| 4 | **Summaries** | `pipeline-steps/summaries/` | 토픽별 요약 생성 | `summarizing` |
| 5 | **Cruxes** (선택) | `pipeline-steps/cruxes/` | 핵심 쟁점(crux) 분석, 합의/대립 분류 | `scoring_bridging` |

### 3.3 파이프라인 인프라

- **큐**: Google Pub/Sub (`pipeline-worker/src/queue/googlepubsub.ts`)
- **상태 저장**: Redis 기반 (`pipeline-worker/src/pipeline-runner/state-store.ts`, TTL 24시간)
- **분산 락**: Redis 락으로 동시 실행 방지, Lua 스크립트 기반 atomic 검증
- **장애 복구**: 중간 상태 저장 + 재개(resume) 기능
- **타임아웃**: `PIPELINE_TIMEOUT_MS` 설정

### 3.4 파이프라인 출력 변환

파이프라인 결과물은 두 단계로 변환된다:

1. **`formatPipelineOutput()`** (`pipeline-runner/format-output.ts`)
   - 내부 `sortedTree` 형식 → `LLMPipelineOutput` 형식
   - taxonomy(토픽/서브토픽/클레임), 원본 데이터, 비용/시간 정보 포함

2. **`getReportDataObj()`** (`common/transforms/pipeline/index.ts`)
   - `LLMPipelineOutput` → 최종 `ReportDataObj`
   - ID 생성, 색상 할당, 정렬 등 UI 표시용 변환

---

## 4. API 엔드포인트

### 4.1 리포트 생성

```
POST /create
인증: 필수 (Firebase Auth)
Rate Limit: 2000 req/15min per IP
Body: {
  userConfig: LLMUserConfig,    // 제목, 설명, LLM 프롬프트, 언어 등
  data: ["csv", SourceRow[]],   // CSV 데이터
  elicitationEventId?: string,  // 설문 이벤트 연결 (선택)
  model?: string                // LLM 모델 선택 (기본값: gpt-4o-mini)
}
Response: {
  message: string,
  filename: string,
  jsonUrl: string,
  reportUrl: string             // 클라이언트 리포트 URL
}
```

**핵심 파일**: `express-server/src/routes/create.ts`

### 4.2 리포트 조회

```
GET /report/:identifier
인증: 선택 (비공개 리포트는 소유자만)
Rate Limit: 2000 req/15min per IP
Query Params: includeData=true (리포트 데이터 직접 포함, CORS 우회용)

identifier:
  - Firebase ID (20자 영숫자) → 현대 방식
  - GCS bucket/path → 레거시 방식

Response (완료 시): {
  status: "finished",
  dataUrl: string,              // GCS signed URL
  metadata: ReportRef,
  isOwner: boolean,
  reportData?: ReportDataObj    // includeData=true일 때만
}

Response (진행 중): {
  status: "queued" | "clustering" | "extraction" | ...,
  metadata: ReportRef,
  isOwner: boolean
}
```

**핵심 파일**: `express-server/src/routes/report.ts`

### 4.3 리포트 공개/비공개 전환

```
PATCH /report/:reportId/visibility
인증: 필수 (소유자만)
Rate Limit: 10 updates/report/user/hour
Body: { isPublic: boolean }
Response: { success: true, isPublic: boolean }
```

**핵심 파일**: `express-server/src/routes/reportVisibility.ts`

### 4.4 레거시 URL 마이그레이션 (deprecated)

```
GET /report/:reportUri/migrate
Response: { success: boolean, newUrl?: string, docId?: string }
```

### 4.5 설문 이벤트 기반 리포트 생성

```
POST /api/elicitation/events/:id/generate-report
```

---

## 5. 스토리지 아키텍처

### 5.1 Firestore 컬렉션

| 컬렉션 | 타입 | 용도 | 환경별 이름 |
|--------|------|------|-------------|
| `reportRef` | `ReportRef` | 리포트 메타데이터 + 접근 제어 | `reportRef` / `reportRef_dev` |
| `reportJob` | `ReportJob` | 파이프라인 작업 정보 | `reportJob` / `reportJob_dev` |
| `users` | `UserDocument` | 사용자 프로필 + 권한 | `users` / `users_dev` |

### 5.2 Google Cloud Storage (GCS)

- **파일명 규칙**: `{reportId}.json` (reportId 기반 안정 파일명)
- **URL 형식**: `https://storage.googleapis.com/{bucket}/{reportId}.json`
- **접근 제어**: 허용 버킷 리스트(`ALLOWED_GCS_BUCKETS`), signed URL로 임시 접근 제공
- **초기 상태**: placeholder JSON (`{ message: "Your data is being generated" }`)

### 5.3 Redis

- 파이프라인 실행 상태 저장 (TTL 24시간)
- 분산 락 관리
- Audit log 저장

---

## 6. 접근 제어

### 6.1 리포트 가시성

**핵심 파일**: `express-server/src/lib/reportPermissions.ts`

```
checkReportAccess(reportRef, requestingUserId):
  - isPublic === true     → 전체 공개
  - isPublic === false    → 소유자(userId)만 접근 가능
  - isPublic === undefined → 레거시 (기본 공개)

canModifyReport(reportRef, userId):
  - 소유자만 가시성 변경 가능
```

### 6.2 상태 판별 전략

3단계 전략으로 리포트 상태를 결정:

1. **Modern (빠름)**: `ReportRef.status` 필드 직접 사용 (신규 리포트)
2. **Legacy Complete (빠름)**: 메타데이터 기반 휴리스틱 (numTopics > 0, numClaims > 0, GCS URL 존재)
3. **Legacy Incomplete (느림)**: `ReportJob` 조회 또는 GCS 파일 존재 검증

---

## 7. 선택적 고급 기능

### 7.1 Cruxes (핵심 쟁점 분석)

```typescript
SubtopicCrux = {
  topic: string
  subtopic: string
  cruxClaim: string           // 논쟁적 주장
  agree: string[]             // 동의 화자 ("id:name" 형식)
  disagree: string[]          // 반대 화자
  no_clear_position: string[] // 입장 불명확
  explanation: string
  agreementScore: number      // 0~1
  disagreementScore: number   // 0~1
  controversyScore: number    // 0~1
}

SpeakerCruxMatrix = {
  speakers: string[]
  cruxLabels: string[]
  matrix: ("agree" | "disagree" | "no_position")[][]
}
```

### 7.2 Bridging Scores (다리 놓기 점수)

Perspective API를 활용하여 "분열을 넘어 연결하는" 의견에 점수를 부여:

```typescript
ClaimBridgingScore = {
  claimId: string
  personalStory: number   // 0~1 (개인 경험 공유)
  reasoning: number       // 0~1 (논리적 추론)
  curiosity: number       // 0~1 (호기심/열린 태도)
  toxicity: number        // 0~1 (독성, 감점 요소)
  bridgingScore: number   // 0~3.0 (종합)
}
```

---

## 8. Elicitation (설문 수집) 연동

T3C는 자체 설문 수집 시스템과 연동된다:

```typescript
ElicitationEventSummary = {
  id: string
  eventName: string
  description?: string
  ownerUserId: string
  responderCount: number
  status?: "draft" | "active" | "completed" | "archived"
  mode: "followup" | "listener" | "survey"
  mainQuestion?: string
  questions?: { id, text, asked_count }[]
  reportIds?: string[]          // 연결된 리포트들
  whatsappLink?: string         // WhatsApp 참여 링크
  expectedParticipantCount?: number
}
```

설문 이벤트에서 수집된 응답 데이터를 바로 리포트로 변환할 수 있으며, 하나의 이벤트에 여러 리포트를 생성할 수 있다.

---

## 9. 핵심 파일 맵

| 영역 | 파일 경로 |
|------|-----------|
| **Report 스키마** | `common/schema/index.ts` |
| **Firebase 타입** | `common/firebase/index.ts` |
| **API 타입** | `common/api/index.ts` |
| **스키마 변환** | `common/transforms/pipeline/index.ts` |
| **리포트 생성 API** | `express-server/src/routes/create.ts` |
| **리포트 조회 API** | `express-server/src/routes/report.ts` |
| **가시성 API** | `express-server/src/routes/reportVisibility.ts` |
| **접근 제어** | `express-server/src/lib/reportPermissions.ts` |
| **Firebase 연동** | `express-server/src/Firebase.ts` |
| **파이프라인 러너** | `pipeline-worker/src/pipeline-runner/runner.ts` |
| **출력 포매터** | `pipeline-worker/src/pipeline-runner/format-output.ts` |
| **상태 저장소** | `pipeline-worker/src/pipeline-runner/state-store.ts` |
| **큐 핸들러** | `pipeline-worker/src/queue/handler.ts` |
| **클러스터링** | `pipeline-worker/src/pipeline-steps/clustering/` |
| **클레임 추출** | `pipeline-worker/src/pipeline-steps/claims/` |
| **정렬/중복제거** | `pipeline-worker/src/pipeline-steps/sort-and-deduplicate/` |
| **요약 생성** | `pipeline-worker/src/pipeline-steps/summaries/` |
| **쟁점 분석** | `pipeline-worker/src/pipeline-steps/cruxes/` |
| **프론트엔드 스토어** | `next-client/src/stores/reportStore.ts` |
| **리포트 컴포넌트** | `next-client/src/components/report/Report.tsx` |
| **응답 핸들러** | `next-client/src/lib/report/handleResponseData.ts` |

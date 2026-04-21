# T3C vs AINSPACE 리포트 파이프라인 비교 분석

> tttc-light-js와 a2a-orchestrator의 구조적 비교 (2026-04-06)

---

## 1. 철학 & 목적

| | T3C (tttc-light-js) | AINSPACE (a2a-orchestrator) |
|---|---------------------|---------------------------|
| **미션** | 대규모 공공 숙의(deliberation)를 AI로 확장 | AI Agent-사용자 대화에서 집단 의견을 구조화 |
| **사용자** | 정부, 시민단체, 연구기관 | 내부 서비스 (AI Agent 운영팀) |
| **입력** | 시민이 직접 작성한 코멘트 (CSV) | AI Agent와 사용자의 대화 스레드 |
| **핵심 가치** | 모든 분석이 원문 인용에 근거 (auditability) | 대화 맥락 보존 + 의견 진화 추적 |
| **규모** | 수천~수만 명의 코멘트 | 다수 스레드의 Agent-사용자 대화 |

---

## 2. 데이터 입력 비교

### T3C: 정적 코멘트
```
CSV 업로드 → 코멘트 1건 = 분석 단위 1건
┌─────────────────────────────────────┐
│ comment: "대중교통이 부족합니다"       │
│ interview: "참여자A"                  │
│ id: "cm1"                            │
└─────────────────────────────────────┘
```
- 1인 1코멘트 (또는 다수), 독립적 의견
- 맥락 없음 — 코멘트 자체가 의견의 전부

### AINSPACE: 대화 세그먼트
```
대화 스레드 → 세그먼트 분할 → 의견 추출
┌──────────────────────────────────────────────┐
│ [Agent] 이 기능에 대해 어떻게 생각하세요?       │
│ [User]  처음엔 좋았는데 느려서 안 쓰게 됐어요   │
│ [Agent] 어떤 부분이 느렸나요?                   │
│ [User]  검색할 때 3초 이상 걸려요               │
└──────────────────────────────────────────────┘
  → ExtractedOpinion: "검색 속도가 느려 사용을 중단함"
    stance: "oppose", evolved: true
```
- Agent 메시지 = 맥락 (분석 대상 아님)
- 대화 흐름에서 의견 변화(evolved) 감지
- 세그먼트 분할: 5분 침묵 / 에이전트 변경 / 20메시지 상한

---

## 3. 파이프라인 비교

### 3.1 전체 흐름 대조

```
T3C                                    AINSPACE (Conversation)
────────────────────                   ────────────────────────
1. CSV 파싱                             1. 대화 세그먼트 분할
                                        2. LLM 의견 추출 (agent=맥락)
2. LLM 의견 추출 (코멘트→claim)          ↓ (opinions → messages 변환)
3. 임베딩 (UMAP+HDBSCAN)               3. 임베딩 (OpenAI)
4. 클러스터링 (GPT-4 라벨링)             4. 클러스터링 (UMAP + K-means)
5. 중복 제거 (LLM)                      5. 서브토픽 클러스터링
6. 토픽 요약 (LLM)                      6. 클러스터 분석 (LLM: 라벨, 의견, 요약)
                                        7. 근거 연결 (LLM: opinion↔message 매핑)
                                        8. 통계 계산
7. 리포트 포맷 변환                      9. 종합 인사이트 (LLM)
8. GCS 업로드                           10. 시각화 생성
                                        11. 점 그리드 생성
                                        12. 마크다운 렌더링
```

### 3.2 단계별 비교

| 단계 | T3C | AINSPACE | 차이점 |
|------|-----|---------|--------|
| **파싱** | CSV → SourceRow[] | Thread → ConversationSegment[] | T3C는 정적 데이터, AINSPACE는 라이브 대화 |
| **의견 추출** | 코멘트에서 직접 claim 추출 | 대화 맥락(agent 포함) 기반 opinion 추출 | AINSPACE는 agent 응답을 맥락으로 활용 |
| **카테고리화** | 없음 (추출이 곧 분류) | 임베딩 유사도 기반 (LLM 불필요) | AINSPACE는 substantive 필터링 포함 |
| **클러스터링** | UMAP + HDBSCAN + GPT-4 | UMAP + K-means (LLM 불필요) | AINSPACE가 비용 효율적, 결정론적 |
| **서브토픽** | 없음 (claim이 곧 세부) | K-means 서브클러스터링 | AINSPACE는 토픽 내 세분화 별도 수행 |
| **중복 제거** | LLM 기반 dedup | 없음 (K-means이 자연 분리) | 접근 방식 자체가 다름 |
| **근거 연결** | claim → quote → reference (내장) | LLM이 opinion ↔ message 매핑 | T3C는 추출 시 내장, AINSPACE는 별도 단계 |
| **요약** | 토픽별 summary (LLM) | consensus/conflicting + 액션 아이템 (LLM) | AINSPACE는 actionable 인사이트 강조 |
| **종합** | 없음 (토픽별만) | 전체 종합: keyFindings, topPriorities, executiveSummary | AINSPACE는 의사결정용 종합 제공 |
| **시각화** | 프론트엔드 렌더링 | 백엔드에서 데이터 생성 (scatter, tree, chart, dotGrid) | AINSPACE는 시각화 데이터까지 서버에서 생성 |

### 3.3 LLM 사용 비교

| 단계 | T3C | AINSPACE |
|------|-----|---------|
| 의견 추출 | O (GPT-4o-mini) | O (conversation 모드만) |
| 카테고리화 | X | X (임베딩 기반) |
| 클러스터링 | O (GPT-4) | X (K-means) |
| 중복 제거 | O | X |
| 라벨링/분석 | O | O |
| 근거 연결 | X (추출 시 내장) | O |
| 요약/종합 | O | O |
| **총 LLM 호출** | **4~5단계** | **3~4단계** |

AINSPACE는 클러스터링/카테고리화에서 LLM을 제거하여 **비용 절감 + 결정론적 결과**를 달성.

---

## 4. 데이터 모델 비교

### 4.1 최상위 리포트

| 필드 | T3C `ReportDataObj` | AINSPACE `Report` |
|------|--------------------|--------------------|
| 토픽 목록 | `topics: Topic[]` | `clusters: MessageClusterWithSubtopics[]` |
| 원본 데이터 | `sources: Source[]` | (메시지가 클러스터 내 포함) |
| 종합 분석 | 없음 | `synthesis: ReportSynthesis` |
| 시각화 | 없음 (프론트엔드) | `visualization: VisualizationData` |
| 점 그리드 | 없음 (프론트엔드) | `dotGrid: DotGridVisualization` |
| 마크다운 | 없음 | `markdown: string` |
| 대화 데이터 | 없음 | `extractedOpinions`, `conversationSegments` |
| 메타데이터 | `reportMetadataObj` (별도) | `ReportMetadata` (T3CReport에 내장) |

### 4.2 의견(Opinion) 구조

```
T3C: Claim                              AINSPACE: Opinion
─────────────                           ──────────────────
id: string                              id: string
title: string                           text: string
                                        type: "consensus"|"conflicting"|"general"
quotes: Quote[]                         supportingMessages: string[]
  └─ reference: { interview, commentId}  mentionCount: number
     rawQuote, paraphrased              representativeQuote?: string
                                        confidence?: number
similarClaims: Claim[] (재귀)            sourceSegmentIds?: string[]  ← EPIC1
number: number                          ─
```

**핵심 차이**: T3C는 claim이 quote를 직접 포함(재귀 구조)하는 반면, AINSPACE는 opinion이 message ID로 참조하고 별도 grounding 단계에서 연결.

### 4.3 토픽 계층

```
T3C                                    AINSPACE
─────                                  ──────────
Topic                                  MessageClusterWithSubtopics
├── Subtopic                           ├── Subtopic
│   └── Claim                          │   └── messageIds[]
│       └── Quote                      ├── Opinion
│           └── Reference              │   ├── supportingMessages[]
│               └── interview (화자)    │   └── representativeQuote
└── (topicColor)                       ├── messages: CategorizedMessage[]
                                       ├── summary: ClusterSummary
                                       └── nextSteps: ActionItem[]
```

T3C는 **Claim > Quote > Reference** 로 원문까지 드릴다운. AINSPACE는 **Opinion + Message[]** 를 병렬 배치하고 ID 참조로 연결.

---

## 5. 아키텍처 비교

### 5.1 인프라

```
T3C                                    AINSPACE
─────                                  ──────────
[Next.js Client]                       [External Client]
      │                                      │
[Express Server]                       [Express Server]
      │                                      │
[Google Pub/Sub] ← 비동기 큐            [ReportService] ← 동기 실행
      │                                      │
[Pipeline Worker] ← 별도 프로세스        [Pipeline] ← 같은 프로세스
      │                                      │
[Firestore] + [GCS]                    [In-memory] + [Redis 캐시]
```

| | T3C | AINSPACE |
|---|-----|---------|
| **큐** | Google Pub/Sub (분산) | 없음 (동기 실행) |
| **Worker** | 별도 프로세스 (pipeline-worker) | 같은 프로세스 내 |
| **DB** | Firestore (ReportRef, ReportJob) | 인메모리 Map |
| **파일 저장** | GCS (signed URL) | 없음 (메모리 내 Report 객체) |
| **캐시** | 없음 (파일 기반) | Redis (임베딩 + 리포트, TTL 1시간) |
| **상태 관리** | Firestore status + Redis 파이프라인 상태 | Job.status 인메모리 |
| **장애 복구** | Redis 상태 저장 + 재개 | 없음 (실패 시 재실행) |
| **분산 락** | Redis Lua 스크립트 | 없음 (단일 프로세스) |

### 5.2 인증 & 접근 제어

| | T3C | AINSPACE |
|---|-----|---------|
| **인증** | Firebase Auth (필수) | 없음 |
| **리포트 공개** | isPublic 필드 (소유자/공개) | 모든 리포트 접근 가능 |
| **가시성 변경** | `PATCH /report/:id/visibility` | 없음 |
| **사용자 관리** | UserDocument (역할, 프로필) | 없음 |
| **CSV 크기 제한** | 역할 기반 (role → capability) | 없음 |

---

## 6. API 설계 비교

### 6.1 리포트 생성

| | T3C | AINSPACE |
|---|-----|---------|
| **엔드포인트** | `POST /create` | `POST /api/reports` |
| **인증** | Firebase token 필수 | 불필요 |
| **데이터 전달** | Body에 CSV 데이터 포함 | threadIds/agentNames로 서버 내부 데이터 참조 |
| **응답** | `{ reportUrl, jsonUrl }` | `{ jobId, status, report? }` |
| **캐시 히트** | 없음 (항상 새로 생성) | 동일 params면 캐시된 리포트 즉시 반환 |

### 6.2 리포트 조회

| | T3C | AINSPACE |
|---|-----|---------|
| **엔드포인트** | `GET /report/:identifier` | `GET /api/reports/:jobId` |
| **식별자** | Firebase ID 또는 레거시 URL | UUID jobId |
| **상태 폴링** | status 필드 확인 | status + progress (step/percentage) |
| **데이터 제공** | GCS signed URL → 클라이언트가 다운로드 | 서버가 직접 JSON 반환 |
| **포맷 선택** | 없음 (항상 전체) | `format=json\|markdown\|full` |
| **부분 조회** | 없음 | `/topics`, `/visualization`, `/statistics`, `/markdown` |

### 6.3 리포트 관리

| 기능 | T3C | AINSPACE |
|------|-----|---------|
| **목록 조회** | 없음 (프론트엔드에서 Firestore 직접 쿼리) | `GET /api/reports` (페이지네이션, 필터, 검색) |
| **메타데이터 수정** | 없음 | `PATCH /api/reports/:jobId` |
| **삭제** | 없음 | `DELETE /api/reports/:jobId` |
| **캐시 무효화** | 없음 | `DELETE /api/reports/cache` |

---

## 7. 의견 분류 체계 비교

### T3C
```
Claim.type: 없음 (claim은 단순 사실적 주장)
Opinion 분류: consensus | conflicting (ClusterSummary 수준에서)
Sentiment: 없음 (claim 수준)
```

### AINSPACE
```
Opinion.type:  consensus | conflicting | general
Stance:        support | oppose | neutral | request | question  ← EPIC1 ExtractedOpinion
Sentiment:     positive | negative | neutral                    ← CategorizedMessage
Evolved:       boolean                                          ← 의견 변화 감지
Confidence:    0.0~1.0                                          ← 확신도
```

AINSPACE는 **5가지 stance + 3가지 sentiment + 의견 진화 + 확신도**로 훨씬 다차원적인 분류를 제공.

---

## 8. 시각화 비교

| 시각화 유형 | T3C | AINSPACE |
|------------|-----|---------|
| **스캐터 플롯** | 프론트엔드 렌더링 (UMAP 좌표) | 백엔드에서 `ScatterPlotData` 생성 |
| **토픽 트리** | 프론트엔드 렌더링 | 백엔드에서 `TopicTreeData` (nodes + links) 생성 |
| **차트** | 프론트엔드 | 백엔드에서 `ChartData` (bar/pie/line/area) 생성 |
| **점 그리드** | 프론트엔드 (T3C 핵심 UI) | 백엔드에서 `DotGridVisualization` 생성 |
| **색상** | 서버에서 `topicColor` 지정 | 프론트엔드에서 subtopicIndex 기반 생성 |

AINSPACE는 시각화 **데이터를 서버에서 완전히 생성**하여 프론트엔드 부담을 줄이는 반면, T3C는 프론트엔드가 원본 데이터로부터 직접 시각화를 구성.

---

## 9. 확장성 & 한계 비교

| 측면 | T3C | AINSPACE |
|------|-----|---------|
| **수평 확장** | Pub/Sub + Worker 분리로 독립 스케일링 가능 | 단일 프로세스, 수평 확장 불가 |
| **장애 복구** | Redis 상태 저장 + 파이프라인 재개 | 실패 시 처음부터 재실행 |
| **데이터 영속성** | Firestore + GCS (영구 보관) | 인메모리 (서버 재시작 시 소실) |
| **동시 처리** | 여러 Worker가 병렬 처리 | 동시 요청은 순차 처리 |
| **비용** | GPT-4 클러스터링으로 높은 LLM 비용 | 임베딩 기반으로 LLM 비용 절감 |
| **결정론성** | LLM 의존으로 비결정론적 | K-means로 결정론적 클러스터링 |
| **캐싱** | 없음 | Redis 기반 임베딩/리포트 캐시 |

---

## 10. 정리: 무엇을 차용했고, 무엇이 다른가

### 차용한 것 (T3C → AINSPACE)

1. **"드릴다운 가능한 계층 구조"** 철학: Topic > Subtopic > Opinion > 원문 추적
2. **Grounding 개념**: 모든 의견이 원문 메시지에 근거하도록 연결
3. **Dot Grid 시각화**: T3C의 핵심 UI 패턴을 데이터 구조로 구현
4. **T3CReport 변환 포맷**: API 응답을 T3C 호환 형태로 변환하는 레이어

### 독자적 설계

1. **대화 세그먼트 파이프라인**: Agent 응답을 맥락으로 활용하는 의견 추출
2. **의견 진화 추적**: 대화 중 입장 변화를 `evolved` 플래그로 감지
3. **5가지 stance 분류**: T3C의 단순 sentiment를 넘어선 다차원 분류
4. **임베딩 기반 클러스터링**: LLM 없이 UMAP + K-means로 비용/결정론성 확보
5. **ActionItem 중심 종합**: 단순 요약이 아닌 우선순위화된 액션 아이템 도출
6. **서버 사이드 시각화 데이터**: 프론트엔드 독립적인 시각화 데이터 생성
7. **듀얼 파이프라인**: Legacy(메시지 직접) + Conversation(대화 맥락) 선택 가능

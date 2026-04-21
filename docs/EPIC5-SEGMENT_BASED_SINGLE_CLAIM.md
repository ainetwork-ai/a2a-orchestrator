# EPIC5 - Segment-Based Single Claim Extraction (세그먼트 기반 단일 Claim 추출)

> 200 스레드에서 ~1700 claims가 추출되는 과다 추출 문제를 해결한다. 세그먼트를 주제 단위로 분할하고, 세그먼트당 정확히 1개의 종합 claim만 추출한다.

## 의존성
- EPIC4 (Opinion Extraction Enhancement) — 완료됨

## 목표
- 물리적 세그먼트 분할(시간/메시지 수)을 주제 기반 분할로 개선한다
- 세그먼트당 정확히 1개의 종합 claim만 추출하도록 제한한다
- claim 수를 ~1700 → ~600-800으로 줄이면서 정보 손실을 최소화한다
- Agent 반복 claim과 턴별 중복 추출을 근본적으로 해소한다

---

## Story 5.1: 프롬프트를 단일 Claim 추출로 변경 (Quick Win)

**수정 파일:** `src/services/reportPipeline/opinionExtractor.ts`

### 배경
현재 `extractFromSegment()`는 세그먼트 하나에서 복수의 opinion을 추출한다. `Promise.all`로 모든 세그먼트를 병렬 처리하고 결과를 모두 합산하므로 (index.ts:48~68), 세그먼트 수 × 세그먼트당 평균 claim 수 = 총 claim 수가 된다.

현재 200 스레드 → ~700 세그먼트 → 세그먼트당 ~2.4 claims → ~1700 total.
프롬프트를 "정확히 1개의 종합 claim"으로 변경하면 ~700으로 즉시 절반 감소.

**핵심 문제**: 프롬프트가 `"opinions": [...]` 배열을 반환하도록 되어있어 LLM이 자연스럽게 복수를 생성한다.

### 참고 파일
- `src/services/reportPipeline/opinionExtractor.ts:167~218` — 현재 프롬프트 전문
- `src/services/reportPipeline/opinionExtractor.ts:48~68` — 결과 합산 로직

### 태스크

#### 프롬프트 변경
- [x] `buildExtractionPrompt()`의 Instructions 서두를 "Extract exactly ONE consolidated opinion" 으로 변경
- [x] 단일 추출 규칙 추가 ("MUST return exactly ONE", "choose the most substantive", speaker = 주요 발화자)
- [x] JSON 응답 형식에 "Return exactly ONE item in the array, or an empty array" 명시

#### 파싱 방어 로직
- [x] `.slice(0, 1)` 방어 로직 추가

### 주의사항
- 이 Story만으로 claim 수가 ~700 이하로 줄어듦 (품질 기준으로 빈 세그먼트 발생하므로 ~500-700)
- 세그먼트 분할 자체는 변경하지 않음 — Story 5.2에서 개선
- speaker: 종합 claim이므로 단일 speaker가 아닐 수 있음. 프롬프트에 "가장 핵심 발화를 한 참여자를 speaker로, 부차적 참여자는 quote에 반영"하도록 지시
- 빈 세그먼트 (LLM이 0개 반환): 정상 동작. 잡담/인사만 있는 세그먼트는 추출 안 하는 게 맞음. 방어 로직은 `.slice(0, 1)`이므로 빈 배열도 통과
- 한 세그먼트에 다른 주제 2개 → 5.1에서는 정보 손실 가능 (더 substantive한 1개만). 5.2에서 주제 기반 분할로 해소

---

## Story 5.2: 주제 기반 세그먼트 분할

**수정 파일:** `src/services/reportPipeline/conversationParser.ts`, `src/services/reportPipeline/index.ts`, `src/services/reportPipeline/embedder.ts`

### 배경
현재 `splitIntoSegments()` (conversationParser.ts:88~149)는 물리적 기준으로 분할한다:
- 5분 시간 간격 (`SEGMENT_TIME_GAP_MS`)
- Agent 변경
- 20 메시지 상한 (`MAX_SEGMENT_MESSAGES`)

이 기준은 주제 전환과 무관하다. 같은 주제가 20 메시지를 넘으면 잘리고, 주제가 바뀌어도 시간이 연속이면 같은 세그먼트에 포함된다. 주제 기반 분할을 위해 메시지 임베딩의 코사인 유사도를 사용하여 topic shift를 감지한다.

**접근 방식**: 파이프라인 순서를 조정하여 임베딩을 세그먼트 분할 전에 수행한다.

현재: `Parse → Segment → Extract → Embed → Cluster`
변경: `Parse → Embed messages → Segment (embedding 기반) → Extract → Embed claims → Cluster`

### 참고 파일
- `src/services/reportPipeline/conversationParser.ts:24~26` — 현재 분할 상수
- `src/services/reportPipeline/embedder.ts:85~105` — `embedMessages()` 함수 (재활용)
- `src/services/reportPipeline/pipelineUtils.ts:116~122` — `opinionsToParsedMessages()` (claim 임베딩용)

### 태스크

#### 코사인 유사도 함수 추가
- [x] `conversationParser.ts`에 `cosineSimilarity()` 함수 추가

#### splitIntoSegments 확장
- [x] `splitIntoSegments()`에 optional `embeddings?: Map<string, number[]>` 파라미터 추가
- [x] 연속 메시지 간 코사인 유사도 < TOPIC_SHIFT_THRESHOLD 이면 분할
- [x] 기존 물리적 기준 유지 (OR 조건)
- [x] MAX_SEGMENT_MESSAGES 상한 유지

#### 파이프라인 순서 조정
- [x] 새 순서: 메시지 수집 → 메시지 임베딩 → 주제 분할 → claim 추출 → claim 임베딩 → 클러스터링
- [x] `parseConversations()`에 `embeddings?` 파라미터 추가
- [x] PIPELINE_STEPS 9단계로 업데이트

#### 설정 상수 추가
- [x] `TOPIC_SHIFT_THRESHOLD = 0.65` 추가
- [x] 기존 상수 유지

### 주의사항
- 임베딩 비용 증가: raw 메시지 ~6000개 (200 스레드 × ~30 메시지) 추가 임베딩. 첫 실행 시 임베딩 단계 ~3배 느려짐 (이후 Redis 캐시 히트로 완화)
- `TOPIC_SHIFT_THRESHOLD`는 실험적으로 조정 필요 — 0.5, 0.65, 0.8로 테스트 권장. 너무 높으면(0.8+) 거의 모든 턴에서 분할, 너무 낮으면(0.5 미만) 물리적 분할과 차이 없음
- Agent 변경 분할은 유지 — 다른 Agent와의 대화는 주제가 같아도 별도 세그먼트가 맞음

---

## Story 5.3: 통계 및 문서 업데이트

**수정 파일:** `src/services/reportPipeline/analyzer.ts`, `docs/API_REPORT_SPEC.md`

### 배경
세그먼트당 1 claim으로 변경되면 `ReportStatistics`에 세그먼트 관련 통계가 의미 있어진다. 또한 claim 수 감소에 따른 API 명세 업데이트가 필요하다.

### 참고 파일
- `src/services/reportPipeline/analyzer.ts` — `analyzeData()` 함수
- `src/types/report.ts` — `ReportStatistics` 타입
- `docs/API_REPORT_SPEC.md` — API 명세

### 태스크

#### 통계 추가
- [x] `ReportStatistics`에 `totalSegments: number` 필드 추가
- [x] `analyzeData()`에 세그먼트 수 전달 및 집계

#### API 명세 업데이트
- [x] `docs/API_REPORT_SPEC.md`의 `ReportStatistics` 타입에 `totalSegments`, `speakerDistribution` 추가
- [x] Pipeline Steps 9단계로 업데이트 (임베딩 기반 세그먼트 분할 반영)
- [x] "세그먼트당 0~1 claim" 정책 명시

### 주의사항
- `totalSegments >= totalOpinions`이어야 정상 (빈 세그먼트 가능) — validator에서 검증 추가 고려

---

## 구현 규칙

### 순서
- Story 5.1 → 5.2 → 5.3 순서로 진행
- Story 5.1만으로 claim 수 ~60% 감소 달성 (Quick Win)
- Story 5.2는 품질 개선 (주제 일관성 향상)
- Story 5.3은 마무리 (통계/문서)

### 테스트
- Story 5.1 후: 동일 200 스레드 데이터로 리포트 생성하여 claim 수 비교 (목표: ~700)
- Story 5.2 후: 세그먼트 분할이 주제 전환 시점과 일치하는지 샘플 검증
- `TOPIC_SHIFT_THRESHOLD` 조정: 0.5, 0.65, 0.8로 각각 테스트하여 최적값 결정

### 금지사항
- 클러스터링 로직(UMAP, K-means)은 변경하지 않는다
- 기존 API 엔드포인트 구조는 변경하지 않는다
- 레거시 리포트 호환을 깨뜨리지 않는다
- LLM 호출 횟수를 늘리지 않는다 (세그먼트 분할은 임베딩 기반, LLM 불필요)

### 퍼포먼스 고려사항
- Story 5.1: LLM 호출 수 변화 없음 (세그먼트 수 동일, 추출 결과만 줄어듦), 토큰 사용 약간 증가 (프롬프트 길어짐)
- Story 5.2: 임베딩 비용 증가 (raw 메시지 임베딩 추가), 단 Redis 캐시로 동일 메시지 재처리 시 0원. LLM 호출 수는 세그먼트 수 변화에 비례
- 클러스터링: claim 수 감소로 UMAP + K-means 속도 개선 (1700개 → 700개 벡터 처리)

---

## 완료 조건
- [x] 프롬프트가 세그먼트당 정확히 1개의 종합 claim을 요청한다
- [x] 파싱에서 복수 claim 반환 시 첫 번째만 사용하는 방어 로직이 있다
- [ ] 200 스레드 기준 claim 수가 ~1700에서 ~600-800으로 감소한다 (실제 테스트 필요)
- [x] 세그먼트가 메시지 임베딩 코사인 유사도 기반으로 주제 전환 시점에서 분할된다
- [x] 기존 물리적 분할 기준(시간 간격, Agent 변경, 메시지 상한)이 유지된다
- [x] `tsc --noEmit`이 타입 에러 없이 통과한다
- [x] 레거시 리포트 조회가 정상 동작한다

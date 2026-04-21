# EPIC4 - Opinion Extraction Enhancement (의견 추출 고도화)

> 의견 추출 프롬프트 품질 보강, Quote 원문 발췌 도입, Agent를 동등한 대화 참여자로 취급하여 AINSPACE 고유의 "대화 기반 분석" 가치를 실현한다.

## 의존성
- EPIC3 (Pipeline Opinion Flow Streamline) — 완료됨

## 목표
- 추출 프롬프트에 T3C 수준의 품질 기준/confidence 가이드/evolved 판별 기준을 도입한다
- Quote.text를 LLM 발췌 인용문으로 교체하여 T3C의 quote 품질을 달성한다
- Agent를 맥락 제공자가 아닌 동등한 대화 참여자로 취급한다 (AINSPACE 이념)
- analyzeClusters에 ExtractedOpinion 메타데이터를 전달하여 summary 품질을 높인다

---

## Story 4.1: 추출 프롬프트 품질 보강

**수정 파일:** `src/services/reportPipeline/opinionExtractor.ts`

### 배경
현재 `buildExtractionPrompt()` (opinionExtractor.ts:151~200)의 프롬프트는 품질 기준이 없어 약한 발화("네 맞아요", "그건 좀...")도 의견으로 추출된다. confidence 판별 기준표가 없어 LLM마다 일관성이 떨어지고, evolved 판별 기준도 모호하다. T3C의 `defaultExtractionPrompt`는 "genuinely debatable positions만 추출", "noise보다 miss를 선택" 같은 명확한 기준을 가진다.

### 참고 파일
- `/Users/comcom/tttc-light-js/common/prompts/index.ts:61~93` — T3C의 defaultExtractionPrompt (품질 기준 참고)

### 태스크

#### 프롬프트 품질 기준 추가
- [x] `buildExtractionPrompt()`의 Rules 섹션에 T3C 참고 품질 기준 추가
- [x] 추출 단위 가이드 추가

#### Statement 품질 기준 변경
- [x] Instructions의 "Write a self-contained statement" → "Write a concise, debatable claim that others could agree or disagree with"

#### Confidence 기준표 추가
- [x] 프롬프트에 confidence 판별 기준표 추가:
  ```
  Confidence guide:
  - 0.9+: explicit, decisive ("must", "absolutely", "definitely")
  - 0.6-0.8: has opinion but hedged ("I think", "it would be nice if")
  - 0.3-0.5: weak preference or questioning ("maybe?", "what about")
  - 0.1-0.2: barely expressed, speculative
  ```

#### Evolved 판별 기준 추가
- [x] 프롬프트에 evolved 판별 기준 추가:
  ```
  evolved = true ONLY when:
  - User initially opposed something but later agreed (or vice versa)
  - User's position clearly shifted after agent's explanation
  evolved = false when:
  - User elaborates on the same opinion with more detail
  - User provides additional information but stance remains the same
  ```

#### 암묵적 의견 패턴 추가
- [x] Rules에 암묵적 의견 패턴 추가

#### 출력 언어 일관성
- [x] 프롬프트에 "Write the statement in the same language as the conversation" 명시
- [x] JSON 예시에 한국어 예시 병기

### 주의사항
- 프롬프트만 변경하므로 타입/파싱 로직 변경 없음
- 기존 파싱 로직(line 110~136)이 그대로 동작해야 함

---

## Story 4.2: analyzeClusters에 ExtractedOpinion 컨텍스트 전달 (EPIC3 이관)

**수정 파일:** `src/services/reportPipeline/clusterAnalyzer.ts`, `src/services/reportPipeline/index.ts`

### 배경
현재 `analyzeClusters()` (clusterAnalyzer.ts:43~48)는 `(clusters, apiUrl, model, language)` 시그니처로, 클러스터 내 메시지의 `content`(opinion statement 텍스트)만 프롬프트에 전달한다. ExtractedOpinion의 `stance`/`confidence` 메타데이터가 빠져있어 summary(consensus/conflicting) 품질이 떨어진다.

**매핑 관계**: `cluster.messages[i].id === ExtractedOpinion.id` — `pipelineUtils.ts`의 `opinionsToParsedMessages()`에서 `op.id`를 `ParsedMessage.id`로 매핑하기 때문.

### 참고 파일
- `src/services/reportPipeline/index.ts:212` — `analyzeClusters()` 호출부
- `src/services/reportPipeline/pipelineUtils.ts:115~122` — `opinionsToParsedMessages()` 매핑

### 태스크

#### 함수 시그니처 변경
- [x] `analyzeClusters()`에 `extractedOpinions?: ExtractedOpinion[]` 파라미터 추가
- [x] `analyzeCluster()`에도 `opinionMap` 전달

#### 프롬프트에 메타데이터 추가
- [x] `analyzeCluster()` 내부에서 `cluster.messages[].id`로 ExtractedOpinion Map을 조회하여 stance/confidence 정보를 프롬프트에 포함
- [x] opinionMap 있으면 "Opinions extracted from conversations" 섹션으로 대체, 없으면 기존 "Examples INSIDE" 폴백

#### index.ts 호출부 변경
- [x] `index.ts`의 `analyzeClusters()` 호출에 `extractedOpinions` 전달

### 주의사항
- `extractedOpinions`가 undefined일 수 있으므로 (레거시 호환) optional 처리
- 별도 커밋으로 Story 4.1과 분리 권장

---

## Story 4.3: Quote에 LLM 원문 발췌 추가

**수정 파일:** `src/services/reportPipeline/opinionExtractor.ts`, `src/types/report.ts`, `src/services/reportPipeline/index.ts`

### 배경
현재 `Quote.text`는 `index.ts`에서 세그먼트 메시지의 전체 원문(`messageMap.get(msgId).content`)을 그대로 넣는다 (index.ts:233). T3C는 LLM이 원문에서 핵심 부분만 발췌하여 `[...]`로 생략하는 방식을 사용한다.

**결정**: Quote.text를 LLM 발췌 텍스트로 교체 (Option A). Quote.context에 이미 세그먼트 전체 대화가 있으므로 원문 손실 없음.

### 참고 파일
- `/Users/comcom/tttc-light-js/common/prompts/index.ts:76` — T3C의 quote 발췌 지침: "The quote must be as concise as possible while still supporting the argument. You may use `[...]` to skip less interesting bits."
- `src/services/reportPipeline/index.ts:220~258` — 현재 Claim 빌드 로직

### 태스크

#### ExtractedOpinion 타입 확장
- [x] `src/types/report.ts`의 `ExtractedOpinion`에 `quote?: string` 필드 추가

#### 프롬프트에 quote 발췌 요청 추가
- [x] `opinionExtractor.ts`의 `buildExtractionPrompt()`에 quote 추출 지침 추가
- [x] JSON 응답 형식에 `"quote"` 필드 추가

#### 파싱 로직 변경
- [x] `extractFromSegment()`의 파싱에 `quote` 필드 매핑 추가
- [x] `ExtractedOpinion` 생성부에 `quote: op.quote?.trim()` 추가

#### Claim 빌드 로직 변경
- [x] `index.ts`의 Claim 빌드에서 `Quote.text`를 `op.quote || content`로 변경

### 주의사항
- `quote` 필드는 optional — LLM이 반환하지 않을 수 있으므로 폴백 필수
- Quote.context는 변경 없음 (세그먼트 전체 대화 유지)

---

## Story 4.4: 대화 참여자 동등화

**수정 파일:** `src/services/reportPipeline/opinionExtractor.ts`, `src/services/reportPipeline/conversationParser.ts`, `src/types/report.ts`, `src/services/reportPipeline/index.ts`, `src/utils/reportValidator.ts`

### 배경
현재 파이프라인은 "Agent = 맥락 제공자, User = 의견 주체"로 고정되어 있다:
- `opinionExtractor.ts:171` — "Extract opinions expressed by the USER only"
- `conversationParser.ts:106` — `if (hasUserMessage)` 조건으로 User 없는 세그먼트 버림
- `ExtractedOpinion` — `speaker` 필드 없음

AINSPACE 이념은 "AI 간의 대화에서도 좋은 아이디어가 나올 수 있다"이므로 Agent도 동등한 대화 참여자로 취급해야 한다.

### 참고 파일
- `/Users/comcom/tttc-light-js/pipeline-worker/src/pipeline-steps/claims/model.ts:176~184` — T3C가 이미 `speaker` 필드를 사용하는 사례
- `src/services/reportPipeline/conversationParser.ts:88~155` — splitIntoSegments 함수

### 태스크

#### 프롬프트 변경
- [x] `opinionExtractor.ts`의 프롬프트에서 "Extract opinions expressed by the USER only" → "Extract opinions from ALL participants"
- [x] USER-only 규칙 제거
- [x] 새 규칙 추가: speaker 식별 지침
- [x] JSON 응답 형식에 `"speaker"` 필드 추가

#### 세그먼트 파서 변경
- [x] `conversationParser.ts`의 `flushSegment()`에서 `if (hasUserMessage)` 조건 제거
- [x] `hasUserMessage` 변수 선언, 설정, 리셋 모두 제거

#### 타입 변경
- [x] `src/types/report.ts`의 `ExtractedOpinion`에 `speaker: string` 필드 추가
- [x] `src/types/report.ts`의 `Claim`에 `speaker: string` 필드 추가

#### 파싱 및 빌드 로직 변경
- [x] `opinionExtractor.ts`의 파싱에 `speaker: op.speaker || "User"` 매핑 추가
- [x] `index.ts`의 Claim 빌드에서 `speaker: op.speaker` 전달

#### Validator 변경
- [x] `src/utils/reportValidator.ts`에 speaker 빈 문자열 경고 추가

### 주의사항
- Story 4.1의 품질 기준이 먼저 적용된 상태여야 Agent 의견 추출 시 노이즈가 적음
- 익명화 정책: Agent 메시지 익명화는 v1에서 적용하지 않음 (Agent가 사용자 PII를 인용하는 확률이 매우 낮으므로)
- `Claim`의 `speaker` 추가 시 `index.ts`의 `satisfies Claim`이 컴파일 에러를 발생시키므로 누락 위험 낮음

---

## Story 4.5: 통계에 Speaker 반영

**수정 파일:** `src/services/reportPipeline/analyzer.ts`, `src/types/report.ts`, `src/services/reportPipeline/synthesizer.ts`, `src/utils/reportValidator.ts`

### 배경
Story 4.4에서 `speaker` 필드가 추가되면 통계에도 반영해야 한다. 현재 `ReportStatistics`는 `stanceDistribution`만 집계하고 speaker별 분포가 없다.

### 참고 파일
- `src/services/reportPipeline/analyzer.ts:7~24` — `analyzeData()` 함수
- `src/types/report.ts:85~100` — `ReportStatistics` 타입

### 태스크

#### 타입 변경
- [x] `ReportStatistics`에 `speakerDistribution: Record<string, number>` 추가

#### 통계 집계 변경
- [x] `analyzer.ts`의 `analyzeData()`에 `calculateSpeakerDistribution()` 추가

#### Synthesizer 프롬프트 반영
- [x] `synthesizer.ts`의 프롬프트에 speaker 분포 정보 추가

#### Validator 변경
- [x] `reportValidator.ts`의 `validateStatistics()`에 `speakerDistribution` 합계 검증 추가

### 주의사항
- Story 4.4 완료 후 진행 (speaker 필드가 있어야 집계 가능)
- `docs/API_REPORT_SPEC.md`의 `ReportStatistics` 타입 문서도 업데이트 필요

---

## 구현 규칙

### 순서
- Story 4.1 → 4.2 → 4.3 → 4.4 → 4.5 순서로 진행
- 4.1과 4.2는 독립적이나 4.1이 프롬프트 구조를 잡으므로 먼저
- 4.3은 4.1 이후 (프롬프트에 quote 추출이 추가되므로)
- 4.4는 4.1+4.3 이후 (품질 기준이 잡힌 상태에서 Agent 의견 확장)
- 4.5는 4.4 이후 (speaker 필드 필요)

### 테스트
- 각 Story 완료 후 `tsc --noEmit`으로 타입 에러 없음 확인
- Story 4.1 후: 동일 대화 데이터로 리포트 생성하여 추출 품질 비교 (claim 수 감소, confidence 분포 변화 확인)
- Story 4.4 후: Agent 발화에서 의견이 추출되는지 확인

### 금지사항
- 파이프라인의 기본 흐름(Parse → Extract → Embed → Cluster → Analyze → Stats → Synthesize)은 변경하지 않는다
- 임베딩, UMAP, K-means 클러스터링 로직은 건드리지 않는다
- 기존 API 엔드포인트 구조는 변경하지 않는다
- 레거시 리포트 호환을 깨뜨리지 않는다

---

## 완료 조건
- [x] opinionExtractor 프롬프트에 T3C 수준 품질 기준, confidence 기준표, evolved 판별 기준이 포함되었다
- [x] analyzeClusters 프롬프트에 ExtractedOpinion의 stance/confidence가 컨텍스트로 전달된다
- [x] ExtractedOpinion에 `quote` 필드가 추가되고, Quote.text에 LLM 발췌 텍스트가 들어간다
- [x] ExtractedOpinion과 Claim에 `speaker` 필드가 추가되었다
- [x] conversationParser가 User 없는 세그먼트도 유효하게 처리한다
- [x] ReportStatistics에 `speakerDistribution`이 추가되었다
- [x] `tsc --noEmit`이 타입 에러 없이 통과한다
- [x] 레거시 리포트 조회가 정상 동작한다 (호환성 유지 — isLegacyReport로 원본 반환)

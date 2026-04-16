# EPIC5.1 - Thread-Level Topic Extraction (스레드 단위 주제별 Claim 추출 실험)

> 세그먼트 분할 + 세그먼트당 추출 2단계를 **스레드당 1회 LLM 호출**로 통합한다. LLM이 대화 전체를 읽고 주제별로 묶어 각 주제당 1개 claim을 추출한다.

## 의존성
- EPIC5 (Segment-Based Single Claim) — 완료됨

## 실험 배경

### EPIC5의 한계
코사인 유사도 기반 세그먼트 분할이 실패했다:
- **근본 원인**: 임베딩 모델은 "의미적 유사도"를 측정하지만 "맥락적 연속성"은 다른 문제. 질문 ↔ 답변은 같은 대화 맥락이지만 문장 구조가 달라 유사도가 낮게 나옴.
- **결과**: threshold 0.65 → 1123 세그먼트(턴마다 분할), 0.4 → 852 세그먼트(여전히 과분할). 어떤 threshold도 "같은 주제의 문답"과 "다른 주제로의 전환"을 구분하지 못함.

### 왜 스레드 단위 LLM 추출인가
- LLM은 대화 전체를 읽고 맥락을 이해할 수 있음 — "이 질문과 답변은 같은 주제"를 판단 가능
- 분할(주제 식별) + 추출(claim 생성)을 한 번에 수행하면 2단계가 1단계로 줄어듦
- LLM 호출 수: ~970회(세그먼트당) → ~200회(스레드당)로 감소

### 우려 사항 (실험으로 검증 필요)
- **정확도**: 긴 대화에서 LLM이 주제를 정확히 구분할지 불확실. 한 번에 복수 claim을 반환하는 출력 품질도 미지수.
- **토큰 비용**: 스레드가 길면 입력 토큰이 커짐. 평균 ~30 메시지 × ~50 토큰 = ~1500 토큰/스레드, 200 스레드 = ~300K 입력 토큰. gpt-4o-mini 기준 ~$0.05로 저렴하지만 긴 스레드는 더 많을 수 있음.
- **429 에러**: 200회 병렬 호출이지만 RequestManager가 `MAX_CONCURRENT_REQUESTS = 4`로 제한하므로 실제로는 4개씩 순차 처리. 429 에러 시 exponential backoff retry 있음.

## 현재 파이프라인 (EPIC5)

```
collectRawMessages → embedMessages → parseConversations(코사인 분할) → extractOpinions(세그먼트당 1)
LLM 호출:   0            0                0                                  ~970회
```

## 제안 파이프라인 (EPIC5.1)

```
collectRawMessages → extractTopicClaims(스레드당 1회 LLM) → embedClaims → cluster
LLM 호출:   0            ~200회 (스레드 수)                       0            0
```

LLM이 대화 전체를 읽고 **주제를 스스로 식별** → 주제별 1개 claim 추출. 분할과 추출이 한 번에.

---

## Story 5.1.1: 스레드 단위 추출 프롬프트 설계

**수정 파일:** `src/services/reportPipeline/opinionExtractor.ts`

### 배경
현재 `extractFromSegment()`는 하나의 세그먼트(대화 조각)를 받아 1개 claim을 추출한다. 이를 **`extractFromThread()`**로 교체하여, 스레드 전체 대화를 받아 주제별 claim 목록을 반환한다.

현재 프롬프트:
```
Extract exactly ONE consolidated opinion from this conversation segment.
```

변경:
```
Read the entire conversation and identify distinct topics discussed.
For each topic, extract exactly ONE consolidated claim.
Return the list of topic-claims.
```

### 태스크

#### 새 추출 함수
- [x] `extractFromThread(messages: SegmentMessage[], threadId: string, ...)` 함수 추가
- [x] 프롬프트: 전체 대화를 주고 주제별 1 claim 추출 요청
  ```
  ## Instructions
  Read the entire conversation below. Identify the distinct topics discussed.
  For each topic, extract exactly ONE consolidated claim that represents the core point.
  
  A "topic" is a coherent subject of discussion — multiple back-and-forth turns 
  about the same subject count as ONE topic, not multiple.
  
  For each claim:
  1. Identify the topic name (2-5 words)
  2. Identify the speaker who made the most central point
  3. Write a concise, debatable claim
  4. Determine stance, confidence, evolved
  5. Provide a concise quote
  6. List the message IDs that belong to this topic
  
  Return JSON:
  {
    "topics": [
      {
        "topicName": "주제명",
        "speaker": "User",
        "statement": "핵심 claim",
        "quote": "발췌 인용",
        "stance": "support",
        "confidence": 0.8,
        "evolved": false,
        "keyMessageIds": ["msg-1", "msg-5", "msg-6"]
      }
    ]
  }
  ```

#### 파싱 로직
- [x] 응답에서 `topics` 배열 파싱 → 각 항목을 `ExtractedOpinion`으로 변환
- [x] `source.keyMessageIds`를 그대로 매핑
- [x] `source.segmentId`는 스레드 ID 기반으로 생성 (세그먼트 개념 사실상 제거)

#### EPIC4 품질 기준 유지
- [x] Quality Rules (debatable positions only, noise < miss) 프롬프트에 포함
- [x] Confidence 기준표, Evolved 판별 기준 포함
- [x] 빈 대화(잡담만)는 `{ "topics": [] }` 반환

### 주의사항
- 긴 대화(50+ 메시지)는 토큰 제한에 걸릴 수 있음 — `maxTokens` 조정 필요 또는 대화 truncate
- 주제 수 제한 없음 (LLM이 자연스럽게 결정) — 과다 추출 시 후처리로 제한 고려

---

## Story 5.1.2: 파이프라인 통합

**수정 파일:** `src/services/reportPipeline/index.ts`

### 배경
현재 파이프라인은 9단계. 스레드 단위 추출로 변경하면 세그먼트 분할 관련 단계 (Step 2 메시지 임베딩, Step 3 주제 분할)가 불필요해진다.

### 태스크

#### 파이프라인 단순화
- [x] Step 1: `collectRawMessages()` → 스레드별 메시지 그룹화
- [x] Step 2: `extractFromThread()` (스레드당 1회 LLM) → 모든 ExtractedOpinion 수집
- [x] Step 3: `embedMessages()` → claim 임베딩
- [x] Step 4~7: 기존 클러스터링/분석/통계/종합 유지
- [x] `PIPELINE_STEPS` 7단계로 업데이트
- [x] 코사인 유사도 관련 코드 비활성화 (삭제는 실험 후 결정)

#### Claim context 처리
- [x] `extractFromThread()`가 반환한 `keyMessageIds`로 해당 메시지들의 전후 대화 맥락을 Claim.context에 구성
- [x] context는 Claim 수준에 1개 (Quote가 아닌 Claim에 저장 — EPIC5 수정 반영)

### 주의사항
- 코사인 유사도 분할 코드는 삭제하지 않고 비활성화 — 실험 결과에 따라 롤백 가능
- `ConversationSegment` 타입은 유지 (레거시 호환)

---

## Story 5.1.2.1: Claim을 대화 맥락의 결론으로 추출

**수정 파일:** `src/services/reportPipeline/opinionExtractor.ts`

### 배경
현재 프롬프트는 "core point"(핵심 주장)를 추출하도록 지시한다. 그 결과 대화 중간의 의견이 claim으로 뽑히고, 대화가 도달한 최종 결론은 무시되는 경우가 있다.

예: `도구 추천 요청 → A 시도 → 불만 → B로 전환 → 수용`
- 현재: "A의 한국어 품질이 부족하다" (중간 불만)
- 기대: "B가 더 적합한 대안이다" (대화의 결론)

### 태스크
- [x] 프롬프트에 "대화의 결론/최종 입장을 추출하라"는 지시 추가
- [x] 후반 메시지에 가중치를 두도록 지시 추가
- [x] 중간 의견이 아닌 최종 도달 입장을 추출하도록 명시

### 주의사항
- 아웃풋 JSON 구조 변경 없음 (프롬프트만 수정)
- 대화에 명확한 결론이 없는 경우(열린 질문 등)는 기존처럼 core point 추출

---

## Story 5.1.3: 비교 테스트

**수정 파일:** 없음 (수동 테스트)

### 태스크
- [ ] 동일 201 스레드 데이터로 리포트 생성
- [ ] 비교 항목:

| 항목 | EPIC5 (세그먼트 기반) | EPIC5.1 (스레드 기반) |
|------|---------------------|---------------------|
| 총 claim 수 | 852 | ? (목표: 400-600) |
| LLM 호출 수 | ~970 | ~209 |
| 총 소요 시간 | ? | ? |
| 토픽 당 claim 분포 | ? | ? |
| claim 품질 (샘플 10개) | ? | ? |
| 중복/유사 claim | ? | ? |
| 빈 스레드 비율 | ? | ? |

- [ ] 결과를 `docs/` 하위에 비교 문서로 정리
- [ ] 채택/롤백 판단:

#### 채택 기준 (모두 충족 시)
- claim 수가 EPIC5 대비 감소 (목표: 400-600, 최소 700 미만)
- 샘플 10개 claim 품질이 EPIC5와 동등 이상 (주관 평가)
- 총 소요 시간이 EPIC5 대비 동등 이상
- 중복/유사 claim이 EPIC5 대비 감소

#### 롤백 기준 (하나라도 해당 시)
- claim 수가 EPIC5보다 증가 (LLM이 주제를 과다 분할)
- 샘플 claim 품질이 현저히 낮음 (모호한 claim, 주제 혼합)
- 긴 스레드에서 토큰 제한으로 추출 실패 비율 > 10%

---

## 구현 규칙

### 브랜치
- `release/1.1.2`에서 `experiment/thread-level-extraction` 브랜치 분기
- 실험 결과에 따라 merge 또는 폐기

### 금지사항
- 기존 세그먼트 기반 코드를 삭제하지 않는다 (비활성화만)
- 클러스터링 이후 파이프라인(분석/통계/종합)은 변경하지 않는다
- ExtractedOpinion/Claim 타입 구조는 변경하지 않는다

---

## 완료 조건
- [x] 스레드 단위 추출 프롬프트가 동작한다
- [x] LLM 호출 수가 ~200회이다 (스레드 수 기준)
- [ ] 동일 데이터에서 EPIC5 대비 비교 테스트가 완료되었다
- [ ] 비교 결과 문서가 작성되었다
- [ ] 채택/롤백 결정이 내려졌다

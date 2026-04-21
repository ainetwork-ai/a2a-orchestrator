# EPIC5 Before-After: 세그먼트 기반 단일 Claim 추출

> EPIC5 적용 전후의 프롬프트, 파이프라인, 리포트 품질, 퍼포먼스 변화를 정리한다.

---

## 1. 프롬프트 변화

### Before (EPIC4 적용 후, 현재)
```
Extract opinions from ALL participants in the conversation —
both users and AI agents. Every participant's ideas are equally valuable.

For each opinion:
1. Identify the speaker
2. Write a concise, debatable claim ...
...

Respond in JSON format only:
{
  "opinions": [
    { "speaker": "User", "statement": "...", ... },
    { "speaker": "Agent", "statement": "...", ... },
    { "speaker": "User", "statement": "...", ... }
  ]
}
```
**결과**: 세그먼트당 평균 ~2.4개 claim 추출. LLM이 배열이니까 채울 수 있는 만큼 채움.

### After (EPIC5)
```
Extract exactly ONE consolidated opinion that best represents
the core discussion point of this conversation segment.

Synthesize multiple viewpoints into a single, comprehensive claim.
If the segment covers multiple topics, choose the most substantive one.

The speaker should be the participant who made the most central point.
Other participants' perspectives should be reflected in the quote.

Respond in JSON format only:
{
  "opinions": [
    { "speaker": "User", "statement": "...", ... }
  ]
}

You MUST return exactly one item in the array.
```
**결과**: 세그먼트당 정확히 0~1개. 잡담/인사 세그먼트는 품질 기준에 의해 0개.

---

## 2. 파이프라인 변화

### Before
```
1. Parse conversations → ConversationSegment[] (물리적 분할: 5분/Agent 변경/20 메시지)
2. Extract claims (LLM) → 복수 ExtractedOpinion per segment
3. Embed claims
4. Cluster (UMAP + K-means)
5. Analyze clusters (LLM)
6. Calculate statistics
7. Synthesize (LLM)
```

### After (EPIC5.2 포함)
```
1. Parse conversations → raw messages (세그먼트 분할 전)
2. Embed raw messages → 메시지별 임베딩 (세그먼트 분할용)
3. Segment by topic → ConversationSegment[] (코사인 유사도 기반 + 물리적 기준 병행)
4. Extract 1 claim per segment (LLM) → 0~1 ExtractedOpinion per segment
5. Embed claims (클러스터링용)
6. Cluster (UMAP + K-means)
7. Analyze clusters (LLM)
8. Calculate statistics
9. Synthesize (LLM)
```

**변경점**: Step 2~3이 새로 삽입 (임베딩 → 주제 분할), 기존 임베딩은 Step 5로 이동. 전체 단계 수 7 → 9이지만 LLM 호출은 3회로 동일.

---

## 3. 리포트 품질 변화 (200 스레드 기준)

### Claim 수

| | Before | After (5.1만) | After (5.1+5.2) |
|---|--------|-------------|----------------|
| 세그먼트 수 | ~700 (물리적) | ~700 (동일) | ~600-900 (주제 기반, 가변) |
| 세그먼트당 claims | ~2.4 | 0~1 | 0~1 |
| 총 claims | **~1700** | **~500-700** | **~400-700** |
| 빈 세그먼트 | 0% | ~10-20% (잡담/인사) | ~5-15% (주제 분할로 잡담이 별도 세그먼트로 분리) |

### Claim 품질

| 문제 | Before | After |
|------|--------|-------|
| Agent 반복 claim | 200 스레드에서 같은 Agent 발화 → 유사 claim 다수 | 세그먼트당 1개로 Agent 단독 claim 감소. 유사 claim은 K-means가 자연 클러스터링 |
| 턴별 중복 | "느려요" → "3초 걸려요" → "안 써요" 각각 claim | **하나의 종합 claim으로 통합** |
| 주제 혼합 | 20 메시지 상한으로 주제 중간에 잘림 | **주제 전환 지점에서 분할** (5.2) |
| 잡담 claim | 품질 기준으로 걸러지지만 간혹 추출 | 세그먼트 자체가 잡담이면 claim 0개 (더 깔끔) |

### 클러스터링 품질

| | Before | After |
|---|--------|-------|
| 입력 벡터 | ~1700 (유사 중복 많음) | ~500-700 (종합 claim, 중복 적음) |
| K-means 효과 | 유사 claim이 클러스터 내에서 중복 | **claim 자체가 이미 종합되어 클러스터 간 구분이 선명** |
| 토픽 대표성 | 한 토픽에 유사 claim 여러 개 | 한 토픽에 서로 다른 관점의 claim |

---

## 4. 퍼포먼스 변화

### LLM 호출

| 단계 | Before | After | 변화 |
|------|--------|-------|------|
| Claim 추출 | ~700회 (세그먼트 수) | ~700회 (세그먼트 수, 주제 분할 후 가변) | **비슷** |
| Cluster 분석 | ~8회 (클러스터 수) | ~8회 | 동일 |
| Synthesize | 1회 | 1회 | 동일 |
| **합계** | **~709회** | **~709회** | 동일 |

LLM 호출 수는 변하지 않음. 단, 응답 크기가 줄어 토큰 비용은 감소.

### 임베딩 비용

| | Before | After | 변화 |
|---|--------|-------|------|
| claim 임베딩 | ~1700 | ~500-700 | **~60% 감소** |
| raw 메시지 임베딩 | 0 | ~6000 (200 스레드 × ~30 메시지) | **신규 추가** |
| 합계 | ~1700 | ~6700 | 약 4배 증가 |
| 캐시 고려 시 | — | 두 번째 실행부터 대부분 캐시 히트 | **재실행 시 무시 가능** |

**첫 실행**: 임베딩 단계 ~3배 느려짐 (~5s → ~15s)
**재실행**: Redis 캐시로 거의 동일

### 클러스터링 속도

| | Before | After |
|---|--------|-------|
| UMAP 입력 | ~1700 벡터 | ~500-700 벡터 |
| 처리 시간 | ~3s | ~1-1.5s |
| **개선** | — | **~50-60% 빠름** |

### 전체 파이프라인

| 단계 | Before | After | 변화 |
|------|--------|-------|------|
| 파싱 | ~1s | ~1s | — |
| raw 메시지 임베딩 | — | ~10-15s (첫 실행) / ~1s (캐시) | **신규** |
| 세그먼트 분할 | 즉시 | ~0.5s (코사인 유사도 계산) | 미미 |
| Claim 추출 (LLM) | ~30s | ~25s (응답 작아짐) | 약간 빠름 |
| Claim 임베딩 | ~5s | ~2s (claim 수 감소) | 빠름 |
| 클러스터링 | ~3s | ~1.5s | 빠름 |
| Cluster 분석 (LLM) | ~10s | ~10s | — |
| Statistics + Synthesize | ~6s | ~6s | — |
| **합계 (첫 실행)** | **~55s** | **~57s** | 비슷 (임베딩 증가 ↔ 클러스터링 감소 상쇄) |
| **합계 (재실행)** | **~55s** | **~47s** | **~15% 빠름** (캐시 히트 + 클러스터링 감소) |

---

## 5. 트레이드오프 요약

| 항목 | 개선 | 비용 |
|------|------|------|
| Claim 수 ~60% 감소 | 노이즈 대폭 감소, 클러스터 품질 향상 | 한 세그먼트에 다른 주제 2개면 1개 유실 가능 (5.2로 완화) |
| 주제 기반 세그먼트 | 세그먼트-주제 일관성 향상 | 첫 실행 임베딩 비용 ~4배 증가 (캐시 후 해소) |
| 턴별 중복 제거 | 같은 맥락의 유사 claim 통합 | 미묘한 뉘앙스 차이 유실 가능 |
| 클러스터링 속도 향상 | 벡터 수 절반 → ~60% 빠름 | — (순수 이득) |
| LLM 호출 수 | 동일 (세그먼트 수 기준) | 프롬프트 약간 길어짐 (토큰 소폭 증가) |

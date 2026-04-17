# EPIC6 초안 — 대화 주제 기반 세그먼트 분할 고도화

> EPIC5에서 코사인 유사도 기반 분할이 "문답 쌍 표면 차이"로 인해 과분할 문제를 보였다. 근본적으로 더 나은 주제 분할 방법을 조사하고 적용한다.

## EPIC5 회고에서 도출된 문제

- 코사인 유사도: "의미적 유사도 ≠ 맥락적 연속성". 질문 ↔ 답변은 같은 맥락이지만 문장 구조가 달라 유사도가 낮음
- threshold 0.65 → 턴마다 분할 (1123 세그먼트), 0.4 → 여전히 과분할 (852)
- 물리적 분할(시간 간격/Agent 변경)만으로는 주제 전환을 잡지 못함
- 두 방식 모두 "대화 맥락 이해" 없이 표면적 신호만 사용하는 한계

---

## 조사된 접근법

### 1. LLM 프롬프트 기반 분할 (Def-DTS 계열)

**논문**: [Def-DTS: Deductive Reasoning for Open-domain Dialogue Topic Segmentation](https://arxiv.org/html/2505.21033)

LLM에 전체 대화를 주고 "주제 전환 경계 인덱스"를 반환하게 하는 방식. Def-DTS는 multi-step deductive reasoning을 사용:
1. 양방향 컨텍스트 요약
2. 발화 의도 분류
3. 연역적 주제 전환 감지

**AINSPACE 적용 방안:**
```
대화 전체를 읽고 주제가 바뀌는 지점의 메시지 인덱스를 JSON으로 반환하세요.
→ { "boundaries": [5, 12, 18] }
```

| 장점 | 단점 |
|------|------|
| 문맥을 완전히 이해하고 분할 | 스레드당 LLM 1회 추가 (200 스레드 = 200회) |
| 문답 쌍 표면 차이 문제 없음 | 토큰 비용 (긴 대화 = 긴 프롬프트) |
| 구현 단순 (프롬프트 + JSON 파싱) | 느린 대화 → 느린 분할 |

**비용 추정**: 분할 프롬프트는 응답이 짧으므로 (인덱스 배열만) 토큰 소비는 입력 위주. 대화 평균 ~30 메시지 × ~50 토큰 = ~1500 입력 토큰/스레드. 200 스레드 = ~300K 입력 토큰. gpt-4o-mini 기준 ~$0.05.

**실용성 평가**: ★★★★★ — 가장 현실적

---

### 2. 윈도우 기반 임베딩 비교 (개선된 코사인)

단일 메시지가 아니라 **N개 메시지 블록**을 하나의 텍스트로 합쳐 임베딩 후 비교.

```
[msg1 + msg2 + msg3] vs [msg4 + msg5 + msg6]
→ 블록 간 코사인 유사도
```

문답 쌍이 하나의 벡터로 합쳐져서 "질문과 답변의 표면 차이" 문제가 줄어듦.

| 장점 | 단점 |
|------|------|
| 추가 LLM 호출 없음 | 윈도우 크기 튜닝 필요 |
| 현재 코드 소수 변경 | 여전히 임베딩 한계 존재 |
| 비용 0 (임베딩만) | 경계가 블록 단위로 제한 (정밀도 낮음) |

**참고**: TextTiling (Hearst, 1997)의 현대적 변형. 초기 방법은 lexical similarity, 현재는 embedding similarity.

**실용성 평가**: ★★★☆☆ — LLM보다 저렴하지만 품질 불확실

---

### 3. Spectral Clustering / HDBScan

**논문**: [Clustering and Summarization of Chat Dialogues](https://liu.diva-portal.org/smash/get/diva2:1576483/FULLTEXT01.pdf)

모든 메시지를 임베딩 → 유사도 행렬 → spectral clustering 또는 HDBScan으로 자연 경계 탐지.

| 장점 | 단점 |
|------|------|
| 전체 대화를 보고 최적 분할점 탐색 | 구현 복잡도 높음 |
| 클러스터 수 자동 결정 (HDBScan) | 대화의 순서(시간) 정보를 활용하지 않음 |
| 비용 0 (임베딩만) | 연속성 보장 안 됨 (비인접 메시지가 같은 클러스터) |

**치명적 문제**: 대화는 시간순 연속성이 핵심인데, 클러스터링은 순서를 무시. 메시지 5와 메시지 20이 같은 클러스터에 묶일 수 있음 → 세그먼트로 변환 시 비연속 구간이 발생.

**실용성 평가**: ★★☆☆☆ — 대화 데이터에 부적합

---

### 4. DASH (Dialogue-Aware Similarity and Handshake Recognition)

**논문**: [DASH: Dialogue-Aware Similarity and Handshake Recognition](https://arxiv.org/html/2512.15042)

"대화 핸드셰이크"(인사, 주제 전환 신호, 맺음말 등) 패턴을 인식하여 구조적 단서로 분할. 의미적 유사도와 구조적 신호를 결합.

| 장점 | 단점 |
|------|------|
| 대화 고유의 구조적 패턴 활용 | 학습 데이터 필요 (supervised) |
| 의미 + 구조 결합으로 정밀 | 구현 복잡도 높음 |

**실용성 평가**: ★★☆☆☆ — 학습 데이터 확보/모델 학습 부담

---

### 5. Multi-granularity Prompts for Topic Shift Detection

**논문**: [Multi-granularity Prompts for Topic Shift Detection](https://arxiv.org/pdf/2305.14006)

프롬프트 기반으로 label 수준, turn 수준, topic 수준의 다중 단위에서 주제 정보를 추출하는 방식.

| 장점 | 단점 |
|------|------|
| 프롬프트만으로 다양한 수준 분석 | 다단계 프롬프트 = 비용 증가 |
| 해석 가능성 높음 | 복잡한 프롬프트 설계 필요 |

**실용성 평가**: ★★★☆☆ — 흥미롭지만 비용 대비 이점 불명확

---

## 권장 방향

### 1순위: LLM 프롬프트 기반 분할

이유:
- AINSPACE는 이미 세그먼트당 LLM 1회를 사용하므로, 스레드당 1회 추가는 상대적으로 저렴 (~$0.05/200스레드)
- "대화 맥락을 이해하고 주제를 구분"하는 건 LLM이 임베딩보다 압도적으로 잘함
- 구현 단순: 프롬프트 + JSON 파싱 + conversationParser에 반영
- EPIC5의 코사인 유사도 실패에서 배운 교훈: 표면적 신호 대신 맥락 이해가 필요

### 2순위: 윈도우 기반 임베딩 (LLM 비용 절약이 중요한 경우)

이유:
- LLM 호출 없이 가능
- 단일 메시지 대신 3-5 메시지 블록을 임베딩하면 문답 쌍 문제 완화
- 현재 코사인 유사도 코드를 블록 단위로 수정하면 됨

### 하지 않을 것:
- Spectral Clustering / HDBScan: 대화의 시간순 연속성을 무시하므로 부적합
- DASH / 학습 기반: 학습 데이터와 모델 학습 부담 대비 이점 불명확

---

## 의존성

- EPIC5 완료 후 진행
- 현재 코사인 유사도 분할 코드는 유지/교체 가능 (fallback으로 남겨도 됨)

## 참고 자료

- [Def-DTS: Deductive Reasoning for Dialogue Topic Segmentation](https://arxiv.org/html/2505.21033)
- [DASH: Dialogue-Aware Similarity and Handshake Recognition](https://arxiv.org/html/2512.15042)
- [A Unified Supervised and Unsupervised Dialogue Topic Segmentation (NAACL 2025)](https://aclanthology.org/2025.naacl-long.252.pdf)
- [Codebook-Injected Dialogue Segmentation](https://arxiv.org/html/2601.12061)
- [Clustering and Summarization of Chat Dialogues](https://liu.diva-portal.org/smash/get/diva2:1576483/FULLTEXT01.pdf)
- [Multi-granularity Prompts for Topic Shift Detection](https://arxiv.org/pdf/2305.14006)
- [When F1 Fails: Granularity-Aware Evaluation for Dialogue Topic Segmentation](https://arxiv.org/pdf/2512.17083)
- [MP2D: Automated Topic Shift Dialogue Generation](https://aclanthology.org/2024.emnlp-main.979.pdf)

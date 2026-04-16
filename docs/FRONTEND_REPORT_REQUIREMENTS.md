# 프론트엔드 리포트 UI 변경 요구사항

> AINSPACE 리포트가 "AI Agent-사용자 대화 기반 분석"임을 UI에서 명확히 드러내야 한다.
> 현재는 단순 설문 분석 도구와 구분되지 않음.

---

## 현재 문제

현재 리포트 UI(`localhost:3000/:reportId`)는 데이터 구조상 대화 맥락, stance, confidence, evolved 등 풍부한 메타데이터를 갖고 있지만 **렌더링하지 않고 있어** AINSPACE의 차별점이 전혀 드러나지 않는다.

---

## 1. Claim → Quote 드릴다운 (최우선)

### 현재
- Claim이 `#1 "주변의 휴식공간이 필요하다"` 식으로 제목만 나열
- 이 의견이 어떤 대화에서, 어떤 맥락으로 나왔는지 알 수 없음

### 요구사항
- Claim 클릭/펼치 시 **원본 대화 메시지(quotes)** 표시
- 각 quote에 **reference 정보** 포함: 어떤 스레드, 어떤 세그먼트에서 나왔는지
- 가능하면 해당 세그먼트의 Agent 질문 → 사용자 응답 흐름을 함께 보여줘서 **대화 맥락** 확인 가능하게

### API 데이터
```json
{
  "claims": [{
    "title": "검색 속도가 느려 사용을 중단함",
    "quotes": [{
      "id": "msg-id-1",
      "text": "검색할 때 3초 이상 걸려서 안 쓰게 됐어요",
      "reference": {
        "sourceId": "thread-123",
        "segmentId": "seg-456",
        "messageId": "msg-id-1"
      }
    }]
  }]
}
```

---

## 2. Stance 표시 및 필터링

### 현재
- Claim에 stance(support/oppose/neutral/request/question) 데이터가 있지만 표시 안 됨
- 모든 Claim이 동일하게 보여서 긍정/부정/요청 의견이 구분되지 않음

### 요구사항
- 각 Claim 옆에 **stance 배지** 표시 (색상 구분)
  - `support` → 초록, `oppose` → 빨강, `neutral` → 회색, `request` → 파랑, `question` → 노랑
- 토픽 내에서 stance별 **필터링** 기능
- Overview 바 차트를 **스택 바**로 변경: 토픽별 stance 분포를 색상으로 분할 표시

### API 데이터
```json
{ "stance": "oppose", "confidence": 0.85 }
```

---

## 3. Confidence 시각 표현

### 현재
- confidence(0.0~1.0) 데이터가 있지만 표시 안 됨
- "강하게 반대"와 "약하게 반대"가 동일하게 보임

### 요구사항
- Claim에 confidence를 시각적으로 표현 (진하기/바/아이콘 등)
- 예: confidence 0.9 → 진한 색, 0.3 → 연한 색
- 또는 confidence 수치를 직접 표시 (ex: `85%`)

---

## 4. Evolved 의견 하이라이트

### 현재
- `evolved: true` (대화 중 의견이 변화한 경우) 데이터가 있지만 표시 안 됨
- T3C에는 없는 AINSPACE만의 고유 인사이트인데 활용되지 않음

### 요구사항
- `evolved: true`인 Claim에 **시각적 마커** 표시 (ex: "의견 변화" 배지, 화살표 아이콘 등)
- 리포트 상단 통계에 **"N건의 의견이 대화 과정에서 변화"** 표시 (deliberation 품질 지표)
- 가능하면 evolved claim을 모아보는 필터/섹션

### API 데이터
```json
{ "evolved": true }
// statistics.deliberation.evolvedCount: 5
```

---

## 5. Topic 카드에 Consensus/Conflicting 표시

### 현재
- 토픽 카드에 설명 1줄만 표시
- `summary.consensus`와 `summary.conflicting` 데이터가 있지만 UI에 없음

### 요구사항
- 토픽 카드(접힌 상태)에 **consensus/conflicting 요약** 표시
  - "공통 의견: ..." (consensus 목록)
  - "상충 의견: ..." (conflicting 목록)
- 접힌 상태에서도 토픽의 핵심 내용을 파악할 수 있어야 함

### API 데이터
```json
{
  "summary": {
    "consensus": ["대부분 속도 개선을 원함"],
    "conflicting": ["UI 변경에 대해 찬반 나뉨"],
    "sentiment": "mixed"
  }
}
```

---

## 6. 대화 기반 분석임을 드러내는 메타 정보

### 현재
- 헤더에 "8 topics, 61 claims, 19 threads" 숫자만 표시
- 이게 AI Agent 대화 분석인지, 설문 분석인지 구분 안 됨

### 요구사항
- 헤더 또는 Summary 영역에 명시:
  - 분석 대상: **N개 스레드의 AI Agent-사용자 대화**
  - 참여 Agent 목록 (어떤 Agent와의 대화인지)
  - 총 세그먼트 수
  - Deliberation 통계: "N건의 의견 추출, 그 중 M건이 대화 과정에서 변화"
- Sources 섹션: 스레드별 참여도 (세그먼트 수, 기여 토픽)

### API 데이터
```json
{
  "sources": [
    { "id": "thread-123", "segmentCount": 5 },
    { "id": "thread-456", "segmentCount": 3 }
  ],
  "statistics": {
    "totalOpinions": 61,
    "totalThreads": 19,
    "deliberation": { "totalOpinions": 61, "evolvedCount": 5 }
  }
}
```

---

## 우선순위 요약

| 순위 | 항목 | 이유 |
|------|------|------|
| **P0** | Claim → Quote 드릴다운 | T3C 핵심 가치. 데이터 있는데 안 보여주고 있음 |
| **P0** | Stance 배지/필터 | AINSPACE 차별화 핵심. "대화 분석"임을 가장 직접적으로 드러냄 |
| **P1** | Consensus/Conflicting 표시 | 토픽 이해에 필수. 펼치지 않아도 핵심 파악 |
| **P1** | 대화 기반 메타 정보 | "이 리포트가 뭔지" 한눈에 파악 |
| **P2** | Evolved 하이라이트 | AINSPACE만의 독자적 인사이트 |
| **P2** | Confidence 표현 | 의견의 강도 구분 |

---

## 참고: API 응답 버전 구분

리포트 API(`GET /api/reports/:jobId`)는 두 가지 포맷을 반환할 수 있음:

- **현재 포맷** (`report.topics` 존재): Topic, Claim, Quote, Reference, Source 구조
- **레거시 포맷** (`report.clusters` 존재): 옛 구조 — stance/quotes/sources 없음

프론트엔드는 `report.topics` 존재 여부로 포맷을 판별하고, 레거시 리포트에서는 stance/quotes 관련 UI를 숨기면 됨.

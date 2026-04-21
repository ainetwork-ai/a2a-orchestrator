# EPIC6 - Subtopic Clustering & Claim Dedup (서브토픽 클러스터링 및 중복 제거)

> Topic 내 claims를 임베딩 기반으로 subtopic으로 세분화하고, subtopic 내 유사 claims를 그룹핑하여 중복을 제거한다.

## 의존성
- EPIC5.2 (Topic Summary Redesign) — 완료됨

## 목표
- Topic 내 claims를 K-means sub-clustering으로 subtopic 분류
- analyzeClusters에서 LLM이 subtopic label/description 부여
- subtopic 내 유사 claims를 `similarClaims`로 그룹핑 (dedup)
- claims를 `topic.subtopics[].claims[]`로 재구조화 (T3C 정렬)

---

## Story 6.1: Subtopic 타입 도입

**수정 파일:** `src/types/report.ts`

### 배경
현재 `Topic.claims`는 flat 배열이다. T3C는 `Topic > Subtopic > Claims` 계층을 가진다. subtopic을 도입하면 claims가 의미적으로 더 세분화된다.

현재 타입 (`report.ts:63-69`):
```typescript
export interface Topic {
  id: string;
  title: string;
  description: string;
  claims: Claim[];           // flat
  summary: ClusterSummary;
}
```

T3C의 구조:
```typescript
Topic > Subtopic[] > Claim[]
```

### 태스크

#### Subtopic 인터페이스 추가
- [x] `Subtopic` 인터페이스 정의:
  ```typescript
  export interface Subtopic {
    id: string;
    title: string;
    description: string;
    claims: Claim[];
  }
  ```
- [x] `Topic` 인터페이스 변경: `claims: Claim[]` → `subtopics: Subtopic[]`
  ```typescript
  export interface Topic {
    id: string;
    title: string;
    description: string;
    subtopics: Subtopic[];      // claims가 subtopics 안으로 이동
    summary: ClusterSummary;
  }
  ```

### 주의사항
- `Claim` 타입 자체는 변경하지 않음
- `Claim.similarClaims: Claim[]`는 기존에 빈 배열이었으나, dedup (Story 6.3)에서 활용
- `PipelineTopic`(`clusterer.ts:18`)이 `Topic`을 extends하므로 함께 컴파일 에러 발생 → Story 6.2에서 처리
- 이 변경은 API 응답 구조 breaking change — Story 6.4에서 명세 업데이트

---

## Story 6.2: Sub-clustering 구현

**수정 파일:** `src/services/reportPipeline/clusterer.ts`, `src/services/reportPipeline/index.ts`

### 배경
Topic 내 claims의 임베딩 벡터가 이미 존재한다 (Step 3 embedClaims). 이 벡터로 topic 내부에서 K-means를 한 번 더 실행하면 subtopic이 생긴다.

현재 파이프라인 (`index.ts:196-249`):
```
4. cluster (UMAP+K-means) → Topics
5. claims 매핑 → topic.claims[]
```

변경:
```
4. cluster (UMAP+K-means) → Topics
5. claims 매핑 → topic.claims[]  (임시)
5.1 sub-cluster → topic.subtopics[]  (claims를 subtopic으로 재배치)
```

### 참고 파일
- `src/types/embedding.ts` — `EmbeddedMessage` (embedding 벡터 포함)
- `src/services/reportPipeline/clusterer.ts:141` — `kMeans()` 함수 (이미 export됨, 재사용 가능)

### 태스크

#### sub-cluster 함수 추가 (clusterer.ts)
- [x] `subClusterTopic(claims, embeddings, maxSubtopics?)` 함수 추가:
  - claims의 id로 `EmbeddedMessage[]`에서 해당 임베딩 벡터 추출
  - 임베딩 벡터로 K-means 실행 (UMAP 불필요 — 같은 topic 내라 이미 근접)
  - k 결정: `Math.min(Math.ceil(claims.length / 10), 5)` (최소 1, 최대 5)
  - claims 수가 5개 이하면 sub-clustering 스킵 (subtopic 1개 = 전체)
  - 반환: `Map<number, Claim[]>` (subtopicId → claims)

#### 파이프라인 통합 (index.ts)
- [x] claims 매핑 후, 각 cluster에 대해 `subClusterTopic()` 호출
- [x] `EmbeddedMessage[]`를 `runSharedPipeline`에 전달 (현재 `substantiveMessages`로 이미 전달됨)
- [x] sub-cluster 결과를 `topic.subtopics[]`로 구성:
  ```typescript
  cluster.subtopics = Array.from(subClusters.entries()).map(([subId, subClaims]) => ({
    id: `${cluster.id}-sub-${subId}`,
    title: `Subtopic ${subId + 1}`,    // placeholder, LLM이 후에 교체
    description: "",
    claims: subClaims,
  }));
  ```

#### PipelineTopic 타입 업데이트 (clusterer.ts)
- [x] `PipelineTopic`이 `Topic`을 extends하므로, `claims` 제거 → `subtopics` 도입에 맞춰 업데이트
- [x] `PipelineTopic`에 임시 `claims: Claim[]`를 유지하되, sub-clustering 후 `subtopics[]`로 이동 후 비움
- [x] 기본 `PipelineTopic` 생성부에 `subtopics: []` 추가

### 주의사항
- `kMeans()`에 넘기는 데이터는 원본 임베딩 벡터 (1536차원), UMAP 축소 벡터(2차원)가 아님
- `substantiveMessages`(`EmbeddedMessage[]`)에서 claim.id로 임베딩을 찾아야 함 — id 매핑 주의
- `EmbeddedMessage.id`는 `ExtractedOpinion.id`와 동일 (`opinionsToParsedMessages`에서 매핑됨)

---

## Story 6.3: Claim Dedup (similarClaims 활용)

**수정 파일:** `src/services/reportPipeline/index.ts` (또는 새 파일)

### 배경
현재 `Claim.similarClaims`는 항상 빈 배열이다 (`index.ts:242`):
```typescript
similarClaims: [],
```

T3C는 subtopic 내에서 LLM으로 유사 claims를 그룹핑한다. 우리는 임베딩 코사인 유사도로 이를 수행할 수 있다 — LLM 호출 없이.

### 태스크

#### 코사인 유사도 기반 dedup
- [x] subtopic 내 claims 간 코사인 유사도 계산
- [x] 유사도 threshold (0.85 이상) → `similarClaims`에 추가
- [x] primary claim 선택 기준: confidence가 가장 높은 claim
- [x] duplicate claims는 primary의 `similarClaims[]`에 넣고, subtopic.claims에서는 primary만 유지
- [x] dedup 후 `claim.number`를 `1 + similarClaims.length`로 업데이트 (총 mention count)

#### dedup 순서
- [x] sub-clustering (Story 6.2) 이후, analyzeClusters (LLM) 이전에 실행
- [x] dedup 결과 로그: 원래 claims 수 → dedup 후 primary claims 수

### 주의사항
- dedup은 **subtopic 내에서만** 수행 (다른 subtopic의 claims와는 비교하지 않음)
- LLM 호출 없음 — 임베딩 코사인 유사도만 사용
- threshold 0.85는 초기값, 실험 후 조정 가능
- similarClaims의 quotes, context는 유지 (프론트에서 펼쳐볼 수 있도록)

---

## Story 6.4: analyzeClusters에 subtopic label 부여 + API 명세 업데이트

**수정 파일:** `src/services/reportPipeline/clusterAnalyzer.ts`, `docs/API_REPORT_SPEC.md`

### 배경
Sub-clustering 후 subtopic의 title은 placeholder("Subtopic 1")이다. analyzeClusters에서 LLM이 subtopic별 claims를 보고 의미 있는 label과 description을 부여해야 한다.

현재 프롬프트는 claims를 flat으로 나열한다. subtopic 구조가 도입되면 subtopic별로 그룹핑하여 나열해야 한다.

### 태스크

#### 프롬프트 변경 (clusterAnalyzer.ts)
- [x] claims 입력을 subtopic별로 그룹핑하여 나열:
  ```
  ## Subtopic 1 (claims 15개):
  - Claim: "..." (support, 0.8)
    Quote: "..."
  
  ## Subtopic 2 (claims 12개):
  - Claim: "..." (oppose, 0.7)
    Quote: "..."
  ```
- [x] LLM 응답에 subtopic labels 요청:
  ```json
  {
    "topic": "토픽 라벨",
    "description": "...",
    "subtopics": [
      { "name": "서브토픽 라벨", "description": "..." },
      ...
    ],
    "summary": { "text": "...", "sentiment": "..." }
  }
  ```
- [x] 파싱 후 `cluster.subtopics[i].title`, `.description`에 LLM 결과 매핑
- [x] subtopic 수가 프롬프트의 subtopic 수와 다를 경우 index 기반 매핑 (순서 유지)

#### API 명세 업데이트 (API_REPORT_SPEC.md)
- [x] `Topic` 타입에서 `claims` → `subtopics` 변경 반영
- [x] `Subtopic` 타입 추가
- [x] `Claim.similarClaims` 설명 업데이트 (빈 배열 → dedup된 유사 claims)

### 주의사항
- LLM 호출 수 변경 없음 (기존 topic당 1회 호출 내에서 처리)
- `maxTokens` 증가가 필요할 수 있음 (subtopic labels 추가 응답)
- subtopic 순서는 sub-clustering 결과 순서를 유지

---

## 구현 규칙

### 순서
- Story 6.1 → 6.2 → 6.3 → 6.4 순서로 구현 (의존 관계)

### 금지사항
- `Claim` 타입 구조는 변경하지 않는다 (`similarClaims` 활용만)
- `ExtractedOpinion` 타입은 변경하지 않는다
- 1단계 클러스터링 로직 (UMAP+K-means)은 변경하지 않는다
- claims 매핑 로직 (quote, context 구성)은 변경하지 않는다
- LLM 호출 수를 늘리지 않는다

---

## 완료 조건
- [x] Topic 내에 subtopics 배열이 존재한다
- [x] 각 subtopic에 LLM이 부여한 label과 description이 있다
- [x] subtopic 내 유사 claims가 `similarClaims`로 그룹핑된다
- [x] dedup 후 primary claims만 subtopic.claims에 남는다
- [x] 기존 파이프라인 LLM 호출 수에 변화가 없다
- [x] TypeScript 컴파일 에러가 없다
- [x] API 명세가 업데이트된다

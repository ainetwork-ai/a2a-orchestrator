# TRD 12: Embedding 기반 클러스터링 파이프라인 개선

## 1. 개요 (Overview)

### 1.1 목적 (Purpose)

현재 리포트 파이프라인은 LLM에 의존하여 토픽을 발견하고 클러스터링합니다. 이 방식은:
- **비결정적**: 같은 데이터에서 매번 다른 토픽이 생성됨
- **캐싱 불가**: 토픽이 바뀌므로 이전 분류 결과 재사용 불가
- **비용 비효율**: 모든 메시지를 LLM으로 처리해야 함
- **샘플링 강제**: 비용 때문에 전체 메시지 분석 불가

본 TRD는 Talk to the City (T3C) 방식을 참고하여, **Embedding + 알고리즘 기반 클러스터링**으로 전환하는 것을 제안합니다.

### 1.2 배경 (Background)

#### Talk to the City 파이프라인 분석

[AI Objectives Institute](https://ai.objectives.institute/talk-to-the-city)의 T3C는 다음과 같은 파이프라인을 사용합니다:

```
[Raw Comments]
      │
      ▼ [Extraction - LLM]
[Atomic Arguments]
      │
      ▼ [Embedding - OpenAI]
[Vector Embeddings]
      │
      ▼ [Clustering - UMAP + HDBSCAN]  ← 알고리즘, LLM 없음
[Clusters]
      │
      ▼ [Labelling - LLM]
[Named Topics]
```

**핵심 인사이트**: 클러스터링 자체는 알고리즘으로 수행하고, LLM은 라벨링에만 사용합니다.

### 1.3 범위 (Scope)

**포함 (In Scope):**
- Embedding 생성 단계 추가
- HDBSCAN/K-means 기반 클러스터링으로 전환
- 메시지별 카테고리 캐싱
- 샘플링 제거 및 전체 메시지 분석
- Grounding과의 통합

**제외 (Out of Scope):**
- 실시간 클러스터링
- 다국어 임베딩 최적화
- GPU 기반 대규모 처리

---

## 2. 현재 상태 분석 (Current State)

### 2.1 현재 파이프라인

```
Parser → Categorizer(LLM) → Clusterer(LLM) → Grounding → Analyzer → Synthesizer → Renderer
              ↑                    ↑
         매번 LLM 호출        매번 LLM 호출
         (10개당 1회)         (토픽 발견)
```

### 2.2 문제점

| 문제 | 영향 | 심각도 |
|------|------|--------|
| **비결정적 토픽** | 리포트 A의 "UI 불만" ≠ 리포트 B의 "디자인 개선" | 높음 |
| **캐싱 불가** | 같은 메시지도 매번 재분류 | 높음 |
| **샘플링 필요** | 5000개 중 1000개만 분석, Grounding 정확도 저하 | 높음 |
| **높은 LLM 비용** | 1000개 메시지 → ~150회 LLM 호출 | 중간 |

### 2.3 현재 비용 구조

```
5000개 메시지 기준 (샘플링으로 1000개 처리):
- Categorizer: 1000 / 10 = 100회 LLM 호출
- Clusterer: ~20회 LLM 호출 (토픽 발견, 분류)
- Grounding: ~10회 LLM 호출 (클러스터당)
- Synthesizer: 1회

총: ~130회 LLM 호출
문제: 4000개 메시지 누락 → Grounding 부정확
```

---

## 3. 제안 설계 (Proposed Design)

### 3.1 새로운 파이프라인

```
Parser
   │
   ▼
Embedder ──────────────── OpenAI text-embedding-3-small (저렴, 빠름)
   │
   ▼
Categorizer (Embedding) ── 유사도 기반 분류 + isSubstantive 판별 (LLM 없음)
   │
   ▼
Clusterer (UMAP+K-means) ─ 알고리즘 클러스터링 (LLM 없음)
   │
   ▼
Labeller (LLM) ─────────── 클러스터 라벨링 (클러스터당 1회)
   │
   ▼
OpinionExtractor (LLM) ─── 클러스터별 opinions 추출 (클러스터당 1회)
   │
   ▼
Grounding ─────────────── 전체 메시지 대상 (샘플링 없음)
   │
   ▼
Analyzer → Synthesizer → Renderer
```

**Note**: Labeller와 OpinionExtractor는 하나의 LLM 호출로 통합 가능

### 3.2 비용 비교

```
5000개 메시지 기준 (전체 처리):

[현재]                           [개선 후]
Categorizer: 100회 LLM          → Embedding: $0.02 (5000 * $0.00002/1K tokens)
Clusterer: 20회 LLM             → UMAP+K-means: 0회 LLM
  (토픽발견 + 할당 + 분석)
                                → Labeller+OpinionExtractor: 10회 LLM (클러스터당, 통합)
Grounding: 10회 LLM             → Grounding: 10회 LLM
Synthesizer: 1회                → Synthesizer: 1회

총: 131회 LLM                   → 21회 LLM + $0.02 Embedding
비용: ~$2.62                     → ~$0.44 (83% 절감)
커버리지: 1000개 (20%)           → 5000개 (100%)
```

**Note**: Labeller와 OpinionExtractor를 하나의 프롬프트로 통합하면 호출 수 추가 없음

### 3.3 아키텍처

```
┌─────────────────────────────────────────────────────────────────┐
│                    Embedding-Based Pipeline                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  ┌─────────┐     ┌──────────────┐     ┌─────────────────┐       │
│  │ Parser  │────►│  Embedder    │────►│ EmbeddingCache  │       │
│  └─────────┘     └──────────────┘     └─────────────────┘       │
│                         │                      │                 │
│                         ▼                      │                 │
│               ┌──────────────────┐             │                 │
│               │   Categorizer    │◄────────────┘                 │
│               │ (Similarity-based)│                               │
│               │ + isSubstantive  │                               │
│               └────────┬─────────┘                               │
│                        │                                          │
│                        ▼                                          │
│               ┌──────────────────┐                               │
│               │    Clusterer     │                               │
│               │ (UMAP + K-means) │                               │
│               └────────┬─────────┘                               │
│                        │                                          │
│                        ▼                                          │
│               ┌──────────────────┐                               │
│               │ ClusterAnalyzer  │  ← LLM (클러스터당 1회)        │
│               │ - Labelling      │     (통합 호출)                │
│               │ - Opinions       │                               │
│               │ - Summary        │                               │
│               │ - NextSteps      │                               │
│               └────────┬─────────┘                               │
│                        │                                          │
│                        ▼                                          │
│               ┌──────────────────┐                               │
│               │    Grounding     │  ← 전체 메시지 대상             │
│               └──────────────────┘                               │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. 상세 설계 (Detailed Design)

### 4.1 Embedder

```typescript
// src/services/reportPipeline/embedder.ts

import { getRedisClient } from "../../utils/redis";
import { ParsedMessage } from "../../types/report";
import crypto from "crypto";

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
const EMBEDDING_CACHE_PREFIX = "emb:msg:";
const BATCH_SIZE = 100; // OpenAI allows up to 2048

export interface EmbeddedMessage extends ParsedMessage {
  embedding: number[];
}

export interface EmbedderResult {
  messages: EmbeddedMessage[];
  cacheHits: number;
  newEmbeddings: number;
}

/**
 * OpenAI Embedding API 호출 함수 타입
 * 외부에서 주입하여 의존성 분리
 */
export type EmbedFunction = (texts: string[]) => Promise<number[][]>;

/**
 * OpenAI Embedding 함수 생성
 */
export function createOpenAIEmbedder(apiKey: string): EmbedFunction {
  return async (texts: string[]): Promise<number[][]> => {
    // Dynamic import to avoid dependency issues
    const { default: OpenAI } = await import("openai");
    const openai = new OpenAI({ apiKey });

    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: texts,
    });

    return response.data.map(d => d.embedding);
  };
}

/**
 * Generate embeddings for messages with caching
 */
export async function embedMessages(
  messages: ParsedMessage[],
  embedFn: EmbedFunction
): Promise<EmbedderResult> {
  const redis = getRedisClient();

  const results: EmbeddedMessage[] = new Array(messages.length);
  const toEmbed: { index: number; message: ParsedMessage; hash: string }[] = [];
  let cacheHits = 0;

  // Check cache first (batch Redis calls for performance)
  const hashes = messages.map(msg => hashContent(msg.content));
  const cacheKeys = hashes.map(h => `${EMBEDDING_CACHE_PREFIX}${h}`);

  // mget for batch cache lookup
  const cachedValues = await redis.mGet(cacheKeys);

  for (let i = 0; i < messages.length; i++) {
    const cached = cachedValues[i];
    if (cached) {
      results[i] = { ...messages[i], embedding: JSON.parse(cached) };
      cacheHits++;
    } else {
      toEmbed.push({ index: i, message: messages[i], hash: hashes[i] });
    }
  }

  console.log(`[Embedder] Cache: ${cacheHits} hits, ${toEmbed.length} misses`);

  // Batch embed new messages
  for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
    const batch = toEmbed.slice(i, i + BATCH_SIZE);
    const texts = batch.map(b => b.message.content);

    console.log(`[Embedder] Generating embeddings for batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(toEmbed.length / BATCH_SIZE)}`);

    const embeddings = await embedFn(texts);

    // Store results and cache (batch Redis calls)
    const cacheEntries: [string, string][] = [];
    for (let j = 0; j < batch.length; j++) {
      const { index, message, hash } = batch[j];
      const embedding = embeddings[j];

      results[index] = { ...message, embedding };
      cacheEntries.push([`${EMBEDDING_CACHE_PREFIX}${hash}`, JSON.stringify(embedding)]);
    }

    // Batch cache with pipeline
    const pipeline = redis.multi();
    for (const [key, value] of cacheEntries) {
      pipeline.setEx(key, 30 * 24 * 60 * 60, value); // 30 days TTL
    }
    await pipeline.exec();
  }

  return {
    messages: results,
    cacheHits,
    newEmbeddings: toEmbed.length,
  };
}

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}
```

### 4.2 Similarity-based Categorizer

```typescript
// src/services/reportPipeline/categorizer.ts (개선)

import { getRedisClient } from "../../utils/redis";
import { EmbeddedMessage } from "./embedder";
import { CategorizedMessage, MIN_MESSAGE_LENGTH } from "../../types/report";

/**
 * 고정 카테고리 정의
 * 기존 카테고리와의 매핑 포함
 */
export const FIXED_CATEGORIES = [
  {
    name: "question",
    legacyName: "question",  // 하위 호환성
    description: "질문, 문의, 궁금한 점",
    keywords: ["어떻게", "왜", "뭐", "무엇", "언제", "?", "알려주세요"],
  },
  {
    name: "request",
    legacyName: "request",
    description: "기능 요청, 개선 제안",
    keywords: ["기능", "추가", "있으면", "해주세요", "원해요", "제안"],
  },
  {
    name: "feedback",
    legacyName: "feedback",
    description: "일반적인 피드백, 의견",
    keywords: ["좋아요", "감사", "최고", "만족", "괜찮", "생각"],
  },
  {
    name: "complaint",
    legacyName: "complaint",
    description: "불만, 버그 신고, 문제 제기",
    keywords: ["오류", "버그", "안됨", "문제", "에러", "불만", "왜 안"],
  },
  {
    name: "information",
    legacyName: "information",
    description: "정보 공유, 알림",
    keywords: ["알려드", "공유", "참고", "정보"],
  },
  {
    name: "greeting",
    legacyName: "greeting",
    description: "인사, 간단한 대화",
    keywords: ["안녕", "하이", "헬로", "반가워"],
    isNonSubstantive: true,  // 비실질적 메시지
  },
  {
    name: "other",
    legacyName: "other",
    description: "기타",
    keywords: [],
  },
] as const;

/**
 * 비실질적 메시지 패턴 (isSubstantive = false)
 */
const NON_SUBSTANTIVE_PATTERNS = {
  // 인사 패턴
  greetings: /^(hi|hello|hey|안녕|하이|헬로|good\s*(morning|afternoon|evening)|greetings)[\s!.?]*$/i,
  // 단순 응답 패턴
  chitchat: /^(ok|okay|yes|no|yeah|yep|nope|thanks|thank you|thx|ty|ㅇㅇ|ㄴㄴ|ㅋ+|ㅎ+|lol|haha|good|nice|cool|great|sure|alright|got it|i see|understood)[\s!.?]*$/i,
  // 봇 질문 패턴
  botQuestions: /^(who are you|what are you|누구|뭐야|너 뭐야)[\s?]*$/i,
};

// 카테고리별 임베딩 캐시
let categoryEmbeddings: Map<string, number[]> | null = null;
const CATEGORY_EMBEDDING_CACHE_KEY = "emb:categories:v1";

/**
 * 카테고리 임베딩 초기화 (Redis 캐싱)
 */
export async function initializeCategoryEmbeddings(
  embedFn: (texts: string[]) => Promise<number[][]>
): Promise<void> {
  if (categoryEmbeddings) return;

  const redis = getRedisClient();

  // Redis에서 캐시 확인
  const cached = await redis.get(CATEGORY_EMBEDDING_CACHE_KEY);
  if (cached) {
    const parsed = JSON.parse(cached);
    categoryEmbeddings = new Map(Object.entries(parsed));
    console.log("[Categorizer] Loaded category embeddings from cache");
    return;
  }

  // 새로 생성
  categoryEmbeddings = new Map();
  const texts = FIXED_CATEGORIES.map(
    c => `${c.name}: ${c.description}. ${c.keywords.join(", ")}`
  );

  const embeddings = await embedFn(texts);

  FIXED_CATEGORIES.forEach((cat, i) => {
    categoryEmbeddings!.set(cat.name, embeddings[i]);
  });

  // Redis에 캐싱 (7일)
  await redis.setEx(
    CATEGORY_EMBEDDING_CACHE_KEY,
    7 * 24 * 60 * 60,
    JSON.stringify(Object.fromEntries(categoryEmbeddings))
  );
  console.log("[Categorizer] Generated and cached category embeddings");
}

/**
 * 코사인 유사도 계산
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * isSubstantive 판별 (규칙 기반)
 */
function checkIsSubstantive(content: string, category: string): boolean {
  const trimmed = content.trim();

  // 1. 너무 짧은 메시지
  if (trimmed.length < MIN_MESSAGE_LENGTH) {
    return false;
  }

  // 2. greeting 카테고리
  if (category === "greeting") {
    return false;
  }

  // 3. 패턴 매칭
  if (NON_SUBSTANTIVE_PATTERNS.greetings.test(trimmed)) {
    return false;
  }
  if (NON_SUBSTANTIVE_PATTERNS.chitchat.test(trimmed)) {
    return false;
  }
  if (NON_SUBSTANTIVE_PATTERNS.botQuestions.test(trimmed)) {
    return false;
  }

  // 4. 20자 미만 + 물음표/느낌표만 있는 경우
  if (trimmed.length < 20 && /^[^a-zA-Z가-힣]*$/.test(trimmed.replace(/[?!.\s]/g, ''))) {
    return false;
  }

  return true;
}

/**
 * 감정 분석 (임베딩 기반 + 키워드 보정)
 */
function detectSentiment(
  content: string,
  embedding: number[],
  sentimentEmbeddings?: { positive: number[]; negative: number[] }
): "positive" | "negative" | "neutral" {
  // 키워드 기반 (부정 키워드 우선 체크)
  const negativeKeywords = ["안됨", "안 됨", "못", "없", "싫", "별로", "불만", "나쁘", "최악", "실망", "짜증", "화나", "문제", "오류", "버그"];
  const positiveKeywords = ["좋", "감사", "최고", "만족", "잘", "굿", "훌륭", "대박", "👍", "❤️"];

  const lower = content.toLowerCase();

  // 부정 키워드가 있으면서 긍정 키워드도 있는 경우 → 문맥 확인
  // "좋아요 버튼이 안 눌려요" 같은 케이스 처리
  const hasNegativeContext = negativeKeywords.some(w => lower.includes(w));
  const hasPositiveContext = positiveKeywords.some(w => lower.includes(w));

  // 부정 문맥이 있으면 부정 우선
  if (hasNegativeContext) {
    return "negative";
  }

  if (hasPositiveContext) {
    return "positive";
  }

  // 임베딩 기반 (sentimentEmbeddings가 제공된 경우)
  if (sentimentEmbeddings) {
    const posScore = cosineSimilarity(embedding, sentimentEmbeddings.positive);
    const negScore = cosineSimilarity(embedding, sentimentEmbeddings.negative);

    if (posScore > negScore + 0.1) return "positive";
    if (negScore > posScore + 0.1) return "negative";
  }

  return "neutral";
}

/**
 * 임베딩 기반 카테고리 분류
 */
export function categorizeByEmbedding(
  messages: EmbeddedMessage[]
): CategorizedMessage[] {
  if (!categoryEmbeddings) {
    throw new Error("Category embeddings not initialized. Call initializeCategoryEmbeddings first.");
  }

  return messages.map(msg => {
    let bestCategory = "other";
    let bestScore = -1;

    for (const [category, embedding] of categoryEmbeddings!) {
      const score = cosineSimilarity(msg.embedding, embedding);
      if (score > bestScore) {
        bestScore = score;
        bestCategory = category;
      }
    }

    // 감정 분석
    const sentiment = detectSentiment(msg.content, msg.embedding);

    // isSubstantive 판별
    const isSubstantive = checkIsSubstantive(msg.content, bestCategory);

    return {
      ...msg,
      category: bestCategory,
      sentiment,
      isSubstantive,
    };
  });
}
```

### 4.3 HDBSCAN Clusterer

```typescript
// src/services/reportPipeline/clusterer.ts (개선)

import { UMAP } from "umap-js";
import { CategorizedMessage, MessageCluster } from "../../types/report";
import { EmbeddedMessage } from "./embedder";

interface ClusteredMessage extends CategorizedMessage {
  embedding: number[];
  clusterId: number;
  x: number; // UMAP 좌표
  y: number;
}

export interface ClustererResult {
  clusters: MessageCluster[];
  visualization: {
    points: Array<{ id: string; x: number; y: number; clusterId: number }>;
  };
}

/**
 * UMAP으로 차원 축소 후 K-means 클러스터링
 * (HDBSCAN은 JS 구현이 제한적이므로 K-means 사용)
 */
export async function clusterByEmbedding(
  messages: (CategorizedMessage & { embedding: number[] })[],
  numClusters: number = 8
): Promise<ClustererResult> {
  if (messages.length < numClusters) {
    // 메시지가 적으면 카테고리 기반 단일 클러스터
    return createSingleCluster(messages);
  }

  // 1. UMAP 차원 축소 (1536 → 2)
  const embeddings = messages.map(m => m.embedding);
  const umap = new UMAP({
    nComponents: 2,
    nNeighbors: Math.min(15, messages.length - 1),
    minDist: 0.1,
    spread: 1.0,
  });

  const reduced = umap.fit(embeddings);

  // 2. K-means 클러스터링
  const clusterAssignments = kMeans(reduced, numClusters);

  // 3. 클러스터별 메시지 그룹화
  const clusterMap = new Map<number, ClusteredMessage[]>();

  messages.forEach((msg, i) => {
    const clusterId = clusterAssignments[i];
    const [x, y] = reduced[i];

    if (!clusterMap.has(clusterId)) {
      clusterMap.set(clusterId, []);
    }

    clusterMap.get(clusterId)!.push({
      ...msg,
      clusterId,
      x,
      y,
    });
  });

  // 4. MessageCluster 형식으로 변환 (라벨은 아직 없음)
  const clusters: MessageCluster[] = Array.from(clusterMap.entries())
    .filter(([_, msgs]) => msgs.length > 0)
    .map(([clusterId, msgs]) => ({
      id: `cluster-${clusterId}`,
      topic: `Cluster ${clusterId}`, // 임시, Labeller에서 업데이트
      description: "",
      messages: msgs,
      opinions: [],
      summary: {
        consensus: [],
        conflicting: [],
        sentiment: calculateClusterSentiment(msgs),
      },
      nextSteps: [],
    }));

  // 5. 시각화 데이터
  const points = messages.map((msg, i) => ({
    id: msg.id,
    x: reduced[i][0],
    y: reduced[i][1],
    clusterId: clusterAssignments[i],
  }));

  return { clusters, visualization: { points } };
}

/**
 * 간단한 K-means 구현
 */
function kMeans(data: number[][], k: number, maxIterations: number = 100): number[] {
  const n = data.length;
  const dim = data[0].length;

  // 초기 중심점: 랜덤 선택 (고정 시드로 결정적)
  const centroids: number[][] = [];
  const step = Math.floor(n / k);
  for (let i = 0; i < k; i++) {
    centroids.push([...data[i * step]]);
  }

  let assignments = new Array(n).fill(0);

  for (let iter = 0; iter < maxIterations; iter++) {
    // Assign points to nearest centroid
    const newAssignments = data.map(point => {
      let minDist = Infinity;
      let minIdx = 0;
      for (let c = 0; c < k; c++) {
        const dist = euclideanDistance(point, centroids[c]);
        if (dist < minDist) {
          minDist = dist;
          minIdx = c;
        }
      }
      return minIdx;
    });

    // Check convergence
    if (arraysEqual(assignments, newAssignments)) break;
    assignments = newAssignments;

    // Update centroids
    for (let c = 0; c < k; c++) {
      const clusterPoints = data.filter((_, i) => assignments[i] === c);
      if (clusterPoints.length > 0) {
        centroids[c] = clusterPoints[0].map((_, d) =>
          clusterPoints.reduce((sum, p) => sum + p[d], 0) / clusterPoints.length
        );
      }
    }
  }

  return assignments;
}

function euclideanDistance(a: number[], b: number[]): number {
  return Math.sqrt(a.reduce((sum, val, i) => sum + (val - b[i]) ** 2, 0));
}

function arraysEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function calculateClusterSentiment(
  messages: CategorizedMessage[]
): "positive" | "negative" | "mixed" | "neutral" {
  const counts = { positive: 0, negative: 0, neutral: 0 };
  messages.forEach(m => counts[m.sentiment || "neutral"]++);

  const total = messages.length;
  if (counts.positive / total > 0.6) return "positive";
  if (counts.negative / total > 0.6) return "negative";
  if (counts.positive > 0 && counts.negative > 0) return "mixed";
  return "neutral";
}

function createSingleCluster(
  messages: (CategorizedMessage & { embedding: number[] })[]
): ClustererResult {
  return {
    clusters: [{
      id: "cluster-0",
      topic: "All Messages",
      description: "",
      messages,
      opinions: [],
      summary: {
        consensus: [],
        conflicting: [],
        sentiment: calculateClusterSentiment(messages),
      },
      nextSteps: [],
    }],
    visualization: {
      points: messages.map((m, i) => ({ id: m.id, x: i, y: 0, clusterId: 0 })),
    },
  };
}
```

### 4.4 ClusterAnalyzer (Labelling + Opinion Extraction 통합)

```typescript
// src/services/reportPipeline/clusterAnalyzer.ts (신규)

import RequestManager from "../../world/requestManager";
import { MessageCluster, CategorizedMessage, Opinion, ClusterSummary, ActionItem, ReportLanguage } from "../../types/report";
import { parseJsonResponse } from "../../utils/llm";
import { v4 as uuidv4 } from "uuid";

interface ClusterAnalysisResult {
  topic: string;
  description: string;
  opinions: Opinion[];
  summary: ClusterSummary;
  nextSteps: ActionItem[];
}

/**
 * 클러스터 분석: 라벨링 + Opinion 추출 + Summary + NextSteps
 * T3C 스타일 대조적 라벨링 + 기존 분석 기능 통합
 */
export async function analyzeClusters(
  clusters: MessageCluster[],
  apiUrl: string,
  model: string,
  language: ReportLanguage = "ko"
): Promise<MessageCluster[]> {
  console.log(`[ClusterAnalyzer] Analyzing ${clusters.length} clusters`);

  const allMessages = clusters.flatMap(c => c.messages);

  const analyzedClusters = await Promise.all(
    clusters.map(cluster => analyzeCluster(cluster, allMessages, apiUrl, model, language))
  );

  return analyzedClusters;
}

async function analyzeCluster(
  cluster: MessageCluster,
  allMessages: CategorizedMessage[],
  apiUrl: string,
  model: string,
  language: ReportLanguage
): Promise<MessageCluster> {
  const clusterId = cluster.id || uuidv4();

  // 클러스터 내부 예시 (최대 10개, 다양성 확보)
  const insideExamples = cluster.messages
    .slice(0, 10)
    .map(m => `- "${m.content.slice(0, 150)}"`);

  // 클러스터 외부 예시 (다른 클러스터에서 최대 5개)
  const outsideMessages = allMessages.filter(
    m => !cluster.messages.some(cm => cm.id === m.id)
  );
  const outsideExamples = outsideMessages
    .slice(0, 5)
    .map(m => `- "${m.content.slice(0, 100)}"`);

  // 감정 분포 계산
  const sentimentCounts = { positive: 0, negative: 0, neutral: 0 };
  for (const msg of cluster.messages) {
    if (msg.sentiment) sentimentCounts[msg.sentiment]++;
  }

  const langInstruction = language === "ko"
    ? "IMPORTANT: Write ALL text content in Korean."
    : "Write all text content in English.";

  const prompt = `You are analyzing a cluster of user feedback messages.

${langInstruction}

## Context
Total messages in cluster: ${cluster.messages.length}
Sentiment distribution: ${sentimentCounts.positive} positive, ${sentimentCounts.negative} negative, ${sentimentCounts.neutral} neutral

## Examples OUTSIDE this cluster (for contrast):
${outsideExamples.join("\n")}

## Examples INSIDE this cluster:
${insideExamples.join("\n")}

## Tasks
Based on the contrast between messages inside and outside the cluster, provide:

1. **Topic Label**: A short, descriptive topic name (3-5 words)
2. **Description**: One sentence describing what this cluster is about
3. **Opinions**: 3-7 distinct opinions expressed by users in this cluster
4. **Summary**:
   - consensus: Common opinions shared by most users
   - conflicting: Conflicting opinions (if any)
   - sentiment: Overall sentiment ("positive", "negative", "mixed", "neutral")
5. **Next Steps**: 1-3 actionable recommendations based on the feedback

Respond in JSON format only:
{
  "topic": "토픽 라벨",
  "description": "이 클러스터에 대한 설명",
  "opinions": [
    "Opinion 1: ...",
    "Opinion 2: ..."
  ],
  "summary": {
    "consensus": ["Common opinion 1", "Common opinion 2"],
    "conflicting": ["Some users want X while others prefer Y"],
    "sentiment": "mixed"
  },
  "nextSteps": [
    {
      "action": "Specific action to take",
      "priority": "high",
      "rationale": "Why this is important"
    }
  ]
}`;

  try {
    const requestManager = RequestManager.getInstance();
    const response = await requestManager.request(
      apiUrl,
      model,
      [{ role: "user", content: prompt }],
      2000,
      0.3
    );

    const parsed = parseJsonResponse<{
      topic?: string;
      description?: string;
      opinions?: any[];
      summary?: { consensus?: string[]; conflicting?: string[]; sentiment?: string };
      nextSteps?: { action?: string; priority?: string; rationale?: string }[];
    }>(response);

    // Opinion 객체 생성
    const opinions: Opinion[] = (parsed.opinions || []).map((op: any, idx: number) => {
      const text = typeof op === "string" ? op : (op.text || op.opinion || String(op));
      return {
        id: `${clusterId}-op-${idx}`,
        text,
        type: "general" as const,
        supportingMessages: [],  // Grounding에서 채움
        mentionCount: 0,         // Grounding에서 채움
      };
    });

    // Summary
    const summary: ClusterSummary = {
      consensus: parsed.summary?.consensus || [],
      conflicting: parsed.summary?.conflicting || [],
      sentiment: (parsed.summary?.sentiment as any) || "neutral",
    };

    // NextSteps
    const nextSteps: ActionItem[] = (parsed.nextSteps || [])
      .map((step: any) => ({
        action: step.action || "",
        priority: (step.priority || "medium") as "high" | "medium" | "low",
        rationale: step.rationale || "",
      }))
      .filter((step: ActionItem) => step.action);

    return {
      ...cluster,
      id: clusterId,
      topic: parsed.topic || cluster.topic,
      description: parsed.description || cluster.description,
      opinions,
      summary,
      nextSteps,
    };
  } catch (error) {
    console.error(`[ClusterAnalyzer] Error analyzing cluster ${cluster.id}:`, error);
    return {
      ...cluster,
      opinions: [{
        id: `${clusterId}-op-0`,
        text: `${cluster.messages.length} messages about this topic`,
        type: "general",
        supportingMessages: [],
        mentionCount: 0,
      }],
      summary: { consensus: [], conflicting: [], sentiment: "neutral" },
      nextSteps: [],
    };
  }
}
```

### 4.5 통합된 파이프라인

```typescript
// src/services/reportPipeline/index.ts (개선)

import { parseThreads } from "./parser";
import { embedMessages, createOpenAIEmbedder, EmbedFunction } from "./embedder";
import { initializeCategoryEmbeddings, categorizeByEmbedding } from "./categorizer";
import { clusterByEmbedding } from "./clusterer";
import { analyzeClusters } from "./clusterAnalyzer";
import { groundOpinions } from "./grounding";
import { analyzeData } from "./analyzer";
import { synthesizeReport } from "./synthesizer";
import { generateVisualization } from "./visualizer";
import { renderMarkdown } from "./renderer";
import {
  Report,
  ReportRequestParams,
  ReportJobProgress,
  ReportLanguage,
  FilteringBreakdown,
} from "../../types/report";

// Embedder 인스턴스 (재사용)
let embedFn: EmbedFunction | null = null;

export async function generateReport(
  params: ReportRequestParams,
  apiUrl: string,
  model: string,
  onProgress?: (progress: ReportJobProgress) => void
): Promise<Report> {
  const steps = [
    "Parsing messages",
    "Generating embeddings",
    "Categorizing",
    "Clustering",
    "Analyzing clusters",
    "Grounding opinions",
    "Calculating statistics",
    "Synthesizing insights",
    "Generating visualization",
    "Rendering report",
  ];

  const language: ReportLanguage = params.language || "ko";

  let step = 0;
  const updateProgress = (currentStep: string) => {
    step++;
    onProgress?.({
      step,
      totalSteps: steps.length,
      currentStep,
      percentage: Math.round((step / steps.length) * 100),
    });
  };

  // Initialize embedder if needed
  if (!embedFn) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is required for embeddings");
    embedFn = createOpenAIEmbedder(apiKey);
  }

  // 1. Parse (no sampling!)
  updateProgress(steps[0]);
  const parsed = await parseThreads({
    ...params,
    maxMessages: undefined, // 샘플링 제거 - 전체 메시지 처리
  });
  console.log(`[Pipeline] Parsed ${parsed.messages.length} messages from ${parsed.threadCount} threads`);

  // 2. Embed
  updateProgress(steps[1]);
  const embedded = await embedMessages(parsed.messages, embedFn);
  console.log(`[Pipeline] Embeddings: ${embedded.cacheHits} cached, ${embedded.newEmbeddings} new`);

  // 3. Categorize (no LLM) + isSubstantive 필터링
  updateProgress(steps[2]);
  await initializeCategoryEmbeddings(embedFn);
  const allCategorized = categorizeByEmbedding(embedded.messages);

  // 실질적 메시지만 필터링
  const substantiveMessages = allCategorized.filter(m => m.isSubstantive);
  const nonSubstantiveCount = allCategorized.length - substantiveMessages.length;
  console.log(`[Pipeline] Categorized: ${substantiveMessages.length} substantive, ${nonSubstantiveCount} filtered`);

  // Filtering breakdown 계산
  const filteringBreakdown = calculateFilteringBreakdown(allCategorized);

  // 4. Cluster (no LLM)
  updateProgress(steps[3]);
  const clustered = await clusterByEmbedding(substantiveMessages);
  console.log(`[Pipeline] Created ${clustered.clusters.length} clusters`);

  // 5. Analyze clusters (LLM - labelling + opinions + summary + nextSteps)
  updateProgress(steps[4]);
  const analyzed = await analyzeClusters(clustered.clusters, apiUrl, model, language);

  // 6. Ground (LLM)
  updateProgress(steps[5]);
  const grounded = await groundOpinions(analyzed, apiUrl, model);

  // 7. Calculate statistics
  updateProgress(steps[6]);
  const statistics = analyzeData(
    substantiveMessages,
    grounded.clusters,
    parsed.threadCount,
    parsed.messages.length, // 원본 메시지 수
    false, // no sampling
    nonSubstantiveCount,
    filteringBreakdown
  );

  // 8. Synthesize
  updateProgress(steps[7]);
  const synthesized = await synthesizeReport(grounded.clusters, statistics.statistics, apiUrl, model, language);

  // 9. Visualize
  updateProgress(steps[8]);
  const visualization = generateVisualization(grounded.clusters, statistics.statistics, clustered.visualization);

  // 10. Render
  updateProgress(steps[9]);
  const markdown = renderMarkdown(grounded.clusters, statistics.statistics, synthesized.synthesis, language);

  return {
    id: `report-${Date.now()}`,
    title: params.title || "User Feedback Report",
    createdAt: Date.now(),
    statistics: statistics.statistics,
    clusters: grounded.clusters,
    synthesis: synthesized.synthesis,
    visualization,
    markdown,
  };
}

/**
 * Filtering breakdown 계산
 */
function calculateFilteringBreakdown(messages: { content: string; category: string; isSubstantive: boolean }[]): FilteringBreakdown {
  const breakdown: FilteringBreakdown = {
    greetings: 0,
    chitchat: 0,
    shortMessages: 0,
    other: 0,
  };

  const greetingPattern = /^(hi|hello|hey|안녕|하이|헬로)[\s!.?]*$/i;
  const chitchatPattern = /^(ok|okay|yes|no|thanks|ㅇㅇ|ㅋ+|ㅎ+)[\s!.?]*$/i;

  for (const msg of messages) {
    if (msg.isSubstantive) continue;

    const content = msg.content.trim();

    if (content.length < 3) {
      breakdown.shortMessages++;
    } else if (greetingPattern.test(content) || msg.category === "greeting") {
      breakdown.greetings++;
    } else if (chitchatPattern.test(content)) {
      breakdown.chitchat++;
    } else {
      breakdown.other++;
    }
  }

  return breakdown;
}
```

---

## 5. 캐싱 전략 (Caching Strategy)

### 5.1 캐싱 레이어

```
┌─────────────────────────────────────────────────────┐
│                    Cache Layers                      │
├─────────────────────────────────────────────────────┤
│                                                       │
│  [L1] Embedding Cache                                │
│       Key: emb:{content_hash}                        │
│       TTL: 30 days                                   │
│       Value: float[1536]                             │
│                                                       │
│  [L2] Category Cache                                 │
│       Key: cat:{content_hash}                        │
│       TTL: 30 days                                   │
│       Value: { category, sentiment }                 │
│                                                       │
│  [L3] Report Cache (기존)                            │
│       Key: report:cache:{params_hash}                │
│       TTL: 1 hour                                    │
│       Value: ReportJob                               │
│                                                       │
└─────────────────────────────────────────────────────┘
```

### 5.2 캐시 효과

```
첫 번째 리포트 (5000개 메시지):
- Embedding: 5000개 생성, 0개 캐시 히트
- 비용: ~$0.10

두 번째 리포트 (같은 데이터 + 500개 신규):
- Embedding: 500개 생성, 5000개 캐시 히트
- 비용: ~$0.01 (90% 절감)

세 번째 리포트 (같은 데이터, 다른 파라미터):
- Embedding: 0개 생성, 5500개 캐시 히트
- 비용: ~$0.00
```

---

## 6. 구현 계획 (Implementation Plan)

### 6.1 작업 분해

| # | 작업 | 설명 | 예상 시간 |
|---|------|------|-----------|
| 1 | Embedder 구현 | OpenAI 임베딩 + Redis 캐싱 + 배치 처리 | 3시간 |
| 2 | Categorizer 개선 | 유사도 기반 분류 + isSubstantive 판별 | 3시간 |
| 3 | Clusterer 개선 | UMAP + K-means 구현 | 4시간 |
| 4 | ClusterAnalyzer 신규 | 라벨링 + opinions + summary 통합 | 3시간 |
| 5 | 파이프라인 통합 | 단계 연결 및 기존 코드 리팩토링 | 3시간 |
| 6 | 샘플링 제거 | Parser에서 maxMessages 제거, 상수 정리 | 1시간 |
| 7 | Grounding 연동 | 새 파이프라인과 Grounding 통합 | 2시간 |
| 8 | 테스트 및 검증 | 기존 리포트와 품질 비교 | 2시간 |

**총 예상 시간:** 21시간 (~3일)

### 6.2 의존성

```
TRD 12 구현 후:
├── TRD 05 (Grounding) - 전체 메시지 대상으로 정확도 향상
├── TRD 07 (Metadata) - 결정적 클러스터로 일관된 메타데이터
└── TRD 06 (Storage) - 캐싱으로 빠른 재생성
```

---

## 7. 위험 요소 및 완화 (Risks & Mitigations)

| 위험 | 영향도 | 완화 방안 |
|------|--------|----------|
| K-means가 HDBSCAN보다 부정확 | 중간 | 클러스터 수 튜닝, 필요시 HDBSCAN.js 도입 |
| 고정 카테고리가 도메인에 안 맞음 | 중간 | 설정 가능한 카테고리 목록 |
| 대량 메시지 시 메모리 이슈 | 낮음 | 배치 처리, 스트리밍 |
| OpenAI 임베딩 API 장애 | 낮음 | 폴백으로 키워드 기반 분류 |
| isSubstantive 정확도 저하 | 중간 | LLM 기반 판별과 A/B 테스트, 필요시 하이브리드 |
| Sentiment 오분류 (부정 문맥에 긍정 키워드) | 중간 | 부정 키워드 우선 체크, 문맥 고려 로직 |

---

## 7.1 하위 호환성 (Backward Compatibility)

### 카테고리명 유지

기존 시스템과의 호환성을 위해 카테고리명을 유지합니다:

```typescript
// 기존 카테고리명 그대로 사용
const CATEGORIES = [
  "question",    // 유지
  "request",     // 유지
  "feedback",    // 유지
  "complaint",   // 유지
  "information", // 유지
  "greeting",    // 유지
  "other",       // 유지
];
```

### API 응답 형식

기존 리포트 응답 형식은 변경 없이 유지됩니다:
- `ReportJob` 구조 동일
- `MessageCluster` 구조 동일
- `Opinion` 구조 동일 (TRD 05에서 정의)

### 마이그레이션

기존 캐시 데이터와의 충돌을 방지하기 위해:
- 새 임베딩 캐시 키: `emb:msg:{hash}` (기존과 다른 prefix)
- 카테고리 임베딩 캐시: `emb:categories:v1` (버전 포함)

---

## 8. 성공 지표 (Success Metrics)

| 지표 | 현재 | 목표 |
|------|------|------|
| LLM 호출 수 (5000개 메시지) | ~130회 | ~25회 |
| 비용 (5000개 메시지) | ~$2.60 | ~$0.50 |
| 메시지 커버리지 | 20% (샘플링) | 100% |
| 클러스터 결정성 | 비결정적 | 결정적 |
| 두 번째 리포트 비용 | ~$2.60 | ~$0.10 |

---

## 9. 의존성 (Dependencies)

### 새로 추가되는 npm 패키지

```bash
npm install umap-js
# 또는
yarn add umap-js
```

| 패키지 | 버전 | 용도 |
|--------|------|------|
| `umap-js` | ^1.4.0 | 차원 축소 (1536D → 2D) |
| `openai` | 기존 | 임베딩 API (기존 설치됨) |

### 기존 의존성 활용

- `redis` - 임베딩 캐싱
- `uuid` - 클러스터 ID 생성
- `crypto` - 컨텐츠 해싱

---

## 10. 참고 자료 (References)

- [Talk to the City - AI Objectives Institute](https://ai.objectives.institute/talk-to-the-city)
- [GitHub: talk-to-the-city-reports](https://github.com/AIObjectives/talk-to-the-city-reports)
- [UMAP.js - GitHub](https://github.com/PAIR-code/umap-js)
- [OpenAI Embeddings Guide](https://platform.openai.com/docs/guides/embeddings)
- [text-embedding-3-small pricing](https://openai.com/pricing) - $0.00002/1K tokens

---

## 변경 이력 (Change Log)

| 날짜 | 버전 | 변경 내용 | 작성자 |
|------|------|----------|--------|
| 2026-01-27 | 1.0 | 초안 작성 | Claude |
| 2026-01-27 | 1.1 | 코드 리뷰 후 수정: isSubstantive 판별 추가, ClusterAnalyzer 통합, 카테고리명 호환성, Embedder 의존성 분리 | Claude |

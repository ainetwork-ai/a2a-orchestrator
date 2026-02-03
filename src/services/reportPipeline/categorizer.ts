/**
 * Embedding-based Categorizer for TRD 12
 *
 * Replaces LLM-based categorization with embedding similarity.
 * Provides deterministic, cacheable categorization with lower cost.
 */

import { getRedisClient } from "../../utils/redis";
import {
  CategorizedMessage,
  CategorizerResult,
  FilteringBreakdown,
  MIN_MESSAGE_LENGTH,
} from "../../types/report";
import {
  EmbeddedMessage,
  EmbedFunction,
  CategorizedEmbeddedMessage,
  CATEGORY_EMBEDDING_CONFIG,
} from "../../types/embedding";

/**
 * Fixed categories with keywords and descriptions for embedding
 * Matches existing category names for backward compatibility
 */
export const FIXED_CATEGORIES = [
  {
    name: "question",
    description: "질문, 문의, 궁금한 점, 도움 요청",
    keywords: ["어떻게", "왜", "뭐", "무엇", "언제", "어디", "?", "알려주세요", "궁금", "how", "why", "what", "when", "where"],
  },
  {
    name: "request",
    description: "기능 요청, 개선 제안, 추가 요청",
    keywords: ["기능", "추가", "있으면", "해주세요", "원해요", "제안", "바라", "feature", "add", "want", "please"],
  },
  {
    name: "feedback",
    description: "일반적인 피드백, 의견, 긍정적 반응",
    keywords: ["좋아요", "감사", "최고", "만족", "괜찮", "생각", "의견", "good", "great", "thanks", "nice", "love"],
  },
  {
    name: "complaint",
    description: "불만, 버그 신고, 문제 제기, 오류 보고",
    keywords: ["오류", "버그", "안됨", "안 됨", "문제", "에러", "불만", "왜 안", "error", "bug", "broken", "fix", "issue"],
  },
  {
    name: "information",
    description: "정보 공유, 알림, 참고 사항",
    keywords: ["알려드", "공유", "참고", "정보", "안내", "notice", "info", "fyi", "share"],
  },
  {
    name: "greeting",
    description: "인사, 간단한 대화, 환영",
    keywords: ["안녕", "하이", "헬로", "반가", "hi", "hello", "hey", "good morning", "good afternoon"],
    isNonSubstantive: true,
  },
  {
    name: "other",
    description: "기타, 분류 불가",
    keywords: [],
  },
] as const;

/**
 * Patterns for non-substantive messages
 */
export const NON_SUBSTANTIVE_PATTERNS = {
  // Greeting patterns
  greetings: /^(hi|hello|hey|안녕|하이|헬로|good\s*(morning|afternoon|evening)|greetings)[\s!.?]*$/i,
  // Simple acknowledgment patterns
  chitchat: /^(ok|okay|yes|no|yeah|yep|nope|thanks|thank you|thx|ty|ㅇㅇ|ㄴㄴ|ㅋ+|ㅎ+|lol|haha|good|nice|cool|great|sure|alright|got it|i see|understood)[\s!.?]*$/i,
  // Bot identity questions
  botQuestions: /^(who are you|what are you|누구|뭐야|너 뭐야|what is this)[\s?]*$/i,
};

// Category embeddings cache (in-memory singleton)
let categoryEmbeddings: Map<string, number[]> | null = null;

/**
 * Initialize category embeddings with Redis caching
 */
export async function initializeCategoryEmbeddings(
  embedFn: EmbedFunction
): Promise<void> {
  if (categoryEmbeddings) {
    return; // Already initialized
  }

  const redis = getRedisClient();

  // Check Redis cache first
  const cached = await redis.get(CATEGORY_EMBEDDING_CONFIG.cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      categoryEmbeddings = new Map(Object.entries(parsed));
      console.log("[Categorizer] Loaded category embeddings from cache");
      return;
    } catch {
      // Invalid cache, regenerate
    }
  }

  // Generate new embeddings
  console.log("[Categorizer] Generating category embeddings...");
  categoryEmbeddings = new Map();

  const texts = FIXED_CATEGORIES.map(
    (c) => `${c.name}: ${c.description}. Keywords: ${c.keywords.join(", ")}`
  );

  const embeddings = await embedFn(texts);

  FIXED_CATEGORIES.forEach((cat, i) => {
    categoryEmbeddings!.set(cat.name, embeddings[i]);
  });

  // Cache in Redis
  await redis.setEx(
    CATEGORY_EMBEDDING_CONFIG.cacheKey,
    CATEGORY_EMBEDDING_CONFIG.cacheTTLSeconds,
    JSON.stringify(Object.fromEntries(categoryEmbeddings))
  );

  console.log("[Categorizer] Category embeddings generated and cached");
}

/**
 * Calculate cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/**
 * Check if a message is substantive (has analytical value)
 */
export function checkIsSubstantive(content: string, category: string): boolean {
  const trimmed = content.trim();

  // 1. Too short
  if (trimmed.length < MIN_MESSAGE_LENGTH) {
    return false;
  }

  // 2. Greeting category
  if (category === "greeting") {
    return false;
  }

  // 3. Pattern matching
  if (NON_SUBSTANTIVE_PATTERNS.greetings.test(trimmed)) {
    return false;
  }
  if (NON_SUBSTANTIVE_PATTERNS.chitchat.test(trimmed)) {
    return false;
  }
  if (NON_SUBSTANTIVE_PATTERNS.botQuestions.test(trimmed)) {
    return false;
  }

  // 4. Very short messages with only punctuation
  if (trimmed.length < 20) {
    const withoutPunctuation = trimmed.replace(/[?!.\s]/g, "");
    if (!/[a-zA-Z가-힣]/.test(withoutPunctuation)) {
      return false;
    }
  }

  return true;
}

/**
 * Detect sentiment with negative keyword priority
 * Handles cases like "좋아요 버튼이 안 눌려요" (negative, not positive)
 */
export function detectSentiment(
  content: string
): "positive" | "negative" | "neutral" {
  const lower = content.toLowerCase();

  // Negative keywords (check first - higher priority)
  const negativeKeywords = [
    "안됨", "안 됨", "안돼", "안 돼", "못", "없", "싫", "별로", "불만",
    "나쁘", "최악", "실망", "짜증", "화나", "문제", "오류", "버그",
    "에러", "고장", "망", "안되", "안 되", "not working", "broken",
    "error", "bug", "issue", "problem", "bad", "worst", "terrible",
    "disappointed", "frustrated", "angry"
  ];

  // Positive keywords
  const positiveKeywords = [
    "좋", "감사", "최고", "만족", "잘", "굿", "훌륭", "대박", "멋",
    "짱", "완벽", "편리", "유용", "좋아", "사랑", "👍", "❤️", "🎉",
    "good", "great", "awesome", "amazing", "love", "thanks", "perfect",
    "excellent", "wonderful", "helpful", "useful"
  ];

  // Check for negative context first (priority)
  const hasNegativeContext = negativeKeywords.some((w) => lower.includes(w));
  const hasPositiveContext = positiveKeywords.some((w) => lower.includes(w));

  // Negative takes priority (handles "좋아요 버튼이 안 눌려요" case)
  if (hasNegativeContext) {
    return "negative";
  }

  if (hasPositiveContext) {
    return "positive";
  }

  return "neutral";
}

/**
 * Categorize messages using embedding similarity
 */
export function categorizeByEmbedding(
  messages: EmbeddedMessage[]
): CategorizedEmbeddedMessage[] {
  if (!categoryEmbeddings) {
    throw new Error(
      "Category embeddings not initialized. Call initializeCategoryEmbeddings first."
    );
  }

  return messages.map((msg) => {
    // Find best matching category
    let bestCategory = "other";
    let bestScore = -1;

    for (const [category, embedding] of categoryEmbeddings!) {
      const score = cosineSimilarity(msg.embedding, embedding);
      if (score > bestScore) {
        bestScore = score;
        bestCategory = category;
      }
    }

    // Detect sentiment
    const sentiment = detectSentiment(msg.content);

    // Check if substantive
    const isSubstantive = checkIsSubstantive(msg.content, bestCategory);

    return {
      ...msg,
      category: bestCategory,
      sentiment,
      isSubstantive,
    };
  });
}

/**
 * Calculate filtering breakdown for non-substantive messages
 */
export function calculateFilteringBreakdown(
  messages: CategorizedMessage[]
): FilteringBreakdown {
  const breakdown: FilteringBreakdown = {
    greetings: 0,
    chitchat: 0,
    shortMessages: 0,
    other: 0,
  };

  for (const msg of messages) {
    if (msg.isSubstantive) continue;

    const content = msg.content.trim();

    if (content.length < MIN_MESSAGE_LENGTH) {
      breakdown.shortMessages++;
    } else if (
      NON_SUBSTANTIVE_PATTERNS.greetings.test(content) ||
      msg.category === "greeting"
    ) {
      breakdown.greetings++;
    } else if (NON_SUBSTANTIVE_PATTERNS.chitchat.test(content)) {
      breakdown.chitchat++;
    } else {
      breakdown.other++;
    }
  }

  return breakdown;
}

/**
 * Main categorization function for pipeline integration
 * Wraps categorizeByEmbedding with result formatting
 */
export async function categorizeEmbeddedMessages(
  messages: EmbeddedMessage[],
  embedFn: EmbedFunction
): Promise<CategorizerResult> {
  // Ensure category embeddings are initialized
  await initializeCategoryEmbeddings(embedFn);

  // Categorize using embeddings
  const categorized = categorizeByEmbedding(messages);

  // Calculate filtering breakdown
  const filteringBreakdown = calculateFilteringBreakdown(categorized);

  // Log statistics
  const substantiveCount = categorized.filter((m) => m.isSubstantive).length;
  const nonSubstantiveCount = categorized.length - substantiveCount;

  console.log(`[Categorizer] Completed: ${categorized.length} messages`);
  console.log(`[Categorizer] Substantive: ${substantiveCount}, Non-substantive: ${nonSubstantiveCount}`);
  console.log(
    `[Categorizer] Breakdown: greetings=${filteringBreakdown.greetings}, chitchat=${filteringBreakdown.chitchat}, short=${filteringBreakdown.shortMessages}, other=${filteringBreakdown.other}`
  );

  return {
    messages: categorized,
    filteringBreakdown,
  };
}

// Re-export legacy function for backward compatibility during transition
export { categorizeMessages } from "./categorizer.legacy";

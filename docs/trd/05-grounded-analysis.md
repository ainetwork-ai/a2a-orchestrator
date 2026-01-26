# Task 5: Grounded Analysis (Opinion-Quote Linking)

## ⚠️ PRIORITY UPDATED: PHASE 1 (Critical for T3C Experience)

**Original Plan:** Deferred to Phase 2
**Updated Plan:** **Phase 1 - Core MVP Feature**
**Reason:** This is T3C's defining feature. Without it, we have a categorization tool, not a T3C-style deliberation platform.

## Objective

Implement "grounded analysis" - linking each AI-generated opinion/summary back to the specific messages that support it. This enables users to verify claims, build trust in AI-generated insights, and explore the diversity of perspectives.

## Why This is Critical

### T3C's Core Value Proposition
> "Every theme or idea is grounded directly in participant quotes... This design makes the analysis not only more reliable, but also auditable."

**Without grounded analysis:**
- ❌ Users can't verify if AI summaries are accurate
- ❌ No way to trace opinions back to source
- ❌ Hallucinations and errors go undetected
- ❌ It's just another clustering tool

**With grounded analysis:**
- ✅ Users can click any opinion to see supporting quotes
- ✅ Trust and transparency built into the system
- ✅ Diversity of perspectives preserved
- ✅ True T3C-style deliberation platform

## Current State

### Data Structure Ready
```typescript
// src/types/report.ts - Opinion interface already prepared
interface Opinion {
  id: string;
  text: string;
  type: "consensus" | "conflicting" | "general";

  // CURRENTLY COMMENTED OUT - NEED TO IMPLEMENT
  // supportingMessages?: string[]; // Message IDs
  // mentionCount?: number;
}
```

### Pipeline Gap
Current pipeline (7 steps):
```
Parser → Categorizer → Clusterer → Analyzer → Synthesizer → Visualizer → Renderer
```

Missing step: **Grounding** (linking opinions to messages)

## Proposed Implementation

### Phase 1A: Basic Grounding (MVP)

**Goal:** Link each opinion to 1-3 representative supporting messages

**Approach:** LLM-based matching (simple, interpretable)

#### 1. Update Opinion Interface

```typescript
// src/types/report.ts
interface Opinion {
  id: string;
  text: string;
  type: "consensus" | "conflicting" | "general";

  // IMPLEMENT IN PHASE 1A
  supportingMessages: string[]; // Message IDs (1-3 examples)
  mentionCount: number; // Total messages that support this opinion

  // OPTIONAL - NICE TO HAVE
  representativeQuote?: string; // Best single example
  confidence?: number; // 0-1, how well supported
}
```

#### 2. Create Grounding Step

```typescript
// src/services/reportPipeline/grounding.ts

import RequestManager from "../../world/requestManager";
import { MessageCluster, Opinion, CategorizedMessage } from "../../types/report";
import { parseJsonResponse } from "../../utils/llm";

export interface GroundingResult {
  clusters: MessageCluster[]; // Updated with grounded opinions
}

/**
 * Link each opinion to supporting messages using LLM
 */
export async function groundOpinions(
  clusters: MessageCluster[],
  apiUrl: string,
  model: string
): Promise<GroundingResult> {
  console.log(`[Grounding] Linking opinions to messages for ${clusters.length} clusters`);

  const groundedClusters = await Promise.all(
    clusters.map(cluster => groundClusterOpinions(cluster, apiUrl, model))
  );

  return { clusters: groundedClusters };
}

/**
 * Ground opinions for a single cluster
 */
async function groundClusterOpinions(
  cluster: MessageCluster,
  apiUrl: string,
  model: string
): Promise<MessageCluster> {
  if (cluster.opinions.length === 0 || cluster.messages.length === 0) {
    return cluster;
  }

  console.log(`[Grounding] Processing cluster "${cluster.topic}" with ${cluster.opinions.length} opinions`);

  // Convert string opinions to Opinion objects with IDs
  const opinionObjects: Opinion[] = cluster.opinions.map((text, idx) => ({
    id: `${cluster.id}-op-${idx}`,
    text,
    type: "general", // Will be determined in prompt
    supportingMessages: [],
    mentionCount: 0,
  }));

  // Build prompt for LLM
  const messages = cluster.messages.map((msg, idx) => ({
    index: idx,
    id: msg.id,
    content: msg.content.substring(0, 200), // Truncate for token efficiency
  }));

  const opinions = opinionObjects.map((op, idx) => ({
    index: idx,
    id: op.id,
    text: op.text,
  }));

  const prompt = `You are analyzing a cluster of user messages to link opinions to supporting quotes.

Cluster Topic: "${cluster.topic}"

Opinions:
${JSON.stringify(opinions, null, 2)}

Messages:
${JSON.stringify(messages, null, 2)}

For each opinion, identify which messages support it:
1. Find messages that express or relate to the opinion
2. Select 1-3 BEST representative messages (most clear and relevant)
3. Count total number of messages that support it (for mentionCount)

Respond in JSON format:
{
  "groundings": [
    {
      "opinionIndex": 0,
      "supportingMessageIndices": [2, 5, 8],
      "mentionCount": 12,
      "confidence": 0.9
    }
  ]
}`;

  try {
    const requestManager = RequestManager.getInstance();
    const response = await requestManager.request(
      apiUrl,
      model,
      [{ role: "user", content: prompt }],
      1500,
      0.2 // Low temperature for consistency
    );

    const parsed = parseJsonResponse<{ groundings?: any[] }>(response);
    const groundings = parsed.groundings || [];

    // Apply groundings to opinions
    for (const grounding of groundings) {
      const opinionIdx = grounding.opinionIndex;
      if (opinionIdx >= 0 && opinionIdx < opinionObjects.length) {
        const messageIds = (grounding.supportingMessageIndices || [])
          .map((idx: number) => cluster.messages[idx]?.id)
          .filter(Boolean);

        opinionObjects[opinionIdx].supportingMessages = messageIds;
        opinionObjects[opinionIdx].mentionCount = grounding.mentionCount || messageIds.length;
        opinionObjects[opinionIdx].confidence = grounding.confidence;

        // Set representative quote (first supporting message)
        if (messageIds.length > 0) {
          const firstMsg = cluster.messages.find(m => m.id === messageIds[0]);
          if (firstMsg) {
            opinionObjects[opinionIdx].representativeQuote = firstMsg.content;
          }
        }
      }
    }

    console.log(`[Grounding] Linked ${groundings.length} opinions in cluster "${cluster.topic}"`);

    // Return cluster with grounded opinions
    return {
      ...cluster,
      opinions: opinionObjects,
    };
  } catch (error) {
    console.error(`[Grounding] Error grounding cluster "${cluster.topic}":`, error);

    // Fallback: return opinions without grounding
    return {
      ...cluster,
      opinions: opinionObjects,
    };
  }
}
```

#### 3. Integrate into Pipeline

```typescript
// src/services/reportPipeline/index.ts

import { groundOpinions } from "./grounding";

const STEPS = [
  "Parsing threads & anonymizing",
  "Categorizing messages",
  "Clustering by topic",
  "Analyzing statistics",
  "Grounding opinions", // NEW STEP 5
  "Synthesizing insights",
  "Generating visualization data",
  "Generating report",
];

export async function generateReport(
  params: ReportRequestParams,
  apiUrl: string,
  model: string,
  onProgress?: ProgressCallback
): Promise<Report> {
  // ... existing steps 1-4 ...

  // Step 5: Ground opinions to messages (NEW)
  updateProgress(5);
  console.log(`[ReportPipeline] Step 5: ${STEPS[4]}`);
  const groundingResult = await groundOpinions(
    clustererResult.clusters,
    apiUrl,
    model
  );
  console.log(`[ReportPipeline] Grounded opinions in ${groundingResult.clusters.length} clusters`);

  // Step 6: Synthesize (was step 5)
  updateProgress(6);
  console.log(`[ReportPipeline] Step 6: ${STEPS[5]}`);
  const synthesizerResult = await synthesizeReport(
    groundingResult.clusters, // Use grounded clusters
    analyzerResult.statistics,
    apiUrl,
    model,
    language
  );

  // Step 7: Visualization (was step 6)
  updateProgress(7);
  console.log(`[ReportPipeline] Step 7: ${STEPS[6]}`);
  const visualizerResult = await generateVisualizationData(
    groundingResult.clusters, // Use grounded clusters
    analyzerResult.statistics
  );

  // Step 8: Render (was step 7)
  updateProgress(8);
  console.log(`[ReportPipeline] Step 8: ${STEPS[7]}`);
  const rendererResult = renderMarkdown(
    analyzerResult.statistics,
    groundingResult.clusters, // Use grounded clusters
    synthesizerResult.synthesis,
    { timezone: params.timezone, language: params.language }
  );

  return {
    id: reportId,
    title,
    createdAt: Date.now(),
    statistics: analyzerResult.statistics,
    clusters: groundingResult.clusters, // Grounded clusters
    synthesis: synthesizerResult.synthesis,
    visualization: visualizerResult.visualization,
    markdown: rendererResult.markdown,
  };
}
```

#### 4. Update Type Definitions

```typescript
// src/types/report.ts

// Update MessageCluster to use Opinion objects instead of strings
export interface MessageCluster {
  id: string;
  topic: string;
  description: string;
  messages: CategorizedMessage[];
  opinions: Opinion[]; // Changed from string[] to Opinion[]
  summary: ClusterSummary;
  nextSteps: ActionItem[];
}

// Uncomment and finalize Opinion interface
export interface Opinion {
  id: string;
  text: string;
  type: "consensus" | "conflicting" | "general";

  // Grounding fields (Phase 1A)
  supportingMessages: string[]; // Message IDs
  mentionCount: number; // Total supporting messages
  representativeQuote?: string; // Best example quote
  confidence?: number; // 0-1, how confident AI is
}
```

### Phase 1B: Enhanced Grounding (Optional Polish)

**If time permits in Phase 1:**

#### Embedding-Based Similarity (Faster, Cheaper)

```typescript
// Alternative approach using embeddings
import { generateEmbedding } from "../../utils/embeddings";

async function groundOpinionsWithEmbeddings(
  cluster: MessageCluster,
  opinionObjects: Opinion[]
): Promise<Opinion[]> {
  // 1. Generate embeddings for all opinions
  const opinionEmbeddings = await Promise.all(
    opinionObjects.map(op => generateEmbedding(op.text))
  );

  // 2. Generate embeddings for all messages
  const messageEmbeddings = await Promise.all(
    cluster.messages.map(msg => generateEmbedding(msg.content))
  );

  // 3. For each opinion, find top-k similar messages
  for (let i = 0; i < opinionObjects.length; i++) {
    const similarities = messageEmbeddings.map((msgEmb, j) => ({
      messageId: cluster.messages[j].id,
      similarity: cosineSimilarity(opinionEmbeddings[i], msgEmb),
    }));

    // Sort by similarity and take top 3
    similarities.sort((a, b) => b.similarity - a.similarity);
    const topMatches = similarities.slice(0, 3).filter(s => s.similarity > 0.7);

    opinionObjects[i].supportingMessages = topMatches.map(m => m.messageId);
    opinionObjects[i].mentionCount = similarities.filter(s => s.similarity > 0.6).length;
  }

  return opinionObjects;
}
```

## UI/UX Implications

### Frontend Requirements

The grounded opinions enable these UX patterns:

1. **Opinion Card with Quote Preview**
   ```
   📌 "Users want faster loading times" (15 mentions)

   💬 "The app takes too long to load"
   💬 "Loading speed is really slow"
   💬 "Can you improve performance?"

   [Show all 15 messages →]
   ```

2. **Clickable Opinion → Message List**
   - Click opinion text → Scroll to or expand supporting messages
   - Highlight supporting messages in topic view
   - Show snippet of each supporting quote

3. **Message Reference Count Badge**
   ```
   Opinion: "Dark mode is requested"  [12 mentions 📊]
   ```

4. **Confidence Indicator**
   ```
   Opinion: "Some users prefer light theme"  [3 mentions ⚠️ Low confidence]
   ```

## Performance Considerations

### Optimization Strategies

1. **Batch Processing**: Ground multiple clusters in parallel
2. **Token Efficiency**: Truncate long messages (first 200 chars)
3. **Caching**: Cache embeddings if using embedding approach
4. **Sampling**: For clusters with >50 messages, sample for grounding

### Performance Targets

- Grounding step: < 2 seconds per cluster
- Total pipeline increase: < 30% (acceptable for MVP)
- For 10 clusters with 30 messages each: ~20 seconds total

## Testing Requirements

### Unit Tests

```typescript
describe("Grounding", () => {
  it("should link opinions to supporting messages", async () => {
    const cluster = createTestCluster();
    const grounded = await groundClusterOpinions(cluster, apiUrl, model);

    expect(grounded.opinions[0].supportingMessages.length).toBeGreaterThan(0);
    expect(grounded.opinions[0].mentionCount).toBeGreaterThan(0);
  });

  it("should select representative quotes", async () => {
    const cluster = createTestCluster();
    const grounded = await groundClusterOpinions(cluster, apiUrl, model);

    expect(grounded.opinions[0].representativeQuote).toBeDefined();
  });

  it("should handle empty opinions gracefully", async () => {
    const cluster = { ...createTestCluster(), opinions: [] };
    const grounded = await groundClusterOpinions(cluster, apiUrl, model);

    expect(grounded.opinions).toEqual([]);
  });
});
```

### Integration Tests

1. Generate report → Check all opinions have supportingMessages
2. Validate message IDs exist in cluster.messages
3. Verify mentionCount ≤ cluster.messages.length
4. Check confidence scores are 0-1

### Manual Validation

- Review sample report: Are linked quotes actually relevant?
- Check for hallucinations: Do opinions reflect actual messages?
- Verify diversity: Are minority opinions also grounded?

## Migration Path

### Backward Compatibility

Old reports (before grounding):
```typescript
opinions: ["Opinion text 1", "Opinion text 2"] // string[]
```

New reports (with grounding):
```typescript
opinions: [
  {
    id: "op-1",
    text: "Opinion text 1",
    supportingMessages: ["msg-1", "msg-2"],
    mentionCount: 5
  }
] // Opinion[]
```

**Solution:** API transformer handles both formats:

```typescript
// src/utils/reportTransformer.ts

function transformOpinions(opinions: string[] | Opinion[]): Opinion[] {
  if (opinions.length === 0) return [];

  // Check if already Opinion objects
  if (typeof opinions[0] === "object") {
    return opinions as Opinion[];
  }

  // Convert old string format to Opinion objects
  return (opinions as string[]).map((text, idx) => ({
    id: `legacy-op-${idx}`,
    text,
    type: "general",
    supportingMessages: [],
    mentionCount: 0,
  }));
}
```

## Acceptance Criteria

- ✅ Opinion interface includes supportingMessages and mentionCount
- ✅ Grounding step integrated into pipeline
- ✅ All opinions have at least 1 supporting message (or 0 if no match)
- ✅ Representative quotes selected accurately
- ✅ Message IDs validated (exist in cluster)
- ✅ Performance within targets (< 2s per cluster)
- ✅ UI can display opinion → quote linking
- ✅ Backward compatibility maintained
- ✅ Tests pass

## Implementation Timeline

**Phase 1A - MVP Grounding:**
- Day 1: Update types, create grounding.ts skeleton
- Day 2: Implement LLM-based grounding logic
- Day 3: Integrate into pipeline, update transformer
- Day 4: Testing and validation
- Day 5: Performance optimization

**Total: 5 days** (parallel with other Phase 1 tasks)

## References

- [Talk to the City - Grounded Analysis](https://ai.objectives.institute/talk-to-the-city)
- [Current Clusterer](../../src/services/reportPipeline/clusterer.ts)
- [Opinion Interface](../../src/types/report.ts)
- [Future Decisions](./99-future-decisions.md) - Original deferred decision

## Decision Record

**Date:** 2026-01-26
**Decision:** Move grounded analysis from Phase 2 to **Phase 1**
**Rationale:** This is T3C's defining feature. Without it, we don't have a T3C-style platform.
**Impact:** +5 days to Phase 1, +30% to pipeline time, but critical for MVP trust and transparency.

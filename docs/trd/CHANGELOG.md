# TRD Changelog

## 2026-01-26 - T3C Comparison Update

### Critical Changes

#### Task 05 Added: Grounded Analysis (Opinion-Quote Linking)
**Status:** 🔴 **MOVED TO PHASE 1** (Originally deferred to Phase 2)

**Reason:** After comprehensive comparison with Talk to the City's implementation, grounded analysis was identified as **THE defining feature** of T3C-style deliberation platforms. Without it, we have a clustering tool, not a deliberation platform.

**Key Findings from T3C Analysis:**
- T3C's core value proposition: "Every theme or idea is grounded directly in participant quotes"
- This enables trust, transparency, and auditability
- Users can verify AI-generated summaries against actual source quotes
- This is not a "nice-to-have" - it's what makes it "T3C-style"

**Impact:**
- **Timeline:** +5 days to Phase 1 (now 10-15 days vs 5-8 days)
- **Pipeline:** +1 step (grounding between clustering and synthesis)
- **Performance:** +30% processing time (acceptable for MVP)
- **Complexity:** Medium (data structure already prepared)

**Files Created:**
- [docs/trd/05-grounded-analysis.md](./05-grounded-analysis.md) - Full implementation spec

**Files Updated:**
- [docs/trd/README.md](./README.md) - Added Task 05, updated Phase 1 timeline
- [docs/trd/00-overview.md](./00-overview.md) - Updated decision table
- [docs/trd/99-future-decisions.md](./99-future-decisions.md) - Marked Decision #13 as Phase 1

---

### Priority Changes

#### Decision #6: Grounded Analysis
- **Before:** Deferred to Phase 2
- **After:** 🔴 Phase 1 (Critical)

#### Decision #7: Message Count per Opinion
- **Before:** Deferred to Phase 2
- **After:** Phase 1 (part of grounded analysis)

---

### What Was Added

#### New Task Document: 05-grounded-analysis.md

**Contents:**
1. **Why Critical:** Explanation of T3C's core value proposition
2. **Implementation Approach:** LLM-based opinion → message linking
3. **Data Structure Updates:**
   ```typescript
   interface Opinion {
     supportingMessages: string[]; // Uncommented and implemented
     mentionCount: number;
     representativeQuote?: string;
     confidence?: number;
   }
   ```
4. **New Pipeline Step:** Grounding (between clustering and synthesis)
5. **Performance Targets:** < 2s per cluster
6. **Testing Strategy:** Unit, integration, and manual validation
7. **Migration Path:** Backward compatibility with old string[] format

**Estimated Effort:** 5 days

---

### Comparison Analysis Results

#### ✅ What We Covered Well
1. JSON API structure (comprehensive type definitions)
2. Visualization data (scatter plot, tree, charts)
3. Message filtering (substantive vs non-substantive)
4. Sentiment analysis (nuanced with "mixed" support)
5. Anonymization (full PII removal)
6. Preserving diversity (consensus vs conflicting opinions)

#### ⚠️ What Needs Attention
1. **Grounded analysis** → Now Phase 1 ✅
2. **Hierarchical subclustering** → Still evaluating (Decision #3, #4)
3. **Message count per opinion** → Now Phase 1 ✅
4. **Navigation patterns** → Deferred to frontend
5. **Confidence scores** → Optional in Phase 1, recommended

#### 🔴 What's Still Missing (Future Phases)
1. Quote highlighting with context
2. Cross-topic connections
3. Participant diversity metrics (challenging with full anonymization)
4. Report versioning/iteration
5. Human review workflow

---

### Timeline Impact

**Original Plan:**
- Phase 1: 5-8 days (Tasks 01 + 04)
- Phase 2: 4-6 days (Tasks 02)
- Phase 3: 2-3 days (Tasks 03)
- Total: 13-20 days (3-4 weeks)

**Updated Plan:**
- Phase 1: 10-15 days (Tasks 01 + 04 + **05**) ← +5 days
- Phase 2: 4-6 days (Task 02)
- Phase 3: 2-3 days (Task 03)
- Phase 4: 2-3 days (Testing)
- Total: 18-27 days (4-5 weeks)

---

### Recommendations Implemented

From T3C comparison analysis:

1. ✅ **Moved grounded analysis to Phase 1**
   - Opinion interface enhanced with supportingMessages
   - New grounding.ts pipeline step
   - LLM-based implementation approach

2. ✅ **Added message count tracking**
   - Part of Opinion interface (mentionCount)
   - Shows which opinions are widely held

3. ⏸️ **Hierarchical subclustering** (Still evaluating)
   - Topic interface supports it (parentId, level)
   - Marked for evaluation in Phase 2
   - Decision #3, #4 in 99-future-decisions.md

4. ⏸️ **Confidence scores** (Optional Phase 1)
   - Added to Opinion interface as optional
   - Can be implemented if time permits

---

### Recommendations Deferred

From T3C comparison analysis:

1. **Human Review Workflow**
   - Out of scope for Phase 1-3
   - Added to 99-future-decisions.md
   - Requires separate product decision

2. **Cross-Topic Connections**
   - Phase 3 or later
   - Would add relatedTopicIds to Topic interface

3. **Enhanced Context** (previousMessage, nextMessage)
   - Phase 3 or later
   - Helps with conversation flow

4. **Temporal Analysis**
   - Phase 3 or later
   - How opinions evolved over time

---

### Document Status

**Before Update:**
- 6 documents (00-04, 99, README)
- Phase 1: 2 tasks
- Timeline: 3-4 weeks

**After Update:**
- **7 documents** (00-05, 99, README, CHANGELOG)
- Phase 1: **3 tasks** (added grounded analysis)
- Timeline: **4-5 weeks**
- **Critical T3C feature now included**

---

### Key Takeaways

1. **Grounded analysis is not optional** for T3C-style experience
   - It's the difference between "clustering tool" and "deliberation platform"
   - Users need to verify AI claims against actual quotes

2. **Data structures were well-prepared**
   - Opinion interface had commented-out fields ready
   - Just needed prioritization decision

3. **Implementation is straightforward**
   - LLM-based approach is simpler than embedding
   - Pipeline is extensible (easy to add step)
   - Performance impact is acceptable (~30%)

4. **Timeline increase is justified**
   - +5 days for critical feature
   - Still delivers in 4-5 weeks
   - MVP will have true T3C-style transparency

---

### Next Steps

1. **Review this changelog** with team
2. **Approve Phase 1 scope change** (add Task 05)
3. **Begin implementation** with updated plan:
   - Week 1-2: Tasks 01, 04, 05 (foundation + grounding)
   - Week 3: Task 02 (visualization)
   - Week 4: Task 03 (API)
   - Week 5: Testing & polish

4. **Re-evaluate subclustering** after Phase 1
   - Decision #3, #4 in 99-future-decisions.md
   - Based on initial report quality

---

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 1.0 | 2026-01-26 | Initial TRD documents (00-04, 99) | - |
| 1.1 | 2026-01-26 | Added Task 05 (grounded analysis), updated timeline | - |

---

## Related Documents

- [00-overview.md](./00-overview.md) - Updated with new Phase 1 tasks
- [05-grounded-analysis.md](./05-grounded-analysis.md) - New document (critical)
- [99-future-decisions.md](./99-future-decisions.md) - Updated Decision #13
- [README.md](./README.md) - Updated roadmap and timeline

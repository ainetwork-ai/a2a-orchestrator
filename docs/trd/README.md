# Technical Requirements Documents (TRD)

## T3C-Style Report Format Migration

This directory contains the Technical Requirements Documents for migrating the A2A Orchestrator report generation system from Markdown-based format to a Talk to the City (T3C) inspired JSON API with visualization support.

## Document Index

### [00. Overview](./00-overview.md)
**Main TRD document** providing project goals, decisions made, scope, and success criteria.

**Key Topics:**
- Project objectives and background
- Decision matrix for all design choices
- In-scope vs out-of-scope features
- Document structure and organization
- Success criteria

**Read this first** to understand the overall project.

---

### [01. JSON API Response Structure](./01-json-api-structure.md)
Design specification for the new T3C-style JSON response format.

**Key Topics:**
- Enhanced `T3CReport` interface with full type definitions
- `Topic`, `Opinion`, `MessageRef` structures
- `VisualizationData` structure (scatter plot, tree, charts)
- `ReportMetadata` for processing information
- Backward compatibility strategy
- Type definitions and implementation plan

**Estimated Effort:** 3-5 days

**Dependencies:** None

**Critical for:** All subsequent tasks depend on this structure

---

### [02. Visualization Data Generation](./02-visualization-data.md)
Implementation guide for generating visualization-ready data structures.

**Key Topics:**
- New `visualizer.ts` pipeline step
- Scatter plot generation algorithm
  - Coordinate calculation (sentiment, time, priority)
  - Point sizing and coloring
  - Axis configuration
- Topic tree generation (hierarchical structure)
- Statistical chart data (pie, bar, line charts)
- Performance optimization strategies
- Integration into existing pipeline

**Estimated Effort:** 4-6 days

**Dependencies:** Task 01 (data structure design)

**Critical for:** Interactive UI visualization features

---

### [03. API Endpoint Updates](./03-api-endpoints.md)
API endpoint modifications to support new JSON format with backward compatibility.

**Key Topics:**
- New `format` query parameter (json/markdown/full)
- `includeMessages` parameter for performance optimization
- Optional endpoints: `/topics`, `/visualization`
- Response format specifications
- Report transformer utility (`reportTransformer.ts`)
- Backward compatibility strategy
- Migration path for clients

**Estimated Effort:** 2-3 days

**Dependencies:** Task 01 (structure), Task 02 (visualization)

**Critical for:** Frontend integration

---

### [04. Substantive Message Filtering](./04-message-filtering.md)
Ensuring only valuable messages appear in report output while filtering non-substantive content.

**Key Topics:**
- Explicit filtering in cluster output
- Report validation utility (`reportValidator.ts`)
- Filtering metrics in metadata
- Enhanced categorizer logging
- Edge case handling (all filtered, few substantive, high filtering rate)
- Testing strategy for data quality

**Estimated Effort:** 2-3 days

**Dependencies:** Task 01 (structure)

**Critical for:** Data quality and user trust

---

### [05. Grounded Analysis (Opinion-Quote Linking)](./05-grounded-analysis.md) 🔴 **CRITICAL**
**⚠️ MOVED TO PHASE 1** - Originally planned for Phase 2, but this is T3C's defining feature.

Link AI-generated opinions back to specific supporting messages for transparency and trust.

**Key Topics:**
- Why this is T3C's core feature (auditable, verifiable analysis)
- LLM-based opinion → message linking
- `Opinion` interface with `supportingMessages`, `mentionCount`
- New pipeline step: Grounding
- Representative quote selection
- Confidence scoring
- Performance optimization (< 2s per cluster)

**Estimated Effort:** 5 days

**Dependencies:** Task 01 (structure), Task 03 (clusterer)

**Critical for:** Trust, transparency, T3C-style experience

**Priority:** 🔴 **HIGH** - Without this, we have a clustering tool, not a T3C platform

---

### [99. Future Decisions & Deferred Features](./99-future-decisions.md)
Tracking decisions deferred to future phases and features out of scope.

**Key Topics:**
- Deferred decisions (10-17 from original analysis)
  - Metadata in reports
  - Anonymization levels
  - Pipeline restructure
  - Grounded analysis (quote linking)
  - Granular API endpoints
  - Real-time updates
  - Report storage strategy
  - Public sharing links
- Out of scope features
- Decision-making process
- Review schedule and priorities

**Purpose:** Long-term planning and decision tracking

**Status:** Living document - to be reviewed quarterly

---

## Implementation Roadmap

### Phase 1: Foundation (Tasks 01 + 04 + 05) 🔴 **UPDATED**
**Duration:** 10-15 days

1. Define TypeScript interfaces for new data structures
2. Implement validation utilities
3. Ensure message filtering is correct
4. **Implement grounded analysis (opinion-quote linking)** ← **NEW**

**Deliverables:**
- Updated `src/types/report.ts` with new interfaces
- `src/utils/reportValidator.ts` for validation
- `src/services/reportPipeline/grounding.ts` for opinion linking ← **NEW**
- Tests for type validation, filtering, and grounding

---

### Phase 2: Visualization (Task 02)
**Duration:** 4-6 days

1. Implement `src/services/reportPipeline/visualizer.ts`
2. Integrate into existing pipeline
3. Generate scatter plot, tree, and chart data

**Deliverables:**
- Visualization data generator
- Updated pipeline with new step
- Tests for visualization generation

---

### Phase 3: API Integration (Task 03)
**Duration:** 2-3 days

1. Update `src/routes/reports.ts` with format parameter
2. Create `src/utils/reportTransformer.ts`
3. Implement optional endpoints

**Deliverables:**
- Updated API endpoints
- Transformer utility
- API integration tests
- Updated API documentation

---

### Phase 4: Testing & Validation
**Duration:** 2-3 days

1. Comprehensive integration testing
2. Performance testing
3. Data quality validation
4. Frontend integration testing

**Deliverables:**
- Full test suite
- Performance benchmarks
- Validation reports
- Bug fixes

---

## Total Estimated Timeline

**Phase 1 (Updated):** 10-15 days
**Phase 2:** 4-6 days
**Phase 3:** 2-3 days
**Phase 4:** 2-3 days

**Best Case:** 18-27 days (sequential execution)

**Realistic:** 4-5 weeks (accounting for reviews, testing, iterations, grounded analysis)

**Note:** This document focuses on **what** and **how**, not **when**. Actual scheduling should consider team capacity, priorities, and dependencies.

---

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Output Format** | JSON API only (Option B) | Frontend handles rendering, backend provides data |
| **Visualization** | Required | Essential for T3C-style interactive UI |
| **Hierarchy** | Evaluate current structure | Check if 1-level topics work or need subclusters |
| **Message Inclusion** | All substantive messages | But filter non-valuable content (greetings, chitchat) |
| **Grounded Analysis** | Deferred to next phase | Opinion → quote mapping is future work |
| **Interactive Features** | Frontend implementation | Filtering, search, navigation in frontend |
| **Backward Compatibility** | Maintained | Markdown endpoint continues working |

---

## Success Metrics

### Functional Requirements
- ✅ JSON API returns structured data suitable for T3C-style UI
- ✅ All substantive messages included, non-substantive filtered
- ✅ Visualization data enables scatter plots, trees, charts
- ✅ Backward compatibility maintained (Markdown endpoint works)

### Performance Requirements
- ✅ API response time < 2 seconds for cached reports
- ✅ Visualization generation < 500ms
- ✅ Pipeline overhead < 10% increase

### Quality Requirements
- ✅ 100% of output messages are substantive (validated)
- ✅ All tests passing (unit, integration, performance)
- ✅ No regressions in existing functionality
- ✅ API documentation complete and accurate

---

## Related Resources

### Code References
- [Current Report Service](../../src/services/reportService.ts)
- [Report Pipeline](../../src/services/reportPipeline/index.ts)
- [Report Types](../../src/types/report.ts)
- [Report Routes](../../src/routes/reports.ts)

### External References
- [Talk to the City](https://talktothe.city/)
- [T3C GitHub (tttc-light-js)](https://github.com/AIObjectives/tttc-light-js)
- [T3C Report Example](https://talktothe.city/report/HAcEAQ3bTfXlWhtCXHa7)
- [AI Objectives Institute](https://ai.objectives.institute/talk-to-the-city)

### Design References
- [D3.js Visualization Gallery](https://observablehq.com/@d3/gallery)
- [REST API Best Practices](https://restfulapi.net/)
- [Data Quality Standards](https://www.dataqualitypro.com/)

---

## Getting Started

1. **Read the Overview** ([00-overview.md](./00-overview.md)) to understand project scope
2. **Review Task Documents** in order (01 → 02 → 03 → 04)
3. **Start with Phase 1** (Foundation) - Tasks 01 and 04
4. **Follow Implementation Roadmap** sequentially
5. **Run Tests** after each phase completion
6. **Update Documentation** as you implement

---

## Questions or Feedback?

For questions about these TRDs or implementation details, please refer to:
- Task-specific "References" sections
- Code comments in related source files
- Project README for general information

---

## Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-01-26 | Initial | All TRD documents created |

---

## Document Status

- [x] 00-overview.md - Complete
- [x] 01-json-api-structure.md - Complete
- [x] 02-visualization-data.md - Complete
- [x] 03-api-endpoints.md - Complete
- [x] 04-message-filtering.md - Complete
- [x] 05-grounded-analysis.md - **Complete (NEW - Phase 1 Critical)** 🔴
- [x] 99-future-decisions.md - Complete (Living document)

**Status:** All core implementation documents finalized and ready for implementation.

**Important Update:** Task 05 (Grounded Analysis) was added to Phase 1 based on T3C comparison analysis. This is a critical feature for delivering true T3C-style experience.

**Note:** Document 99 (Future Decisions) is a living document that will be updated as decisions are made and priorities change.

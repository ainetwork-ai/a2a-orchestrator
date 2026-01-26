# Future Decisions & Deferred Features

## Overview

This document tracks decisions that have been **deferred** to future phases and features that are **out of scope** for the initial T3C-style report migration but may be implemented later.

## Status: To Be Decided

These decisions are intentionally left open and will be addressed in future iterations based on:
- Initial implementation experience
- User feedback
- Performance data
- Product priorities

---

## Deferred Decisions

### 10. Metadata in Report Output

**Question:** What metadata should be included in the report?

**Options:**
- [ ] Thread-level breakdown (Thread #123: 5 messages)
- [ ] Agent-level breakdown (Agent "MedicalBot": 20 messages)
- [ ] Time-period breakdown (Week 1: 50 messages, Week 2: 30 messages)
- [ ] Per-message timestamps in detail view
- [ ] Category-specific deep analysis

**Current Decision:** Deferred

**Rationale:**
- Need to understand frontend requirements first
- Depends on what insights users actually need
- May impact performance if too much metadata

**When to Revisit:** After Phase 1-3 completion and initial user testing

**Impact:**
- Low - Can add incrementally without breaking changes
- Metadata can be added to existing structures

**Related Code:**
- `src/types/report.ts` - ReportMetadata interface
- `src/services/reportPipeline/analyzer.ts`

---

### 11. Anonymization Level

**Question:** Should anonymization level be adjustable?

**Options:**
- **Full anonymization** (current): All PII removed, no user/thread IDs
- **Partial anonymization**: Session/thread IDs preserved (not personally identifiable)
- **Configurable**: Parameter to control anonymization level

**Current Decision:** Deferred

**Rationale:**
- Security and privacy concerns need careful consideration
- Current full anonymization is safest approach
- Need compliance review before exposing more data

**When to Revisit:** After legal/compliance review

**Impact:**
- Medium - Requires privacy impact assessment
- May need user consent mechanisms

**Related Code:**
- `src/services/reportPipeline/parser.ts` - anonymizeContent()
- `src/types/report.ts` - MessageRef interface

**Security Considerations:**
- Must ensure no PII leakage
- Consider GDPR, CCPA compliance
- Document anonymization guarantees

---

### 12. Pipeline Modification

**Question:** Should the report generation pipeline be restructured?

**Options:**
- **Option A**: Keep current pipeline, only modify renderer
- **Option B**: Full restructure to T3C-style pipeline
- **Option C**: Hybrid approach - current pipeline + additional subclustering step

**Current Decision:** Option A (current pipeline) + evaluation

**Rationale:**
- Current pipeline works well
- Minimize risk and development time
- Can optimize later based on needs

**When to Revisit:** After Phase 2 completion (visualization)

**Impact:**
- Low (Option A) - Minimal changes
- High (Option B) - Complete rewrite
- Medium (Option C) - Additional complexity

**Related Code:**
- `src/services/reportPipeline/index.ts` - Main pipeline
- All pipeline steps (parser, categorizer, clusterer, etc.)

**Evaluation Criteria:**
- Is subclustering needed for better organization?
- Are current topics too broad or too narrow?
- User feedback on topic granularity

---

### 13. Quote Linking (Grounded Analysis)

**Question:** Should we implement opinion → message linking?

**Options:**
- **LLM-based**: Use LLM to map each opinion to supporting messages ✅ **SELECTED**
- **Embedding-based**: Use semantic similarity to link opinions and messages
- **Skip**: Keep current summary-only approach

**Current Decision:** ✅ **MOVED TO PHASE 1**

**Update (2026-01-26):** After T3C comparison analysis, this feature was identified as **critical** for delivering true T3C-style experience. Moved from deferred to Phase 1.

**Rationale for Priority Change:**
- This IS T3C's defining feature, not an add-on
- Without it, we have a clustering tool, not a deliberation platform
- Trust and transparency require linking opinions to actual quotes
- Data structure already ready, implementation is straightforward

**See:** [Task 05: Grounded Analysis](./05-grounded-analysis.md) for full implementation plan

**When to Revisit:** ~~Phase 2 (Q2 2026)~~ → **Now in Phase 1**

**Impact:**
- High - Major feature addition
- Requires new pipeline step
- Increases API response size

**Implementation Notes:**
```typescript
// Future structure
interface Opinion {
  id: string;
  text: string;
  type: "consensus" | "conflicting" | "general";

  // FUTURE: Grounded analysis
  supportingMessages?: string[]; // Message IDs
  mentionCount?: number;
  confidence?: number; // 0-1, how well supported
}
```

**Related Code:**
- `src/types/report.ts` - Opinion interface
- New file: `src/services/reportPipeline/grounding.ts` (to be created)

**Evaluation Criteria:**
- User feedback: Do they trust summaries without quotes?
- Usage patterns: Do users drill down to individual messages?
- Technical: Can we maintain performance with linking?

---

### 14. API Structure

**Question:** Should we add granular API endpoints?

**Options:**
- **Option A**: Keep current + add format parameter only
- **Option B**: Add topic-level endpoints for granular access
  - `GET /api/reports/:jobId/topics`
  - `GET /api/reports/:jobId/topics/:topicId`
  - `GET /api/reports/:jobId/quotes`

**Current Decision:** Option A with optional lightweight endpoints

**Implementation Status:**
- ✅ `GET /api/reports/:jobId?format=json` - Implemented
- ✅ `GET /api/reports/:jobId/markdown` - Existing
- ⏸️ `GET /api/reports/:jobId/topics` - Optional (documented in Task 03)
- ⏸️ `GET /api/reports/:jobId/visualization` - Optional (documented in Task 03)

**When to Revisit:** After measuring API response sizes and frontend needs

**Impact:**
- Low - Optional endpoints can be added without breaking changes
- Improves performance for large reports

**Related Code:**
- `src/routes/reports.ts`

**Performance Considerations:**
- Full report may be >1MB for large datasets
- Granular endpoints reduce initial load time
- Implement if frontend reports performance issues

---

### 15. Real-time Updates

**Question:** Should report generation status stream in real-time?

**Options:**
- **WebSocket/SSE**: Real-time progress streaming
- **Polling** (current): Frontend polls for status
- **Completion only**: Only accessible when done

**Current Decision:** Keep polling (current approach)

**Rationale:**
- Polling works for current use case
- Less complex than WebSocket infrastructure
- Reports complete quickly (< 10 seconds typically)

**When to Revisit:** If reports start taking >30 seconds or user feedback requests it

**Impact:**
- Medium - Infrastructure change required
- Better UX for long-running reports

**Related Code:**
- `src/routes/reports.ts` - GET /:jobId endpoint
- Thread system already has SSE: `src/routes/threads.ts`

**Implementation Path (if needed):**
```typescript
// Example SSE endpoint
router.get("/:jobId/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const interval = setInterval(async () => {
    const job = await reportService.getJob(req.params.jobId);
    res.write(`data: ${JSON.stringify(job.progress)}\n\n`);

    if (job.status === "completed" || job.status === "failed") {
      clearInterval(interval);
      res.end();
    }
  }, 1000);
});
```

---

### 16. Report Storage

**Question:** How should reports be stored and managed?

**Options:**
- **Temporary** (current): Redis cache with 1-hour TTL
- **Persistent**: Permanent storage (S3, GCS, or database)
- **Configurable**: Optional permanent storage for important reports

**Current Decision:** Keep temporary (current approach)

**Rationale:**
- Reports can be regenerated if needed
- Reduces storage costs
- Most use cases don't need long-term storage

**When to Revisit:** If users request report history or archival

**Impact:**
- Medium - Requires storage infrastructure
- Adds complexity for cleanup and management

**Related Code:**
- `src/services/reportService.ts` - Cache management
- `src/types/report.ts` - REPORT_CACHE_TTL_SECONDS

**Implementation Notes:**
```typescript
// Future: Optional persistent storage
interface ReportRequestParams {
  // ... existing params ...

  // FUTURE: Storage options
  persist?: boolean; // Save permanently
  expiresAt?: number; // Custom expiration
  tags?: string[]; // For organization
}
```

**Storage Considerations:**
- Cost: Large reports can be 1-5MB each
- Cleanup: Need garbage collection strategy
- Access control: Who can view archived reports?

---

### 17. Public Sharing Links

**Question:** Should reports be shareable via public links?

**Options:**
- **Public links**: `https://domain.com/reports/public/abc123`
- **Internal only** (current): Authentication required
- **Conditional**: Optional public sharing with token

**Current Decision:** Internal only (current approach)

**Rationale:**
- Security concerns with public data
- Anonymization may not be sufficient for all data
- Need access control design first

**When to Revisit:** After security review and user requirements

**Impact:**
- High - Security and privacy implications
- Requires authentication/authorization system

**Related Code:**
- `src/routes/reports.ts`
- New file: `src/middleware/publicReportAuth.ts` (to be created)

**Security Requirements:**
- Token-based access control
- Expiration for public links
- Audit logging for public access
- Rate limiting

**Implementation Notes:**
```typescript
// Future: Public sharing
interface ReportJob {
  // ... existing fields ...

  // FUTURE: Public sharing
  isPublic?: boolean;
  publicToken?: string;
  publicExpiresAt?: number;
  sharedBy?: string;
}

// New route
router.get("/public/:token", async (req, res) => {
  // Validate token, check expiration
  // Return report without authentication
});
```

---

## Out of Scope (Not Planned)

These features are explicitly **not** in scope for the foreseeable future:

### Multi-language UI
- Reports support ko/en in content
- But UI/navigation remains English
- Full i18n is separate project

### Report Comparison
- Compare two reports side-by-side
- Trend analysis over time
- Requires significant additional work

### Collaborative Features
- Comments on reports
- Annotations
- Sharing within teams
- Requires full user management system

### Advanced Analytics
- ML-based trend detection
- Anomaly detection
- Predictive insights
- Requires ML infrastructure

### Export Formats
- PDF export
- Excel export
- PowerPoint export
- Scheduled email reports

---

## Decision-Making Process

When revisiting deferred decisions:

1. **Gather Data**
   - User feedback and usage patterns
   - Performance metrics
   - Technical feasibility assessment

2. **Create Proposal**
   - Update this document with recommendation
   - Create new TRD if substantial work required
   - Estimate effort and impact

3. **Review & Approve**
   - Technical review
   - Product review
   - Security/compliance review (if applicable)

4. **Implement**
   - Follow standard development process
   - Update documentation
   - Deprecate old behavior if breaking change

---

## Tracking

### By Priority

**High Priority** (likely to implement soon):
- [ ] Decision 10: Metadata in reports
- [ ] Decision 13: Grounded analysis (quote linking)
- [ ] Decision 14: Granular API endpoints

**Medium Priority** (implement if requested):
- [ ] Decision 11: Anonymization levels
- [ ] Decision 15: Real-time updates
- [ ] Decision 16: Persistent storage

**Low Priority** (unlikely to implement):
- [ ] Decision 17: Public sharing
- [ ] Decision 12: Pipeline restructure

### By Phase

**Phase 2** (After MVP - Q2 2026):
- Grounded analysis (opinion → quote mapping)
- Enhanced metadata

**Phase 3** (Based on feedback - Q3 2026):
- Granular API endpoints
- Real-time updates

**Phase 4** (If needed - Q4 2026+):
- Persistent storage
- Public sharing

---

## Review Schedule

This document should be reviewed:
- After each major release
- When user feedback suggests new features
- Quarterly product planning sessions
- When technical constraints change

**Next Review Date:** 2026-04-01 (After Phase 1-3 completion)

---

## Version History

| Version | Date | Changes | Reviewer |
|---------|------|---------|----------|
| 1.0 | 2026-01-26 | Initial document created | - |

---

## Related Documents

- [00-overview.md](./00-overview.md) - Main TRD overview
- [README.md](./README.md) - TRD index
- Product roadmap (to be linked)
- User feedback tracker (to be linked)

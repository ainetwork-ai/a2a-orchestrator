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

**Status:** ✅ **MOVED TO PHASE 4 - Task 07**

**Update (2026-01-27):** This feature has been fully designed and documented.

**See:** [Task 07: Enhanced Report Metadata](./07-enhanced-metadata.md) for full implementation plan

**Key Features Designed:**
- Thread-level breakdown (스레드별 메시지 분포, 활성 기간)
- Agent-level breakdown (에이전트별 참여도, 응답 패턴)
- Time-period breakdown (시간대별 활동 패턴, 피크 시간)
- Category deep analysis (카테고리별 상세 인사이트)
- `MetadataLevel` 옵션: basic, detailed, full

**Estimated Effort:** 4 days (19시간)

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

**Status:** ✅ **MOVED TO PHASE 4 - Task 08**

**Update (2026-01-27):** This feature has been fully designed and documented.

**See:** [Task 08: Real-time Report Updates](./08-realtime-updates.md) for full implementation plan

**Chosen Approach:** Server-Sent Events (SSE)
- `GET /api/reports/:jobId/stream` 엔드포인트
- 파이프라인 단계별 진행률 이벤트
- Heartbeat 연결 유지
- 완료 시 결과 데이터 포함 옵션

**Key Features Designed:**
- SSEManager 클래스 (연결 관리, 정리)
- 이벤트 타입: status, progress, error, complete, heartbeat
- 연결 타임아웃 및 복구 지원
- 기존 폴링 방식 병행 지원

**Estimated Effort:** 3 days (16시간)

---

### 16. Report Storage

**Question:** How should reports be stored and managed?

**Options:**
- **Temporary** (current): Redis cache with 1-hour TTL
- **Persistent**: Permanent storage (S3, GCS, or database)
- **Configurable**: Optional permanent storage for important reports

**Current Decision:** ✅ **MOVED TO PHASE 3 - Task 06**

**Update (2026-01-27):** Report storage feature has been redesigned with storage-agnostic approach in [Task 06: Report Storage & Persistence](./06-report-storage.md).

**Chosen Approach:** Abstracted Storage Provider + Redis
- Redis: Hot cache (1hr TTL for temporary, 24hr for persistent)
- Storage Provider: 추상화된 인터페이스 (구현 기술은 구현 시 결정)
  - Options: PostgreSQL, MongoDB, S3, GCS, etc.
- Configurable via `persist` option

**Key Features Designed:**
- `POST /api/reports` with `storage.persist: true` option
- `GET /api/reports/stored` - History/list API
- `StorageProvider` interface for technology-agnostic implementation
- Redis cache integration strategy

**See:** [06-report-storage.md](./06-report-storage.md) for interface specifications

**Note:** 저장소 기술 선택 (PostgreSQL, S3 등)은 구현 시 결정

**Estimated Effort:** 5 days (Phase 3)

**Related Code:**
- `src/services/reportService.ts` - To be extended
- `src/services/reportStorageService.ts` - New file
- `src/storage/provider.ts` - New file (interface)
- `src/types/storage.ts` - New file

---

### 17. Public Sharing Links

**Question:** Should reports be shareable via public links?

**Status:** ✅ **MOVED TO PHASE 4 - Task 09**

**Update (2026-01-27):** This feature has been fully designed and documented.

**See:** [Task 09: Public Sharing Links](./09-public-sharing.md) for full implementation plan

**Chosen Approach:** Token-based public sharing
- 32바이트 URL-safe 토큰
- 만료 시간 및 조회 횟수 제한
- 비밀번호 보호 (선택적)
- 접근 감사 로그

**Key Features Designed:**
- `POST /api/reports/stored/:id/share` - 공개 링크 생성
- `GET /public/reports/:token` - 공개 접근
- ShareRepository 및 ShareService
- Rate limiting 적용

**Estimated Effort:** 5 days (22시간)

**Dependencies:** Task 06 (Report Storage)

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

**High Priority** (implemented):
- [x] Decision 10: Metadata in reports → **Task 07 (Phase 4)**
- [x] Decision 13: Grounded analysis (quote linking) → **Task 05 (Phase 1)**
- [x] Decision 14: Granular API endpoints → **Task 03 (Phase 2)**

**Medium Priority** (implemented or deferred):
- [ ] Decision 11: Anonymization levels → **Deferred** (compliance review 필요)
- [x] Decision 15: Real-time updates → **Task 08 (Phase 4)**
- [x] Decision 16: Persistent storage → **Task 06 (Phase 3)** - 저장소 기술 비종속 설계

**Low Priority** (implemented or deferred):
- [x] Decision 17: Public sharing → **Task 09 (Phase 4)**
- [ ] Decision 12: Pipeline restructure → **Deferred** (Phase 2 후 평가)

### By Phase

**Phase 1** (Core MVP):
- [x] Grounded analysis (opinion → quote mapping) - Task 05

**Phase 2** (Visualization & API):
- [x] Granular API endpoints - Task 03

**Phase 3** (Storage):
- [x] Persistent storage - Task 06 ✅ **Designed**

**Phase 4** (Enhanced Features):
- [x] Enhanced metadata - Task 07 ✅ **Designed**
- [x] Real-time updates - Task 08 ✅ **Designed**
- [x] Public sharing - Task 09 ✅ **Designed**

**Phase 5** (Quality & Reliability):
- [x] Error handling - Task 10 ✅ **Designed**
- [x] Testing strategy - Task 11 ✅ **Designed**

**Remaining Deferred Decisions:**
- [ ] Decision 11: Anonymization levels
- [ ] Decision 12: Pipeline restructure

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
| 1.1 | 2026-01-26 | Decision 13 moved to Phase 1 (Task 05) | - |
| 1.2 | 2026-01-27 | Decision 16 moved to Phase 3 (Task 06) | - |
| 2.0 | 2026-01-27 | Decisions 10, 15, 17 moved to Phase 4 (Tasks 07, 08, 09); Added Phase 5 tasks (10, 11) | Claude |

---

## Related Documents

### TRD Documents
- [00-overview.md](./00-overview.md) - Main TRD overview
- [README.md](./README.md) - TRD index
- [CHANGELOG.md](./CHANGELOG.md) - TRD 변경 이력

### Implemented TRDs (from this document)
- [05-grounded-analysis.md](./05-grounded-analysis.md) - Decision 13 구현
- [06-report-storage.md](./06-report-storage.md) - Decision 16 구현
- [07-enhanced-metadata.md](./07-enhanced-metadata.md) - Decision 10 구현
- [08-realtime-updates.md](./08-realtime-updates.md) - Decision 15 구현
- [09-public-sharing.md](./09-public-sharing.md) - Decision 17 구현
- [10-error-handling.md](./10-error-handling.md) - 추가 기능
- [11-testing-strategy.md](./11-testing-strategy.md) - 추가 기능

### External
- Product roadmap (to be linked)
- User feedback tracker (to be linked)

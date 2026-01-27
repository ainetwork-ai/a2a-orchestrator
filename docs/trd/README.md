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

## Phase 1: Core MVP

### [01. JSON API Response Structure](./01-json-api-structure.md)
Design specification for the new T3C-style JSON response format.

**Key Topics:**
- Enhanced `T3CReport` interface with full type definitions
- `Topic`, `Opinion`, `MessageRef` structures
- `VisualizationData` structure (scatter plot, tree, charts)
- `ReportMetadata` for processing information
- Backward compatibility strategy

**Estimated Effort:** 3-5 days | **Dependencies:** None

---

### [04. Substantive Message Filtering](./04-message-filtering.md)
Ensuring only valuable messages appear in report output while filtering non-substantive content.

**Key Topics:**
- Explicit filtering in cluster output
- Report validation utility (`reportValidator.ts`)
- Filtering metrics in metadata
- Edge case handling

**Estimated Effort:** 2-3 days | **Dependencies:** Task 01

---

### [05. Grounded Analysis (Opinion-Quote Linking)](./05-grounded-analysis.md) 🔴 **CRITICAL**
Link AI-generated opinions back to specific supporting messages for transparency and trust.

**Key Topics:**
- LLM-based opinion → message linking
- `Opinion` interface with `supportingMessages`, `mentionCount`
- New pipeline step: Grounding
- Performance optimization (< 2s per cluster)

**Estimated Effort:** 5 days | **Priority:** 🔴 **HIGH**

---

## Phase 2: Visualization & API

### [02. Visualization Data Generation](./02-visualization-data.md)
Implementation guide for generating visualization-ready data structures.

**Key Topics:**
- New `visualizer.ts` pipeline step
- Scatter plot, topic tree, chart generation
- Performance optimization strategies

**Estimated Effort:** 4-6 days | **Dependencies:** Task 01

---

### [03. API Endpoint Updates](./03-api-endpoints.md)
API endpoint modifications to support new JSON format with backward compatibility.

**Key Topics:**
- New `format` query parameter (json/markdown/full)
- Optional endpoints: `/topics`, `/visualization`
- Report transformer utility

**Estimated Effort:** 2-3 days | **Dependencies:** Task 01, 02

---

## Phase 3: Storage & Persistence

### [06. Report Storage & Persistence](./06-report-storage.md)
리포트 영구 저장 및 히스토리 관리 기능 구현 문서.

**Key Topics:**
- 저장소 추상화 인터페이스 (StorageProvider)
- 저장 옵션 인터페이스 (persist: true/false)
- 저장된 리포트 조회/관리 API (/api/reports/stored/*)
- Redis 캐시-저장소 통합 전략

**Note:** 저장소 기술 (PostgreSQL, S3, GCS 등)은 구현 시 결정

**Estimated Effort:** 5 days (35시간) | **Dependencies:** Task 01-05

---

## Phase 4: Enhanced Features

### [07. Enhanced Report Metadata](./07-enhanced-metadata.md) 🟢 **NEW**
리포트 메타데이터 확장 - 스레드별, 에이전트별, 시간대별 분석.

**Key Topics:**
- Thread-level breakdown (스레드별 메시지 분포)
- Agent-level breakdown (에이전트별 참여도)
- Time-period breakdown (시간대별 활동 패턴)
- Category-specific deep analysis

**Estimated Effort:** 4 days (19시간) | **Dependencies:** Task 01-06

**Priority:** Medium - 99-future-decisions.md Decision #10 구현

---

### [08. Real-time Report Updates](./08-realtime-updates.md) 🟢 **NEW**
SSE 기반 실시간 리포트 진행 상황 스트리밍.

**Key Topics:**
- SSE (Server-Sent Events) 스트림 엔드포인트
- 파이프라인 단계별 진행률 이벤트
- Heartbeat 및 연결 관리
- 클라이언트 연동 예제

**Estimated Effort:** 3 days (16시간) | **Dependencies:** Task 01-06

**Priority:** Medium - 99-future-decisions.md Decision #15 구현

---

### [09. Public Sharing Links](./09-public-sharing.md) 🟢 **NEW**
토큰 기반 공개 공유 링크 기능.

**Key Topics:**
- 토큰 기반 공개 링크 생성
- 만료 시간 및 조회 제한
- 비밀번호 보호 (선택적)
- 접근 감사 로그

**Estimated Effort:** 5 days (22시간) | **Dependencies:** Task 06 (Report Storage)

**Priority:** Low - 99-future-decisions.md Decision #17 구현

---

## Phase 5: Quality & Reliability

### [10. Error Handling & Recovery](./10-error-handling.md) 🟢 **NEW**
견고한 에러 처리 및 복구 시스템.

**Key Topics:**
- 재시도 메커니즘 (exponential backoff)
- 체크포인트 기반 복구
- 에러 코드 체계화
- 부분 결과 지원

**Estimated Effort:** 4 days (20시간) | **Dependencies:** All previous tasks

**Priority:** High - 시스템 안정성 핵심

---

### [11. Testing Strategy](./11-testing-strategy.md) 🟢 **NEW**
포괄적인 테스팅 전략 및 인프라.

**Key Topics:**
- 단위/통합/E2E 테스트 전략
- Mock 라이브러리 (LLM, Redis, PostgreSQL)
- 테스트 커버리지 목표 (70%+)
- CI/CD 통합

**Estimated Effort:** 6 days (30시간) | **Dependencies:** All previous tasks

**Priority:** High - 품질 보증 필수

---

## Future Planning

### [99. Future Decisions & Deferred Features](./99-future-decisions.md)
Tracking decisions deferred to future phases and features out of scope.

**Key Topics:**
- ~~Decision #10: Metadata in reports~~ → **Task 07로 이동**
- Decision #11: Anonymization levels
- Decision #12: Pipeline restructure
- ~~Decision #15: Real-time updates~~ → **Task 08로 이동**
- ~~Decision #16: Report storage~~ → **Task 06으로 이동**
- ~~Decision #17: Public sharing~~ → **Task 09로 이동**

**Status:** Living document - to be reviewed quarterly

---

## Implementation Roadmap

### Phase 1: Foundation (Tasks 01 + 04 + 05) 🔴 CRITICAL
**Duration:** 10-15 days

### Phase 2: Visualization & API (Tasks 02 + 03)
**Duration:** 6-9 days

### Phase 3: Storage (Task 06)
**Duration:** 5 days

### Phase 4: Enhanced Features (Tasks 07 + 08 + 09)
**Duration:** 12 days

### Phase 5: Quality (Tasks 10 + 11)
**Duration:** 10 days

---

## Total Estimated Timeline

| Phase | Duration | Tasks |
|-------|----------|-------|
| Phase 1 | 10-15 days | 01, 04, 05 |
| Phase 2 | 6-9 days | 02, 03 |
| Phase 3 | 5 days | 06 |
| Phase 4 | 12 days | 07, 08, 09 |
| Phase 5 | 10 days | 10, 11 |
| **Total** | **43-51 days** | 11 Tasks |

**Realistic:** 8-10 weeks (accounting for reviews, testing, iterations)

---

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Output Format** | JSON API only | Frontend handles rendering |
| **Visualization** | Required | Essential for T3C-style UI |
| **Grounded Analysis** | Phase 1 | Core T3C feature |
| **Storage** | Abstracted Provider + Redis | Hybrid hot/cold storage (기술 구현 시 결정) |
| **Real-time** | SSE | Simpler than WebSocket |
| **Sharing** | Token-based | Security with flexibility |
| **Error Handling** | Checkpoint + Retry | Robust recovery |

---

## Success Metrics

### Functional Requirements
- JSON API returns structured data suitable for T3C-style UI
- All substantive messages included, non-substantive filtered
- Visualization data enables interactive features
- Grounded opinions link to supporting quotes
- Reports can be stored persistently
- Real-time progress streaming available

### Performance Requirements
- API response time < 2 seconds for cached reports
- Visualization generation < 500ms
- Pipeline overhead < 10% increase
- SSE latency < 100ms

### Quality Requirements
- Test coverage 70%+ overall, 80%+ for critical modules
- All tests passing (unit, integration, E2E)
- Error recovery success rate > 95%
- No regressions in existing functionality

---

## Document Status

| Document | Status | Phase |
|----------|--------|-------|
| 00-overview.md | Complete | - |
| 01-json-api-structure.md | Complete | 1 |
| 02-visualization-data.md | Complete | 2 |
| 03-api-endpoints.md | Complete | 2 |
| 04-message-filtering.md | Complete | 1 |
| 05-grounded-analysis.md | Complete 🔴 | 1 |
| 06-report-storage.md | Complete (v2.1) | 3 |
| 07-enhanced-metadata.md | **NEW** 🟢 | 4 |
| 08-realtime-updates.md | **NEW** 🟢 | 4 |
| 09-public-sharing.md | **NEW** 🟢 | 4 |
| 10-error-handling.md | **NEW** 🟢 | 5 |
| 11-testing-strategy.md | **NEW** 🟢 | 5 |
| 99-future-decisions.md | Living Doc | - |
| CHANGELOG.md | Updated | - |

**Total: 13 documents (11 implementation tasks + 2 reference documents)**

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-01-26 | Initial TRD documents (00-05, 99) |
| 1.1 | 2026-01-26 | Added Task 05 (grounded analysis) to Phase 1 |
| 1.2 | 2026-01-27 | Added Task 06 (report storage) |
| **2.0** | **2026-01-27** | **Added Tasks 07-11 (metadata, realtime, sharing, error handling, testing)** |

---

## Getting Started

1. **Read the Overview** ([00-overview.md](./00-overview.md)) to understand project scope
2. **Review Phase 1 Tasks** (01, 04, 05) for core implementation
3. **Follow Implementation Roadmap** sequentially
4. **Run Tests** after each phase completion
5. **Update Documentation** as you implement

---

## Related Resources

### Code References
- [Report Service](../../src/services/reportService.ts)
- [Report Pipeline](../../src/services/reportPipeline/index.ts)
- [Report Types](../../src/types/report.ts)
- [Report Routes](../../src/routes/reports.ts)

### External References
- [Talk to the City](https://talktothe.city/)
- [T3C GitHub (tttc-light-js)](https://github.com/AIObjectives/tttc-light-js)
- [Jest Documentation](https://jestjs.io/)

# TRD Changelog

## 2026-01-27 - Task 06 Rewrite (Version 2.1)

### Task 06: Report Storage & Persistence - Redesigned

**변경 사유:**
- 기존 버전이 PostgreSQL을 특정 기술로 확정
- 요구사항은 저장소 기술을 구현 시 결정하도록 열어둘 것을 요구

**주요 변경 사항:**

1. **저장소 기술 비종속 설계**
   - Before: PostgreSQL + Redis hybrid
   - After: `StorageProvider` 인터페이스 추상화 + Redis cache

2. **구현 세부사항 제거**
   - 데이터베이스 스키마 제거
   - 압축 알고리즘 세부사항 제거
   - 특정 라이브러리 의존성 제거

3. **인터페이스 중심 설계**
   ```typescript
   interface StorageProvider {
     save(report, options): Promise<StoredReport>;
     get(id): Promise<StoredReport | null>;
     list(query): Promise<PaginatedResult<StoredReportSummary>>;
     update(id, updates): Promise<StoredReport>;
     delete(id): Promise<void>;
     cleanupExpired(): Promise<number>;
   }
   ```

4. **유지된 요구사항**
   - `persist` 파라미터로 저장 여부 선택
   - `/api/reports/stored/*` API 엔드포인트
   - Redis 캐시 통합 전략
   - 페이지네이션, 필터링, 검색 기능

**영향:**
- 구현 시 저장소 기술 선택 유연성 확보
- 요구사항 문서와 구현 세부사항 분리

---

## 2026-01-27 - Major Update: Tasks 07-11 Added (Version 2.0)

### New Documents

#### Task 07: Enhanced Report Metadata
**Status:** Phase 4

**Problem Addressed:**
- 현재 메타데이터는 기본 처리 정보만 포함
- 스레드별, 에이전트별, 시간대별 분석 없음
- 카테고리 심층 분석 불가

**Solution:**
- Thread-level breakdown (스레드별 메시지 분포, 활성 기간)
- Agent-level breakdown (에이전트별 참여도, 응답 패턴)
- Time-period breakdown (시간대별 활동, 피크 시간)
- Category deep analysis (카테고리별 상세 인사이트)

**Key Features:**
- `MetadataLevel`: basic, detailed, full
- API 요청 시 메타데이터 레벨 선택 가능
- 성능 영향 최소화 (lazy loading)

**Estimated Effort:** 4 days (19시간)

**Related Decision:** 99-future-decisions.md Decision #10

---

#### Task 08: Real-time Report Updates (SSE)
**Status:** Phase 4

**Problem Addressed:**
- 현재 폴링 방식만 지원 (1초마다 요청)
- 대규모 리포트 생성 시 UX 저하
- 불필요한 서버 부하

**Solution:**
- Server-Sent Events (SSE) 기반 실시간 스트리밍
- 파이프라인 단계별 진행률 이벤트
- Heartbeat 연결 유지
- 완료 시 결과 데이터 포함 옵션

**Key Features:**
- `GET /api/reports/:jobId/stream` 엔드포인트
- 이벤트 타입: status, progress, error, complete, heartbeat
- 연결 타임아웃 및 복구 지원
- 기존 폴링 방식 병행 지원

**Estimated Effort:** 3 days (16시간)

**Related Decision:** 99-future-decisions.md Decision #15

---

#### Task 09: Public Sharing Links
**Status:** Phase 4

**Problem Addressed:**
- 외부 이해관계자와 리포트 공유 불가
- 공유 시 보안 통제 없음
- 접근 추적 불가

**Solution:**
- 토큰 기반 공개 링크 생성
- 만료 시간 및 조회 횟수 제한
- 비밀번호 보호 (선택적)
- 접근 감사 로그

**Key Features:**
- `POST /api/reports/stored/:id/share` - 공개 링크 생성
- `GET /public/reports/:token` - 공개 접근
- 32바이트 URL-safe 토큰
- Rate limiting 적용

**Estimated Effort:** 5 days (22시간)

**Related Decision:** 99-future-decisions.md Decision #17

**Dependencies:** Task 06 (Report Storage)

---

#### Task 10: Error Handling & Recovery
**Status:** Phase 5

**Problem Addressed:**
- 에러 발생 시 전체 작업 실패
- 부분 복구 메커니즘 없음
- 재시도 로직 없음
- 에러 정보 부족

**Solution:**
- 재시도 메커니즘 (exponential backoff)
- 체크포인트 기반 복구
- 표준화된 에러 코드 체계
- 부분 결과 지원

**Key Features:**
- `ErrorCode` enum (LLM_TIMEOUT, REDIS_CONNECTION 등)
- `PipelineError` 클래스 (코드, 심각도, 재시도 가능 여부)
- `CheckpointManager` (중간 결과 저장/복구)
- `RetryExecutor` (exponential backoff with jitter)

**Estimated Effort:** 4 days (20시간)

**Priority:** High - 시스템 안정성 핵심

---

#### Task 11: Testing Strategy
**Status:** Phase 5

**Problem Addressed:**
- 테스트 부재로 회귀 버그 위험
- 수동 테스트 의존
- LLM 의존성으로 비결정적 테스트
- 데이터 품질 검증 없음

**Solution:**
- 포괄적 테스트 전략 (단위/통합/E2E)
- Mock 라이브러리 (LLM, Redis, PostgreSQL)
- 테스트 헬퍼 및 팩토리
- CI/CD 통합

**Key Features:**
- Jest 기반 테스트 인프라
- 커버리지 목표: 70% 전체, 80% 핵심 모듈
- LLM Mock으로 결정적 테스트
- GitHub Actions CI 워크플로우

**Estimated Effort:** 6 days (30시간)

**Priority:** High - 품질 보증 필수

---

### Timeline Impact

**Before:**
- Phase 1-5: 23-32 days (5-6 weeks)

**After:**
- Phase 1-5: 43-51 days (8-10 weeks)
- +5 new tasks (Tasks 07-11)
- +107 hours of work

---

### Updated Phase Structure

| Phase | Tasks | Duration | Description |
|-------|-------|----------|-------------|
| 1 | 01, 04, 05 | 10-15 days | Core MVP (JSON, Filtering, Grounding) |
| 2 | 02, 03 | 6-9 days | Visualization & API |
| 3 | 06 | 5 days | Storage & Persistence |
| 4 | 07, 08, 09 | 12 days | Enhanced Features |
| 5 | 10, 11 | 10 days | Quality & Reliability |

---

### 99-future-decisions.md Updates

**Decisions Moved to TRD:**
- Decision #10 (Metadata) → **Task 07**
- Decision #15 (Real-time) → **Task 08**
- Decision #17 (Public Sharing) → **Task 09**

**Remaining Deferred Decisions:**
- Decision #11: Anonymization levels
- Decision #12: Pipeline restructure

---

## 2026-01-27 - Report Storage & Persistence (Task 06)

### New Document

#### Task 06 Added: Report Storage & Persistence
**Status:** Phase 3

**Problem Addressed:**
- 현재 리포트는 Redis 기반 임시 캐싱만 지원 (1시간 TTL)
- 1시간 후 자동 삭제되어 히스토리 관리 불가
- 동일 데이터 반복 분석으로 비용/시간 낭비
- Redis 재시작 시 모든 리포트 소실

**Solution:**
- PostgreSQL 기반 영구 저장소 추가
- `persist` 옵션으로 저장 방식 선택 (임시 vs 영구)
- 리포트 히스토리 조회/관리 API
- Redis-PostgreSQL 캐시 레이어 통합
- 자동 만료 및 정리 정책

**Key Features:**
1. **저장 옵션 인터페이스**
   ```typescript
   interface StorageOptions {
     persist?: boolean;
     title?: string;
     description?: string;
     tags?: string[];
     expiresAt?: number;
     compress?: boolean;
   }
   ```

2. **새로운 API 엔드포인트**
   - `GET /api/reports/stored` - 저장된 리포트 목록
   - `GET /api/reports/stored/:id` - 저장된 리포트 상세
   - `PATCH /api/reports/stored/:id` - 메타데이터 수정
   - `DELETE /api/reports/stored/:id` - 리포트 삭제
   - `POST /api/reports/:jobId/archive` - 기존 리포트 아카이브

3. **PostgreSQL 스키마**
   - `reports` 테이블 (id, job_id, title, tags, params, report_data...)
   - 인덱스 (created_at, tags, expires_at)
   - Soft delete 지원

4. **성능 최적화**
   - 2MB 이상 리포트 자동 압축 (gzip)
   - 영구 리포트 캐시 TTL: 24시간
   - 페이지네이션 지원

**Impact:**
- **Timeline:** +5 days (Phase 3 추가)
- **New Dependencies:** PostgreSQL (pg), zlib
- **Files to Create:**
  - `src/types/storage.ts`
  - `src/repositories/reportRepository.ts`
  - `src/routes/storedReports.ts` (or extend reports.ts)
  - `migrations/001_create_reports_table.sql`

**Related Decision:**
- 99-future-decisions.md Decision #16 (Report Storage) 구현

---

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
     supportingMessages: string[];
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

## Version History

| Version | Date | Changes | Author |
|---------|------|---------|--------|
| 1.0 | 2026-01-26 | Initial TRD documents (00-04, 99) | - |
| 1.1 | 2026-01-26 | Added Task 05 (grounded analysis), updated timeline | - |
| 1.2 | 2026-01-27 | Added Task 06 (report storage), Phase 3 추가 | Claude |
| 2.0 | 2026-01-27 | Added Tasks 07-11 (metadata, realtime, sharing, error handling, testing), Phase 4-5 추가 | Claude |
| **2.1** | **2026-01-27** | **Task 06 재작성: 저장소 기술 비종속, 인터페이스 중심 설계** | Claude |

---

## Summary of All TRD Documents

| Task | Title | Phase | Effort | Status |
|------|-------|-------|--------|--------|
| 00 | Overview | - | - | Complete |
| 01 | JSON API Structure | 1 | 3-5 days | Complete |
| 02 | Visualization Data | 2 | 4-6 days | Complete |
| 03 | API Endpoints | 2 | 2-3 days | Complete |
| 04 | Message Filtering | 1 | 2-3 days | Complete |
| 05 | Grounded Analysis | 1 | 5 days | Complete 🔴 |
| 06 | Report Storage | 3 | 5 days | Complete (v2.1 - 기술 비종속) |
| 07 | Enhanced Metadata | 4 | 4 days | **NEW** 🟢 |
| 08 | Real-time Updates | 4 | 3 days | **NEW** 🟢 |
| 09 | Public Sharing | 4 | 5 days | **NEW** 🟢 |
| 10 | Error Handling | 5 | 4 days | **NEW** 🟢 |
| 11 | Testing Strategy | 5 | 6 days | **NEW** 🟢 |
| 99 | Future Decisions | - | - | Living Doc |

**Total Implementation Tasks:** 11
**Total Estimated Effort:** 43-51 days
**Total Documents:** 13

---

## Related Documents

- [00-overview.md](./00-overview.md) - Project overview
- [README.md](./README.md) - Document index and roadmap
- [99-future-decisions.md](./99-future-decisions.md) - Deferred decisions tracker

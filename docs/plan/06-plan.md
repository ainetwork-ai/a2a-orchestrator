# Refactoring Plan: Report Storage (TRD 06)

## Overview

리포트 영구 저장 기능을 구현합니다. 현재 Redis 캐시에 1시간 TTL로 저장되는 리포트를 선택적으로 영구 저장할 수 있게 합니다.

## Source Documents

- `docs/trd/06-report-storage.md` - 리포트 영구 저장 기능

## Dependencies

- 기존 ReportService, Redis 인프라
- 선행 작업 없음 (독립적으로 진행 가능)

---

## Phase 1: Types & Interfaces

- [ ] task1 - Create `src/types/storage.ts` with StorageOptions, StoredReport, StoredReportSummary interfaces
- [ ] task2 - Create StoredReportQuery and PaginatedResult interfaces for list queries
- [ ] task3 - Define StorageProvider interface for storage abstraction

## Phase 2: Storage Provider Implementation

- [ ] task4 - Create `src/storage/provider.ts` with StorageProvider abstract interface
- [ ] task5 - Implement Redis-based StorageProvider in `src/storage/redisStorageProvider.ts`
- [ ] task6 - Add storage provider factory/initialization logic

## Phase 3: Report Storage Service

- [ ] task7 - Create `src/services/reportStorageService.ts` with core CRUD operations
- [ ] task8 - Implement save() method with metadata extraction from Report
- [ ] task9 - Implement list() method with pagination and filtering
- [ ] task10 - Implement get(), update(), delete() methods
- [ ] task11 - Add cache integration (Redis hot cache for stored reports)

## Phase 4: ReportService Extension

- [ ] task12 - Extend ReportRequestParams to include StorageOptions
- [ ] task13 - Modify createJob() to handle persist option
- [ ] task14 - Add persistReport() method to convert temporary to persistent
- [ ] task15 - Integrate ReportStorageService into ReportService

## Phase 5: API Endpoints

- [ ] task16 - Add `storage` parameter to POST /api/reports request body
- [ ] task17 - Create GET /api/reports/stored endpoint for list query
- [ ] task18 - Create GET /api/reports/stored/:id endpoint for detail view
- [ ] task19 - Create PATCH /api/reports/stored/:id endpoint for metadata update
- [ ] task20 - Create DELETE /api/reports/stored/:id endpoint
- [ ] task21 - Create POST /api/reports/:jobId/persist endpoint for conversion

## Phase 6: Testing

- [ ] task22 - Write unit tests for StorageProvider implementation
- [ ] task23 - Write unit tests for ReportStorageService
- [ ] task24 - Write integration tests for storage API endpoints

---

## Build Verification

- [ ] Run TypeScript build check (`source ~/.nvm/nvm.sh && nvm use 22 && npx tsc --noEmit`)

---

## Implementation Order

1. **Phase 1** (tasks 1-3): Types & Interfaces
2. **Phase 2** (tasks 4-6): Storage Provider
3. **Phase 3** (tasks 7-11): Storage Service
4. **Phase 4** (tasks 12-15): ReportService Integration
5. **Phase 5** (tasks 16-21): API Endpoints
6. **Phase 6** (tasks 22-24): Testing

---

## Notes

### Technical Decisions:

1. **Storage Backend**: Redis 기반 구현 (향후 PostgreSQL/S3 등으로 마이그레이션 가능)
2. **TTL Strategy**:
   - Temporary reports: 1 hour (기존 유지)
   - Persistent report cache: 24 hours

### API Backward Compatibility:

- `persist` 옵션은 기본 `false` (기존 워크플로우 유지)
- 기존 `/api/reports/*` 엔드포인트 동작 변경 없음

---

## Estimated Timeline

| Phase | Tasks | Estimated Hours |
|-------|-------|-----------------|
| 1 | Types & Interfaces | 4h |
| 2 | Storage Provider | 4h |
| 3 | Storage Service | 6h |
| 4 | ReportService | 4h |
| 5 | API Endpoints | 4h |
| 6 | Testing | 4h |
| **Total** | | **26h (~4 days)** |

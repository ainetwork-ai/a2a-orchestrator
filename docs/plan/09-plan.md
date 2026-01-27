# Refactoring Plan: Public Sharing Links (TRD 09)

## Overview

토큰 기반 공개 공유 링크 기능을 구현합니다. 인증 없이 특정 리포트를 열람할 수 있는 링크를 생성하고 관리합니다.

## Source Documents

- `docs/trd/09-public-sharing.md` - 공개 공유 링크 기능

## Dependencies

```
TRD 06 (Report Storage) ◄── 필수 선행
    │
    └──► TRD 09 (Public Sharing)
```

- **TRD 06 완료 필수**: 공개 링크는 저장된 리포트(StoredReport)에 대해서만 생성 가능
- StorageProvider, ReportStorageService가 먼저 구현되어야 함

---

## Phase 1: Types & Interfaces

- [ ] task1 - Create `src/types/sharing.ts` with ReportShare, CreateShareOptions interfaces
- [ ] task2 - Define ShareAccessLog and ShareAccessStats interfaces
- [ ] task3 - Define ShareValidationResult interface

## Phase 2: Share Repository

- [ ] task4 - Create `src/repositories/shareRepository.ts` with Redis data structure
- [ ] task5 - Implement token generation (32-byte URL-safe random)
- [ ] task6 - Implement create() method with password hashing (bcrypt)
- [ ] task7 - Implement findByToken() and findByReportId() methods
- [ ] task8 - Implement update() and delete() methods
- [ ] task9 - Implement incrementViews() and verifyPassword() methods
- [ ] task10 - Implement access logging (logAccess, getAccessLogs, getAccessStats)

## Phase 3: Share Service

- [ ] task11 - Create `src/services/shareService.ts` with business logic
- [ ] task12 - Implement createShare() with report existence validation
- [ ] task13 - Implement validateAndGetReport() with all validation checks
- [ ] task14 - Implement share management methods (getShares, updateShare, deleteShare)
- [ ] task15 - Implement audit log retrieval methods

## Phase 4: Management API Endpoints

- [ ] task16 - Create POST /api/reports/stored/:reportId/share endpoint
- [ ] task17 - Create GET /api/reports/stored/:reportId/shares endpoint
- [ ] task18 - Create PATCH /api/shares/:shareId endpoint
- [ ] task19 - Create DELETE /api/shares/:shareId endpoint
- [ ] task20 - Create GET /api/shares/:shareId/logs endpoint

## Phase 5: Public Access Endpoints

- [ ] task21 - Create GET /public/reports/:token endpoint for public access
- [ ] task22 - Create POST /public/reports/:token/access endpoint for password-protected access
- [ ] task23 - Implement rate limiting for public endpoints (express-rate-limit)

## Phase 6: Testing

- [ ] task24 - Write unit tests for ShareRepository
- [ ] task25 - Write unit tests for ShareService
- [ ] task26 - Write integration tests for share management API
- [ ] task27 - Write integration tests for public access API
- [ ] task28 - Test token expiration, max views, password protection scenarios

---

## Build Verification

- [ ] Run TypeScript build check (`source ~/.nvm/nvm.sh && nvm use 22 && npx tsc --noEmit`)

---

## Implementation Order

1. **Phase 1** (tasks 1-3): Types & Interfaces
2. **Phase 2** (tasks 4-10): Share Repository
3. **Phase 3** (tasks 11-15): Share Service
4. **Phase 4** (tasks 16-20): Management API
5. **Phase 5** (tasks 21-23): Public Access API
6. **Phase 6** (tasks 24-28): Testing

---

## Notes

### Dependencies to Add:

- `bcrypt` for password hashing
- `uuid` for share ID generation
- `express-rate-limit` for public endpoint protection

### Security Considerations:

- 토큰: 32-byte URL-safe random string (`crypto.randomBytes()`)
- Rate limit: 분당 60회 / IP
- 비밀번호: bcrypt 해싱

### Redis Data Structure:

```
share:{shareId}           → Hash (메타데이터)
share:token:{token}       → String (shareId 매핑)
report:{reportId}:shares  → Set (리포트별 공유 링크)
share:{shareId}:logs      → SortedSet (접근 로그)
```

---

## Estimated Timeline

| Phase | Tasks | Estimated Hours |
|-------|-------|-----------------|
| 1 | Types & Interfaces | 2h |
| 2 | Share Repository | 6h |
| 3 | Share Service | 4h |
| 4 | Management API | 4h |
| 5 | Public Access API | 3h |
| 6 | Testing | 5h |
| **Total** | | **24h (~3 days)** |

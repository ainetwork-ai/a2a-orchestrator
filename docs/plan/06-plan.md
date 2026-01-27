# Refactoring Plan: Report Management (TRD 06)

## Overview

리포트 관리 기능을 추가합니다.

**핵심 인사이트**: 기존 `report:job:{jobId}`는 이미 TTL 없이 영구 저장됩니다.
별도의 "영구 저장" 레이어가 필요 없고, 기존 ReportJob에 메타데이터와 관리 기능만 추가하면 됩니다.

## Source Documents

- `docs/trd/06-report-storage.md` - 리포트 저장 기능 (일부만 적용)

## 실제 필요한 기능

| 기능 | 현재 | 목표 |
|------|------|------|
| 영구 저장 | ✅ 이미 됨 | - |
| jobId 조회 | ✅ 이미 됨 | - |
| 메타데이터 (title, description, tags) | ❌ | ✅ |
| 목록 조회 (페이지네이션) | △ 기본만 | ✅ |
| 검색/필터링 | ❌ | ✅ |
| 메타데이터 수정 | ❌ | ✅ |
| 삭제 | ❌ | ✅ |

---

## Phase 1: ReportJob 타입 확장

- [x] task1 - `ReportJob`에 메타데이터 필드 추가 (title, description, tags)
- [x] task2 - `ReportRequestParams`에 메타데이터 옵션 추가 (생성 시 지정 가능)

## Phase 2: ReportService 확장

- [x] task3 - `getAllJobs()` 개선: 페이지네이션, 필터링, 검색 지원
- [x] task4 - `updateJob()` 메서드 추가: 메타데이터 수정
- [x] task5 - `deleteJob()` 메서드 추가: job 삭제

## Phase 3: API 엔드포인트

- [x] task6 - `GET /api/reports` 개선: query params로 페이지네이션, 필터링, 검색
- [x] task7 - `PATCH /api/reports/:jobId` 추가: 메타데이터 수정
- [x] task8 - `DELETE /api/reports/:jobId` 추가: job 삭제
- [x] task9 - `POST /api/reports` 확장: 생성 시 title, description, tags 지정

---

## Build Verification

- [x] Run TypeScript build check (`source ~/.nvm/nvm.sh && nvm use 22 && npx tsc --noEmit`)

---

## 상세 설계

### ReportJob 타입 확장

```typescript
export interface ReportJob {
  id: string;
  status: ReportJobStatus;
  progress?: ReportJobProgress;
  report?: Report;
  error?: string;
  createdAt: number;
  updatedAt: number;
  cachedAt?: number;
  params: ReportRequestParams;

  // 메타데이터 (신규)
  title?: string;
  description?: string;
  tags?: string[];
}
```

### API 변경

**GET /api/reports (개선)**
```
Query Parameters:
- page: number (default: 1)
- limit: number (default: 20, max: 100)
- tags: string (comma-separated)
- startDate: string (ISO date)
- endDate: string (ISO date)
- search: string (title, description 검색)
- status: string (pending, processing, completed, failed)
- sortBy: string (createdAt, updatedAt, title)
- sortOrder: string (asc, desc)
```

**PATCH /api/reports/:jobId (신규)**
```json
{
  "title": "새 제목",
  "description": "새 설명",
  "tags": ["tag1", "tag2"]
}
```

**DELETE /api/reports/:jobId (신규)**
```
Response: { success: true, message: "Job deleted" }
```

---

## Estimated Timeline

| Phase | Tasks | Estimated Hours |
|-------|-------|-----------------|
| 1 | 타입 확장 | 1h |
| 2 | Service 확장 | 3h |
| 3 | API 엔드포인트 | 2h |
| **Total** | | **6h (~1 day)** |

---

## Notes

- 기존 `persist` 옵션, `StorageProvider`, `StoredReport` 등은 불필요하여 제거됨
- 기존 job 데이터는 그대로 유지되며, 새 필드는 optional로 추가
- 하위 호환성 100% 유지

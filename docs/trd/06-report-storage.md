# TRD 06: Report Storage & Persistence

> **Origin:** [99-future-decisions.md](./99-future-decisions.md) - Decision #16

## 1. 개요 (Overview)

### 1.1 목적 (Purpose)

현재 A2A Orchestrator의 리포트는 Redis 캐시에 1시간 TTL로 저장되어 자동 삭제됩니다. 이로 인해:

- **히스토리 관리 불가**: 과거 리포트 재참조 불가
- **중복 비용 발생**: 동일 데이터 반복 분석 (LLM 비용, 시간)
- **데이터 휘발성**: Redis 재시작 시 모든 리포트 소실

이 TRD는 **리포트 영구 저장 기능**을 정의합니다. 사용자가 선택적으로 리포트를 영구 저장하고, 저장된 리포트를 조회/관리할 수 있는 인터페이스를 설계합니다.

### 1.2 범위 (Scope)

**포함:**
- 리포트 영구 저장 옵션 인터페이스 (`persist` 파라미터)
- 저장된 리포트 조회/검색/관리 API
- 기존 Redis 캐시 시스템과의 통합 전략
- 저장소 추상화 인터페이스 (구현 기술 비종속)

**명시적 제외:**
- 특정 저장소 기술 선택 (S3, GCS, PostgreSQL 등 - 구현 시 결정)
- 데이터베이스 스키마 세부 설계 (구현 시 결정)
- 압축/암호화 알고리즘 세부 사항 (구현 시 결정)

### 1.3 용어 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **Temporary Report** | Redis 캐시에 1시간 TTL로 저장되는 임시 리포트 (현재 방식) |
| **Persistent Report** | 영구 저장소에 저장되어 명시적 삭제 전까지 유지되는 리포트 |
| **Storage Provider** | 리포트 저장을 담당하는 추상화된 저장소 (구현: DB, Object Storage 등) |
| **Hot Cache** | Redis 기반 빠른 접근을 위한 캐시 레이어 |
| **Cold Storage** | 영구 저장을 위한 저장소 |

---

## 2. 현재 상태 분석 (Current State Analysis)

### 2.1 기존 시스템 구조

```
┌─────────────────┐     ┌─────────────┐
│  ReportService  │────▶│    Redis    │
│                 │     │  (1hr TTL)  │
└─────────────────┘     └─────────────┘
        │
        ▼
┌─────────────────┐
│ Report Pipeline │
│  (LLM 분석)     │
└─────────────────┘
```

**현재 저장 방식:**
- `report:job:{jobId}` - Job 메타데이터 및 리포트 데이터
- `report:cache:{cacheKey}` - 파라미터 기반 캐시 (1시간 TTL)
- 모든 데이터는 Redis에만 저장

**관련 코드:**
- `src/services/reportService.ts` - 리포트 생성 및 캐시 관리
- `src/utils/redis.ts` - Redis 클라이언트
- `src/types/report.ts` - 리포트 타입 정의

### 2.2 문제점 및 한계

| 문제점 | 영향 | 심각도 |
|--------|------|--------|
| 1시간 후 자동 삭제 | 히스토리 조회 불가 | High |
| 동일 파라미터 재분석 | LLM 비용/시간 낭비 | Medium |
| Redis 의존성 | 재시작 시 데이터 소실 | High |
| 검색/필터링 불가 | 과거 리포트 찾기 어려움 | Medium |

---

## 3. 요구사항 (Requirements)

### 3.1 기능적 요구사항 (Functional Requirements)

#### 저장 기능

| ID | 요구사항 | 우선순위 |
|----|----------|----------|
| FR-001 | 리포트 생성 시 `persist` 옵션으로 영구 저장 여부 선택 가능 | High |
| FR-002 | 기존 임시 리포트를 영구 저장으로 전환 가능 | Medium |
| FR-003 | 영구 저장 리포트에 메타데이터 추가 가능 (제목, 설명, 태그) | Medium |
| FR-004 | 영구 저장 리포트에 선택적 만료 시간 설정 가능 | Low |

#### 조회 기능

| ID | 요구사항 | 우선순위 |
|----|----------|----------|
| FR-005 | 저장된 리포트 목록 조회 (페이지네이션) | High |
| FR-006 | 저장된 리포트 상세 조회 | High |
| FR-007 | 태그, 날짜 범위로 필터링 | Medium |
| FR-008 | 제목, 설명으로 검색 | Low |

#### 관리 기능

| ID | 요구사항 | 우선순위 |
|----|----------|----------|
| FR-009 | 저장된 리포트 메타데이터 수정 | Medium |
| FR-010 | 저장된 리포트 삭제 | High |
| FR-011 | 만료된 리포트 자동 정리 | Low |

### 3.2 비기능적 요구사항 (Non-Functional Requirements)

| ID | 요구사항 | 목표 |
|----|----------|------|
| NFR-001 | 저장 리포트 조회 응답 시간 | < 500ms (캐시), < 2s (cold) |
| NFR-002 | 저장소 추상화 | 저장 기술 변경 시 비즈니스 로직 변경 없음 |
| NFR-003 | 대용량 리포트 처리 | 10MB+ 리포트 저장/조회 지원 |
| NFR-004 | 기존 API 호환성 | 기존 `/api/reports` 엔드포인트 동작 유지 |

### 3.3 제약사항 (Constraints)

- **기술 선택 지연**: 저장소 기술은 이 TRD에서 결정하지 않음 (구현 시 결정)
- **Redis 유지**: 기존 Redis 캐시 시스템은 Hot Cache로 계속 사용
- **점진적 도입**: 기존 워크플로우에 영향 없이 선택적 기능으로 도입

---

## 4. 기술 설계 (Technical Design)

### 4.1 아키텍처 개요

```
┌─────────────────────────────────────────────────────────┐
│                      API Layer                          │
│  POST /api/reports (with persist option)                │
│  GET  /api/reports/stored                               │
│  GET  /api/reports/stored/:id                           │
└─────────────────┬───────────────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────────────┐
│                   ReportService                         │
│  - createJob(params, storageOptions?)                   │
│  - getStoredReports(query)                              │
│  - getStoredReport(id)                                  │
│  - updateStoredReport(id, updates)                      │
│  - deleteStoredReport(id)                               │
└─────────────────┬───────────────────────────────────────┘
                  │
┌─────────────────▼───────────────────────────────────────┐
│              ReportStorageService                       │
│  - save(report, options) → StoredReport                 │
│  - get(id) → StoredReport | null                        │
│  - list(query) → PaginatedResult<StoredReportSummary>   │
│  - update(id, updates) → StoredReport                   │
│  - delete(id) → void                                    │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ├──────────────────┐
                  ▼                  ▼
┌─────────────────────┐    ┌─────────────────────┐
│    Redis (Cache)    │    │   Storage Provider  │
│    - Hot cache      │    │   (구현 시 결정)      │
│    - 24hr TTL       │    │   - Database        │
│                     │    │   - Object Storage  │
│                     │    │   - etc.            │
└─────────────────────┘    └─────────────────────┘
```

### 4.2 인터페이스 설계

#### 4.2.1 저장 옵션 인터페이스

```typescript
/**
 * 리포트 저장 옵션
 */
interface StorageOptions {
  /** 영구 저장 여부 (false면 기존 Redis 캐시만 사용) */
  persist?: boolean;

  /** 리포트 제목 (영구 저장 시) */
  title?: string;

  /** 리포트 설명 */
  description?: string;

  /** 검색/필터용 태그 */
  tags?: string[];

  /** 만료 시간 (Unix timestamp, 없으면 무기한) */
  expiresAt?: number;
}
```

#### 4.2.2 저장된 리포트 인터페이스

```typescript
/**
 * 저장된 리포트 (목록 조회용 요약)
 */
interface StoredReportSummary {
  id: string;
  jobId: string;
  title: string;
  description?: string;
  tags: string[];

  /** 리포트 파라미터 요약 */
  params: {
    threadCount?: number;
    dateRange?: { start: string; end: string };
  };

  /** 리포트 통계 요약 */
  stats: {
    totalMessages: number;
    topicCount: number;
  };

  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}

/**
 * 저장된 리포트 (상세 조회용)
 */
interface StoredReport extends StoredReportSummary {
  /** 전체 리포트 데이터 */
  report: Report;

  /** 원본 요청 파라미터 */
  originalParams: ReportRequestParams;
}
```

#### 4.2.3 조회 쿼리 인터페이스

```typescript
/**
 * 저장된 리포트 조회 쿼리
 */
interface StoredReportQuery {
  /** 페이지네이션 */
  page?: number;
  limit?: number;

  /** 필터링 */
  tags?: string[];
  startDate?: string;
  endDate?: string;

  /** 검색 */
  search?: string;

  /** 정렬 */
  sortBy?: 'createdAt' | 'updatedAt' | 'title';
  sortOrder?: 'asc' | 'desc';
}

/**
 * 페이지네이션 결과
 */
interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}
```

#### 4.2.4 Storage Provider 인터페이스

```typescript
/**
 * 저장소 제공자 인터페이스 (추상화)
 * 구현체: PostgreSQL, MongoDB, S3, GCS 등
 */
interface StorageProvider {
  /** 리포트 저장 */
  save(report: Report, options: StorageOptions): Promise<StoredReport>;

  /** ID로 조회 */
  get(id: string): Promise<StoredReport | null>;

  /** 목록 조회 */
  list(query: StoredReportQuery): Promise<PaginatedResult<StoredReportSummary>>;

  /** 메타데이터 수정 */
  update(id: string, updates: Partial<StorageOptions>): Promise<StoredReport>;

  /** 삭제 */
  delete(id: string): Promise<void>;

  /** 만료된 리포트 정리 */
  cleanupExpired(): Promise<number>;
}
```

### 4.3 API 설계

#### 4.3.1 리포트 생성 (기존 API 확장)

```
POST /api/reports
```

**Request Body (확장):**
```json
{
  "threadIds": ["thread-1", "thread-2"],
  "startDate": "2026-01-01",
  "endDate": "2026-01-27",

  "storage": {
    "persist": true,
    "title": "1월 4주차 주간 리포트",
    "description": "에이전트 피드백 분석",
    "tags": ["weekly", "feedback", "2026-01"]
  }
}
```

**Response:**
```json
{
  "success": true,
  "jobId": "job-123",
  "status": "pending",
  "storedReportId": "stored-456"
}
```

#### 4.3.2 저장된 리포트 목록 조회

```
GET /api/reports/stored
```

**Query Parameters:**
| 파라미터 | 타입 | 설명 | 기본값 |
|----------|------|------|--------|
| page | number | 페이지 번호 | 1 |
| limit | number | 페이지당 항목 수 | 20 |
| tags | string | 태그 필터 (comma-separated) | - |
| startDate | string | 생성일 시작 | - |
| endDate | string | 생성일 끝 | - |
| search | string | 제목/설명 검색 | - |
| sortBy | string | 정렬 기준 | createdAt |
| sortOrder | string | 정렬 방향 | desc |

**Response:**
```json
{
  "success": true,
  "items": [
    {
      "id": "stored-456",
      "jobId": "job-123",
      "title": "1월 4주차 주간 리포트",
      "description": "에이전트 피드백 분석",
      "tags": ["weekly", "feedback", "2026-01"],
      "params": {
        "threadCount": 15,
        "dateRange": { "start": "2026-01-01", "end": "2026-01-27" }
      },
      "stats": {
        "totalMessages": 342,
        "topicCount": 8
      },
      "createdAt": 1737990000000,
      "updatedAt": 1737990000000
    }
  ],
  "total": 45,
  "page": 1,
  "limit": 20,
  "hasMore": true
}
```

#### 4.3.3 저장된 리포트 상세 조회

```
GET /api/reports/stored/:id
```

**Query Parameters:**
| 파라미터 | 타입 | 설명 | 기본값 |
|----------|------|------|--------|
| format | string | json, markdown, full | json |
| includeMessages | boolean | 메시지 포함 여부 | true |

**Response:** 기존 `GET /api/reports/:jobId` 응답과 동일 + 메타데이터

#### 4.3.4 저장된 리포트 수정

```
PATCH /api/reports/stored/:id
```

**Request Body:**
```json
{
  "title": "수정된 제목",
  "description": "수정된 설명",
  "tags": ["updated", "tags"]
}
```

#### 4.3.5 저장된 리포트 삭제

```
DELETE /api/reports/stored/:id
```

#### 4.3.6 기존 리포트 영구 저장으로 전환

```
POST /api/reports/:jobId/persist
```

**Request Body:**
```json
{
  "title": "영구 저장할 리포트",
  "description": "임시 리포트를 영구 저장으로 전환",
  "tags": ["converted"]
}
```

### 4.4 캐시 통합 전략

```
┌─────────────────────────────────────────────────────────┐
│                    요청 흐름                             │
└─────────────────────────────────────────────────────────┘

1. GET /api/reports/stored/:id
   │
   ├─▶ Redis 캐시 확인 (stored:cache:{id})
   │   ├─ HIT  → 바로 반환
   │   └─ MISS → Storage Provider 조회
   │              ├─▶ Redis 캐시에 저장 (24hr TTL)
   │              └─▶ 반환

2. POST /api/reports (persist: true)
   │
   ├─▶ 리포트 생성 (기존 파이프라인)
   │
   ├─▶ Storage Provider에 저장
   │
   └─▶ Redis 캐시에도 저장 (24hr TTL)

3. DELETE /api/reports/stored/:id
   │
   ├─▶ Storage Provider에서 삭제
   │
   └─▶ Redis 캐시에서도 삭제
```

**TTL 정책:**
| 저장 유형 | Redis TTL | 영구 저장 |
|----------|-----------|-----------|
| Temporary (persist: false) | 1시간 | X |
| Persistent (persist: true) | 24시간 | O |

---

## 5. 구현 계획 (Implementation Plan)

### 5.1 작업 분해 (Task Breakdown)

| ID | 작업 | 예상 시간 | 우선순위 |
|----|------|----------|----------|
| T1 | 타입 정의 (StorageOptions, StoredReport 등) | 2시간 | High |
| T2 | StorageProvider 인터페이스 정의 | 2시간 | High |
| T3 | ReportStorageService 구현 | 4시간 | High |
| T4 | 저장소 구현체 개발 (기술 선택 후) | 8시간 | High |
| T5 | ReportService 확장 (persist 옵션) | 4시간 | High |
| T6 | API 엔드포인트 구현 (/stored/*) | 6시간 | High |
| T7 | Redis 캐시 통합 | 3시간 | Medium |
| T8 | 만료 리포트 정리 스케줄러 | 2시간 | Low |
| T9 | 테스트 작성 | 4시간 | High |
| **총계** | | **35시간 (~5일)** | |

### 5.2 의존성 (Dependencies)

```
T1 (타입) ─┬─▶ T2 (Provider 인터페이스)
           │
           └─▶ T3 (StorageService) ─┬─▶ T4 (구현체)
                                    │
                                    └─▶ T5 (ReportService 확장)
                                           │
                                           └─▶ T6 (API 엔드포인트)
                                                  │
                                                  └─▶ T7 (캐시 통합)
                                                         │
                                                         └─▶ T8 (스케줄러)
T9 (테스트) - 각 단계별 병행
```

### 5.3 파일 구조

```
src/
├── types/
│   └── storage.ts              # StorageOptions, StoredReport 등
├── services/
│   ├── reportService.ts        # 기존 파일 확장
│   └── reportStorageService.ts # NEW: 저장소 서비스
├── storage/
│   ├── provider.ts             # StorageProvider 인터페이스
│   └── [구현체].ts              # 구현 시 결정 (예: postgresProvider.ts)
└── routes/
    └── reports.ts              # 기존 파일 확장 (/stored/* 추가)
```

---

## 6. 테스트 전략 (Testing Strategy)

### 6.1 단위 테스트

- `StorageProvider` 인터페이스 구현체 테스트
- `ReportStorageService` 메서드별 테스트
- 타입 검증 테스트

### 6.2 통합 테스트

- API 엔드포인트 테스트 (`/api/reports/stored/*`)
- Redis 캐시 통합 테스트
- 저장 → 조회 → 수정 → 삭제 플로우 테스트

### 6.3 테스트 시나리오

| 시나리오 | 설명 |
|----------|------|
| TC-001 | persist: true로 리포트 생성 시 영구 저장 |
| TC-002 | persist: false로 리포트 생성 시 기존 동작 유지 |
| TC-003 | 저장된 리포트 목록 조회 (페이지네이션) |
| TC-004 | 태그로 필터링 |
| TC-005 | 저장된 리포트 상세 조회 (캐시 HIT) |
| TC-006 | 저장된 리포트 상세 조회 (캐시 MISS → 저장소) |
| TC-007 | 메타데이터 수정 |
| TC-008 | 리포트 삭제 (캐시 + 저장소) |
| TC-009 | 임시 리포트 → 영구 전환 |
| TC-010 | 만료된 리포트 자동 정리 |

---

## 7. 위험 요소 및 완화 방안 (Risks & Mitigations)

| 위험 요소 | 영향도 | 발생 가능성 | 완화 방안 |
|----------|--------|------------|----------|
| 저장소 기술 선택 지연 | Medium | Medium | 인터페이스 추상화로 구현 분리 |
| 대용량 리포트 저장 성능 | Medium | Low | 압축 옵션 제공, 스트리밍 고려 |
| 캐시 불일치 | Low | Medium | Write-through 패턴, TTL 관리 |
| 마이그레이션 복잡도 | Low | Low | 기존 API 호환성 유지 |

---

## 8. 참고 자료 (References)

### 내부 문서
- [00-overview.md](./00-overview.md) - 프로젝트 개요
- [99-future-decisions.md](./99-future-decisions.md) - Decision #16 원본

### 관련 코드
- `src/services/reportService.ts` - 현재 리포트 서비스
- `src/utils/redis.ts` - Redis 클라이언트
- `src/types/report.ts` - 리포트 타입

---

## 변경 이력 (Change Log)

| 날짜 | 버전 | 변경 내용 | 작성자 |
|------|------|----------|--------|
| 2026-01-27 | 1.0 | 초안 작성 (특정 기술 지정) | Claude |
| 2026-01-27 | 2.0 | 재작성: 저장소 기술 비종속, 인터페이스 중심 설계 | Claude |

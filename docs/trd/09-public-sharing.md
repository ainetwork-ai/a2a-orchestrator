# TRD 09: Public Sharing Links (공개 공유 링크)

> **Origin:** [99-future-decisions.md](./99-future-decisions.md) - Decision #17

## 1. 개요 (Overview)

### 1.1 목적 (Purpose)

현재 리포트는 인증된 사용자만 접근 가능합니다. 본 TRD는 토큰 기반의 공개 공유 링크 기능을 설계하여:

- **간편한 공유**: 인증 없이 특정 리포트 열람 가능
- **보안 통제**: 만료 시간, 접근 제한, 감사 로그
- **협업 지원**: 팀 외부 이해관계자와의 리포트 공유

### 1.2 범위 (Scope)

**포함 (In Scope):**
- 토큰 기반 공개 링크 생성
- 만료 시간 설정 기능
- 조회 횟수 제한 (선택적)
- 공개 링크 관리 API (목록, 취소)
- 접근 감사 로그
- 읽기 전용 뷰어 페이지

**제외 (Out of Scope):**
- 편집 권한 공유
- 댓글/주석 기능
- 인증된 사용자 간 공유 (별도 권한 시스템)
- SSO/OAuth 기반 접근 제어

### 1.3 용어 정의 (Definitions)

| 용어 | 정의 |
|------|------|
| **Public Token** | 공개 링크에 사용되는 고유 식별 토큰 |
| **Share Link** | 공개 토큰이 포함된 리포트 접근 URL |
| **Audit Log** | 공개 링크 접근 기록 |
| **Viewer** | 인증 없이 공개 링크로 리포트를 열람하는 사용자 |

---

## 2. 현재 상태 분석 (Current State Analysis)

### 2.1 기존 시스템 구조

```
┌─────────────────────────────────────────────────────────────┐
│                    Current Access Model                      │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  [Client]                                                     │
│      │                                                        │
│      └──► GET /api/reports/:jobId                            │
│               │                                               │
│               ▼                                               │
│         ┌─────────────┐                                       │
│         │   Server    │                                       │
│         │ (No Auth)   │ ◄── 현재: 인증 미구현                 │
│         └─────────────┘                                       │
│               │                                               │
│               ▼                                               │
│         Report Data                                           │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

**현재 상태:**
- 인증 시스템 미구현 (모든 요청 허용)
- 공유 기능 없음
- 접근 로그 없음

### 2.2 문제점 및 한계

| 문제 | 영향 | 심각도 |
|------|------|--------|
| **공유 불가** | 외부 이해관계자 접근 불가 | 높음 |
| **접근 통제 없음** | 보안 우려 | 높음 |
| **추적 불가** | 누가 리포트를 열람했는지 알 수 없음 | 중간 |

---

## 3. 요구사항 (Requirements)

### 3.1 기능적 요구사항 (Functional Requirements)

**[FR-001] 공개 링크 생성**
- 저장된 리포트에 대해 공개 토큰 생성
- 만료 시간 설정 (기본: 7일, 최대: 90일)
- 조회 횟수 제한 설정 (선택적)
- 비밀번호 보호 (선택적)

**[FR-002] 공개 링크 접근**
- 토큰만으로 리포트 열람 가능
- 읽기 전용 (다운로드 옵션 선택 가능)
- 만료/비활성화 시 접근 차단

**[FR-003] 공개 링크 관리**
- 리포트별 공개 링크 목록 조회
- 공개 링크 비활성화/삭제
- 만료 시간 연장
- 설정 변경 (조회 제한, 비밀번호 등)

**[FR-004] 접근 감사 로그**
- 접근 시간, IP 주소 기록
- User-Agent 기록
- 조회 횟수 집계
- 로그 조회 API

**[FR-005] 보안 제어**
- 토큰은 URL-safe, 예측 불가능해야 함
- Rate limiting 적용
- 민감 정보 필터링 옵션

### 3.2 비기능적 요구사항 (Non-Functional Requirements)

**[NFR-001] 보안**
- 토큰: 최소 32자 URL-safe random string
- HTTPS 필수 (프로덕션)
- Rate limit: 분당 60회 / IP

**[NFR-002] 성능**
- 토큰 검증: < 10ms
- 리포트 로드: < 200ms (캐시된 경우)

**[NFR-003] 가용성**
- 공개 링크 시스템 다운 시 기존 API 영향 없음
- Graceful degradation

### 3.3 제약사항 (Constraints)

- 익명화 원칙 유지 (공개 리포트에서도 PII 노출 금지)
- 기존 API 하위 호환성 유지
- Redis 기반 저장소 사용 (기존 인프라 활용)
- TRD 06 (Report Storage) 의존

---

## 4. 기술 설계 (Technical Design)

### 4.1 아키텍처 개요

```
┌────────────────────────────────────────────────────────────────────┐
│                    Public Sharing Architecture                      │
├────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  [Viewer]                                                            │
│      │                                                               │
│      └──► GET /public/reports/:token                                │
│               │                                                      │
│               ▼                                                      │
│         ┌─────────────────┐                                         │
│         │  Token Validator │                                         │
│         └────────┬────────┘                                         │
│                  │                                                   │
│          ┌───────┴───────┐                                          │
│          │               │                                           │
│          ▼               ▼                                           │
│     [Valid]         [Invalid]                                        │
│          │               │                                           │
│          ▼               ▼                                           │
│    ┌───────────┐   ┌──────────┐                                     │
│    │  Report   │   │  Error   │                                     │
│    │  Service  │   │ Response │                                     │
│    └─────┬─────┘   └──────────┘                                     │
│          │                                                           │
│          ▼                                                           │
│    ┌───────────┐                                                     │
│    │  Audit    │                                                     │
│    │   Log     │                                                     │
│    └───────────┘                                                     │
│                                                                      │
│  ────────────────────────────────────────────────────────           │
│                                                                      │
│  [Admin/Owner]                                                       │
│      │                                                               │
│      ├──► POST /api/reports/:id/share      (공개 링크 생성)          │
│      ├──► GET  /api/reports/:id/shares     (공개 링크 목록)          │
│      ├──► PATCH /api/shares/:shareId       (설정 변경)              │
│      └──► DELETE /api/shares/:shareId      (링크 비활성화)          │
│                                                                      │
└────────────────────────────────────────────────────────────────────┘
```

### 4.2 데이터 모델

#### 4.2.1 Redis 데이터 구조

```typescript
// Redis Key Patterns

// 공유 링크 메타데이터 (Hash)
// Key: share:{shareId}
// Fields: reportId, token, passwordHash, expiresAt, maxViews, currentViews,
//         allowDownload, isActive, createdBy, createdAt, updatedAt
"share:{shareId}" → Hash {
  reportId: string,
  token: string,
  passwordHash: string | null,
  expiresAt: number,      // timestamp (ms)
  maxViews: number | null,
  currentViews: number,
  allowDownload: boolean,
  isActive: boolean,
  createdBy: string | null,
  createdAt: number,
  updatedAt: number
}

// 토큰 → shareId 매핑 (String)
// Key: share:token:{token}
// Value: shareId
"share:token:{token}" → "{shareId}"

// 리포트별 공유 링크 목록 (Set)
// Key: report:{reportId}:shares
// Members: shareId[]
"report:{reportId}:shares" → Set<shareId>

// 접근 감사 로그 (Sorted Set)
// Key: share:{shareId}:logs
// Score: timestamp
// Member: JSON serialized log entry
"share:{shareId}:logs" → SortedSet<{
  id: string,
  accessedAt: number,
  ipAddress: string | null,
  userAgent: string | null,
  referer: string | null,
  success: boolean,
  failureReason: string | null
}>

// 만료 예정 공유 링크 (Sorted Set) - 자동 정리용
// Key: shares:expiring
// Score: expiresAt timestamp
// Member: shareId
"shares:expiring" → SortedSet<shareId>

// IP별 접근 카운터 (접근 통계용)
// Key: share:{shareId}:ips
// Members: IP addresses
"share:{shareId}:ips" → Set<ipAddress>
```

**TTL 전략:**
- `share:{shareId}`: 만료 시간 + 7일 (감사 로그 보존 기간)
- `share:token:{token}`: 만료 시간과 동일
- `share:{shareId}:logs`: 90일 후 자동 삭제
- `share:{shareId}:ips`: 만료 시간 + 7일

#### 4.2.2 TypeScript 인터페이스

```typescript
// src/types/sharing.ts

/**
 * 공개 공유 링크 생성 옵션
 */
export interface CreateShareOptions {
  expiresIn?: number;       // 만료 시간 (초, 기본: 7일)
  maxViews?: number;        // 최대 조회 횟수 (선택적)
  password?: string;        // 비밀번호 (선택적)
  allowDownload?: boolean;  // 다운로드 허용 (기본: false)
}

/**
 * 공개 공유 링크 엔티티
 */
export interface ReportShare {
  id: string;
  reportId: string;
  token: string;
  hasPassword: boolean;  // 비밀번호 설정 여부 (해시는 노출 안함)
  expiresAt: number;     // timestamp
  maxViews: number | null;
  currentViews: number;
  allowDownload: boolean;
  isActive: boolean;
  createdBy?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 공개 공유 링크 요약 (목록용)
 */
export interface ReportShareSummary {
  id: string;
  token: string;
  shareUrl: string;      // 전체 URL
  hasPassword: boolean;
  expiresAt: number;
  maxViews: number | null;
  currentViews: number;
  isActive: boolean;
  createdAt: number;
}

/**
 * 공개 링크 업데이트 옵션
 */
export interface UpdateShareOptions {
  expiresAt?: number;       // 새 만료 시간
  maxViews?: number | null; // 새 조회 제한
  password?: string | null; // 새 비밀번호 (null = 제거)
  allowDownload?: boolean;
  isActive?: boolean;
}

/**
 * 접근 로그 엔트리
 */
export interface ShareAccessLog {
  id: string;
  shareId: string;
  accessedAt: number;
  ipAddress?: string;
  userAgent?: string;
  referer?: string;
  success: boolean;
  failureReason?: "expired" | "max_views" | "password" | "inactive" | "not_found";
}

/**
 * 접근 통계
 */
export interface ShareAccessStats {
  totalViews: number;
  uniqueIps: number;
  recentViews: number;  // 최근 24시간
  topReferers: Array<{ referer: string; count: number }>;
}

/**
 * 공개 링크 검증 결과
 */
export interface ShareValidationResult {
  valid: boolean;
  share?: ReportShare;
  report?: any;         // 유효할 때만
  reason?: "expired" | "max_views" | "password_required" | "password_invalid" | "inactive" | "not_found";
}
```

### 4.3 API 설계

#### 4.3.1 공개 링크 생성

**POST /api/reports/stored/:reportId/share**

```http
POST /api/reports/stored/:reportId/share
Content-Type: application/json

{
  "expiresIn": 604800,      // 7일 (초)
  "maxViews": 100,          // 최대 100회 조회
  "password": "secret123",  // 선택적
  "allowDownload": true
}
```

**Response:**

```json
{
  "success": true,
  "share": {
    "id": "share-uuid",
    "token": "aBc123XyZ...",
    "shareUrl": "https://example.com/public/reports/aBc123XyZ...",
    "hasPassword": true,
    "expiresAt": 1707004800000,
    "maxViews": 100,
    "currentViews": 0,
    "allowDownload": true,
    "isActive": true,
    "createdAt": 1706400000000
  }
}
```

#### 4.3.2 공개 링크 목록 조회

**GET /api/reports/stored/:reportId/shares**

```http
GET /api/reports/stored/:reportId/shares
```

**Response:**

```json
{
  "success": true,
  "shares": [
    {
      "id": "share-1",
      "token": "abc123...",
      "shareUrl": "https://example.com/public/reports/abc123...",
      "hasPassword": false,
      "expiresAt": 1707004800000,
      "maxViews": null,
      "currentViews": 42,
      "isActive": true,
      "createdAt": 1706400000000
    }
  ],
  "total": 1
}
```

#### 4.3.3 공개 링크 수정

**PATCH /api/shares/:shareId**

```http
PATCH /api/shares/:shareId
Content-Type: application/json

{
  "expiresAt": 1708214400000,  // 만료 연장
  "isActive": false            // 비활성화
}
```

#### 4.3.4 공개 링크 삭제

**DELETE /api/shares/:shareId**

```http
DELETE /api/shares/:shareId
```

#### 4.3.5 공개 링크로 리포트 접근

**GET /public/reports/:token**

```http
GET /public/reports/:token
```

**비밀번호 필요 시:**

```http
GET /public/reports/:token?password=secret123
```

또는

```http
POST /public/reports/:token/access
Content-Type: application/json

{
  "password": "secret123"
}
```

**Response (성공):**

```json
{
  "success": true,
  "report": { /* T3C Report */ },
  "shareInfo": {
    "expiresAt": 1707004800000,
    "viewsRemaining": 58,
    "allowDownload": true
  }
}
```

**Response (실패):**

```json
{
  "success": false,
  "error": "Share link has expired",
  "code": "SHARE_EXPIRED"
}
```

#### 4.3.6 접근 로그 조회

**GET /api/shares/:shareId/logs**

```http
GET /api/shares/:shareId/logs?limit=50&offset=0
```

**Response:**

```json
{
  "success": true,
  "logs": [
    {
      "id": "log-1",
      "accessedAt": 1706450000000,
      "ipAddress": "203.xxx.xxx.xxx",
      "userAgent": "Mozilla/5.0...",
      "success": true
    }
  ],
  "stats": {
    "totalViews": 42,
    "uniqueIps": 15,
    "recentViews": 8
  }
}
```

### 4.4 컴포넌트 설계

#### 4.4.1 ShareRepository

```typescript
// src/repositories/shareRepository.ts

import { Redis } from "ioredis";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import bcrypt from "bcrypt";
import {
  ReportShare,
  ReportShareSummary,
  CreateShareOptions,
  UpdateShareOptions,
  ShareAccessLog,
  ShareAccessStats,
} from "../types/sharing";

export class ShareRepository {
  private redis: Redis;
  private baseUrl: string;

  // Redis Key Prefixes
  private readonly SHARE_PREFIX = "share:";
  private readonly TOKEN_PREFIX = "share:token:";
  private readonly REPORT_SHARES_PREFIX = "report:";
  private readonly EXPIRING_SET = "shares:expiring";

  constructor(redis: Redis, baseUrl: string) {
    this.redis = redis;
    this.baseUrl = baseUrl;
  }

  /**
   * 토큰 생성 (URL-safe, 32 bytes = 43 chars base64url)
   */
  private generateToken(): string {
    return crypto.randomBytes(32).toString("base64url");
  }

  /**
   * 공개 링크 생성
   */
  async create(
    reportId: string,
    options: CreateShareOptions = {},
    createdBy?: string
  ): Promise<ReportShare> {
    const id = uuidv4();
    const token = this.generateToken();
    const now = Date.now();

    // 기본값
    const expiresIn = options.expiresIn || 7 * 24 * 60 * 60; // 7일
    const expiresAt = now + expiresIn * 1000;

    // 비밀번호 해싱
    let passwordHash: string | null = null;
    if (options.password) {
      passwordHash = await bcrypt.hash(options.password, 10);
    }

    const shareData: Record<string, string> = {
      id,
      reportId,
      token,
      passwordHash: passwordHash || "",
      expiresAt: expiresAt.toString(),
      maxViews: options.maxViews?.toString() || "",
      currentViews: "0",
      allowDownload: (options.allowDownload || false).toString(),
      isActive: "true",
      createdBy: createdBy || "",
      createdAt: now.toString(),
      updatedAt: now.toString(),
    };

    const pipeline = this.redis.pipeline();

    // 공유 링크 메타데이터 저장
    pipeline.hset(`${this.SHARE_PREFIX}${id}`, shareData);

    // 토큰 → shareId 매핑
    pipeline.set(`${this.TOKEN_PREFIX}${token}`, id);

    // 리포트별 공유 링크 목록에 추가
    pipeline.sadd(`${this.REPORT_SHARES_PREFIX}${reportId}:shares`, id);

    // 만료 예정 목록에 추가 (자동 정리용)
    pipeline.zadd(this.EXPIRING_SET, expiresAt, id);

    // TTL 설정 (만료 + 7일 보존)
    const ttlSeconds = Math.ceil(expiresIn + 7 * 24 * 60 * 60);
    pipeline.expire(`${this.SHARE_PREFIX}${id}`, ttlSeconds);
    pipeline.expire(`${this.TOKEN_PREFIX}${token}`, expiresIn);

    await pipeline.exec();

    return this.mapToShare(shareData);
  }

  /**
   * 토큰으로 공개 링크 조회
   */
  async findByToken(token: string): Promise<ReportShare | null> {
    const shareId = await this.redis.get(`${this.TOKEN_PREFIX}${token}`);
    if (!shareId) return null;

    return this.findById(shareId);
  }

  /**
   * 리포트의 공개 링크 목록 조회
   */
  async findByReportId(reportId: string): Promise<ReportShareSummary[]> {
    const shareIds = await this.redis.smembers(
      `${this.REPORT_SHARES_PREFIX}${reportId}:shares`
    );

    const shares: ReportShareSummary[] = [];
    for (const shareId of shareIds) {
      const data = await this.redis.hgetall(`${this.SHARE_PREFIX}${shareId}`);
      if (data && data.id) {
        shares.push(this.mapToSummary(data));
      }
    }

    // createdAt 기준 내림차순 정렬
    return shares.sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 공개 링크 업데이트
   */
  async update(
    shareId: string,
    updates: UpdateShareOptions
  ): Promise<ReportShare | null> {
    const existing = await this.findById(shareId);
    if (!existing) return null;

    const updateData: Record<string, string> = {
      updatedAt: Date.now().toString(),
    };

    if (updates.expiresAt !== undefined) {
      updateData.expiresAt = updates.expiresAt.toString();
      // 만료 예정 목록 업데이트
      await this.redis.zadd(this.EXPIRING_SET, updates.expiresAt, shareId);
    }
    if (updates.maxViews !== undefined) {
      updateData.maxViews = updates.maxViews?.toString() || "";
    }
    if (updates.allowDownload !== undefined) {
      updateData.allowDownload = updates.allowDownload.toString();
    }
    if (updates.isActive !== undefined) {
      updateData.isActive = updates.isActive.toString();
    }
    if (updates.password !== undefined) {
      if (updates.password === null) {
        updateData.passwordHash = "";
      } else {
        updateData.passwordHash = await bcrypt.hash(updates.password, 10);
      }
    }

    await this.redis.hset(`${this.SHARE_PREFIX}${shareId}`, updateData);
    return this.findById(shareId);
  }

  /**
   * 공개 링크 삭제
   */
  async delete(shareId: string): Promise<boolean> {
    const share = await this.findById(shareId);
    if (!share) return false;

    const pipeline = this.redis.pipeline();

    // 메타데이터 삭제
    pipeline.del(`${this.SHARE_PREFIX}${shareId}`);

    // 토큰 매핑 삭제
    pipeline.del(`${this.TOKEN_PREFIX}${share.token}`);

    // 리포트 목록에서 제거
    pipeline.srem(`${this.REPORT_SHARES_PREFIX}${share.reportId}:shares`, shareId);

    // 만료 목록에서 제거
    pipeline.zrem(this.EXPIRING_SET, shareId);

    // 로그 삭제
    pipeline.del(`${this.SHARE_PREFIX}${shareId}:logs`);
    pipeline.del(`${this.SHARE_PREFIX}${shareId}:ips`);

    await pipeline.exec();
    return true;
  }

  /**
   * 조회 수 증가
   */
  async incrementViews(shareId: string): Promise<void> {
    await this.redis.hincrby(`${this.SHARE_PREFIX}${shareId}`, "currentViews", 1);
  }

  /**
   * 비밀번호 검증
   */
  async verifyPassword(share: ReportShare, password: string): Promise<boolean> {
    if (!share.hasPassword) return true;

    const passwordHash = await this.redis.hget(
      `${this.SHARE_PREFIX}${share.id}`,
      "passwordHash"
    );

    if (!passwordHash) return true;

    return bcrypt.compare(password, passwordHash);
  }

  /**
   * 접근 로그 기록
   */
  async logAccess(
    shareId: string,
    ipAddress: string | undefined,
    userAgent: string | undefined,
    referer: string | undefined,
    success: boolean,
    failureReason?: string
  ): Promise<void> {
    const log: ShareAccessLog = {
      id: uuidv4(),
      shareId,
      accessedAt: Date.now(),
      ipAddress,
      userAgent,
      referer,
      success,
      failureReason: failureReason as any,
    };

    const pipeline = this.redis.pipeline();

    // 로그를 Sorted Set에 추가 (score = timestamp)
    pipeline.zadd(
      `${this.SHARE_PREFIX}${shareId}:logs`,
      log.accessedAt,
      JSON.stringify(log)
    );

    // IP 주소 Set에 추가 (통계용)
    if (ipAddress && success) {
      pipeline.sadd(`${this.SHARE_PREFIX}${shareId}:ips`, ipAddress);
    }

    // 90일 후 자동 삭제
    pipeline.expire(`${this.SHARE_PREFIX}${shareId}:logs`, 90 * 24 * 60 * 60);

    await pipeline.exec();
  }

  /**
   * 접근 로그 조회
   */
  async getAccessLogs(
    shareId: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<ShareAccessLog[]> {
    // 최신순으로 조회 (ZREVRANGE)
    const logs = await this.redis.zrevrange(
      `${this.SHARE_PREFIX}${shareId}:logs`,
      offset,
      offset + limit - 1
    );

    return logs.map((log) => JSON.parse(log) as ShareAccessLog);
  }

  /**
   * 접근 통계 조회
   */
  async getAccessStats(shareId: string): Promise<ShareAccessStats> {
    const logsKey = `${this.SHARE_PREFIX}${shareId}:logs`;
    const ipsKey = `${this.SHARE_PREFIX}${shareId}:ips`;

    // 전체 로그 조회
    const allLogs = await this.redis.zrange(logsKey, 0, -1);
    const parsedLogs = allLogs.map((log) => JSON.parse(log) as ShareAccessLog);

    // 성공한 조회만 필터
    const successLogs = parsedLogs.filter((log) => log.success);

    // 최근 24시간 조회
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recentLogs = successLogs.filter((log) => log.accessedAt > oneDayAgo);

    // Unique IPs
    const uniqueIps = await this.redis.scard(ipsKey);

    // Top referers 계산
    const refererCounts = new Map<string, number>();
    for (const log of successLogs) {
      if (log.referer) {
        refererCounts.set(log.referer, (refererCounts.get(log.referer) || 0) + 1);
      }
    }
    const topReferers = Array.from(refererCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([referer, count]) => ({ referer, count }));

    return {
      totalViews: successLogs.length,
      uniqueIps,
      recentViews: recentLogs.length,
      topReferers,
    };
  }

  /**
   * ID로 조회
   */
  private async findById(id: string): Promise<ReportShare | null> {
    const data = await this.redis.hgetall(`${this.SHARE_PREFIX}${id}`);
    if (!data || !data.id) return null;
    return this.mapToShare(data);
  }

  /**
   * 매핑 헬퍼
   */
  private mapToShare(data: Record<string, string>): ReportShare {
    return {
      id: data.id,
      reportId: data.reportId,
      token: data.token,
      hasPassword: !!data.passwordHash,
      expiresAt: parseInt(data.expiresAt, 10),
      maxViews: data.maxViews ? parseInt(data.maxViews, 10) : null,
      currentViews: parseInt(data.currentViews, 10) || 0,
      allowDownload: data.allowDownload === "true",
      isActive: data.isActive === "true",
      createdBy: data.createdBy || undefined,
      createdAt: parseInt(data.createdAt, 10),
      updatedAt: parseInt(data.updatedAt, 10),
    };
  }

  private mapToSummary(data: Record<string, string>): ReportShareSummary {
    return {
      id: data.id,
      token: data.token,
      shareUrl: `${this.baseUrl}/public/reports/${data.token}`,
      hasPassword: !!data.passwordHash,
      expiresAt: parseInt(data.expiresAt, 10),
      maxViews: data.maxViews ? parseInt(data.maxViews, 10) : null,
      currentViews: parseInt(data.currentViews, 10) || 0,
      isActive: data.isActive === "true",
      createdAt: parseInt(data.createdAt, 10),
    };
  }
}
```

#### 4.4.2 ShareService

```typescript
// src/services/shareService.ts

import { ShareRepository } from "../repositories/shareRepository";
import { ReportRepository } from "../repositories/reportRepository";
import {
  ReportShare,
  CreateShareOptions,
  UpdateShareOptions,
  ShareValidationResult,
} from "../types/sharing";

export class ShareService {
  private shareRepo: ShareRepository;
  private reportRepo: ReportRepository;

  constructor(shareRepo: ShareRepository, reportRepo: ReportRepository) {
    this.shareRepo = shareRepo;
    this.reportRepo = reportRepo;
  }

  /**
   * 공개 링크 생성
   */
  async createShare(
    reportId: string,
    options: CreateShareOptions,
    createdBy?: string
  ): Promise<ReportShare> {
    // 리포트 존재 확인
    const report = await this.reportRepo.findById(reportId);
    if (!report) {
      throw new Error("Report not found");
    }

    return this.shareRepo.create(reportId, options, createdBy);
  }

  /**
   * 공개 링크 검증 및 리포트 반환
   */
  async validateAndGetReport(
    token: string,
    password?: string,
    ipAddress?: string,
    userAgent?: string,
    referer?: string
  ): Promise<ShareValidationResult> {
    const share = await this.shareRepo.findByToken(token);

    // 존재하지 않음
    if (!share) {
      return { valid: false, reason: "not_found" };
    }

    // 비활성화됨
    if (!share.isActive) {
      await this.logAccess(share.id, ipAddress, userAgent, referer, false, "inactive");
      return { valid: false, share, reason: "inactive" };
    }

    // 만료됨
    if (share.expiresAt < Date.now()) {
      await this.logAccess(share.id, ipAddress, userAgent, referer, false, "expired");
      return { valid: false, share, reason: "expired" };
    }

    // 조회 횟수 초과
    if (share.maxViews !== null && share.currentViews >= share.maxViews) {
      await this.logAccess(share.id, ipAddress, userAgent, referer, false, "max_views");
      return { valid: false, share, reason: "max_views" };
    }

    // 비밀번호 필요
    if (share.hasPassword) {
      if (!password) {
        return { valid: false, share, reason: "password_required" };
      }
      const validPassword = await this.shareRepo.verifyPassword(share, password);
      if (!validPassword) {
        await this.logAccess(share.id, ipAddress, userAgent, referer, false, "password");
        return { valid: false, share, reason: "password_invalid" };
      }
    }

    // 리포트 조회
    const report = await this.reportRepo.findById(share.reportId);
    if (!report) {
      return { valid: false, share, reason: "not_found" };
    }

    // 조회 수 증가 및 로그
    await this.shareRepo.incrementViews(share.id);
    await this.logAccess(share.id, ipAddress, userAgent, referer, true);

    return {
      valid: true,
      share,
      report: report.reportData,
    };
  }

  /**
   * 접근 로그 기록
   */
  private async logAccess(
    shareId: string,
    ipAddress?: string,
    userAgent?: string,
    referer?: string,
    success: boolean = true,
    failureReason?: string
  ): Promise<void> {
    try {
      await this.shareRepo.logAccess(
        shareId,
        ipAddress,
        userAgent,
        referer,
        success,
        failureReason
      );
    } catch (error) {
      console.error("[ShareService] Error logging access:", error);
    }
  }

  // ... 기타 메서드 (update, delete, getShares, getLogs, getStats)
}
```

---

## 5. 구현 계획 (Implementation Plan)

### 5.1 작업 분해 (Task Breakdown)

| # | 작업 | 설명 | 예상 시간 |
|---|------|------|-----------|
| 1 | 타입 정의 | sharing.ts 인터페이스 정의 | 1시간 |
| 2 | Redis 데이터 구조 | Key patterns, TTL 설정 | 1시간 |
| 3 | ShareRepository | CRUD, 토큰 생성, 비밀번호 해싱 (Redis) | 4시간 |
| 4 | ShareService | 비즈니스 로직, 검증 | 3시간 |
| 5 | 관리 API | 생성, 목록, 수정, 삭제 엔드포인트 | 3시간 |
| 6 | 공개 접근 API | 토큰 검증, 리포트 반환 | 2시간 |
| 7 | 감사 로그 | 접근 기록, 통계 조회 | 2시간 |
| 8 | Rate Limiting | IP 기반 제한 | 1시간 |
| 9 | 테스트 작성 | Unit, Integration 테스트 | 4시간 |
| 10 | 문서화 | API 문서 업데이트 | 1시간 |

### 5.2 의존성 (Dependencies)

```
Task 06 (Report Storage) ◄── 필수 선행
    │
    ▼
Task 1 (타입 정의) + Task 2 (Redis 데이터 구조)
    │
    ▼
Task 3 (ShareRepository)
    │
    ▼
Task 4 (ShareService)
    │
    ├──► Task 5 (관리 API)
    │
    ├──► Task 6 (공개 접근 API)
    │
    └──► Task 7 (감사 로그)

Task 5, 6, 7 완료 후
    │
    ▼
Task 8 (Rate Limiting)
    │
    ▼
Task 9 (테스트)
    │
    ▼
Task 10 (문서화)
```

### 5.3 예상 일정 (Estimated Timeline)

**총 예상 시간:** 22시간

**일정 (5일 기준):**
- **Day 1:** Task 1, 2, 3 (타입, 스키마, Repository) - 6시간
- **Day 2:** Task 4, 5 (Service, 관리 API) - 6시간
- **Day 3:** Task 6, 7 (공개 API, 감사 로그) - 4시간
- **Day 4:** Task 8, 9 (Rate Limiting, 테스트) - 5시간
- **Day 5:** Task 10 및 버그 수정 - 1시간 +

---

## 6. 테스트 전략 (Testing Strategy)

### 6.1 단위 테스트

```typescript
describe("ShareRepository", () => {
  describe("generateToken", () => {
    it("should generate URL-safe token of correct length", () => {
      const token = repository["generateToken"]();
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(token.length).toBe(43); // 32 bytes = 43 chars base64url
    });
  });

  describe("verifyPassword", () => {
    it("should return true for correct password", async () => {
      const share = await repository.create(reportId, { password: "test123" });
      const result = await repository.verifyPassword(share, "test123");
      expect(result).toBe(true);
    });

    it("should return false for incorrect password", async () => {
      const share = await repository.create(reportId, { password: "test123" });
      const result = await repository.verifyPassword(share, "wrong");
      expect(result).toBe(false);
    });
  });
});
```

### 6.2 통합 테스트

```typescript
describe("Public Share Integration", () => {
  it("should create and access share link", async () => {
    // Create share
    const createRes = await request(app)
      .post(`/api/reports/stored/${reportId}/share`)
      .send({ expiresIn: 3600 });

    expect(createRes.status).toBe(200);
    const { token } = createRes.body.share;

    // Access via public link
    const accessRes = await request(app)
      .get(`/public/reports/${token}`);

    expect(accessRes.status).toBe(200);
    expect(accessRes.body.report).toBeDefined();
  });

  it("should reject expired share link", async () => {
    // Create expired share (1 second)
    const share = await createShare({ expiresIn: 1 });
    await new Promise((r) => setTimeout(r, 2000));

    const res = await request(app)
      .get(`/public/reports/${share.token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SHARE_EXPIRED");
  });
});
```

### 6.3 테스트 시나리오

| 시나리오 | 검증 항목 |
|----------|-----------|
| **정상 접근** | 토큰으로 리포트 접근 성공 |
| **만료된 링크** | 403 + SHARE_EXPIRED |
| **조회 제한 초과** | 403 + MAX_VIEWS_EXCEEDED |
| **비밀번호 필요** | 401 + PASSWORD_REQUIRED |
| **잘못된 비밀번호** | 403 + INVALID_PASSWORD |
| **비활성화 링크** | 403 + SHARE_INACTIVE |
| **접근 로그** | IP, UA, Referer 기록됨 |
| **Rate Limiting** | 429 Too Many Requests |

---

## 7. 위험 요소 및 완화 방안 (Risks & Mitigations)

| 위험 요소 | 영향도 | 발생 가능성 | 완화 방안 |
|----------|--------|------------|----------|
| **토큰 유출** | 높음 | 중간 | 만료 시간, 조회 제한, 비활성화 기능 |
| **무차별 대입** | 높음 | 낮음 | 32바이트 토큰, rate limiting |
| **민감 정보 노출** | 높음 | 낮음 | 익명화 유지, 다운로드 제한 |
| **DoS 공격** | 중간 | 중간 | Rate limiting, 캐싱 |

---

## 8. 참고 자료 (References)

### 내부 문서
- [06-report-storage.md](./06-report-storage.md) - 리포트 저장소 (선행 의존)
- [99-future-decisions.md](./99-future-decisions.md) - Decision 17 원본

### 외부 참조
- [bcrypt.js](https://github.com/kelektiv/node.bcrypt.js)
- [OWASP Secure Token Generation](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)

---

## 변경 이력 (Change Log)

| 날짜 | 버전 | 변경 내용 | 작성자 |
|------|------|----------|--------|
| 2026-01-27 | 1.0 | 초안 작성 | Claude |

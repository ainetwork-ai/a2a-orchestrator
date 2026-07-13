// backend 이관 엔드포인트 HTTP 클라이언트.
// 호출 규약: 계약 §1 (Bearer migrationToken, credentials omit는 서버 fetch엔 무의미).
// - 401/403 → 즉시 throw(토큰 만료/scope 부족). 멱등이라 새 토큰으로 재실행하면 이어짐.
// - 5xx/네트워크 → 지수 백오프 재시도.
// - 200 + errors[] (부분 실패)는 정상 응답으로 그대로 반환(호출부가 집계/로그).

import type { MigrationBatchReport, MigrationBatchRequest } from "./contract";

export class MigrationAuthError extends Error {}

/** 413: 배치 본문이 backend body 한계 초과. 호출부가 배치를 쪼개 재시도한다. */
export class MigrationPayloadTooLargeError extends Error {}

export interface MigrationClientOpts {
  baseUrl: string;
  token: string;
  maxRetries?: number;
}

export class MigrationClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly maxRetries: number;

  constructor(opts: MigrationClientOpts) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.maxRetries = opts.maxRetries ?? 4;
  }

  postAgents<T>(req: MigrationBatchRequest<T>): Promise<MigrationBatchReport> {
    return this.post("/migration/ainspace/agents", req);
  }

  postDms<T>(req: MigrationBatchRequest<T>): Promise<MigrationBatchReport> {
    return this.post("/migration/ainspace/dms", req);
  }

  private async post(
    path: string,
    body: unknown,
  ): Promise<MigrationBatchReport> {
    let lastErr: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (attempt > 0) {
        const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 8000);
        await sleep(backoffMs);
        console.warn(`[client] ${path} 재시도 ${attempt}/${this.maxRetries}`);
      }

      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
      } catch (err) {
        lastErr = err; // 네트워크 오류 → 재시도
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        const text = await res.text().catch(() => "");
        throw new MigrationAuthError(
          `인증 실패(${res.status}): 토큰 만료 또는 migration:write scope 부족. ` +
            `새 토큰 발급 후 재실행(멱등). ${text.slice(0, 200)}`,
        );
      }

      if (res.status === 413) {
        const text = await res.text().catch(() => "");
        throw new MigrationPayloadTooLargeError(
          `본문 초과(413): 배치가 너무 큼. ${text.slice(0, 200)}`,
        );
      }

      if (res.status >= 500) {
        lastErr = new Error(`서버 오류 ${res.status}`); // 재시도
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`요청 실패 ${res.status} ${path}: ${text.slice(0, 300)}`);
      }

      return (await res.json()) as MigrationBatchReport;
    }

    throw new Error(
      `${path} ${this.maxRetries}회 재시도 후 실패: ${String(lastErr)}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

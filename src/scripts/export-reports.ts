// 레거시 리포트 산출물 Redis → backend Postgres 일회성 이관 exporter.
//
// 흐름:
//   0. env: MIGRATION_TOKEN(migration:write, 운영자 발급), BACKEND_BASE,
//      WORKSPACE_ID(적재 대상 워크스페이스 UUID), REDIS_URL
//   1. Redis 의 `report:job:*` 전부 스캔 → ReportJob[]
//   2. backend LegacyReportJobEnvelope 형태로 매핑(ReportJob 의 부분집합)
//   3. POST /migration/ainspace/legacy-reports  { workspaceId, items }
//
// 안전장치: 기본 dryRun(쓰기 X, 카운트만). 실제 적재는 --execute.
//   backend 는 orig job.id(uuid) 보존 + onConflictDoNothing 이라 재실행 멱등.
//   401/403 이면 즉시 중단(새 토큰으로 재실행하면 이어짐).
//
// 사용:
//   MIGRATION_TOKEN=... BACKEND_BASE=https://... WORKSPACE_ID=... REDIS_URL=redis://... \
//     npx ts-node src/scripts/export-reports.ts             # dryRun
//   ... npx ts-node src/scripts/export-reports.ts --execute   # 실제 적재
//
// backend 수신: a2a-slack-notion `MigrationController.importLegacyReports`
//   (EPIC34 Story 34.14, LegacyReportImportService). source='orchestrator-legacy'.

import "dotenv/config";
import { closeRedis, getRedisClient, initRedis } from "../utils/redis";
import type { ReportJob } from "../types/report";

const JOB_PREFIX = "report:job:";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** backend LegacyReportJobEnvelope 와 동일 형태 (ReportJob 의 부분집합). */
interface LegacyReportEnvelope {
  id: string;
  status?: ReportJob["status"];
  report?: ReportJob["report"];
  params?: ReportJob["params"];
  createdAt: number;
  updatedAt?: number;
  cachedAt?: number;
  title?: string;
  description?: string;
  tags?: string[];
}

/** backend LegacyReportImportReport 응답 형태. */
interface ImportReport {
  processed: number;
  imported: number;
  skipped: number;
  errors: { sourceId: string; reason: string }[];
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`✖ 환경변수 ${name} 필요`);
    process.exit(1);
  }
  return v;
}

/** Redis 의 report:job:* 전부 읽어 ReportJob[] 로 반환. */
async function readAllReportJobs(): Promise<ReportJob[]> {
  const redis = getRedisClient();
  const keys = await redis.keys(`${JOB_PREFIX}*`);
  if (keys.length === 0) return [];
  const values = await redis.mGet(keys);
  const jobs: ReportJob[] = [];
  for (const raw of values) {
    if (!raw) continue;
    try {
      jobs.push(JSON.parse(raw) as ReportJob);
    } catch {
      console.warn("⚠ JSON 파싱 실패한 job 1건 skip");
    }
  }
  return jobs;
}

function toEnvelope(job: ReportJob): LegacyReportEnvelope {
  return {
    id: job.id,
    status: job.status,
    report: job.report,
    params: job.params,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    cachedAt: job.cachedAt,
    title: job.title,
    description: job.description,
    tags: job.tags,
  };
}

async function postLegacyReports(
  baseUrl: string,
  token: string,
  workspaceId: string,
  items: LegacyReportEnvelope[],
): Promise<ImportReport> {
  const res = await fetch(
    `${baseUrl.replace(/\/+$/, "")}/migration/ainspace/legacy-reports`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workspaceId, items }),
    },
  );

  if (res.status === 401 || res.status === 403) {
    const text = await res.text().catch(() => "");
    console.error(
      `✖ 인증 실패(${res.status}): 토큰 만료 또는 migration:write scope 부족. ` +
        `새 토큰 발급 후 재실행(멱등). ${text.slice(0, 200)}`,
    );
    process.exit(2);
  }
  if (res.status === 413) {
    console.error(
      "✖ 본문 초과(413): 리포트 수/크기가 backend body 한계 초과. " +
        "backend body 한계 상향 또는 스크립트에 배치 분할 추가 필요.",
    );
    process.exit(1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`요청 실패 ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as ImportReport;
}

async function main(): Promise<void> {
  const execute = process.argv.slice(2).includes("--execute");
  const dryRun = !execute;
  const token = requireEnv("MIGRATION_TOKEN");
  const baseUrl = requireEnv("BACKEND_BASE");
  const workspaceId = requireEnv("WORKSPACE_ID");
  if (!UUID_RE.test(workspaceId)) {
    console.error(`✖ WORKSPACE_ID 는 UUID 여야 함: ${workspaceId}`);
    process.exit(1);
  }

  console.log(
    `=== 레거시 리포트 → backend 이관 exporter (${dryRun ? "DRY-RUN" : "EXECUTE"}) ===`,
  );
  console.log(`backend: ${baseUrl}  workspace: ${workspaceId}`);

  await initRedis();
  try {
    const jobs = await readAllReportJobs();
    const items = jobs.map(toEnvelope);
    const byStatus = items.reduce<Record<string, number>>((acc, it) => {
      const s = it.status ?? "completed";
      acc[s] = (acc[s] ?? 0) + 1;
      return acc;
    }, {});
    const withReport = items.filter((it) => it.report != null).length;
    console.log(
      `스캔: report job ${items.length}건 ` +
        `(status ${JSON.stringify(byStatus)}, report 포함 ${withReport}건)`,
    );

    if (items.length === 0) {
      console.log("이관할 리포트 없음.");
      return;
    }

    if (dryRun) {
      console.log(
        "DRY-RUN 완료. 위 숫자를 확인하고 이상 없으면 --execute 로 실제 적재하세요.\n" +
          "  (backend 는 orig id 보존 + 멱등이므로 재실행해도 중복 생성 안 됨.)",
      );
      return;
    }

    const report = await postLegacyReports(baseUrl, token, workspaceId, items);
    console.log("=== 적재 결과 ===");
    console.log(
      `  processed=${report.processed} imported=${report.imported} ` +
        `skipped(멱등)=${report.skipped} errors=${report.errors.length}`,
    );
    for (const e of report.errors.slice(0, 20)) {
      console.log(`    ✖ ${e.sourceId}: ${e.reason}`);
    }
    if (report.errors.length > 20) {
      console.log(`    … 외 ${report.errors.length - 20}건`);
    }
    console.log("EXECUTE 완료.");
  } catch (err) {
    console.error("✖ 이관 중단:", err);
    process.exitCode = 1;
  } finally {
    await closeRedis();
  }
}

void main();

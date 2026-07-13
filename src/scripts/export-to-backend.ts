// ainspace Redis → backend Postgres 일회성 이관 exporter.
//
// 흐름 (계약 docs/integration/ainspace-migration-guide.md):
//   0. env: MIGRATION_TOKEN(migration:write, 운영자 발급), BACKEND_BASE, REDIS_URL
//   1. 전 thread 스캔 → agent union(Set ∪ thread.agents) 수집
//   2. POST /agents  (errors 있으면 dms 진입 전 중단)
//   3. orphan(userId 없음) 제외 → thread별 envelope(owner shape 판정 + senderRef 해소)
//      → 배치 분할 → POST /dms
//
// 안전장치: 기본 dryRun(쓰기 X). 실제 적재는 --execute. 401이면 즉시 중단(멱등 재개).
//
// 사용:
//   MIGRATION_TOKEN=... BACKEND_BASE=https://... REDIS_URL=redis://... \
//     npx ts-node src/scripts/export-to-backend.ts            # dryRun
//   ... npx ts-node src/scripts/export-to-backend.ts --execute  # 실제 적재

import "dotenv/config";
import { closeRedis, getRedisClient, initRedis } from "../utils/redis";
import {
  MigrationAuthError,
  MigrationClient,
  MigrationPayloadTooLargeError,
} from "../migration/client";
import {
  readAllThreads,
  readRegisteredAgents,
  readThreadMessages,
} from "../migration/redis-source";
import {
  batchThreads,
  collectAgentUnion,
  SESSION_FALLBACK_ADDRESS,
  threadToEnvelope,
} from "../migration/transform";
import type {
  DmThreadEnvelope,
  MigrationBatchReport,
} from "../migration/contract";

interface Args {
  execute: boolean;
  includeDropped: boolean;
  maxThreads: number;
  maxMessages: number;
}

function parseArgs(argv: string[]): Args {
  const has = (f: string) => argv.includes(f);
  const num = (f: string, d: number) => {
    const i = argv.indexOf(f);
    return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : d;
  };
  return {
    execute: has("--execute"),
    includeDropped: has("--include-dropped"),
    maxThreads: num("--max-threads", 100),
    maxMessages: num("--max-messages", 3000),
  };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`✖ 환경변수 ${name} 필요`);
    process.exit(1);
  }
  return v;
}

function emptyReport(): MigrationBatchReport {
  return { processed: 0, created: 0, matched: 0, skipped: 0, errors: [] };
}

function mergeReport(acc: MigrationBatchReport, r: MigrationBatchReport): void {
  acc.processed += r.processed;
  acc.created += r.created;
  acc.matched += r.matched;
  acc.skipped += r.skipped;
  acc.errors.push(...r.errors);
}

function printReport(label: string, r: MigrationBatchReport): void {
  console.log(
    `  ${label}: processed=${r.processed} created=${r.created} ` +
      `matched=${r.matched} skipped=${r.skipped} errors=${r.errors.length}`,
  );
  for (const e of r.errors.slice(0, 20)) {
    console.log(`    ✖ ${e.sourceId}: ${e.reason}`);
  }
  if (r.errors.length > 20) console.log(`    … 외 ${r.errors.length - 20}건`);
}

/**
 * drop된 미매칭 speaker를 이름별로 집계해 출력한다.
 * thread 내내 같은 speaker가 여러 번 drop되므로, 어떤 이름이 문제인지 한눈에 보여준다.
 * speaker가 owner(user) 발화였는지 agent였는지는 알 수 없어 "미매칭 speaker"로 통칭.
 */
function printDroppedSummary(
  droppedLog: Array<{ thread: string; messageId: string; speaker: string }>,
): void {
  if (droppedLog.length === 0) return;

  const bySpeaker = new Map<string, { count: number; threads: Set<string> }>();
  for (const d of droppedLog) {
    const entry = bySpeaker.get(d.speaker) ?? { count: 0, threads: new Set() };
    entry.count += 1;
    entry.threads.add(d.thread);
    bySpeaker.set(d.speaker, entry);
  }

  const rows = [...bySpeaker.entries()].sort((a, b) => b[1].count - a[1].count);
  console.log(`=== drop된 미매칭 speaker 집계 (${rows.length}종) ===`);
  for (const [speaker, { count, threads }] of rows) {
    console.log(
      `  "${speaker}": 메시지 ${count}건, thread ${threads.size}개`,
    );
  }
}

/**
 * 배치를 POST하다 413(본문 초과)를 만나면 반으로 쪼개 재귀 재시도한다.
 * backend body 한계를 모르고도 동작하게 하는 적응형 분할 — thread 경계는 보존(쪼개지 않음).
 * 단일 thread 하나가 한계를 넘으면 더 못 쪼개므로 명확히 throw(해당 thread 별도 처리 필요).
 */
async function sendDmsBatchAdaptive(
  client: MigrationClient,
  batch: DmThreadEnvelope[],
  opts: { dryRun: boolean; includeDropped: boolean },
  label: string,
): Promise<MigrationBatchReport> {
  try {
    return await client.postDms({
      dryRun: opts.dryRun,
      includeDropped: opts.includeDropped,
      items: batch,
    });
  } catch (err) {
    if (!(err instanceof MigrationPayloadTooLargeError)) throw err;

    if (batch.length <= 1) {
      const t = batch[0];
      throw new Error(
        `배치 ${label}: thread 1개(sourceId=${t?.sourceId}, 메시지 ${t?.messages.length}건)가 ` +
          `단독으로도 backend body 한계 초과(413). 더 분할 불가 — backend 한계 상향 또는 해당 thread 개별 처리 필요.`,
      );
    }

    const mid = Math.ceil(batch.length / 2);
    console.warn(
      `  ⚠ 배치 ${label} 413 → ${batch.length}개를 ${mid}/${batch.length - mid}로 분할 재시도`,
    );
    const left = await sendDmsBatchAdaptive(client, batch.slice(0, mid), opts, `${label}.1`);
    const right = await sendDmsBatchAdaptive(client, batch.slice(mid), opts, `${label}.2`);
    mergeReport(left, right);
    return left;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = !args.execute;
  const token = requireEnv("MIGRATION_TOKEN");
  const baseUrl = requireEnv("BACKEND_BASE");

  console.log(
    `=== ainspace → backend 이관 exporter (${dryRun ? "DRY-RUN" : "EXECUTE"}) ===`,
  );
  console.log(`backend: ${baseUrl}`);

  const client = new MigrationClient({ baseUrl, token });
  await initRedis();
  const redis = getRedisClient();

  try {
    // ---- 1. 스캔 ----
    const registered = await readRegisteredAgents(redis);
    const threads = await readAllThreads(redis);
    console.log(
      `스캔: 등록 agent ${registered.length}, thread ${threads.length}`,
    );

    // ---- 2. agents ----
    const agents = collectAgentUnion(registered, threads);
    console.log(`agent union(Set ∪ thread.agents): ${agents.length}`);
    const agentReport = await client.postAgents({ dryRun, items: agents });
    console.log("[/agents]");
    printReport("agents", agentReport);

    if (agentReport.errors.length > 0) {
      console.error(
        "✖ agents 적재에 오류가 있어 dms 진입을 중단합니다 " +
          "(dms의 agentUrls가 agent를 참조하므로 먼저 해소돼야 함). " +
          "오류 확인 후 재실행하세요.",
      );
      return;
    }

    // ---- 3. dms ----
    let legacyCount = 0; // owner(userId) 없는 레거시 thread → owner=unknown 으로 보존
    let sessionFallbackCount = 0; // wallet 아닌 비로그인 세션 → 지정 주소로 귀속
    const droppedLog: Array<{ thread: string; messageId: string; speaker: string }> = [];
    const envelopes: DmThreadEnvelope[] = [];

    for (const thread of threads) {
      if (!thread.userId) legacyCount++;
      const messages = await readThreadMessages(redis, thread.id);
      const { envelope, droppedMessages } = threadToEnvelope(thread, messages);
      if (
        envelope.owner.kind === "wallet" &&
        envelope.owner.address === SESSION_FALLBACK_ADDRESS &&
        thread.userId !== SESSION_FALLBACK_ADDRESS
      ) {
        sessionFallbackCount++;
      }
      for (const d of droppedMessages) {
        droppedLog.push({ thread: thread.id, ...d });
      }
      envelopes.push(envelope);
    }

    if (legacyCount > 0) {
      console.warn(
        `ℹ owner(userId) 없는 레거시 thread ${legacyCount}건 → owner=unknown ` +
          `(공유 "unknown user (legacy)"로 보존, 제외 안 함)`,
      );
    }
    if (sessionFallbackCount > 0) {
      console.warn(
        `ℹ wallet 아닌 비로그인 세션 thread ${sessionFallbackCount}건 → ` +
          `지정 주소 ${SESSION_FALLBACK_ADDRESS}로 전부 귀속(세션 단위 구분 없음)`,
      );
    }
    if (droppedLog.length > 0) {
      console.warn(`⚠ 미매칭 speaker 메시지 ${droppedLog.length}건 제외:`);
      for (const d of droppedLog.slice(0, 20)) {
        console.warn(`    thread=${d.thread} msg=${d.messageId} speaker="${d.speaker}"`);
      }
      if (droppedLog.length > 20) console.warn(`    … 외 ${droppedLog.length - 20}건`);
    }

    const batches = batchThreads(envelopes, {
      maxThreads: args.maxThreads,
      maxMessages: args.maxMessages,
    });
    console.log(
      `[/dms] thread ${envelopes.length}건 → ${batches.length}개 배치 ` +
        `(maxThreads=${args.maxThreads}, maxMessages=${args.maxMessages})`,
    );

    const dmsTotal = emptyReport();
    for (let i = 0; i < batches.length; i++) {
      console.log(`  배치 ${i + 1}/${batches.length} (thread ${batches[i].length})`);
      const report = await sendDmsBatchAdaptive(
        client,
        batches[i],
        { dryRun, includeDropped: args.includeDropped },
        `${i + 1}`,
      );
      mergeReport(dmsTotal, report);
      if (report.errors.length > 0) printReport(`배치 ${i + 1}`, report);
    }

    console.log("=== 합계 ===");
    printReport("dms", dmsTotal);
    console.log(
      `레거시(owner=unknown) thread=${legacyCount}, 미매칭 speaker 메시지=${droppedLog.length}`,
    );
    printDroppedSummary(droppedLog);
    if (dryRun) {
      console.log(
        "DRY-RUN 완료. 위 숫자(특히 errors / 레거시 / 미매칭 speaker)를 확인하고 " +
          "이상 없으면 --execute 로 실제 적재하세요.",
      );
    } else {
      console.log("EXECUTE 완료.");
    }
  } catch (err) {
    if (err instanceof MigrationAuthError) {
      console.error(`✖ ${err.message}`);
      process.exitCode = 2;
    } else {
      console.error("✖ 이관 중단:", err);
      process.exitCode = 1;
    }
  } finally {
    await closeRedis();
  }
}

void main();

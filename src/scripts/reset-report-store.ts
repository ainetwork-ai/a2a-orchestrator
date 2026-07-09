// orchestrator 대화·리포트 Redis 데이터 초기화 일회성 스크립트 (EPIC9 Story 9.1).
//
// 목적: ainspace 대화를 backend → orchestrator 로 전량 re-mirror(A안, a2a-slack-notion
// EPIC35 backfill) 하기 **직전에** orchestrator 의 frozen(컷오버 이전) 대화·리포트
// Redis 키를 비운다. 초기화하지 않으면 같은 대화가 (구 orchestrator thread id) +
// (새 backend conversationId) 두 벌로 중복된다 (EPIC9 배경 참조).
//
// ⚠ 반드시 orchestrator 를 **정지**한 상태에서 실행할 것.
//    orchestrator 는 부팅 시 loadThreadsFromRedis(threadManager.ts)로 in-memory World 를
//    채우고, report 는 그 in-memory 를 읽는다. 실행 중에 Redis 를 지우면 in-memory 와
//    Redis 가 어긋나(desync) report 가 유령 데이터를 읽는다.
//
// 실행 순서 (EPIC35 와 맞물림):
//    1. dual-write ON (시각 T)
//    2. orchestrator **정지**
//    3. 이 스크립트 실행  ← 여기
//    4. orchestrator **재기동** (빈 in-memory)
//    5. (EPIC35) backfill 실행 (createdAt < T, backend id 기준)
//    6. (EPIC9 Story 9.2) report new-shape 검증
//
// 삭제 키군: thread:*, threads:list, messages:*, orchestrator:agents,
//            report:job:*, report:cache:*
// 보존 키군: emb:msg:*  ← 임베딩 캐시. content-hash 키라 re-mirror 시 캐시 히트로
//            재임베딩 비용을 아낀다. **절대 삭제하지 않는다.**
//
// 안전장치: 기본 dryRun(삭제 X, 키군 카운트만 출력). 실제 삭제는 --execute.
//           REDIS_URL 을 명시적으로 요구한다(잘못된 Redis 초기화 방지).
//
// 사용:
//   REDIS_URL=redis://... npx ts-node src/scripts/reset-report-store.ts            # dryRun
//   REDIS_URL=redis://... npx ts-node src/scripts/reset-report-store.ts --execute  # 실제 삭제

import "dotenv/config";
import { closeRedis, getRedisClient, initRedis, type RedisClient } from "../utils/redis";

// SCAN 으로 지울 패턴 키군 (여러 키).
const PATTERN_GROUPS = [
  "thread:*",
  "messages:*",
  "report:job:*",
  "report:cache:*",
] as const;

// 단일 키군 (Set 하나씩).
const LITERAL_KEYS = ["threads:list", "orchestrator:agents"] as const;

// 보존 키군 — 절대 삭제하지 않는다(임베딩 캐시).
const PRESERVE_PATTERN = "emb:msg:*";

interface Args {
  execute: boolean;
}

interface KeyGroup {
  label: string;
  keys: string[];
  members?: number; // Set 키의 멤버 수 (LITERAL_KEYS 참고 정보)
}

function parseArgs(argv: string[]): Args {
  return { execute: argv.includes("--execute") };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`✖ 환경변수 ${name} 필요`);
    process.exit(1);
  }
  return v;
}

/** redis URL 의 password 를 마스킹해 로그에 안전하게 출력한다. */
function maskRedisUrl(url: string): string {
  return url.replace(/(:\/\/[^:@/]*:)[^@/]*@/, "$1***@");
}

/**
 * MATCH 패턴에 걸리는 키를 SCAN 으로 전량 수집한다.
 * SCAN 은 스캔 중 존재한 키를 중복 반환할 수 있으므로 Set 으로 dedupe 한다.
 */
async function scanKeys(redis: RedisClient, pattern: string): Promise<string[]> {
  const found = new Set<string>();
  for await (const key of redis.scanIterator({ MATCH: pattern, COUNT: 500 })) {
    found.add(key);
  }
  return [...found];
}

/** 키를 배치로 나눠 삭제하고 실제 삭제 건수를 합산해 돌려준다. */
async function delInBatches(
  redis: RedisClient,
  keys: string[],
  batchSize = 500,
): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < keys.length; i += batchSize) {
    deleted += await redis.del(keys.slice(i, i + batchSize));
  }
  return deleted;
}

async function main(): Promise<void> {
  const { execute } = parseArgs(process.argv.slice(2));
  const dryRun = !execute;
  const redisUrl = requireEnv("REDIS_URL");

  console.log(
    `=== orchestrator 대화·리포트 store 초기화 (${dryRun ? "DRY-RUN" : "EXECUTE"}) ===`,
  );
  console.log(`redis: ${maskRedisUrl(redisUrl)}`);
  console.log(
    "⚠ orchestrator 가 **정지**된 상태여야 합니다. 실행 후 재기동 → (EPIC35) backfill 순서.",
  );

  await initRedis();
  const redis = getRedisClient();

  try {
    // ---- 1. 삭제 대상 수집 ----
    const groups: KeyGroup[] = [];

    for (const pattern of PATTERN_GROUPS) {
      groups.push({ label: pattern, keys: await scanKeys(redis, pattern) });
    }

    for (const key of LITERAL_KEYS) {
      const exists = (await redis.exists(key)) === 1;
      groups.push({
        label: key,
        keys: exists ? [key] : [],
        members: exists ? await redis.sCard(key) : 0,
      });
    }

    // ---- 2. 보존 대상(emb) 확인 + 안전 가드 ----
    const embKeys = await scanKeys(redis, PRESERVE_PATTERN);

    // 삭제 대상에 emb: 키가 한 건이라도 섞이면 패턴 오류 — 중단(캐시 보존 invariant).
    const embLeak = groups.flatMap((g) => g.keys).filter((k) => k.startsWith("emb:"));
    if (embLeak.length > 0) {
      console.error(
        `✖ 안전 가드: 삭제 대상에 emb: 키 ${embLeak.length}건 포함(예: ${embLeak[0]}) — 중단. 패턴을 점검하세요.`,
      );
      process.exitCode = 1;
      return;
    }

    // ---- 3. 카운트 출력 ----
    console.log("=== 삭제 대상 키군 ===");
    let totalKeys = 0;
    for (const g of groups) {
      totalKeys += g.keys.length;
      const extra = g.members !== undefined ? ` (set members=${g.members})` : "";
      console.log(`  ${g.label}: ${g.keys.length} keys${extra}`);
    }
    console.log(`  합계: ${totalKeys} keys`);
    console.log(`보존(삭제 안 함) ${PRESERVE_PATTERN}: ${embKeys.length} keys (임베딩 캐시)`);

    // ---- 4. 실행 or dryRun ----
    if (dryRun) {
      console.log(
        "DRY-RUN 완료. 삭제 없음. 위 카운트를 확인하고 이상 없으면 --execute 로 실제 삭제하세요.",
      );
      return;
    }

    console.log("=== 삭제 실행 ===");
    let totalDeleted = 0;
    for (const g of groups) {
      if (g.keys.length === 0) {
        console.log(`  ${g.label}: 0 keys (건너뜀)`);
        continue;
      }
      const deleted = await delInBatches(redis, g.keys);
      totalDeleted += deleted;
      console.log(`  ${g.label}: ${deleted} keys 삭제`);
    }
    console.log(
      `=== 합계: ${totalDeleted} keys 삭제 (${PRESERVE_PATTERN} ${embKeys.length}건 보존) ===`,
    );
    console.log(
      "EXECUTE 완료. 이제 orchestrator 를 재기동한 뒤 (EPIC35) backfill 을 실행하세요.",
    );
  } catch (err) {
    console.error("✖ 초기화 중단:", err);
    process.exitCode = 1;
  } finally {
    await closeRedis();
  }
}

void main();

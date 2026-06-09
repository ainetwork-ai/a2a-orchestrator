// Redis 읽기 전용 소스. 기존 키 구조를 그대로 읽는다(쓰기 없음).
//   orchestrator:agents (Set)  → { name, a2aUrl }
//   threads:list (Set)         → thread:{id} (JSON Thread)
//   messages:{threadId}        → { messages: Message[], ... }

import type { RedisClient } from "../utils/redis";
import type { Message, Thread } from "../types";
import type { AgentEnvelope } from "./contract";

const AGENTS_KEY = "orchestrator:agents";

/** orchestrator:agents Set → AgentEnvelope[]. 파싱 실패 멤버는 건너뛴다. */
export async function readRegisteredAgents(
  redis: RedisClient,
): Promise<AgentEnvelope[]> {
  const members = await redis.sMembers(AGENTS_KEY);
  const out: AgentEnvelope[] = [];
  for (const m of members) {
    try {
      const a = JSON.parse(m) as { name: string; a2aUrl: string };
      if (a.a2aUrl) out.push({ name: a.name ?? a.a2aUrl, a2aUrl: a.a2aUrl });
    } catch {
      console.warn(`[redis-source] agents Set 멤버 파싱 실패, 건너뜀: ${m.slice(0, 80)}`);
    }
  }
  return out;
}

/** threads:list → thread:{id} 전량 로드. 누락/파싱 실패 thread는 건너뛴다. */
export async function readAllThreads(redis: RedisClient): Promise<Thread[]> {
  const ids = await redis.sMembers("threads:list");
  const out: Thread[] = [];
  for (const id of ids) {
    const raw = await redis.get(`thread:${id}`);
    if (!raw) {
      console.warn(`[redis-source] thread:${id} 본문 없음(목록엔 있음), 건너뜀`);
      continue;
    }
    try {
      out.push(JSON.parse(raw) as Thread);
    } catch {
      console.warn(`[redis-source] thread:${id} 파싱 실패, 건너뜀`);
    }
  }
  return out;
}

/** messages:{threadId}의 .messages[]. 없으면 빈 배열. */
export async function readThreadMessages(
  redis: RedisClient,
  threadId: string,
): Promise<Message[]> {
  const raw = await redis.get(`messages:${threadId}`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { messages?: Message[] };
    return Array.isArray(parsed.messages) ? parsed.messages : [];
  } catch {
    console.warn(`[redis-source] messages:${threadId} 파싱 실패, 빈 배열 처리`);
    return [];
  }
}

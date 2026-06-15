// Redis 엔티티 → 이관 envelope 순수 변환 로직 (I/O 없음, 테스트 대상).
// 변환 규칙 근거: docs/integration/ainspace-migration-guide.md §3~§4.

import type { AgentPersona, Message, Thread } from "../types";
import type {
  AgentEnvelope,
  DmThreadEnvelope,
  MessageEnvelope,
  OwnerRef,
} from "./contract";

/** Base 지갑 주소 모양(0x + 40 hex). 체크섬은 안 봄 — 대/소문자 혼합 다 수용. */
const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * wallet 아닌 opaque userId(비로그인 세션) thread를 전부 귀속시킬 지정 wallet 주소.
 * 세션 단위 구분 없이 단일 유저로 몰아넣는다(소스 정책).
 */
export const SESSION_FALLBACK_ADDRESS = "0x2935Bb8564c672401EC62dF716A03456068AC612";

/** user 발화 speaker 리터럴. orchestrator world.ts:305 `speaker: "User"`. */
const USER_SPEAKER = "User";

/** dev 전용 호스트 — 실서비스 주소 아님. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

/**
 * localhost/127.0.0.1 등 dev 주소의 agent URL은 이관에서 제외한다.
 * 실서비스에서 fetch 불가능한 로컬 개발용 agent라 옮길 의미가 없음(소스 정책).
 * 제외된 agent의 발화 메시지는 자연히 "미매칭 speaker"로 drop된다(호출부 로그).
 */
export function isLocalAgentUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(url);
  }
}

/**
 * thread.userId로 owner 분류.
 * - 없음(레거시 thread, userId 저장 이전) → unknown (backend가 공유 "unknown user (legacy)"로 적재)
 * - 지갑 주소 모양 → wallet (해당 주소)
 * - 그 외 opaque string(비로그인 세션) → wallet (지정 SESSION_FALLBACK_ADDRESS로 전부 귀속)
 * orchestrator엔 세션 스토어가 없어 userId는 opaque — shape로 판정한다(계약 §4.2 A안).
 */
export function classifyOwner(userId: string | undefined | null): OwnerRef {
  if (!userId) return { kind: "unknown" };
  return WALLET_RE.test(userId)
    ? { kind: "wallet", address: userId }
    : { kind: "wallet", address: SESSION_FALLBACK_ADDRESS };
}

export type MessageResult =
  | { ok: true; message: MessageEnvelope }
  | { ok: false; reason: "unmatched-speaker"; messageId: string; speaker: string };

/**
 * Message → MessageEnvelope. senderRef를 exporter가 해소한다(계약 §4.3).
 * - speaker === "User"            → "user"
 * - speaker가 thread.agents의 name → { a2aUrl }
 * - 어느 쪽도 아니면               → drop(unmatched-speaker), 호출부가 로그로 남긴다.
 */
export function resolveMessage(
  msg: Message,
  agents: AgentPersona[],
): MessageResult {
  let senderRef: "user" | { a2aUrl: string };

  if (msg.speaker === USER_SPEAKER) {
    senderRef = "user";
  } else {
    const agent = agents.find((a) => a.name === msg.speaker);
    if (!agent) {
      return {
        ok: false,
        reason: "unmatched-speaker",
        messageId: msg.id,
        speaker: msg.speaker,
      };
    }
    senderRef = { a2aUrl: agent.a2aUrl };
  }

  const envelope: MessageEnvelope = {
    sourceId: msg.id,
    senderRef,
    content: msg.content,
    createdAt: msg.timestamp,
  };
  if (msg.replyTo) envelope.replyToSourceId = msg.replyTo;
  if (msg.status) envelope.status = msg.status;

  return { ok: true, message: envelope };
}

export interface ThreadConversion {
  envelope: DmThreadEnvelope;
  /** senderRef 미해소로 제외된 메시지(데이터 정합 점검용). */
  droppedMessages: Array<{ messageId: string; speaker: string }>;
}

/**
 * Thread + 그 메시지 → DmThreadEnvelope.
 * userId 없는 레거시 thread도 owner=unknown으로 보존(제외하지 않음).
 * dropped status 메시지는 그대로 통과시키고, 적재 여부는 backend의 includeDropped가 결정(계약 §3.3).
 */
export function threadToEnvelope(
  thread: Thread,
  messages: Message[],
): ThreadConversion {
  // localhost/127.0.0.1 dev agent는 제외 — 그 발화는 미매칭 speaker로 drop된다.
  const agents = (thread.agents ?? []).filter((a) => !isLocalAgentUrl(a.a2aUrl));
  const droppedMessages: Array<{ messageId: string; speaker: string }> = [];
  const out: MessageEnvelope[] = [];

  for (const msg of messages) {
    const result = resolveMessage(msg, agents);
    if (result.ok) out.push(result.message);
    else droppedMessages.push({ messageId: result.messageId, speaker: result.speaker });
  }

  const agentUrls = [...new Set(agents.map((a) => a.a2aUrl).filter(Boolean))];

  const envelope: DmThreadEnvelope = {
    sourceId: thread.id,
    name: thread.name,
    owner: classifyOwner(thread.userId),
    agentUrls,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    messages: out,
  };

  return { envelope, droppedMessages };
}

/**
 * /agents 페이로드 = (orchestrator:agents Set) ∪ (모든 thread.agents[]), a2aUrl 기준 dedup.
 * Set이 thread 참조 agent 전체를 담는다는 보장이 없어, thread에서도 모은다(계약 §4.1).
 * name은 fallback일 뿐이라 첫 등장 값을 쓴다(정체성은 URL).
 */
export function collectAgentUnion(
  registered: AgentEnvelope[],
  threads: Array<Pick<Thread, "agents">>,
): AgentEnvelope[] {
  const byUrl = new Map<string, AgentEnvelope>();

  const add = (name: string, a2aUrl: string) => {
    if (a2aUrl && !isLocalAgentUrl(a2aUrl) && !byUrl.has(a2aUrl)) {
      byUrl.set(a2aUrl, { name, a2aUrl });
    }
  };

  for (const a of registered) add(a.name, a.a2aUrl);
  for (const t of threads) {
    for (const a of t.agents ?? []) add(a.name, a.a2aUrl);
  }

  return [...byUrl.values()];
}

/**
 * thread 단위 배치 분할. thread는 절대 쪼개지 않는다(reply 체인이 thread 내부에 닫혀야 함).
 * - 메시지 수가 maxMessages 이상인 thread는 단독 배치.
 * - 그 외엔 maxThreads / 누적 maxMessages 둘 중 먼저 차면 끊는다.
 */
export function batchThreads(
  threads: DmThreadEnvelope[],
  opts: { maxThreads: number; maxMessages: number },
): DmThreadEnvelope[][] {
  const batches: DmThreadEnvelope[][] = [];
  let cur: DmThreadEnvelope[] = [];
  let curMsgs = 0;

  const flush = () => {
    if (cur.length) {
      batches.push(cur);
      cur = [];
      curMsgs = 0;
    }
  };

  for (const t of threads) {
    const n = t.messages.length;

    if (n >= opts.maxMessages) {
      flush();
      batches.push([t]); // 큰 thread 단독 배치
      continue;
    }
    if (cur.length >= opts.maxThreads || curMsgs + n > opts.maxMessages) {
      flush();
    }
    cur.push(t);
    curMsgs += n;
  }
  flush();

  return batches;
}

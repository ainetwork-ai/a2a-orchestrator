// 순수 변환 로직 테스트. 실행:
//   node --require ts-node/register --test src/migration/transform.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentPersona, Message, Thread } from "../types";
import {
  batchThreads,
  classifyOwner,
  collectAgentUnion,
  isLocalAgentUrl,
  resolveMessage,
  SESSION_FALLBACK_ADDRESS,
  threadToEnvelope,
} from "./transform";
import type { DmThreadEnvelope } from "./contract";

const agent = (name: string, a2aUrl: string): AgentPersona => ({
  name,
  role: "agent",
  a2aUrl,
  color: "#000",
});

test("classifyOwner: 0x+40hex는 wallet", () => {
  const o = classifyOwner("0x" + "a".repeat(40));
  assert.deepEqual(o, { kind: "wallet", address: "0x" + "a".repeat(40) });
});

test("classifyOwner: 혼합 대소문자 지갑도 wallet", () => {
  const addr = "0xAbC0000000000000000000000000000000000123";
  assert.equal(classifyOwner(addr).kind, "wallet");
});

test("classifyOwner: uuid 형태 비로그인 세션은 지정 주소 wallet으로 귀속", () => {
  const o = classifyOwner("550e8400-e29b-41d4-a716-446655440000");
  assert.deepEqual(o, { kind: "wallet", address: SESSION_FALLBACK_ADDRESS });
});

test("classifyOwner: 0x지만 40hex 아니면 지정 주소 wallet으로 귀속", () => {
  assert.deepEqual(classifyOwner("0x123"), {
    kind: "wallet",
    address: SESSION_FALLBACK_ADDRESS,
  });
});

test("isLocalAgentUrl: localhost/127.0.0.1/0.0.0.0 제외, 실서비스는 통과", () => {
  assert.equal(isLocalAgentUrl("http://localhost:3001/api/agents/x"), true);
  assert.equal(isLocalAgentUrl("http://127.0.0.1:9/agent-a"), true);
  assert.equal(isLocalAgentUrl("https://a2a-builder.ainetwork.ai/api/agents/y"), false);
  assert.equal(isLocalAgentUrl("https://foo.vercel.app"), false);
});

test("collectAgentUnion: localhost agent 제외", () => {
  const out = collectAgentUnion(
    [{ name: "Local", a2aUrl: "http://localhost:3001/api/agents/l" }],
    [{ agents: [agent("Real", "https://real.example/card")] }],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].a2aUrl, "https://real.example/card");
});

test("threadToEnvelope: localhost agent는 agentUrls 제외 + 그 발화 drop", () => {
  const thread = {
    id: "t1", name: "t", createdAt: 1, updatedAt: 2,
    userId: "0x" + "a".repeat(40),
    agents: [
      agent("Real", "https://real.example/card"),
      agent("LocalBot", "http://localhost:3001/api/agents/l"),
    ],
  } as unknown as Thread;
  const msgs: Message[] = [
    { id: "m1", speaker: "User", content: "hi", timestamp: 1 },
    { id: "m2", speaker: "Real", content: "real", timestamp: 2 },
    { id: "m3", speaker: "LocalBot", content: "local", timestamp: 3 },
  ];
  const { envelope, droppedMessages } = threadToEnvelope(thread, msgs);
  assert.deepEqual(envelope.agentUrls, ["https://real.example/card"]);
  assert.equal(envelope.messages.length, 2); // user + Real
  assert.deepEqual(droppedMessages, [{ messageId: "m3", speaker: "LocalBot" }]);
});

test("classifyOwner: userId 없으면(레거시 thread) unknown", () => {
  assert.deepEqual(classifyOwner(undefined), { kind: "unknown" });
  assert.deepEqual(classifyOwner(null), { kind: "unknown" });
  assert.deepEqual(classifyOwner(""), { kind: "unknown" });
});

test("threadToEnvelope: userId 없는 레거시 thread도 owner=unknown으로 보존", () => {
  const thread = {
    id: "t-legacy",
    name: "legacy",
    agents: [agent("Researcher", "https://a.example/card")],
    createdAt: 1,
    updatedAt: 2,
  } as unknown as Thread;
  const msgs: Message[] = [
    { id: "m1", speaker: "User", content: "hi", timestamp: 1 },
  ];
  const { envelope } = threadToEnvelope(thread, msgs);
  assert.deepEqual(envelope.owner, { kind: "unknown" });
  assert.equal(envelope.messages.length, 1);
});

test("resolveMessage: User speaker → user", () => {
  const m: Message = { id: "m1", speaker: "User", content: "hi", timestamp: 1 };
  const r = resolveMessage(m, []);
  assert.ok(r.ok);
  assert.equal(r.message.senderRef, "user");
});

test("resolveMessage: agent speaker → { a2aUrl }, replyTo/status 통과", () => {
  const m: Message = {
    id: "m2",
    speaker: "Researcher",
    content: "yo",
    timestamp: 2,
    replyTo: "m1",
    status: "accepted",
  };
  const r = resolveMessage(m, [agent("Researcher", "https://a.example/card")]);
  assert.ok(r.ok);
  assert.deepEqual(r.message.senderRef, { a2aUrl: "https://a.example/card" });
  assert.equal(r.message.replyToSourceId, "m1");
  assert.equal(r.message.status, "accepted");
});

test("resolveMessage: 미매칭 speaker는 drop", () => {
  const m: Message = { id: "m3", speaker: "Ghost", content: "x", timestamp: 3 };
  const r = resolveMessage(m, [agent("Researcher", "https://a.example/card")]);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "unmatched-speaker");
    assert.equal(r.messageId, "m3");
    assert.equal(r.speaker, "Ghost");
  }
});

test("threadToEnvelope: 미매칭 메시지 격리 + agentUrls dedup + owner 분류", () => {
  const thread: Thread = {
    id: "t1",
    name: "리서치",
    agents: [
      agent("Researcher", "https://a.example/card"),
      agent("Writer", "https://a.example/card"), // 중복 url
    ],
    createdAt: 100,
    updatedAt: 200,
    userId: "session-xyz",
  };
  const messages: Message[] = [
    { id: "m1", speaker: "User", content: "hi", timestamp: 1 },
    { id: "m2", speaker: "Researcher", content: "yo", timestamp: 2 },
    { id: "m3", speaker: "Ghost", content: "??", timestamp: 3 },
  ];
  const { envelope, droppedMessages } = threadToEnvelope(thread, messages);

  assert.equal(envelope.sourceId, "t1");
  assert.deepEqual(envelope.owner, {
    kind: "wallet",
    address: SESSION_FALLBACK_ADDRESS,
  });
  assert.deepEqual(envelope.agentUrls, ["https://a.example/card"]); // dedup
  assert.equal(envelope.messages.length, 2);
  assert.equal(droppedMessages.length, 1);
  assert.equal(droppedMessages[0].messageId, "m3");
});

test("collectAgentUnion: Set ∪ thread.agents, url dedup, thread 전용 agent 포함", () => {
  const registered = [{ name: "A", a2aUrl: "https://a" }];
  const threads = [
    { agents: [agent("A-dup", "https://a"), agent("B", "https://b")] },
    { agents: [agent("C", "https://c")] },
  ];
  const union = collectAgentUnion(registered, threads);
  const urls = union.map((u) => u.a2aUrl).sort();
  assert.deepEqual(urls, ["https://a", "https://b", "https://c"]);
  // 첫 등장 name 보존 (Set의 A가 thread의 A-dup보다 우선)
  assert.equal(union.find((u) => u.a2aUrl === "https://a")!.name, "A");
});

const mkEnv = (id: string, msgCount: number): DmThreadEnvelope => ({
  sourceId: id,
  name: id,
  owner: { kind: "session", sessionId: "s" },
  agentUrls: [],
  createdAt: 0,
  updatedAt: 0,
  messages: Array.from({ length: msgCount }, (_, i) => ({
    sourceId: `${id}-${i}`,
    senderRef: "user" as const,
    content: "x",
    createdAt: i,
  })),
});

test("batchThreads: maxThreads 캡으로 분할", () => {
  const threads = [mkEnv("a", 1), mkEnv("b", 1), mkEnv("c", 1)];
  const batches = batchThreads(threads, { maxThreads: 2, maxMessages: 1000 });
  assert.deepEqual(batches.map((b) => b.length), [2, 1]);
});

test("batchThreads: 큰 thread는 단독 배치 + 앞 배치 flush", () => {
  const threads = [mkEnv("a", 1), mkEnv("big", 500), mkEnv("c", 1)];
  const batches = batchThreads(threads, { maxThreads: 100, maxMessages: 500 });
  assert.equal(batches.length, 3);
  assert.deepEqual(batches[0].map((t) => t.sourceId), ["a"]);
  assert.deepEqual(batches[1].map((t) => t.sourceId), ["big"]);
  assert.deepEqual(batches[2].map((t) => t.sourceId), ["c"]);
});

test("batchThreads: 누적 메시지 캡으로 분할", () => {
  const threads = [mkEnv("a", 30), mkEnv("b", 30), mkEnv("c", 10)];
  const batches = batchThreads(threads, { maxThreads: 100, maxMessages: 50 });
  // a(30) → b(30)면 60>50 이라 끊김 → [a],[b,c]
  assert.deepEqual(batches.map((b) => b.map((t) => t.sourceId)), [["a"], ["b", "c"]]);
});

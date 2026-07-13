// speaker 검증/폴백 순수 로직 테스트 (report speaker 오귀속 hotfix). 실행:
//   node --require ts-node/register --test src/services/reportPipeline/opinionExtractor.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";
import type { SegmentMessage } from "../../types/report";
import { resolveSpeaker } from "./opinionExtractor";

const msg = (id: string, speaker: string, isUser = false): SegmentMessage => ({
  id,
  speaker,
  content: "",
  timestamp: 0,
  isUser,
});

// 재현 시나리오: 실제 화자는 "KXIZY 주작"(agent). 다른 에이전트("핑크퐁")가 본문에서
// "주작 언니"라 호칭 → LLM 이 speaker 를 본문에 등장한 "주작 언니"로 환각.
const messages: SegmentMessage[] = [
  msg("m1", "User", true),
  msg("m2", "KXIZY 주작"),
  msg("m3", "핑크퐁"),
];

test("resolveSpeaker: LLM 이 실제 agent 화자를 주면 그대로 채택", () => {
  assert.equal(resolveSpeaker("KXIZY 주작", messages, ["m2"]), "KXIZY 주작");
});

test("resolveSpeaker: LLM 이 'User'를 주고 User 가 대화에 있으면 그대로", () => {
  assert.equal(resolveSpeaker("User", messages, ["m1"]), "User");
});

test("resolveSpeaker: 본문에서 지어낸 화자('주작 언니')는 keyMessage 실제 화자로 교정", () => {
  // 핵심 회귀 테스트 — 환각 speaker 가 통과하지 않고 실제 화자로 폴백.
  // (구 동작: `op.speaker || "User"` 라 "주작 언니"가 그대로 통과했다.)
  assert.equal(resolveSpeaker("주작 언니", messages, ["m2"]), "KXIZY 주작");
});

test("resolveSpeaker: speaker 미지정이면 keyMessage 실제 화자로 폴백", () => {
  assert.equal(resolveSpeaker(undefined, messages, ["m3"]), "핑크퐁");
});

test("resolveSpeaker: keyMessage 가 여럿이면 최빈 실제 화자", () => {
  assert.equal(
    resolveSpeaker("주작 언니", messages, ["m2", "m2", "m3"]),
    "KXIZY 주작"
  );
});

test("resolveSpeaker: User keyMessage 가 우세하면 User", () => {
  assert.equal(
    resolveSpeaker("존재하지않는화자", messages, ["m1", "m1", "m2"]),
    "User"
  );
});

test("resolveSpeaker: 유효 keyMessage 신호가 없으면 'User'(익명 기본값)", () => {
  assert.equal(resolveSpeaker("주작 언니", messages, []), "User");
});

test("resolveSpeaker: keyMessage 에 대화 밖 id 만 있으면 무시하고 'User'로 폴백", () => {
  // 호출부가 messageIdSet 으로 선필터하지만, 헬퍼는 미지의 id(get miss)를 만나도
  // 건너뛰고 폴백해야 한다. (빈 배열 케이스와 달리 speakerById.get miss 경로를 탄다.)
  assert.equal(resolveSpeaker("주작 언니", messages, ["m-not-in-conversation"]), "User");
});
